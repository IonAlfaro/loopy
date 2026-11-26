use crate::engine::executor::{compact_agent_messages, parse_inline_tool_calls};
use crate::inference::llama_cpp::LlamaCppManager;
use crate::inference::{resolve_load_config_with_profile, ChatMessage, ChatRequest};
use crate::knowledge::{build_knowledge_tree, build_or_update_index, search_bm25, KnowledgeIndex};
use crate::mcp::{load_saved_mcp_servers, mcp_prefixed_tool_name, McpSession};
use crate::skills::{discover_skills, load_skill_file};
use crate::tools::{
    cancel_scheduled_task, capture_file_state, compute_compact_diff, execute_tool_cancellable,
    get_bg_task_status, kill_bg_task, list_scheduled_tasks, schedule_task, start_bg_task,
    tool_definitions,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::sync::oneshot;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum PermissionMode {
    ReadOnly,
    Ask,
    AutoReview,
    FullAuto,
}

impl Default for PermissionMode {
    fn default() -> Self {
        Self::Ask
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionDecision {
    pub approved: bool,
    #[serde(default)]
    pub always_allow_tool: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestionDecision {
    pub answers: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentToolCallRecord {
    pub id: String,
    pub name: String,
    pub args_json: String,
    pub status: String,
    pub output_preview: String,
    pub duration_ms: u64,
    #[serde(default)]
    pub file_path: Option<String>,
    #[serde(default)]
    pub previous_content: Option<String>,
    #[serde(default)]
    pub file_existed: bool,
    #[serde(default)]
    pub diff_preview: Option<String>,
    #[serde(default)]
    pub added_lines: usize,
    #[serde(default)]
    pub removed_lines: usize,
    #[serde(default)]
    pub screenshot_path: Option<String>,
    #[serde(default)]
    pub cursor_x: Option<f64>,
    #[serde(default)]
    pub cursor_y: Option<f64>,
    #[serde(default)]
    pub undone: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentChatMessage {
    pub id: String,
    pub role: String,
    pub content: String,
    #[serde(default)]
    pub thinking: String,
    #[serde(default)]
    pub attachments: Vec<String>,
    #[serde(default)]
    pub tool_calls: Vec<AgentToolCallRecord>,
    pub timestamp: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSession {
    pub id: String,
    pub title: String,
    pub workspace: String,
    pub model_path: String,
    #[serde(default)]
    pub permission_mode: PermissionMode,
    #[serde(default = "default_true")]
    pub use_rag: bool,
    #[serde(default)]
    pub compact_at_tokens: u32,
    #[serde(default)]
    pub reasoning_effort: Option<String>,
    #[serde(default)]
    pub enabled_skills: Vec<String>,
    #[serde(default)]
    pub pinned_files: Vec<String>,
    #[serde(default)]
    pub pinned: bool,
    #[serde(default)]
    pub allowed_session_tools: Vec<String>,
    #[serde(default)]
    pub messages: Vec<AgentChatMessage>,
    #[serde(default)]
    pub updated_at: u64,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionSummary {
    pub id: String,
    pub title: String,
    pub workspace: String,
    pub updated_at: u64,
    pub message_count: usize,
    pub permission_mode: PermissionMode,
    #[serde(default)]
    pub pinned: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTodoItem {
    pub title: String,
    pub status: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AgentChatEvent {
    Token {
        session_id: String,
        message_id: String,
        is_thinking: bool,
        token: String,
    },
    TodoUpdated {
        session_id: String,
        items: Vec<AgentTodoItem>,
    },
    ToolStarted {
        session_id: String,
        message_id: String,
        call: AgentToolCallRecord,
    },
    ToolFinished {
        session_id: String,
        message_id: String,
        call: AgentToolCallRecord,
    },
    PermissionRequested {
        session_id: String,
        message_id: String,
        call_id: String,
        tool_name: String,
        summary: String,
        preview: String,
    },
    QuestionRequested {
        session_id: String,
        call_id: String,
        question: String,
        options: Vec<String>,
        allow_multiple: bool,
    },
    ArtifactUpdated {
        session_id: String,
        title: String,
        path: String,
        kind: String,
        content: String,
    },
    TurnFinished {
        session_id: String,
        status: String,
        context_used_chars: usize,
        context_max_tokens: u32,
        summary: String,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceMemoryFileInfo {
    pub name: String,
    pub rel_path: String,
    pub content: String,
    pub size_bytes: usize,
}

pub struct AgentChatState {
    active_cancel: Mutex<Option<Arc<AtomicBool>>>,
    pending_permission: Arc<Mutex<Option<oneshot::Sender<PermissionDecision>>>>,
    pending_question: Arc<Mutex<Option<oneshot::Sender<QuestionDecision>>>>,
    running: Arc<AtomicBool>,
}

impl Default for AgentChatState {
    fn default() -> Self {
        Self {
            active_cancel: Mutex::new(None),
            pending_permission: Arc::new(Mutex::new(None)),
            pending_question: Arc::new(Mutex::new(None)),
            running: Arc::new(AtomicBool::new(false)),
        }
    }
}

impl AgentChatState {
    pub fn is_running(&self) -> bool {
        self.running.load(Ordering::SeqCst)
    }

    pub fn begin_turn(&self) -> Result<Arc<AtomicBool>, String> {
        let mut guard = self
            .active_cancel
            .lock()
            .map_err(|_| "Agent lock poisoned".to_string())?;
        if let Some(prev) = guard.take() {
            prev.store(true, Ordering::SeqCst);
        }
        if let Ok(mut perm) = self.pending_permission.lock() {
            perm.take();
        }
        if let Ok(mut q) = self.pending_question.lock() {
            q.take();
        }
        let flag = Arc::new(AtomicBool::new(false));
        *guard = Some(flag.clone());
        self.running.store(true, Ordering::SeqCst);
        Ok(flag)
    }

    pub fn end_turn(&self) {
        self.running.store(false, Ordering::SeqCst);
        if let Ok(mut perm) = self.pending_permission.lock() {
            perm.take();
        }
        if let Ok(mut q) = self.pending_question.lock() {
            q.take();
        }
    }

    pub fn stop_turn(&self) {
        if let Ok(guard) = self.active_cancel.lock() {
            if let Some(flag) = guard.as_ref() {
                flag.store(true, Ordering::SeqCst);
            }
        }
        if let Ok(mut perm) = self.pending_permission.lock() {
            perm.take();
        }
        if let Ok(mut q) = self.pending_question.lock() {
            q.take();
        }
    }

    pub fn resolve_question(&self, decision: QuestionDecision) -> Result<(), String> {
        let mut slot = self
            .pending_question
            .lock()
            .map_err(|_| "Question lock poisoned".to_string())?;
        let Some(tx) = slot.take() else {
            return Err("No pending question to answer.".to_string());
        };
        tx.send(decision)
            .map_err(|_| "Question channel already closed.".to_string())
    }

    pub fn resolve_permission(&self, decision: PermissionDecision) -> Result<(), String> {
        let mut perm = self
            .pending_permission
            .lock()
            .map_err(|_| "Permission lock poisoned".to_string())?;
        if let Some(tx) = perm.take() {
            let _ = tx.send(decision);
            Ok(())
        } else {
            Err("No hay ninguna solicitud de permiso pendiente.".to_string())
        }
    }
}

pub fn sessions_dir() -> PathBuf {
    dirs::data_local_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("loopy")
        .join("agent_sessions")
}

fn session_file_path(dir: &Path, id: &str) -> PathBuf {
    let safe_id: String = id
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    dir.join(format!("{safe_id}.json"))
}

pub fn list_sessions_in(dir: &Path) -> Vec<AgentSessionSummary> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut list = Vec::new();
    for entry in entries.flatten() {
        let p = entry.path();
        if p.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        if let Ok(raw) = fs::read_to_string(&p) {
            if let Ok(sess) = serde_json::from_str::<AgentSession>(&raw) {
                list.push(AgentSessionSummary {
                    id: sess.id,
                    title: sess.title,
                    workspace: sess.workspace,
                    updated_at: sess.updated_at,
                    message_count: sess.messages.len(),
                    permission_mode: sess.permission_mode,
                    pinned: sess.pinned,
                });
            }
        }
    }
    list.sort_by_key(|a| (std::cmp::Reverse(a.pinned), std::cmp::Reverse(a.updated_at)));
    list
}

pub fn load_session_in(dir: &Path, id: &str) -> Result<AgentSession, String> {
    let p = session_file_path(dir, id);
    let raw = fs::read_to_string(&p)
        .map_err(|e| format!("No se pudo abrir sesiÃ³n '{}': {e}", p.display()))?;
    serde_json::from_str::<AgentSession>(&raw)
        .map_err(|e| format!("SesiÃ³n JSON corrupta: {e}"))
}

pub fn save_session_in(dir: &Path, session: &AgentSession) -> Result<(), String> {
    fs::create_dir_all(dir)
        .map_err(|e| format!("Error creando carpeta de sesiones: {e}"))?;
    let p = session_file_path(dir, &session.id);
    let json = serde_json::to_string_pretty(session)
        .map_err(|e| format!("Error serializando sesiÃ³n: {e}"))?;
    fs::write(&p, json).map_err(|e| format!("Error escribiendo sesiÃ³n: {e}"))
}

pub fn delete_session_in(dir: &Path, id: &str) -> Result<(), String> {
    let p = session_file_path(dir, id);
    if p.exists() {
        fs::remove_file(&p).map_err(|e| format!("Error eliminando sesiÃ³n: {e}"))?;
    }
    Ok(())
}

pub const READONLY_TOOLS: &[&str] = &[
    "list_files",
    "find_files",
    "grep_search",
    "code_symbols",
    "read_file",
    "binary_inspect",
    "git_diff",
    "git_log",
    "web_search",
    "fetch_url",
];

pub const ALL_MODE_TOOLS: &[&str] = &[
    "list_files",
    "find_files",
    "grep_search",
    "code_symbols",
    "read_file",
    "binary_inspect",
    "edit_file",
    "write_file",
    "delete_file",
    "run_cmd",
    "git_diff",
    "git_log",
    "debug_crash",
    "differential_test",
    "web_search",
    "fetch_url",
    "browser_action",
    "sql_query",
    "docker_exec",
];

pub fn enabled_tools_for_mode(mode: &PermissionMode) -> Vec<String> {
    match mode {
        PermissionMode::ReadOnly => READONLY_TOOLS.iter().map(|s| s.to_string()).collect(),
        PermissionMode::Ask | PermissionMode::AutoReview | PermissionMode::FullAuto => {
            ALL_MODE_TOOLS.iter().map(|s| s.to_string()).collect()
        }
    }
}

pub fn tool_requires_permission(name: &str) -> bool {
    if name.starts_with("mcp__") {
        return true;
    }
    matches!(
        name,
        "edit_file"
            | "write_file"
            | "delete_file"
            | "run_cmd"
            | "run_bg_cmd"
            | "kill_bg_task"
            | "schedule_task"
            | "cancel_scheduled_task"
            | "generate_image"
            | "docker_exec"
            | "debug_crash"
            | "differential_test"
            | "browser_action"
            | "sql_query"
    )
}

fn now_epoch_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn truncate_chars(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let p: String = s.chars().take(max).collect();
        format!("{p}â€¦")
    }
}

fn is_image_attachment(path: &str) -> bool {
    let lower = path.trim().to_lowercase();
    lower.ends_with(".png")
        || lower.ends_with(".jpg")
        || lower.ends_with(".jpeg")
        || lower.ends_with(".webp")
        || lower.ends_with(".gif")
        || lower.ends_with(".bmp")
}

pub async fn run_agent_turn<F>(
    llama: &LlamaCppManager,
    binary_path: String,
    state: &AgentChatState,
    mut session: AgentSession,
    user_prompt: String,
    override_ctx: Option<u32>,
    attachments: Vec<String>,
    emit: F,
) -> Result<AgentSession, String>
where
    F: Fn(AgentChatEvent) + Send + Sync + 'static,
{
    let cancel = state.begin_turn()?;
    struct TurnGuard<'a>(&'a AgentChatState);
    impl<'a> Drop for TurnGuard<'a> {
        fn drop(&mut self) {
            self.0.end_turn();
        }
    }
    let _guard = TurnGuard(state);

    let is_cloud = crate::inference::cloud::is_cloud_model(&session.model_path);
    let (context_size, has_mmproj, profile, port) = if is_cloud {
        let mut prof = crate::inference::ModelTuningProfile::default();
        prof.max_tokens = 0;
        (128_000u32, true, prof, None)
    } else {
        let (load_cfg, profile) = resolve_load_config_with_profile(
            binary_path,
            &session.model_path,
            override_ctx,
            None,
        );
        let ctx = load_cfg.context_size;
        let mm = load_cfg.mmproj_path.is_some();
        let p = llama.ensure_loaded(load_cfg).await?;
        (ctx, mm, profile, Some(p))
    };

    let dir = sessions_dir();
    let trimmed_prompt = user_prompt.trim().to_string();
    if !trimmed_prompt.is_empty() || !attachments.is_empty() {
        let cur_title_lower = session.title.trim().to_ascii_lowercase();
        let is_default_title = cur_title_lower.is_empty()
            || cur_title_lower == "new session"
            || cur_title_lower == "new chat"
            || cur_title_lower == "nuevo chat"
            || cur_title_lower.starts_with("nueva sesi");
        if session.messages.is_empty() && is_default_title {
            let title_seed = if !trimmed_prompt.is_empty() {
                trimmed_prompt
                    .split_whitespace()
                    .collect::<Vec<_>>()
                    .join(" ")
            } else {
                Path::new(&attachments[0])
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("Attachment")
                    .to_string()
            };
            session.title = truncate_chars(&title_seed, 46);
        }
        session.messages.push(AgentChatMessage {
            id: format!("u-{}", now_epoch_secs()),
            role: "user".to_string(),
            content: trimmed_prompt.clone(),
            thinking: String::new(),
            attachments: attachments.clone(),
            tool_calls: Vec::new(),
            timestamp: now_epoch_secs(),
        });
    }

    let assistant_msg_id = format!(
        "a-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
    );
    session.messages.push(AgentChatMessage {
        id: assistant_msg_id.clone(),
        role: "assistant".to_string(),
        content: String::new(),
        thinking: String::new(),
        attachments: Vec::new(),
        tool_calls: Vec::new(),
        timestamp: now_epoch_secs(),
    });
    session.updated_at = now_epoch_secs();
    let _ = save_session_in(&dir, &session);

    // Optional RAG index & Mini-Repo-Map (only when a real project workspace is linked)
    let has_workspace =
        !session.workspace.trim().is_empty() && session.workspace.trim() != ".";
    let mut rag_index: Option<KnowledgeIndex> = None;
    let mut system_prompt = if has_workspace {
        format!(
            "Eres el Agente de IngenierÃ­a de Loopy trabajando directamente sobre el proyecto del usuario.\n\
             Workspace activo: `{}`\n\
             Modo de permisos: {:?}\n\n\
             REGLAS DE TRABAJO:\n\
             - Verifica siempre leyendo archivos reales antes de afirmar comportamientos o rutas.\n\
             - Si el usuario menciona un documento (.pdf, .docx, .xlsx, .pptx, .epub), usa `read_file` directamente.\n\
             - Si te piden buscar en internet precios, productos, noticias o navegar por una web, usa `browser_action` (por ejemplo `action: \"goto\"` a `https://duckduckgo.com/?q=...` o `https://www.google.com/search?q=...` o a la tienda/web objetivo, seguido de `snapshot` / `click` / `type` / `scroll`) para que el usuario vea en tiempo real tu navegaciÃ³n y clics en el panel Navegador de la derecha. TambiÃ©n puedes complementar con `web_search` o `fetch_url`.\n\
             - Responde en espaÃ±ol claro, conciso y con rutas/lÃ­neas o enlaces verificados.",
            session.workspace, session.permission_mode
        )
    } else {
        "Eres el Agente de Loopy en una conversaciÃ³n libre (sin proyecto enlazado).\n\
         REGLAS DE TRABAJO:\n\
         - Ayuda directamente con preguntas, anÃ¡lisis, redacciÃ³n, programaciÃ³n, documentos adjuntos o bÃºsqueda en internet.\n\
         - Si el usuario te pide buscar informaciÃ³n actual, precios, noticias o navegar por una web, usa `browser_action`, `web_search` o `fetch_url`.\n\
         - Si el usuario adjunta archivos o imÃ¡genes, analÃ­zalos directamente.\n\
         - Responde en espaÃ±ol claro y conciso."
            .to_string()
    };

    if has_workspace && session.use_rag {
        if let Ok((idx, stats)) = build_or_update_index(&session.workspace, "") {
            let tree = build_knowledge_tree(&idx, None, 2800);
            system_prompt.push_str(&format!(
                "\n\n## MAPA DEL REPOSITORIO ({} archivos indexados Â· herramientas `search_knowledge` y `knowledge_tree` activas)\n{}",
                stats.total_files, tree
            ));
            rag_index = Some(idx);
        }
    }

    if !session.enabled_skills.is_empty() {
        let available = discover_skills(&session.workspace);
        for sk in available {
            if session.enabled_skills.contains(&sk.name) || session.enabled_skills.contains(&sk.path) {
                if let Ok(loaded) = load_skill_file(Path::new(&sk.path)) {
                    system_prompt.push_str(&format!(
                        "\n\n## SKILL ACTIVA: {}\n{}",
                        loaded.name,
                        truncate_chars(&loaded.body, 4000)
                    ));
                }
            }
        }
    }

    if !session.pinned_files.is_empty() {
        let ws_base = if session.workspace.trim().is_empty() || session.workspace == "." {
            std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
        } else {
            PathBuf::from(&session.workspace)
        };
        for rel in &session.pinned_files {
            let candidate = ws_base.join(rel);
            if let Ok(txt) = fs::read_to_string(&candidate) {
                system_prompt.push_str(&format!(
                    "\n\n## ARCHIVO FIJADO (`{rel}`)\n```\n{}\n```",
                    truncate_chars(&txt, 4000)
                ));
            }
        }
    }

    // Build LLM messages: frozen system prompt + compact historical turns + current user turn
    let mut llm_messages = vec![ChatMessage {
        role: "system".to_string(),
        content: Some(system_prompt),
        tool_calls: None,
        tool_call_id: None,
        image_paths: Vec::new(),
    }];

    // Exclude the newly created empty assistant message at the end
    let prev_count = session.messages.len().saturating_sub(1);
    for (idx, msg) in session.messages.iter().take(prev_count).enumerate() {
        let is_latest_user = idx + 1 == prev_count && msg.role == "user";
        if is_latest_user {
            let mut txt = msg.content.clone();
            let mut img_paths = Vec::new();
            for att in &msg.attachments {
                let fname = Path::new(att)
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or(att);
                if is_image_attachment(att) {
                    if has_mmproj {
                        img_paths.push(att.clone());
                        txt.push_str(&format!("\n\n[Imagen adjunta para visiÃ³n: `{fname}` ({att})]"));
                    } else {
                        txt.push_str(&format!(
                            "\n\n[Imagen adjunta: `{fname}` ({att}). Nota: no hay proyector multimodal mmproj configurado en el modelo actual.]"
                        ));
                    }
                } else {
                    match crate::tools::docs::read_document_or_text(Path::new(att)).await {
                        Ok(doc_text) => {
                            let total_lines = doc_text.lines().count();
                            let snippet = truncate_chars(&doc_text, 6000);
                            txt.push_str(&format!(
                                "\n\n<archivo_adjunto nombre=\"{fname}\" ruta=\"{att}\" lineas=\"{total_lines}\">\n{snippet}\n</archivo_adjunto>"
                            ));
                        }
                        Err(err) => {
                            txt.push_str(&format!(
                                "\n\n[Archivo adjunto `{fname}` ({att}): error al leer: {err}]"
                            ));
                        }
                    }
                }
            }
            llm_messages.push(ChatMessage {
                role: "user".to_string(),
                content: Some(txt),
                tool_calls: None,
                tool_call_id: None,
                image_paths: img_paths,
            });
        } else if msg.role == "user" {
            let mut txt = msg.content.clone();
            if !msg.attachments.is_empty() {
                let names: Vec<String> = msg
                    .attachments
                    .iter()
                    .map(|a| {
                        Path::new(a)
                            .file_name()
                            .and_then(|n| n.to_str())
                            .unwrap_or(a)
                            .to_string()
                    })
                    .collect();
                txt.push_str(&format!("\n[Adjuntos en ese turno: {}]", names.join(", ")));
            }
            llm_messages.push(ChatMessage {
                role: "user".to_string(),
                content: Some(txt),
                tool_calls: None,
                tool_call_id: None,
                image_paths: Vec::new(),
            });
        } else {
            let mut txt = msg.content.clone();
            if !msg.tool_calls.is_empty() {
                let summary_tools: Vec<String> = msg
                    .tool_calls
                    .iter()
                    .map(|tc| format!("{}[{}]", tc.name, tc.status))
                    .collect();
                txt.push_str(&format!(
                    "\n[Herramientas ejecutadas en ese turno: {}]",
                    summary_tools.join(", ")
                ));
            }
            llm_messages.push(ChatMessage {
                role: "assistant".to_string(),
                content: Some(txt),
                tool_calls: None,
                tool_call_id: None,
                image_paths: Vec::new(),
            });
        }
    }

    // Build tool definitions strictly honoring ReadOnly vs Ask/FullAuto
    let allowed_names = enabled_tools_for_mode(&session.permission_mode);
    let mut tool_defs = tool_definitions(&allowed_names);
    if rag_index.is_some() {
        tool_defs.push(json!({
            "type": "function",
            "function": {
                "name": "search_knowledge",
                "description": "Busca fragmentos de cÃ³digo o documentaciÃ³n en el Ã­ndice RAG local (BM25).",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": { "type": "string", "description": "Consulta tÃ©cnica, sÃ­mbolo o concepto" },
                        "top_k": { "type": "integer", "description": "MÃ¡ximo de fragmentos (por defecto 5)" }
                    },
                    "required": ["query"]
                }
            }
        }));
        tool_defs.push(json!({
            "type": "function",
            "function": {
                "name": "knowledge_tree",
                "description": "Devuelve el Ã¡rbol de conocimiento (archivos y sÃ­mbolos) del repo o subcarpeta.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": { "type": "string", "description": "Subcarpeta opcional" }
                    }
                }
            }
        }));
    }

    // Live task checklist tool (available in all modes)
    tool_defs.push(json!({
        "type": "function",
        "function": {
            "name": "update_todo_list",
            "description": "Updates the live task checklist shown to the user. Always send the full ordered list of steps with status 'pending', 'in_progress', 'done', or 'failed'.",
            "parameters": {
                "type": "object",
                "properties": {
                    "items": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "title": { "type": "string" },
                                "status": { "type": "string", "enum": ["pending", "in_progress", "done", "failed"] }
                            },
                            "required": ["title", "status"]
                        }
                    }
                },
                "required": ["items"]
            }
        }
    }));

    // Isolated research subagent tool (clean context window, read-only workspace + RAG + web)
    tool_defs.push(json!({
        "type": "function",
        "function": {
            "name": "spawn_subagent",
            "description": "Launches an isolated read-only subagent with a fresh context window to research files, symbols, RAG, git history, or web docs and return a concise summary.",
            "parameters": {
                "type": "object",
                "properties": {
                    "role": { "type": "string", "description": "Short role title, e.g. 'Codebase Researcher'" },
                    "task": { "type": "string", "description": "Detailed research prompt and what to return" },
                    "max_steps": { "type": "integer", "description": "Max tool steps (default 8, max 15)" }
                },
                "required": ["role", "task"]
            }
        }
    }));

    // Parallel subagents fan-out tool
    tool_defs.push(json!({
        "type": "function",
        "function": {
            "name": "spawn_parallel_subagents",
            "description": "Launches multiple isolated read-only subagents concurrently (up to 4) and returns all their reports together.",
            "parameters": {
                "type": "object",
                "properties": {
                    "tasks": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "role": { "type": "string" },
                                "task": { "type": "string" },
                                "max_steps": { "type": "integer" }
                            },
                            "required": ["role", "task"]
                        }
                    }
                },
                "required": ["tasks"]
            }
        }
    }));

    // Structured clickable user question tool
    tool_defs.push(json!({
        "type": "function",
        "function": {
            "name": "ask_question",
            "description": "Pauses to ask the user a structured multiple-choice question with clickable options before proceeding.",
            "parameters": {
                "type": "object",
                "properties": {
                    "question": { "type": "string", "description": "Clear question for the user" },
                    "options": {
                        "type": "array",
                        "items": { "type": "string" },
                        "description": "2 to 6 concise answer choices"
                    },
                    "allow_multiple": { "type": "boolean", "description": "Allow selecting multiple options (default false)" }
                },
                "required": ["question", "options"]
            }
        }
    }));

    // Persistent Artifacts (Markdown reports, Mermaid diagrams, interactive HTML widgets)
    tool_defs.push(json!({
        "type": "function",
        "function": {
            "name": "write_artifact",
            "description": "Creates or updates a rich persistent artifact in .loopy/artifacts/ (Markdown .md or interactive HTML .html) and displays it to the user.",
            "parameters": {
                "type": "object",
                "properties": {
                    "filename": { "type": "string", "description": "e.g. 'architecture-plan.md' or 'dashboard.html'" },
                    "title": { "type": "string", "description": "Human-readable title" },
                    "content": { "type": "string", "description": "Full Markdown or standalone HTML content" }
                },
                "required": ["filename", "title", "content"]
            }
        }
    }));
    tool_defs.push(json!({
        "type": "function",
        "function": {
            "name": "list_artifacts",
            "description": "Lists saved artifacts in .loopy/artifacts/.",
            "parameters": { "type": "object", "properties": {} }
        }
    }));

    // Scheduled tasks / timers
    tool_defs.push(json!({
        "type": "function",
        "function": {
            "name": "list_scheduled_tasks",
            "description": "Lists scheduled timers and recurring tasks with their status and last output.",
            "parameters": { "type": "object", "properties": {} }
        }
    }));
    if session.permission_mode != PermissionMode::ReadOnly {
        tool_defs.push(json!({
            "type": "function",
            "function": {
                "name": "schedule_task",
                "description": "Schedules a one-shot timer or recurring shell task in the background.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "label": { "type": "string", "description": "Short task name" },
                        "command": { "type": "string", "description": "Shell command to run" },
                        "delay_seconds": { "type": "integer", "description": "Initial delay in seconds (default 60)" },
                        "interval_seconds": { "type": "integer", "description": "Recurring interval in seconds (0 = one-shot)" },
                        "max_runs": { "type": "integer", "description": "Max executions for recurring tasks (default 10)" }
                    },
                    "required": ["label", "command"]
                }
            }
        }));
        tool_defs.push(json!({
            "type": "function",
            "function": {
                "name": "cancel_scheduled_task",
                "description": "Cancels an active scheduled task by task_id.",
                "parameters": {
                    "type": "object",
                    "properties": { "task_id": { "type": "string" } },
                    "required": ["task_id"]
                }
            }
        }));
        tool_defs.push(json!({
            "type": "function",
            "function": {
                "name": "generate_image",
                "description": "Generates a PNG image using the configured OpenAI-compatible image provider and saves it into .loopy/generated/.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "prompt": { "type": "string", "description": "Detailed visual prompt" },
                        "size": { "type": "string", "description": "e.g. '1024x1024' (default)" },
                        "model": { "type": "string", "description": "Optional model override (default 'gpt-image-1')" }
                    },
                    "required": ["prompt"]
                }
            }
        }));
    }

    // Background process tools
    tool_defs.push(json!({
        "type": "function",
        "function": {
            "name": "bg_task_status",
            "description": "Lists background tasks or reads the status and recent output lines of a specific background task.",
            "parameters": {
                "type": "object",
                "properties": {
                    "task_id": { "type": "string", "description": "Optional task_id returned by run_bg_cmd. Omit to list all tasks." },
                    "tail_lines": { "type": "integer", "description": "How many recent log lines to return (default 40)" }
                }
            }
        }
    }));
    if session.permission_mode != PermissionMode::ReadOnly {
        tool_defs.push(json!({
            "type": "function",
            "function": {
                "name": "run_bg_cmd",
                "description": "Starts a long-running shell command in the background (dev server, build, watcher) without blocking. Returns a task_id.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "command": { "type": "string", "description": "Shell command to run in the background" }
                    },
                    "required": ["command"]
                }
            }
        }));
        tool_defs.push(json!({
            "type": "function",
            "function": {
                "name": "kill_bg_task",
                "description": "Stops a running background task started with run_bg_cmd.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "task_id": { "type": "string", "description": "The task_id to terminate" }
                    },
                    "required": ["task_id"]
                }
            }
        }));
    }

    // Connect enabled global MCP servers and expose their tools directly to Agent Mode
    let mut mcp_sessions: Vec<McpSession> = Vec::new();
    let mut mcp_tool_routes: std::collections::HashMap<String, (usize, String)> =
        std::collections::HashMap::new();
    if session.permission_mode != PermissionMode::ReadOnly {
        for srv in load_saved_mcp_servers().into_iter().filter(|s| s.enabled) {
            let cfg = srv.to_config();
            if let Ok(mut mcp_sess) = McpSession::connect(&cfg, &session.workspace).await {
                if let Ok(tools) = mcp_sess.list_tools(&cfg.allowed_tools).await {
                    let idx = mcp_sessions.len();
                    for t in tools {
                        let prefixed = mcp_prefixed_tool_name(&cfg.name, &t.name);
                        tool_defs.push(json!({
                            "type": "function",
                            "function": {
                                "name": prefixed,
                                "description": format!("[MCP:{}] {}", cfg.name, t.description),
                                "parameters": t.input_schema,
                            }
                        }));
                        mcp_tool_routes.insert(prefixed, (idx, t.name));
                    }
                    mcp_sessions.push(mcp_sess);
                }
            }
        }
    }

    let max_steps = 40usize;
    let target_compact_tokens = if session.compact_at_tokens > 0 {
        session.compact_at_tokens
    } else {
        profile.compact_at_tokens
    };
    let effective_compact_budget = if target_compact_tokens > 0 {
        let scaled = ((target_compact_tokens as u64 * 4) / 3) as u32;
        if context_size > 0 {
            scaled.min(context_size)
        } else {
            scaled
        }
    } else {
        context_size
    };

    let mut last_call_sig = String::new();
    let mut repeat_count: u32 = 0;
    let mut final_status = "completed".to_string();
    let mut final_summary = String::new();

    for _step in 1..=max_steps {
        if cancel.load(Ordering::SeqCst) {
            final_status = "cancelled".to_string();
            final_summary = "Detenido por el usuario.".to_string();
            break;
        }

        let _ = compact_agent_messages(&mut llm_messages, effective_compact_budget);

        let sid_clone = session.id.clone();
        let mid_clone = assistant_msg_id.clone();

        let chat_req = ChatRequest {
            messages: llm_messages.clone(),
            tools: tool_defs.clone(),
            temperature: profile.temperature,
            top_p: Some(profile.top_p),
            max_tokens: if profile.max_tokens > 0 {
                Some(profile.max_tokens)
            } else {
                None
            },
            min_p: Some(profile.min_p),
            repeat_penalty: Some(profile.repeat_penalty),
            seed: Some(profile.seed),
            reasoning_effort: session.reasoning_effort.clone(),
        };

        let mut step_started_content = true;
        let chat_res = if let Some(p) = port {
            llama
                .chat_stream(p, chat_req, Some(&cancel), |is_thinking, tok| {
                    if let Some(last) = session.messages.last_mut() {
                        if is_thinking {
                            last.thinking.push_str(tok);
                        } else {
                            if !last.content.is_empty()
                                && !last.content.ends_with('\n')
                                && !last.content.ends_with(' ')
                                && _step > 1
                                && step_started_content
                            {
                                last.content.push_str("\n\n");
                                emit(AgentChatEvent::Token {
                                    session_id: sid_clone.clone(),
                                    message_id: mid_clone.clone(),
                                    is_thinking: false,
                                    token: "\n\n".to_string(),
                                });
                            }
                            step_started_content = false;
                            last.content.push_str(tok);
                        }
                    }
                    emit(AgentChatEvent::Token {
                        session_id: sid_clone.clone(),
                        message_id: mid_clone.clone(),
                        is_thinking,
                        token: tok.to_string(),
                    });
                })
                .await
        } else {
            crate::inference::cloud::chat_stream_cloud(
                &session.model_path,
                chat_req,
                Some(&cancel),
                |is_thinking, tok| {
                    if let Some(last) = session.messages.last_mut() {
                        if is_thinking {
                            last.thinking.push_str(tok);
                        } else {
                            if !last.content.is_empty()
                                && !last.content.ends_with('\n')
                                && !last.content.ends_with(' ')
                                && _step > 1
                                && step_started_content
                            {
                                last.content.push_str("\n\n");
                                emit(AgentChatEvent::Token {
                                    session_id: sid_clone.clone(),
                                    message_id: mid_clone.clone(),
                                    is_thinking: false,
                                    token: "\n\n".to_string(),
                                });
                            }
                            step_started_content = false;
                            last.content.push_str(tok);
                        }
                    }
                    emit(AgentChatEvent::Token {
                        session_id: sid_clone.clone(),
                        message_id: mid_clone.clone(),
                        is_thinking,
                        token: tok.to_string(),
                    });
                },
            )
            .await
        };

        let resp = match chat_res {
            Ok(r) => r,
            Err(err) if err == "__CANCELLED__" => {
                final_status = "cancelled".to_string();
                final_summary = "Detenido por el usuario.".to_string();
                break;
            }
            Err(err) => {
                final_status = "error".to_string();
                final_summary = err.clone();
                if let Some(last) = session.messages.last_mut() {
                    if !last.content.is_empty() {
                        last.content.push_str("\n\n");
                    }
                    last.content.push_str(&format!("Error: {err}"));
                }
                break;
            }
        };

        let mut tool_calls = resp.tool_calls.clone();
        if tool_calls.is_empty() && resp.content.contains("<tool_call>") {
            tool_calls = parse_inline_tool_calls(&resp.content);
        }

        if tool_calls.is_empty() {
            let truncated = resp.finish_reason.as_deref() == Some("length")
                || resp.content.trim().is_empty();
            if truncated && _step < max_steps && repeat_count < 3 {
                repeat_count += 1;
                if !resp.content.trim().is_empty() {
                    llm_messages.push(ChatMessage {
                        role: "assistant".to_string(),
                        content: Some(resp.content.clone()),
                        tool_calls: None,
                        tool_call_id: None,
                        image_paths: Vec::new(),
                    });
                }
                llm_messages.push(ChatMessage {
                    role: "user".to_string(),
                    content: Some(
                        "Tu turno anterior se cortÃ³ por lÃ­mite de longitud durante el razonamiento. ContinÃºa ejecutando la herramienta pendiente o entrega tu respuesta final."
                            .to_string(),
                    ),
                    tool_calls: None,
                    tool_call_id: None,
                    image_paths: Vec::new(),
                });
                continue;
            }
            break;
        }

        llm_messages.push(ChatMessage {
            role: "assistant".to_string(),
            content: if resp.content.is_empty() {
                None
            } else {
                Some(resp.content.clone())
            },
            tool_calls: Some(tool_calls.clone()),
            tool_call_id: None,
            image_paths: Vec::new(),
        });

        let sig: String = tool_calls
            .iter()
            .map(|c| format!("{}:{}", c.function.name, c.function.arguments))
            .collect::<Vec<_>>()
            .join("|");
        if sig == last_call_sig {
            repeat_count += 1;
        } else {
            last_call_sig = sig;
            repeat_count = 1;
        }

        let mut attach_shots: Vec<String> = Vec::new();

        for tc in tool_calls {
            let call_id = tc.id.clone();
            let mut record = AgentToolCallRecord {
                id: call_id.clone(),
                name: tc.function.name.clone(),
                args_json: tc.function.arguments.clone(),
                status: "running".to_string(),
                output_preview: String::new(),
                duration_ms: 0,
                file_path: None,
                previous_content: None,
                file_existed: false,
                diff_preview: None,
                added_lines: 0,
                removed_lines: 0,
                screenshot_path: None,
                cursor_x: None,
                cursor_y: None,
                undone: false,
            };

            emit(AgentChatEvent::ToolStarted {
                session_id: session.id.clone(),
                message_id: assistant_msg_id.clone(),
                call: record.clone(),
            });

            let parsed_res = if tc.function.arguments.trim().is_empty() {
                Ok(json!({}))
            } else {
                serde_json::from_str::<Value>(&tc.function.arguments)
            };

            let t0 = Instant::now();
            let mut denied = false;
            let tool_output: String;

            match parsed_res {
                Err(parse_err) => {
                    record.status = "error".to_string();
                    tool_output = format!(
                        "Error de sintaxis JSON en arguments para '{}': {parse_err}. Corrige el JSON y reintenta.",
                        tc.function.name
                    );
                }
                Ok(parsed_args) => {
                    // Strictly block writes in ReadOnly even if hallucinated
                    if session.permission_mode == PermissionMode::ReadOnly
                        && tool_requires_permission(&tc.function.name)
                    {
                        denied = true;
                        record.status = "denied".to_string();
                        tool_output = format!(
                            "Permiso denegado: la sesiÃ³n estÃ¡ en modo Solo Lectura; '{}' no estÃ¡ permitida.",
                            tc.function.name
                        );
                    } else if (session.permission_mode == PermissionMode::Ask
                        || session.permission_mode == PermissionMode::AutoReview)
                        && tool_requires_permission(&tc.function.name)
                        && !session.allowed_session_tools.contains(&tc.function.name)
                    {
                        let mut needs_user_approval = true;
                        let mut summary = format!("Ejecutar {}", tc.function.name);

                        if session.permission_mode == PermissionMode::AutoReview {
                            let (is_safe, reason) = llm_check_tool_safety(
                                llama,
                                port,
                                &session.model_path,
                                &session.workspace,
                                &tc.function.name,
                                &tc.function.arguments,
                                &cancel,
                            )
                            .await;
                            if is_safe {
                                needs_user_approval = false;
                            } else {
                                summary = if reason.is_empty() {
                                    format!("AI Safety Review: confirmar {}", tc.function.name)
                                } else {
                                    format!("AI Safety Review ({}): {}", tc.function.name, reason)
                                };
                            }
                        }

                        if !needs_user_approval {
                            tool_output = dispatch_agent_tool(
                                state,
                                &call_id,
                                &session.id,
                                &session.workspace,
                                &session.model_path,
                                llama,
                                port,
                                &tc.function.name,
                                &parsed_args,
                                &mut record,
                                &rag_index,
                                &mut mcp_sessions,
                                &mcp_tool_routes,
                                &cancel,
                                &emit,
                            )
                            .await;
                        } else {
                            let preview = truncate_chars(&tc.function.arguments, 800);
                            let (tx, rx) = oneshot::channel::<PermissionDecision>();
                            if let Ok(mut slot) = state.pending_permission.lock() {
                                *slot = Some(tx);
                            }
                            emit(AgentChatEvent::PermissionRequested {
                                session_id: session.id.clone(),
                                message_id: assistant_msg_id.clone(),
                                call_id: call_id.clone(),
                                tool_name: tc.function.name.clone(),
                                summary,
                                preview,
                            });

                            let decision = tokio::select! {
                                res = rx => res.unwrap_or(PermissionDecision { approved: false, always_allow_tool: false }),
                                _ = async {
                                    while !cancel.load(Ordering::SeqCst) {
                                        tokio::time::sleep(Duration::from_millis(90)).await;
                                    }
                                } => PermissionDecision { approved: false, always_allow_tool: false },
                            };

                            if !decision.approved {
                                denied = true;
                                record.status = "denied".to_string();
                                tool_output = if cancel.load(Ordering::SeqCst) {
                                    "Cancelado por el usuario mientras esperaba aprobaciÃ³n.".to_string()
                                } else {
                                    format!(
                                        "El usuario rechazÃ³ ejecutar '{}' ({}). Busca una alternativa o pregunta cÃ³mo proceder.",
                                        tc.function.name,
                                        truncate_chars(&tc.function.arguments, 120)
                                    )
                                };
                            } else {
                                if decision.always_allow_tool
                                    && !session.allowed_session_tools.contains(&tc.function.name)
                                {
                                    session.allowed_session_tools.push(tc.function.name.clone());
                                }
                                tool_output = dispatch_agent_tool(
                                    state,
                                    &call_id,
                                    &session.id,
                                    &session.workspace,
                                    &session.model_path,
                                    llama,
                                    port,
                                    &tc.function.name,
                                    &parsed_args,
                                    &mut record,
                                    &rag_index,
                                    &mut mcp_sessions,
                                    &mcp_tool_routes,
                                    &cancel,
                                    &emit,
                                )
                                .await;
                            }
                        }
                    } else {
                        tool_output = dispatch_agent_tool(
                            state,
                            &call_id,
                            &session.id,
                            &session.workspace,
                            &session.model_path,
                            llama,
                            port,
                            &tc.function.name,
                            &parsed_args,
                            &mut record,
                            &rag_index,
                            &mut mcp_sessions,
                            &mcp_tool_routes,
                            &cancel,
                            &emit,
                        )
                        .await;
                    }
                }
            }

            if !denied && record.status == "running" {
                record.status = "success".to_string();
            }
            record.duration_ms = t0.elapsed().as_millis() as u64;
            record.output_preview = truncate_chars(&tool_output, 4000);

            if has_mmproj {
                if let Some(ref shot) = record.screenshot_path {
                    if Path::new(shot).exists() {
                        attach_shots.push(shot.clone());
                    }
                }
            }

            if let Some(last) = session.messages.last_mut() {
                last.tool_calls.push(record.clone());
            }
            session.updated_at = now_epoch_secs();
            let _ = save_session_in(&dir, &session);

            emit(AgentChatEvent::ToolFinished {
                session_id: session.id.clone(),
                message_id: assistant_msg_id.clone(),
                call: record,
            });

            llm_messages.push(ChatMessage {
                role: "tool".to_string(),
                content: Some(truncate_chars(&tool_output, 8000)),
                tool_calls: None,
                tool_call_id: Some(call_id),
                image_paths: Vec::new(),
            });

            if cancel.load(Ordering::SeqCst) {
                break;
            }
        }

        if !attach_shots.is_empty() {
            llm_messages.push(ChatMessage {
                role: "user".to_string(),
                content: Some("[Captura de pantalla del navegador adjunta para inspecciÃ³n visual]".to_string()),
                tool_calls: None,
                tool_call_id: None,
                image_paths: attach_shots,
            });
        }

        if repeat_count >= 3 {
            llm_messages.push(ChatMessage {
                role: "user".to_string(),
                content: Some(
                    "Aviso: repetiste la misma llamada a herramienta 3 veces seguidas. Cambia de enfoque o concluye ya tu respuesta."
                        .to_string(),
                ),
                tool_calls: None,
                tool_call_id: None,
                image_paths: Vec::new(),
            });
            repeat_count = 0;
        }
    }

    let used_chars: usize = llm_messages
        .iter()
        .map(|m| m.content.as_ref().map(|c| c.len()).unwrap_or(0))
        .sum();

    session.updated_at = now_epoch_secs();
    let _ = save_session_in(&dir, &session);

    emit(AgentChatEvent::TurnFinished {
        session_id: session.id.clone(),
        status: final_status,
        context_used_chars: used_chars,
        context_max_tokens: context_size,
        summary: final_summary,
    });

    Ok(session)
}

#[allow(clippy::too_many_arguments)]
async fn dispatch_agent_tool<F>(
    state: &AgentChatState,
    call_id: &str,
    session_id: &str,
    workspace: &str,
    model_path: &str,
    llama: &LlamaCppManager,
    port: Option<u16>,
    name: &str,
    parsed_args: &Value,
    record: &mut AgentToolCallRecord,
    rag_index: &Option<KnowledgeIndex>,
    mcp_sessions: &mut [McpSession],
    mcp_tool_routes: &std::collections::HashMap<String, (usize, String)>,
    cancel: &Arc<AtomicBool>,
    emit: &F,
) -> String
where
    F: Fn(AgentChatEvent) + Send + Sync,
{
    if name == "ask_question" {
        let question = parsed_args
            .get("question")
            .and_then(|v| v.as_str())
            .unwrap_or("Please choose an option:")
            .to_string();
        let options: Vec<String> = parsed_args
            .get("options")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|x| x.as_str().map(|s| s.trim().to_string()))
                    .filter(|s| !s.is_empty())
                    .collect()
            })
            .unwrap_or_default();
        let allow_multiple = parsed_args
            .get("allow_multiple")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);

        let (tx, rx) = oneshot::channel::<QuestionDecision>();
        if let Ok(mut slot) = state.pending_question.lock() {
            *slot = Some(tx);
        }
        emit(AgentChatEvent::QuestionRequested {
            session_id: session_id.to_string(),
            call_id: call_id.to_string(),
            question: question.clone(),
            options,
            allow_multiple,
        });

        let decision = tokio::select! {
            res = rx => res.unwrap_or(QuestionDecision { answers: Vec::new() }),
            _ = async {
                while !cancel.load(Ordering::SeqCst) {
                    tokio::time::sleep(Duration::from_millis(90)).await;
                }
            } => QuestionDecision { answers: Vec::new() },
        };

        if cancel.load(Ordering::SeqCst) {
            return "User cancelled while answering question.".to_string();
        }
        if decision.answers.is_empty() {
            return format!("User dismissed question: '{question}'.");
        }
        return format!("User answered '{}': {}", question, decision.answers.join(", "));
    }

    if name == "write_artifact" {
        let raw_name = parsed_args
            .get("filename")
            .and_then(|v| v.as_str())
            .unwrap_or("artifact.md");
        let safe_name: String = raw_name
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_') { c } else { '_' })
            .collect();
        let title = parsed_args
            .get("title")
            .and_then(|v| v.as_str())
            .unwrap_or(&safe_name)
            .to_string();
        let content = parsed_args
            .get("content")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let base = if workspace.trim().is_empty() || workspace == "." {
            std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
        } else {
            PathBuf::from(workspace)
        };
        let dir = base.join(".loopy").join("artifacts");
        if let Err(e) = fs::create_dir_all(&dir) {
            record.status = "error".to_string();
            return format!("Failed creating artifacts dir: {e}");
        }
        let dest = dir.join(&safe_name);
        if let Err(e) = fs::write(&dest, &content) {
            record.status = "error".to_string();
            return format!("Failed writing artifact: {e}");
        }
        let kind = if safe_name.to_ascii_lowercase().ends_with(".html") {
            "html".to_string()
        } else {
            "markdown".to_string()
        };
        let path_str = dest.to_string_lossy().to_string();
        emit(AgentChatEvent::ArtifactUpdated {
            session_id: session_id.to_string(),
            title: title.clone(),
            path: path_str.clone(),
            kind,
            content,
        });
        return format!("Artifact '{title}' saved to {path_str}.");
    }

    if name == "list_artifacts" {
        let base = if workspace.trim().is_empty() || workspace == "." {
            std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
        } else {
            PathBuf::from(workspace)
        };
        let dir = base.join(".loopy").join("artifacts");
        let Ok(entries) = fs::read_dir(&dir) else {
            return "No artifacts saved yet.".to_string();
        };
        let mut names: Vec<String> = entries
            .flatten()
            .filter_map(|e| e.file_name().into_string().ok())
            .collect();
        names.sort();
        if names.is_empty() {
            return "No artifacts saved yet.".to_string();
        }
        return format!("Saved artifacts ({}):\n- {}", names.len(), names.join("\n- "));
    }

    if name == "schedule_task" {
        let label = parsed_args.get("label").and_then(|v| v.as_str()).unwrap_or("");
        let cmd = parsed_args.get("command").and_then(|v| v.as_str()).unwrap_or("");
        let delay = parsed_args.get("delay_seconds").and_then(|v| v.as_u64()).unwrap_or(60);
        let interval = parsed_args.get("interval_seconds").and_then(|v| v.as_u64()).unwrap_or(0);
        let max_runs = parsed_args.get("max_runs").and_then(|v| v.as_u64()).unwrap_or(10) as u32;
        return match schedule_task(workspace, label, cmd, delay, interval, max_runs) {
            Ok(msg) => msg,
            Err(err) => {
                record.status = "error".to_string();
                err
            }
        };
    }

    if name == "list_scheduled_tasks" {
        return list_scheduled_tasks();
    }

    if name == "cancel_scheduled_task" {
        let id = parsed_args.get("task_id").and_then(|v| v.as_str()).unwrap_or("");
        return cancel_scheduled_task(id);
    }

    if name == "generate_image" {
        let prompt = parsed_args.get("prompt").and_then(|v| v.as_str()).unwrap_or("");
        let size = parsed_args.get("size").and_then(|v| v.as_str()).unwrap_or("1024x1024");
        let model_opt = parsed_args.get("model").and_then(|v| v.as_str());
        let base = if workspace.trim().is_empty() || workspace == "." {
            std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
        } else {
            PathBuf::from(workspace)
        };
        let out_dir = base.join(".loopy").join("generated");
        return match crate::inference::cloud::generate_image_cloud(prompt, size, model_opt, &out_dir).await {
            Ok(path) => {
                record.screenshot_path = Some(path.clone());
                format!("Generated image saved to: {path}")
            }
            Err(err) => {
                record.status = "error".to_string();
                err
            }
        };
    }

    if name == "spawn_parallel_subagents" {
        let tasks = parsed_args
            .get("tasks")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        if tasks.is_empty() {
            record.status = "error".to_string();
            return "spawn_parallel_subagents requires at least one task.".to_string();
        }
        let mut futs = Vec::new();
        for item in tasks.into_iter().take(4) {
            let role = item
                .get("role")
                .and_then(|v| v.as_str())
                .unwrap_or("Research Subagent")
                .to_string();
            let task_str = item
                .get("task")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let max_steps = item
                .get("max_steps")
                .and_then(|v| v.as_u64())
                .unwrap_or(8)
                .clamp(2, 15) as usize;
            let ws = workspace.to_string();
            let mp = model_path.to_string();
            let llama_clone = llama.clone();
            let rag_ref = rag_index.clone();
            let cancel_clone = cancel.clone();
            futs.push(async move {
                run_subagent_loop(
                    &ws,
                    &mp,
                    &llama_clone,
                    port,
                    &role,
                    &task_str,
                    max_steps,
                    &rag_ref,
                    &cancel_clone,
                )
                .await
            });
        }
        let reports = futures_util::future::join_all(futs).await;
        return reports.join("\n\n---\n\n");
    }

    if name == "update_todo_list" {
        let items: Vec<AgentTodoItem> = parsed_args
            .get("items")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|item| {
                        let title = item.get("title")?.as_str()?.trim().to_string();
                        if title.is_empty() {
                            return None;
                        }
                        let status = item
                            .get("status")
                            .and_then(|s| s.as_str())
                            .unwrap_or("pending")
                            .to_string();
                        Some(AgentTodoItem { title, status })
                    })
                    .collect()
            })
            .unwrap_or_default();
        let count = items.len();
        emit(AgentChatEvent::TodoUpdated {
            session_id: session_id.to_string(),
            items,
        });
        return format!("Todo list updated ({count} items).");
    }

    if name == "run_bg_cmd" {
        let cmd = parsed_args
            .get("command")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        return match start_bg_task(workspace, cmd) {
            Ok(msg) => msg,
            Err(err) => {
                record.status = "error".to_string();
                err
            }
        };
    }

    if name == "bg_task_status" {
        let task_id = parsed_args.get("task_id").and_then(|v| v.as_str());
        let tail = parsed_args
            .get("tail_lines")
            .and_then(|v| v.as_u64())
            .unwrap_or(40) as usize;
        return get_bg_task_status(task_id, tail);
    }

    if name == "kill_bg_task" {
        let task_id = parsed_args
            .get("task_id")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        return kill_bg_task(task_id);
    }

    if let Some((idx, real_tool)) = mcp_tool_routes.get(name) {
        if let Some(sess) = mcp_sessions.get_mut(*idx) {
            return match sess.call_tool(real_tool, parsed_args.clone()).await {
                Ok(out) => out,
                Err(err) => {
                    record.status = "error".to_string();
                    format!("MCP tool error ({name}): {err}")
                }
            };
        }
        record.status = "error".to_string();
        return format!("MCP server session for '{name}' is not connected.");
    }

    if name == "spawn_subagent" {
        let role = parsed_args
            .get("role")
            .and_then(|v| v.as_str())
            .unwrap_or("Research Subagent");
        let task = parsed_args
            .get("task")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let max_steps = parsed_args
            .get("max_steps")
            .and_then(|v| v.as_u64())
            .unwrap_or(8)
            .clamp(2, 15) as usize;
        if task.trim().is_empty() {
            record.status = "error".to_string();
            return "spawn_subagent requires a non-empty 'task'.".to_string();
        }
        return run_subagent_loop(
            workspace,
            model_path,
            llama,
            port,
            role,
            task,
            max_steps,
            rag_index,
            cancel,
        )
        .await;
    }

    let browser_args_owned;
    let effective_args = if name == "browser_action" {
        let mut cloned = parsed_args.clone();
        if let Some(obj) = cloned.as_object_mut() {
            obj.insert("__session_id".to_string(), json!(session_id));
        }
        browser_args_owned = cloned;
        &browser_args_owned
    } else {
        parsed_args
    };
    run_single_tool(workspace, name, effective_args, record, rag_index, cancel).await
}

#[allow(clippy::too_many_arguments)]
async fn run_subagent_loop(
    workspace: &str,
    model_path: &str,
    llama: &LlamaCppManager,
    port: Option<u16>,
    role: &str,
    task: &str,
    max_steps: usize,
    rag_index: &Option<KnowledgeIndex>,
    cancel: &Arc<AtomicBool>,
) -> String {
    let ro_names: Vec<String> = READONLY_TOOLS.iter().map(|s| s.to_string()).collect();
    let mut sub_tools = tool_definitions(&ro_names);
    if rag_index.is_some() {
        sub_tools.push(json!({
            "type": "function",
            "function": {
                "name": "search_knowledge",
                "description": "Search local RAG BM25 index.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": { "type": "string" },
                        "top_k": { "type": "integer" }
                    },
                    "required": ["query"]
                }
            }
        }));
        sub_tools.push(json!({
            "type": "function",
            "function": {
                "name": "knowledge_tree",
                "description": "List repository files and symbols.",
                "parameters": {
                    "type": "object",
                    "properties": { "path": { "type": "string" } }
                }
            }
        }));
    }

    let mut messages = vec![
        ChatMessage {
            role: "system".to_string(),
            content: Some(format!(
                "You are an isolated read-only subagent ({role}) working in workspace '{workspace}'. \
                 Use your tools to investigate thoroughly and return a concise, factual report with exact file paths and line numbers."
            )),
            tool_calls: None,
            tool_call_id: None,
            image_paths: Vec::new(),
        },
        ChatMessage {
            role: "user".to_string(),
            content: Some(task.to_string()),
            tool_calls: None,
            tool_call_id: None,
            image_paths: Vec::new(),
        },
    ];

    let mut final_reply = String::new();

    for _step in 0..max_steps {
        if cancel.load(Ordering::SeqCst) {
            return format!("[Subagent: {role}] Cancelled.");
        }
        let req = ChatRequest {
            messages: messages.clone(),
            tools: sub_tools.clone(),
            temperature: 0.2,
            top_p: Some(0.95),
            max_tokens: Some(1536),
            min_p: None,
            repeat_penalty: None,
            seed: None,
            reasoning_effort: None,
        };
        let res = if let Some(p) = port {
            llama.chat_stream(p, req, Some(cancel), |_, _| {}).await
        } else {
            crate::inference::cloud::chat_stream_cloud(model_path, req, Some(cancel), |_, _| {}).await
        };

        let resp = match res {
            Ok(r) => r,
            Err(e) => return format!("[Subagent: {role}] Error: {e}"),
        };

        let mut tcs = resp.tool_calls.clone();
        if tcs.is_empty() && resp.content.contains("<tool_call>") {
            tcs = parse_inline_tool_calls(&resp.content);
        }
        if tcs.is_empty() {
            final_reply = resp.content;
            break;
        }

        messages.push(ChatMessage {
            role: "assistant".to_string(),
            content: if resp.content.is_empty() { None } else { Some(resp.content) },
            tool_calls: Some(tcs.clone()),
            tool_call_id: None,
            image_paths: Vec::new(),
        });

        for tc in tcs {
            let parsed = serde_json::from_str::<Value>(&tc.function.arguments).unwrap_or_else(|_| json!({}));
            let mut dummy = AgentToolCallRecord {
                id: tc.id.clone(),
                name: tc.function.name.clone(),
                args_json: tc.function.arguments.clone(),
                status: "running".into(),
                output_preview: String::new(),
                duration_ms: 0,
                file_path: None,
                previous_content: None,
                file_existed: false,
                diff_preview: None,
                added_lines: 0,
                removed_lines: 0,
                screenshot_path: None,
                cursor_x: None,
                cursor_y: None,
                undone: false,
            };
            let out = run_single_tool(workspace, &tc.function.name, &parsed, &mut dummy, rag_index, cancel).await;
            messages.push(ChatMessage {
                role: "tool".to_string(),
                content: Some(truncate_chars(&out, 4500)),
                tool_calls: None,
                tool_call_id: Some(tc.id),
                image_paths: Vec::new(),
            });
        }
    }

    if final_reply.trim().is_empty() {
        format!("[Subagent: {role}] Finished {max_steps} steps without a final text summary.")
    } else {
        format!("[Subagent: {role}]\n{}", truncate_chars(&final_reply, 6000))
    }
}

async fn run_single_tool(
    workspace: &str,
    name: &str,
    parsed_args: &Value,
    record: &mut AgentToolCallRecord,
    rag_index: &Option<KnowledgeIndex>,
    cancel: &Arc<AtomicBool>,
) -> String {
    if name == "search_knowledge" {
        return match rag_index {
            Some(idx) => {
                let q = parsed_args.get("query").and_then(|v| v.as_str()).unwrap_or("");
                let k = parsed_args.get("top_k").and_then(|v| v.as_u64()).unwrap_or(5) as usize;
                search_bm25(idx, q, k, 6000)
            }
            None => "RAG no estÃ¡ habilitado en esta sesiÃ³n.".to_string(),
        };
    }
    if name == "knowledge_tree" {
        return match rag_index {
            Some(idx) => {
                let sub = parsed_args.get("path").and_then(|v| v.as_str());
                build_knowledge_tree(idx, sub, 6000)
            }
            None => "RAG no estÃ¡ habilitado en esta sesiÃ³n.".to_string(),
        };
    }

    // Capture pre-mutation snapshot for Undo support
    let is_file_mutation = matches!(name, "edit_file" | "write_file" | "delete_file");
    let mut captured_abs: Option<PathBuf> = None;
    let mut prev_content: Option<String> = None;
    if is_file_mutation {
        if let Some(rel) = parsed_args.get("path").and_then(|v| v.as_str()) {
            record.file_path = Some(rel.to_string());
            if let Ok((abs, existing)) = capture_file_state(workspace, rel) {
                record.file_existed = existing.is_some();
                record.previous_content = existing.clone();
                captured_abs = Some(abs);
                prev_content = existing;
            }
        }
    }

    let out = execute_tool_cancellable(workspace, name, parsed_args, Some(cancel)).await;

    if is_file_mutation {
        if let (Some(abs), Some(rel)) = (captured_abs, record.file_path.as_deref()) {
            let after_content = fs::read_to_string(&abs).ok();
            let (diff, add, rem) =
                compute_compact_diff(prev_content.as_deref(), after_content.as_deref(), rel);
            record.diff_preview = Some(diff);
            record.added_lines = add;
            record.removed_lines = rem;
        }
    }

    if name == "browser_action" {
        if let Ok(val) = serde_json::from_str::<Value>(&out) {
            if let Some(shot) = val.get("screenshot").and_then(|v| v.as_str()) {
                record.screenshot_path = Some(shot.to_string());
            }
            if let Some(cur) = val.get("cursor") {
                record.cursor_x = cur.get("x").and_then(|v| v.as_f64());
                record.cursor_y = cur.get("y").and_then(|v| v.as_f64());
            }
        }
    }

    out
}

pub fn undo_tool_call_in_dir(
    dir: &Path,
    session_id: &str,
    message_id: &str,
    call_id: &str,
) -> Result<AgentSession, String> {
    let mut session = load_session_in(dir, session_id)?;
    let ws = session.workspace.clone();
    let msg = session
        .messages
        .iter_mut()
        .find(|m| m.id == message_id)
        .ok_or_else(|| "Mensaje no encontrado.".to_string())?;
    let call = msg
        .tool_calls
        .iter_mut()
        .find(|c| c.id == call_id)
        .ok_or_else(|| "Llamada a herramienta no encontrada.".to_string())?;

    if call.undone {
        return Err("Ese cambio ya fue deshecho previamente.".to_string());
    }
    let rel = call
        .file_path
        .as_deref()
        .ok_or_else(|| "Esta herramienta no modificÃ³ ningÃºn archivo.".to_string())?;
    let (abs, _) = capture_file_state(&ws, rel)?;

    if call.file_existed {
        let prev = call
            .previous_content
            .as_deref()
            .ok_or_else(|| "No hay copia previa guardada.".to_string())?;
        if let Some(parent) = abs.parent() {
            let _ = fs::create_dir_all(parent);
        }
        fs::write(&abs, prev).map_err(|e| format!("Error restaurando '{rel}': {e}"))?;
    } else if abs.exists() {
        fs::remove_file(&abs).map_err(|e| format!("Error eliminando archivo creado '{rel}': {e}"))?;
    }

    call.undone = true;
    session.updated_at = now_epoch_secs();
    save_session_in(dir, &session)?;
    Ok(session)
}

pub fn read_workspace_memory_files(workspace: &str) -> Vec<WorkspaceMemoryFileInfo> {
    let base = if workspace.trim().is_empty() || workspace == "." {
        std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
    } else {
        PathBuf::from(workspace)
    };
    let loopy_dir = base.join(".loopy");
    let Ok(entries) = fs::read_dir(&loopy_dir) else {
        return Vec::new();
    };
    let mut files = Vec::new();
    for entry in entries.flatten() {
        let p = entry.path();
        if !p.is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        let lower = name.to_lowercase();
        if !(lower.ends_with(".md") || lower.ends_with(".txt")) {
            continue;
        }
        if let Ok(raw) = fs::read_to_string(&p) {
            let size_bytes = raw.len();
            let content = if raw.len() > 40_000 {
                let end = raw.floor_char_boundary(40_000);
                format!("{}\n\n... [truncado a 40KB]", &raw[..end])
            } else {
                raw
            };
            files.push(WorkspaceMemoryFileInfo {
                rel_path: format!(".loopy/{name}"),
                name,
                content,
                size_bytes,
            });
        }
    }
    files.sort_by(|a, b| a.name.cmp(&b.name));
    files
}

pub fn clear_workspace_memory_file(workspace: &str, rel_path: &str) -> Result<(), String> {
    let (abs, _) = capture_file_state(workspace, rel_path)?;
    if abs.exists() {
        fs::write(&abs, "").map_err(|e| format!("Error vaciando '{rel_path}': {e}"))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn readonly_mode_filters_all_mutating_and_exec_tools() {
        let ro = enabled_tools_for_mode(&PermissionMode::ReadOnly);
        assert!(ro.contains(&"read_file".to_string()));
        assert!(ro.contains(&"grep_search".to_string()));
        assert!(!ro.contains(&"edit_file".to_string()));
        assert!(!ro.contains(&"write_file".to_string()));
        assert!(!ro.contains(&"run_cmd".to_string()));
        assert!(!ro.contains(&"browser_action".to_string()));
    }

    #[test]
    fn session_persistence_and_undo_restore_previous_file_state() {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let base_dir = std::env::temp_dir().join(format!("loopy-agent-undo-{stamp}"));
        let sess_dir = base_dir.join("sessions");
        let ws_dir = base_dir.join("repo");
        fs::create_dir_all(&ws_dir).unwrap();
        let target = ws_dir.join("demo.txt");
        fs::write(&target, "estado original\n").unwrap();

        // Simulate modification
        fs::write(&target, "estado roto\n").unwrap();

        let sess = AgentSession {
            id: "s1".to_string(),
            title: "Test".to_string(),
            workspace: ws_dir.to_string_lossy().to_string(),
            model_path: String::new(),
            permission_mode: PermissionMode::Ask,
            use_rag: false,
            compact_at_tokens: 0,
            reasoning_effort: None,
            enabled_skills: Vec::new(),
            pinned_files: Vec::new(),
            allowed_session_tools: Vec::new(),
            pinned: false,
            updated_at: 1,
            messages: vec![AgentChatMessage {
                id: "m1".to_string(),
                role: "assistant".to_string(),
                content: "Hecho".to_string(),
                thinking: String::new(),
                attachments: Vec::new(),
                timestamp: 1,
                tool_calls: vec![AgentToolCallRecord {
                    id: "c1".to_string(),
                    name: "edit_file".to_string(),
                    args_json: "{}".to_string(),
                    status: "success".to_string(),
                    output_preview: String::new(),
                    duration_ms: 5,
                    file_path: Some("demo.txt".to_string()),
                    previous_content: Some("estado original\n".to_string()),
                    file_existed: true,
                    diff_preview: None,
                    added_lines: 1,
                    removed_lines: 1,
                    screenshot_path: None,
                    cursor_x: None,
                    cursor_y: None,
                    undone: false,
                }],
            }],
        };

        save_session_in(&sess_dir, &sess).unwrap();
        let updated = undo_tool_call_in_dir(&sess_dir, "s1", "m1", "c1").unwrap();
        assert!(updated.messages[0].tool_calls[0].undone);
        assert_eq!(fs::read_to_string(&target).unwrap(), "estado original\n");

        let _ = fs::remove_dir_all(&base_dir);
    }

    #[test]
    fn parses_llm_safety_verdict_json() {
        assert_eq!(
            parse_safety_verdict(r#"{"safe": true, "reason": "read-only test run"}"#),
            (true, "read-only test run".to_string())
        );
        assert_eq!(
            parse_safety_verdict(r#"```json
{"safe": false, "reason": "deletes files"}
```"#),
            (false, "deletes files".to_string())
        );
        // Fail-safe on malformed output
        assert!(!parse_safety_verdict("not valid json").0);
    }
}

fn parse_safety_verdict(raw: &str) -> (bool, String) {
    let trimmed = raw.trim();
    let json_slice = if let (Some(start), Some(end)) = (trimmed.find('{'), trimmed.rfind('}')) {
        if end > start {
            &trimmed[start..=end]
        } else {
            trimmed
        }
    } else {
        trimmed
    };
    if let Ok(val) = serde_json::from_str::<Value>(json_slice) {
        let safe = val.get("safe").and_then(|v| v.as_bool()).unwrap_or(false);
        let reason = val
            .get("reason")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        return (safe, reason);
    }
    (false, "No se pudo verificar seguridad automÃ¡ticamente".to_string())
}

async fn llm_check_tool_safety(
    llama: &LlamaCppManager,
    port: Option<u16>,
    model_path: &str,
    workspace: &str,
    tool_name: &str,
    args_json: &str,
    cancel: &Arc<AtomicBool>,
) -> (bool, String) {
    let req = ChatRequest {
        messages: vec![
            ChatMessage {
                role: "system".to_string(),
                content: Some(
                    "You are a strict security reviewer for local developer tool calls.\n\
                     Return ONLY a valid JSON object: {\"safe\": true|false, \"reason\": \"brief reason\"}.\n\
                     Mark safe=true ONLY for routine, reversible, workspace-scoped actions (running tests/builds, editing source files inside the workspace, harmless read/check commands).\n\
                     Mark safe=false for destructive commands (rm -rf, del, format, git push --force, git reset --hard, dropping databases, modifying system files outside workspace, piping curl to sh, deleting important files, or anything risky/irreversible)."
                        .to_string(),
                ),
                tool_calls: None,
                tool_call_id: None,
                image_paths: Vec::new(),
            },
            ChatMessage {
                role: "user".to_string(),
                content: Some(format!(
                    "Workspace: {workspace}\nTool: {tool_name}\nArguments:\n{}",
                    truncate_chars(args_json, 1200)
                )),
                tool_calls: None,
                tool_call_id: None,
                image_paths: Vec::new(),
            },
        ],
        tools: Vec::new(),
        temperature: 0.0,
        top_p: Some(0.9),
        max_tokens: Some(160),
        min_p: None,
        repeat_penalty: None,
        seed: None,
        reasoning_effort: Some("low".to_string()),
    };

    let res = if let Some(p) = port {
        llama.chat_stream(p, req, Some(cancel), |_, _| {}).await
    } else {
        crate::inference::cloud::chat_stream_cloud(model_path, req, Some(cancel), |_, _| {}).await
    };

    match res {
        Ok(resp) => parse_safety_verdict(&resp.content),
        Err(_) => (false, "Error consultando verificaciÃ³n de seguridad IA".to_string()),
    }
}

#[cfg(test)]
mod e2e_new_tools_tests {
    use super::*;

    #[tokio::test]
    async fn e2e_todo_artifacts_question_bg_and_scheduler_tools() {
        let ts = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        let ws = std::env::temp_dir().join(format!("loopy-agent-tools-{ts}"));
        fs::create_dir_all(&ws).unwrap();
        let ws_str = ws.to_string_lossy().to_string();

        let state = Arc::new(AgentChatState::default());
        let llama = LlamaCppManager::new();
        let cancel = Arc::new(AtomicBool::new(false));
        let mut mcp_sessions = Vec::new();
        let mcp_routes = std::collections::HashMap::new();
        let events = Arc::new(Mutex::new(Vec::<AgentChatEvent>::new()));
        let ev_clone = events.clone();
        let emit = move |ev: AgentChatEvent| {
            ev_clone.lock().unwrap().push(ev);
        };

        let make_rec = |name: &str| AgentToolCallRecord {
            id: format!("c-{name}"),
            name: name.to_string(),
            args_json: "{}".into(),
            status: "running".into(),
            output_preview: String::new(),
            duration_ms: 0,
            file_path: None,
            previous_content: None,
            file_existed: false,
            diff_preview: None,
            added_lines: 0,
            removed_lines: 0,
            screenshot_path: None,
            cursor_x: None,
            cursor_y: None,
            undone: false,
        };

        // 1. Live Todo List
        let mut r1 = make_rec("update_todo_list");
        let out1 = dispatch_agent_tool(
            &state,
            "c1",
            "sess-1",
            &ws_str,
            "",
            &llama,
            None,
            "update_todo_list",
            &json!({
                "items": [
                    { "title": "Inspect repo", "status": "done" },
                    { "title": "Build feature", "status": "in_progress" }
                ]
            }),
            &mut r1,
            &None,
            &mut mcp_sessions,
            &mcp_routes,
            &cancel,
            &emit,
        )
        .await;
        assert!(out1.contains("2 items"));

        // 2. Persistent Artifacts (Markdown + HTML)
        let mut r2 = make_rec("write_artifact");
        let out2 = dispatch_agent_tool(
            &state,
            "c2",
            "sess-1",
            &ws_str,
            "",
            &llama,
            None,
            "write_artifact",
            &json!({
                "filename": "report.md",
                "title": "Audit Report",
                "content": "# OK\nAll checks passed."
            }),
            &mut r2,
            &None,
            &mut mcp_sessions,
            &mcp_routes,
            &cancel,
            &emit,
        )
        .await;
        assert!(out2.contains("Audit Report"));
        assert!(ws.join(".loopy/artifacts/report.md").exists());

        let mut r2b = make_rec("write_artifact");
        let _ = dispatch_agent_tool(
            &state,
            "c2b",
            "sess-1",
            &ws_str,
            "",
            &llama,
            None,
            "write_artifact",
            &json!({
                "filename": "widget.html",
                "title": "Widget",
                "content": "<h1>Hello</h1>"
            }),
            &mut r2b,
            &None,
            &mut mcp_sessions,
            &mcp_routes,
            &cancel,
            &emit,
        )
        .await;

        let mut r3 = make_rec("list_artifacts");
        let out3 = dispatch_agent_tool(
            &state,
            "c3",
            "sess-1",
            &ws_str,
            "",
            &llama,
            None,
            "list_artifacts",
            &json!({}),
            &mut r3,
            &None,
            &mut mcp_sessions,
            &mcp_routes,
            &cancel,
            &emit,
        )
        .await;
        assert!(out3.contains("report.md") && out3.contains("widget.html"));

        // 3. Interactive ask_question resolved asynchronously
        let state_bg = state.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(80)).await;
            let _ = state_bg.resolve_question(QuestionDecision {
                answers: vec!["Option B".to_string()],
            });
        });
        let mut r4 = make_rec("ask_question");
        let out4 = dispatch_agent_tool(
            &state,
            "c4",
            "sess-1",
            &ws_str,
            "",
            &llama,
            None,
            "ask_question",
            &json!({
                "question": "Pick database?",
                "options": ["Option A", "Option B"],
                "allow_multiple": false
            }),
            &mut r4,
            &None,
            &mut mcp_sessions,
            &mcp_routes,
            &cancel,
            &emit,
        )
        .await;
        assert!(out4.contains("Option B"), "Expected Option B in: {out4}");

        // Verify emitted UI events
        let evs = events.lock().unwrap();
        assert!(evs.iter().any(|e| matches!(e, AgentChatEvent::TodoUpdated { items, .. } if items.len() == 2)));
        assert!(evs.iter().any(|e| matches!(e, AgentChatEvent::ArtifactUpdated { kind, .. } if kind == "markdown")));
        assert!(evs.iter().any(|e| matches!(e, AgentChatEvent::ArtifactUpdated { kind, .. } if kind == "html")));
        assert!(evs.iter().any(|e| matches!(e, AgentChatEvent::QuestionRequested { question, .. } if question == "Pick database?")));

        let _ = fs::remove_dir_all(&ws);
    }
}
