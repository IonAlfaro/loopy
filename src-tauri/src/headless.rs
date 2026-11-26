use crate::agent_chat::{
    clear_workspace_memory_file, delete_session_in, list_sessions_in, load_session_in,
    read_workspace_memory_files, run_agent_turn, save_session_in, sessions_dir,
    undo_tool_call_in_dir, AgentChatState, AgentSession, PermissionDecision, QuestionDecision,
};
use crate::architect::{
    ensure_and_load_architect_skill, run_architect_chat, ArchitectMessageInput, ArchitectState,
};
use crate::custom_nodes::{
    delete_custom_node, list_custom_nodes, save_custom_node, CustomNodeDef,
};
use crate::engine::{
    capture_git_diff,
    executor::push_live_instruction,
    types::{EngineEvent, RunOutcomeKind},
    EngineManager, HumanDecision, WorkflowGraph,
};
use crate::hardware::{detect_hardware_profile, RuntimeBackendKind};
use crate::inference;
use crate::mcp::{
    load_saved_mcp_servers, probe_mcp_server, save_mcp_servers, McpServerConfig, SavedMcpServer,
};
use crate::models::{download_hf_model, list_hf_gguf_files, search_hf_models};
use crate::runtime::{
    get_runtime_status, install_runtime, save_custom_runtime_path, uninstall_runtime,
};
use crate::skills::discover_skills;
use crate::tools::{
    browser_interact, set_browser_frame_listener, shutdown_browser, BrowserInteractRequest,
};
use crate::triggers::TriggerManager;
use crate::updater;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::broadcast;

pub struct HeadlessState {
    pub engine: EngineManager,
    pub agent: AgentChatState,
    pub architect: ArchitectState,
    pub triggers: TriggerManager,
    pub events_tx: broadcast::Sender<(String, Value)>,
    pub auth_token: Option<String>,
    pub dist_dir: Option<PathBuf>,
}

impl HeadlessState {
    pub fn new(auth_token: Option<String>, dist_dir: Option<PathBuf>) -> Arc<Self> {
        let (events_tx, _) = broadcast::channel(512);
        let state = Arc::new(Self {
            engine: EngineManager::default(),
            agent: AgentChatState::default(),
            architect: ArchitectState::default(),
            triggers: TriggerManager::default(),
            events_tx,
            auth_token,
            dist_dir,
        });

        let tx_browser = state.events_tx.clone();
        set_browser_frame_listener(move |ev| {
            if let Ok(val) = serde_json::to_value(ev) {
                let _ = tx_browser.send(("loors://browser-frame".to_string(), val));
            }
        });

        let tx_load = state.events_tx.clone();
        inference::llama_cpp::set_model_load_listener(move |ev| {
            if let Ok(val) = serde_json::to_value(ev) {
                let _ = tx_load.send(("loors://model-load-progress".to_string(), val));
            }
        });

        state
    }

    pub fn emit_event<T: serde::Serialize>(&self, name: &str, payload: T) {
        if let Ok(val) = serde_json::to_value(payload) {
            let _ = self.events_tx.send((name.to_string(), val));
        }
    }
}

pub fn generate_random_token() -> String {
    use std::collections::hash_map::RandomState;
    use std::hash::{BuildHasher, Hasher};

    let mut out = String::with_capacity(32);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let pid = std::process::id() as u64;
    for i in 0..4u64 {
        let rs = RandomState::new();
        let mut h = rs.build_hasher();
        h.write_u128(nanos.wrapping_add(i as u128 * 0x9E37_79B9_7F4A_7C15));
        h.write_u64(pid.wrapping_mul(i + 1));
        out.push_str(&format!("{:016x}", h.finish()));
    }
    out.truncate(32);
    out
}

pub fn resolve_dist_dir(explicit: Option<PathBuf>) -> Option<PathBuf> {
    if let Some(p) = explicit {
        if p.join("index.html").is_file() {
            return Some(p);
        }
    }
    let mut candidates = Vec::new();
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("dist"));
        candidates.push(cwd.join("..").join("dist"));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("dist"));
            candidates.push(dir.join("..").join("..").join("..").join("dist"));
        }
    }
    candidates.into_iter().find(|p| p.join("index.html").is_file())
}

pub fn list_workflows_json() -> Value {
    json!(crate::list_saved_workflows())
}

pub fn list_models_json() -> Value {
    json!({
        "local": crate::scan_local_models(),
        "cloudProviders": inference::cloud::load_cloud_providers(),
    })
}

pub fn status_json() -> Value {
    json!({
        "version": env!("CARGO_PKG_VERSION"),
        "hardware": detect_hardware_profile(),
        "runtime": get_runtime_status(),
    })
}

#[derive(Debug, Clone)]
pub struct HeadlessRunOptions {
    pub workflow_ref: String,
    pub workspace: Option<String>,
    pub prompt: Option<String>,
    pub model: Option<String>,
    pub backend: RuntimeBackendKind,
    pub timeout_secs: Option<u64>,
    pub max_llm_calls: Option<u32>,
    pub jsonl: bool,
    pub quiet: bool,
}

fn load_workflow_graph(workflow_ref: &str) -> Result<WorkflowGraph, String> {
    let direct = Path::new(workflow_ref);
    let raw = if direct.is_file() {
        fs::read_to_string(direct)
            .map_err(|e| format!("Failed to read workflow '{}': {e}", direct.display()))?
    } else {
        let saved = crate::list_saved_workflows();
        let needle = workflow_ref.trim().to_ascii_lowercase();
        let found = saved
            .into_iter()
            .find(|w| {
                w.name.to_ascii_lowercase() == needle
                    || Path::new(&w.path)
                        .file_name()
                        .and_then(|n| n.to_str())
                        .map(|n| n.to_ascii_lowercase() == needle)
                        .unwrap_or(false)
            })
            .ok_or_else(|| {
                format!(
                    "Workflow '{}' not found as file or in library ({}).",
                    workflow_ref,
                    crate::workflows_dir().display()
                )
            })?;
        fs::read_to_string(&found.path)
            .map_err(|e| format!("Failed to read saved workflow '{}': {e}", found.path))?
    };

    serde_json::from_str::<WorkflowGraph>(&raw)
        .map_err(|e| format!("Invalid .loors.json workflow format: {e}"))
}

/// Runs a single Loors harness headless from CLI and returns a standard process exit code:
/// 0 = Completed, 1 = Failed/Error, 2 = Budget/Timeout exhausted, 130 = Interrupted (Ctrl+C).
pub async fn run_workflow_headless(opts: HeadlessRunOptions) -> i32 {
    let mut graph = match load_workflow_graph(&opts.workflow_ref) {
        Ok(g) => g,
        Err(err) => {
            eprintln!("error: {err}");
            return 1;
        }
    };

    // Apply CLI overrides to graph nodes
    for node in &mut graph.nodes {
        if node.data.kind == "task_input" {
            if let Some(ws) = opts.workspace.as_ref() {
                node.data.config.insert("workspace".to_string(), json!(ws));
            }
            if let Some(p) = opts.prompt.as_ref() {
                node.data.config.insert("prompt".to_string(), json!(p));
            }
            if let Some(secs) = opts.timeout_secs {
                node.data.config.insert("maxRunSeconds".to_string(), json!(secs));
            }
            if let Some(max_calls) = opts.max_llm_calls {
                node.data.config.insert("maxLlmCalls".to_string(), json!(max_calls));
            }
        } else if node.data.kind == "workspace" {
            if let Some(ws) = opts.workspace.as_ref() {
                node.data.config.insert("path".to_string(), json!(ws));
            }
        } else if node.data.kind == "local_model" {
            if let Some(m) = opts.model.as_ref() {
                node.data.config.insert("modelPath".to_string(), json!(m));
            }
        }
    }

    let engine = Arc::new(EngineManager::default());
    let (done_tx, mut done_rx) = tokio::sync::mpsc::unbounded_channel::<(RunOutcomeKind, String)>();
    let last_output = Arc::new(std::sync::Mutex::new(String::new()));
    let last_output_cb = last_output.clone();
    let jsonl = opts.jsonl;
    let quiet = opts.quiet;

    if !jsonl && !quiet {
        eprintln!(
            "[loors-cli] Starting harness '{}' ({} nodes, backend={:?})",
            graph.name,
            graph.nodes.len(),
            opts.backend
        );
    }

    let start_res = engine.start_run(graph, opts.backend, move |ev| {
        if jsonl {
            if let Ok(line) = serde_json::to_string(&ev) {
                println!("{line}");
            }
        }
        match &ev {
            EngineEvent::NodeLog {
                node_title,
                stream,
                text,
                ..
            } => {
                if !jsonl && !quiet {
                    eprintln!("[{node_title}][{stream:?}] {text}");
                }
            }
            EngineEvent::NodeStatus {
                node_id,
                status,
                message,
                ..
            } => {
                if let Some(msg) = message {
                    if !msg.trim().is_empty() {
                        if let Ok(mut guard) = last_output_cb.lock() {
                            *guard = msg.clone();
                        }
                    }
                }
                if !jsonl && !quiet {
                    eprintln!("[node:{node_id}] {status:?}");
                }
            }
            EngineEvent::RunFinished { outcome, summary, .. } => {
                let _ = done_tx.send((outcome.clone(), summary.clone()));
            }
            _ => {}
        }
    });

    if let Err(err) = start_res {
        eprintln!("error: failed to start harness: {err}");
        return 1;
    }

    let interrupted = Arc::new(AtomicBool::new(false));
    let exit_code = tokio::select! {
        res = done_rx.recv() => {
            match res {
                Some((RunOutcomeKind::Completed, summary)) => {
                    let final_text = last_output
                        .lock()
                        .ok()
                        .map(|s| s.clone())
                        .filter(|s| !s.trim().is_empty())
                        .unwrap_or(summary);
                    if !jsonl {
                        println!("{final_text}");
                    }
                    0
                }
                Some((RunOutcomeKind::Exhausted, summary)) => {
                    if !jsonl {
                        eprintln!("[loors-cli] Exhausted: {summary}");
                    }
                    2
                }
                Some((RunOutcomeKind::Cancelled, summary)) => {
                    if !jsonl {
                        eprintln!("[loors-cli] Cancelled: {summary}");
                    }
                    130
                }
                Some((RunOutcomeKind::Failed, summary)) => {
                    if !jsonl {
                        eprintln!("[loors-cli] Failed: {summary}");
                    }
                    1
                }
                None => 1,
            }
        }
        _ = tokio::signal::ctrl_c() => {
            interrupted.store(true, Ordering::SeqCst);
            if !jsonl {
                eprintln!("\n[loors-cli] Caught Ctrl+C — stopping harness and cleaning up...");
            }
            let _ = engine.stop_run();
            130
        }
    };

    engine.llama.shutdown().await;
    shutdown_browser().await;
    exit_code
}

// ---------------------------------------------------------------------------
// Unified RPC Dispatcher (mirrors Tauri commands 1:1 for the Web UI)
// ---------------------------------------------------------------------------

fn get_str(args: &Value, keys: &[&str]) -> String {
    for k in keys {
        if let Some(s) = args.get(*k).and_then(|v| v.as_str()) {
            return s.to_string();
        }
    }
    String::new()
}

fn get_opt_str(args: &Value, keys: &[&str]) -> Option<String> {
    for k in keys {
        if let Some(s) = args.get(*k).and_then(|v| v.as_str()) {
            return Some(s.to_string());
        }
    }
    None
}

fn parse_backend(args: &Value) -> RuntimeBackendKind {
    args.get("backend")
        .and_then(|v| serde_json::from_value::<RuntimeBackendKind>(v.clone()).ok())
        .unwrap_or(RuntimeBackendKind::Auto)
}

pub async fn dispatch_rpc(
    state: Arc<HeadlessState>,
    cmd: &str,
    args: Value,
) -> Result<Value, String> {
    match cmd {
        "ping_engine" => Ok(json!("loors-core ready (headless)")),
        "get_app_version" => Ok(json!(env!("CARGO_PKG_VERSION"))),
        "detect_hardware" => Ok(json!(detect_hardware_profile())),
        "get_runtime_status" => Ok(json!(get_runtime_status())),
        "install_runtime" => {
            let backend = parse_backend(&args);
            let st = state.clone();
            let info = install_runtime(backend, move |p| {
                st.emit_event("loors://runtime-progress", p);
            })
            .await?;
            Ok(json!(info))
        }
        "uninstall_runtime" => {
            let backend = parse_backend(&args);
            uninstall_runtime(backend)?;
            Ok(json!(null))
        }
        "set_custom_runtime_binary" => {
            let path = get_str(&args, &["path"]);
            save_custom_runtime_path(&path)?;
            Ok(json!(null))
        }
        "scan_local_models" => Ok(json!(crate::scan_local_models())),
        "search_hf_models" => {
            let query = get_str(&args, &["query"]);
            let sort = get_opt_str(&args, &["sort"]);
            let repos = search_hf_models(&query, sort.as_deref()).await?;
            Ok(json!(repos))
        }
        "list_hf_gguf_files" => {
            let repo_id = get_str(&args, &["repoId", "repo_id"]);
            let files = list_hf_gguf_files(&repo_id).await?;
            Ok(json!(files))
        }
        "download_hf_model" => {
            let repo_id = get_str(&args, &["repoId", "repo_id"]);
            let filename = get_str(&args, &["filename"]);
            let st = state.clone();
            let path = download_hf_model(&repo_id, &filename, move |p| {
                st.emit_event("loors://model-download", p);
            })
            .await?;
            Ok(json!(path))
        }
        "delete_local_model" => {
            let model_path = get_str(&args, &["modelPath", "model_path"]);
            let p = Path::new(&model_path);
            if !p.exists() || !p.is_file() {
                return Err("Model file not found.".to_string());
            }
            if !model_path.to_ascii_lowercase().ends_with(".gguf") {
                return Err("Only .gguf model files can be deleted.".to_string());
            }
            state.engine.llama.shutdown().await;
            fs::remove_file(p).map_err(|e| format!("Failed to delete model: {e}"))?;
            Ok(json!(null))
        }
        "unload_model" => {
            state.engine.llama.shutdown().await;
            state.emit_event(
                "loors://engine-event",
                EngineEvent::ModelState {
                    loaded: false,
                    model_name: None,
                    context_size: None,
                },
            );
            Ok(json!(null))
        }
        "get_model_profile" => {
            let model_path = get_str(&args, &["modelPath", "model_path"]);
            Ok(json!(inference::load_model_profile(&model_path)))
        }
        "save_model_tuning_profile" => {
            let model_path = get_str(&args, &["modelPath", "model_path"]);
            let profile: inference::ModelTuningProfile = serde_json::from_value(
                args.get("profile").cloned().unwrap_or(Value::Null),
            )
            .map_err(|e| format!("Invalid profile: {e}"))?;
            inference::save_model_profile(&model_path, &profile)?;
            Ok(json!(null))
        }
        "reload_model_with_profile" => {
            let model_path = get_str(&args, &["modelPath", "model_path"]);
            let backend = parse_backend(&args);
            let profile: inference::ModelTuningProfile = serde_json::from_value(
                args.get("profile").cloned().unwrap_or(Value::Null),
            )
            .map_err(|e| format!("Invalid profile: {e}"))?;
            inference::save_model_profile(&model_path, &profile)?;
            let rt = crate::runtime::find_installed_binary(backend)
                .ok_or_else(|| "No llama.cpp runtime installed.".to_string())?;
            let (cfg, _) = inference::resolve_load_config_with_profile(
                rt.binary_path,
                &model_path,
                None,
                None,
            );
            let ctx = cfg.context_size;
            state.engine.llama.shutdown().await;
            state.engine.llama.ensure_loaded(cfg).await?;
            let short = Path::new(&model_path)
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or(&model_path)
                .to_string();
            state.emit_event(
                "loors://engine-event",
                EngineEvent::ModelState {
                    loaded: true,
                    model_name: Some(short),
                    context_size: Some(ctx),
                },
            );
            Ok(json!(null))
        }
        "get_cloud_providers" => Ok(json!(inference::cloud::load_cloud_providers())),
        "save_cloud_providers" => {
            let providers: Vec<inference::cloud::CloudProviderConfig> = serde_json::from_value(
                args.get("providers").cloned().unwrap_or(json!([])),
            )
            .map_err(|e| format!("Invalid providers: {e}"))?;
            inference::cloud::save_cloud_providers(&providers)?;
            Ok(json!(null))
        }
        "fetch_cloud_provider_models" => {
            let provider: inference::cloud::CloudProviderConfig = serde_json::from_value(
                args.get("provider").cloned().unwrap_or(Value::Null),
            )
            .map_err(|e| format!("Invalid provider: {e}"))?;
            let models = inference::cloud::fetch_provider_models(&provider).await?;
            Ok(json!(models))
        }
        "get_mcp_servers" => Ok(json!(load_saved_mcp_servers())),
        "save_mcp_servers" => {
            let servers: Vec<SavedMcpServer> = serde_json::from_value(
                args.get("servers").cloned().unwrap_or(json!([])),
            )
            .map_err(|e| format!("Invalid servers: {e}"))?;
            save_mcp_servers(&servers)?;
            Ok(json!(null))
        }
        "test_mcp_server" => {
            let config: McpServerConfig = serde_json::from_value(
                args.get("config").cloned().unwrap_or(Value::Null),
            )
            .map_err(|e| format!("Invalid MCP config: {e}"))?;
            let workspace = get_str(&args, &["workspace"]);
            let tools = probe_mcp_server(config, workspace).await?;
            Ok(json!(tools))
        }
        "list_saved_workflows" => Ok(json!(crate::list_saved_workflows())),
        "save_workflow_to_library" => {
            let name = get_str(&args, &["name"]);
            let content = get_str(&args, &["content"]);
            let path = crate::save_workflow_to_library(name, content)?;
            Ok(json!(path))
        }
        "load_workflow_from_library" => {
            let path = get_str(&args, &["path"]);
            let content = crate::load_workflow_from_library(path)?;
            Ok(json!(content))
        }
        "delete_workflow_from_library" => {
            let path = get_str(&args, &["path"]);
            crate::delete_workflow_from_library(path)?;
            Ok(json!(null))
        }
        "list_custom_nodes" => {
            let workspace = get_str(&args, &["workspace"]);
            Ok(json!(list_custom_nodes(&workspace)))
        }
        "save_custom_node" => {
            let def: CustomNodeDef =
                serde_json::from_value(args.get("def").cloned().unwrap_or(Value::Null))
                    .map_err(|e| format!("Invalid custom node: {e}"))?;
            Ok(json!(save_custom_node(def)?))
        }
        "delete_custom_node" => {
            let id = get_str(&args, &["id"]);
            delete_custom_node(&id)?;
            Ok(json!(null))
        }
        "list_skills" => {
            let workspace = get_str(&args, &["workspace"]);
            Ok(json!(discover_skills(&workspace)))
        }
        "get_workspace_diff" => {
            let workspace = get_str(&args, &["workspace"]);
            Ok(json!(capture_git_diff(&workspace).await))
        }
        "start_workflow" => {
            if state.agent.is_running() {
                return Err("__GPU_BUSY_AGENT__".to_string());
            }
            let graph: WorkflowGraph =
                serde_json::from_value(args.get("graph").cloned().unwrap_or(Value::Null))
                    .map_err(|e| format!("Invalid workflow graph: {e}"))?;
            let backend = parse_backend(&args);
            let start_node_id = get_opt_str(&args, &["startNodeId", "start_node_id"]);
            let tab_id = get_opt_str(&args, &["tabId", "tab_id"])
                .unwrap_or_else(|| "default".to_string());
            let emit_tid = tab_id.clone();
            let st = state.clone();
            let run_id = state.engine.start_run_in_tab(
                Some(tab_id),
                graph,
                backend,
                start_node_id,
                move |ev| {
                    let mut val = serde_json::to_value(&ev).unwrap_or_else(|_| json!({}));
                    if let Some(obj) = val.as_object_mut() {
                        obj.insert("tabId".to_string(), json!(emit_tid));
                    }
                    st.emit_event("loors://engine-event", val);
                },
            )?;
            Ok(json!(run_id))
        }
        "stop_workflow" => {
            let tab_id = get_opt_str(&args, &["tabId", "tab_id"]);
            let _ = state.engine.stop_run_for(tab_id.as_deref());
            Ok(json!(null))
        }
        "send_agent_instruction" => {
            let text = get_str(&args, &["instruction", "text"]);
            if !text.trim().is_empty() {
                push_live_instruction(text.trim().to_string());
            }
            Ok(json!(null))
        }
        "resolve_human_gate" => {
            let decision: HumanDecision =
                serde_json::from_value(args.get("decision").cloned().unwrap_or(Value::Null))
                    .map_err(|e| format!("Invalid decision: {e}"))?;
            let tab_id = get_opt_str(&args, &["tabId", "tab_id"]);
            state
                .engine
                .resolve_human_gate_for(tab_id.as_deref(), decision)?;
            Ok(json!(null))
        }
        "get_engine_busy_state" => Ok(json!({
            "harnessRunning": state.engine.is_running(),
            "agentRunning": state.agent.is_running(),
        })),
        "list_agent_sessions" => Ok(json!(list_sessions_in(&sessions_dir()))),
        "load_agent_session" => {
            let id = get_str(&args, &["id"]);
            Ok(json!(load_session_in(&sessions_dir(), &id)?))
        }
        "save_agent_session" => {
            let session: AgentSession =
                serde_json::from_value(args.get("session").cloned().unwrap_or(Value::Null))
                    .map_err(|e| format!("Invalid session: {e}"))?;
            save_session_in(&sessions_dir(), &session)?;
            Ok(json!(null))
        }
        "delete_agent_session" => {
            let id = get_str(&args, &["id"]);
            delete_session_in(&sessions_dir(), &id)?;
            Ok(json!(null))
        }
        "run_agent_turn" => {
            if state.engine.is_running() {
                return Err("__GPU_BUSY_HARNESS__".to_string());
            }
            let session: AgentSession =
                serde_json::from_value(args.get("session").cloned().unwrap_or(Value::Null))
                    .map_err(|e| format!("Invalid session: {e}"))?;
            let user_prompt = get_str(&args, &["userPrompt", "user_prompt"]);
            let backend = parse_backend(&args);
            let override_ctx = args
                .get("overrideCtx")
                .or_else(|| args.get("override_ctx"))
                .and_then(|v| v.as_u64())
                .map(|n| n as u32);
            let attachments: Vec<String> = args
                .get("attachments")
                .and_then(|v| serde_json::from_value(v.clone()).ok())
                .unwrap_or_default();

            let is_cloud = inference::cloud::is_cloud_model(&session.model_path);
            let binary_path = if is_cloud {
                let model_short = inference::cloud::parse_cloud_model(&session.model_path)
                    .map(|(p, m)| format!("{p}/{m}"))
                    .unwrap_or_else(|| session.model_path.clone());
                state.emit_event(
                    "loors://engine-event",
                    EngineEvent::ModelState {
                        loaded: true,
                        model_name: Some(model_short),
                        context_size: Some(128_000),
                    },
                );
                String::new()
            } else {
                let rt = crate::runtime::find_installed_binary(backend)
                    .ok_or_else(|| "No llama.cpp runtime installed.".to_string())?;
                rt.binary_path
            };

            let st = state.clone();
            let updated = run_agent_turn(
                &state.engine.llama,
                binary_path,
                &state.agent,
                session,
                user_prompt,
                override_ctx,
                attachments,
                move |ev| {
                    st.emit_event("loors://agent-chat-event", ev);
                },
            )
            .await?;
            Ok(json!(updated))
        }
        "stop_agent_turn" => {
            state.agent.stop_turn();
            Ok(json!(null))
        }
        "resolve_agent_permission" => {
            let decision: PermissionDecision =
                serde_json::from_value(args.get("decision").cloned().unwrap_or(Value::Null))
                    .map_err(|e| format!("Invalid permission decision: {e}"))?;
            state.agent.resolve_permission(decision)?;
            Ok(json!(null))
        }
        "resolve_agent_question" => {
            let decision: QuestionDecision =
                serde_json::from_value(args.get("decision").cloned().unwrap_or(Value::Null))
                    .map_err(|e| format!("Invalid question decision: {e}"))?;
            state.agent.resolve_question(decision)?;
            Ok(json!(null))
        }
        "undo_agent_tool_call" => {
            let session_id = get_str(&args, &["sessionId", "session_id"]);
            let message_id = get_str(&args, &["messageId", "message_id"]);
            let call_id = get_str(&args, &["callId", "call_id"]);
            let updated = undo_tool_call_in_dir(&sessions_dir(), &session_id, &message_id, &call_id)?;
            Ok(json!(updated))
        }
        "read_workspace_memory_files" => {
            let workspace = get_str(&args, &["workspace"]);
            Ok(json!(read_workspace_memory_files(&workspace)))
        }
        "clear_workspace_memory_file" => {
            let workspace = get_str(&args, &["workspace"]);
            let rel_path = get_str(&args, &["relPath", "rel_path"]);
            clear_workspace_memory_file(&workspace, &rel_path)?;
            Ok(json!(null))
        }
        "find_workspace_files" => {
            let workspace = get_str(&args, &["workspace"]);
            let query = get_str(&args, &["query"]);
            Ok(json!(crate::find_workspace_files(workspace, query).await))
        }
        "read_workspace_file_preview" => {
            let workspace = get_str(&args, &["workspace"]);
            let rel_path = get_str(&args, &["relPath", "rel_path"]);
            Ok(json!(
                crate::read_workspace_file_preview(workspace, rel_path).await?
            ))
        }
        "read_screenshot_base64" => {
            let path = get_str(&args, &["path"]);
            Ok(json!(crate::read_screenshot_base64(path)?))
        }
        "browser_interact" => {
            let req: BrowserInteractRequest =
                serde_json::from_value(args.get("request").cloned().unwrap_or(args))
                    .map_err(|e| format!("Invalid browser request: {e}"))?;
            Ok(json!(browser_interact(req).await?))
        }
        "get_architect_skill_info" => {
            let workspace = get_str(&args, &["workspace"]);
            Ok(json!(ensure_and_load_architect_skill(&workspace).1))
        }
        "stop_architect_chat" => {
            state.architect.stop_turn();
            Ok(json!(null))
        }
        "architect_chat" => {
            if state.engine.is_running() {
                return Err("__GPU_BUSY_HARNESS__".to_string());
            }
            if state.agent.is_running() {
                return Err("__GPU_BUSY_AGENT__".to_string());
            }
            let model_path = get_str(&args, &["modelPath", "model_path"]);
            let backend = parse_backend(&args);
            let context_size = args
                .get("contextSize")
                .or_else(|| args.get("context_size"))
                .and_then(|v| v.as_u64())
                .map(|n| n as u32);
            let reasoning_effort = get_opt_str(&args, &["reasoningEffort", "reasoning_effort"]);
            let messages: Vec<ArchitectMessageInput> = serde_json::from_value(
                args.get("messages").cloned().unwrap_or(json!([])),
            )
            .map_err(|e| format!("Invalid messages: {e}"))?;
            let current_graph_json = get_str(&args, &["currentGraphJson", "current_graph_json"]);

            let is_cloud = inference::cloud::is_cloud_model(&model_path);
            let (port, has_mmproj, cloud_opt) = if is_cloud {
                (0u16, true, Some(model_path.as_str()))
            } else {
                let rt = crate::runtime::find_installed_binary(backend)
                    .ok_or_else(|| "No llama.cpp runtime installed.".to_string())?;
                let (cfg, _) = inference::resolve_load_config_with_profile(
                    rt.binary_path,
                    &model_path,
                    context_size,
                    None,
                );
                let has_mm = cfg.mmproj_path.is_some();
                let p = state.engine.llama.ensure_loaded(cfg).await?;
                (p, has_mm, None)
            };

            let cancel = state.architect.start_turn();
            let st = state.clone();
            let reply = run_architect_chat(
                &state.engine.llama,
                cloud_opt,
                port,
                has_mmproj,
                reasoning_effort,
                messages,
                current_graph_json,
                Some(&cancel),
                move |ev| {
                    st.emit_event("loors://architect-event", ev);
                },
            )
            .await;
            state.architect.clear_turn();
            Ok(json!(reply?))
        }
        "get_trigger_status" => Ok(json!(state.triggers.status())),
        "get_update_repo" => Ok(json!(updater::configured_update_repo().unwrap_or_default())),
        "set_update_repo" => {
            let repo = get_str(&args, &["repo"]);
            Ok(json!(updater::save_update_repo(&repo)?))
        }
        "check_app_update" => {
            let repo = get_opt_str(&args, &["repo"]);
            Ok(json!(updater::check_for_updates(repo).await?))
        }
        "pick_folder" | "pick_files" => {
            Err("Native OS file dialogs are only available in Desktop mode; enter the server path directly.".to_string())
        }
        "stage_uploaded_file" => {
            let filename = get_str(&args, &["filename"]);
            let base64_data = get_str(&args, &["base64Data", "base64_data"]);
            use base64::Engine as _;
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(&base64_data)
                .map_err(|e| format!("Invalid base64 upload: {e}"))?;
            let dir = std::env::temp_dir().join("loors-uploads");
            let _ = fs::create_dir_all(&dir);
            let safe_name: String = Path::new(&filename)
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("upload.bin")
                .chars()
                .map(|c| if c.is_alphanumeric() || matches!(c, '.' | '-' | '_') { c } else { '_' })
                .collect();
            let ts = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0);
            let out = dir.join(format!("{ts}-{safe_name}"));
            fs::write(&out, bytes).map_err(|e| format!("Failed writing upload: {e}"))?;
            Ok(json!(out.to_string_lossy().to_string()))
        }
        _ => Err(format!("Unknown RPC command: {cmd}")),
    }
}

// ---------------------------------------------------------------------------
// Embedded Async HTTP/1.1 + SSE Headless Server
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct HeadlessServerConfig {
    pub host: String,
    pub port: u16,
    pub token: Option<String>,
    pub dist_dir: Option<PathBuf>,
}

pub async fn run_headless_server(cfg: HeadlessServerConfig) -> Result<(), String> {
    let bind_addr = format!("{}:{}", cfg.host, cfg.port);
    let listener = TcpListener::bind(&bind_addr)
        .await
        .map_err(|e| format!("Failed to bind {bind_addr}: {e}"))?;

    let state = HeadlessState::new(cfg.token.clone(), cfg.dist_dir.clone());

    let display_host = if cfg.host == "0.0.0.0" {
        "127.0.0.1"
    } else {
        cfg.host.as_str()
    };
    println!("Loors Headless Server v{}", env!("CARGO_PKG_VERSION"));
    println!("  Listening : http://{}:{}", cfg.host, cfg.port);
    if let Some(tok) = &cfg.token {
        println!("  Auth      : Bearer token REQUIRED");
        println!("  Web Panel : http://{}:{}/?token={}", display_host, cfg.port, tok);
    } else {
        println!("  Auth      : Disabled (loopback / --no-auth)");
        println!("  Web Panel : http://{}:{}/", display_host, cfg.port);
    }
    if let Some(dist) = &cfg.dist_dir {
        println!("  UI Bundle : {}", dist.display());
    } else {
        println!("  UI Bundle : Not found (API-only mode; run `npm run build` or pass --dist <dir>)");
    }
    println!("  Press Ctrl+C to stop.");

    let shutdown_state = state.clone();
    loop {
        tokio::select! {
            accept_res = listener.accept() => {
                match accept_res {
                    Ok((stream, _addr)) => {
                        let st = state.clone();
                        tokio::spawn(async move {
                            let _ = handle_http_connection(stream, st).await;
                        });
                    }
                    Err(e) => {
                        eprintln!("[loors-server] accept error: {e}");
                    }
                }
            }
            _ = tokio::signal::ctrl_c() => {
                println!("\n[loors-server] Shutting down cleanly...");
                let _ = shutdown_state.engine.stop_run();
                shutdown_state.agent.stop_turn();
                shutdown_state.engine.llama.shutdown().await;
                shutdown_browser().await;
                break;
            }
        }
    }

    Ok(())
}

struct ParsedRequest {
    method: String,
    path: String,
    query: HashMap<String, String>,
    headers: HashMap<String, String>,
    body: Vec<u8>,
}

async fn read_http_request(stream: &mut TcpStream) -> Option<ParsedRequest> {
    let mut buf = Vec::with_capacity(4096);
    let mut tmp = [0u8; 4096];
    let header_end;

    loop {
        let n = stream.read(&mut tmp).await.ok()?;
        if n == 0 {
            return None;
        }
        buf.extend_from_slice(&tmp[..n]);
        if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            header_end = pos + 4;
            break;
        }
        if buf.len() > 64 * 1024 {
            return None;
        }
    }

    let head_str = String::from_utf8_lossy(&buf[..header_end - 4]);
    let mut lines = head_str.lines();
    let req_line = lines.next()?;
    let mut parts = req_line.split_whitespace();
    let method = parts.next()?.to_string();
    let raw_target = parts.next()?.to_string();

    let mut headers = HashMap::new();
    for line in lines {
        if let Some((k, v)) = line.split_once(':') {
            headers.insert(k.trim().to_ascii_lowercase(), v.trim().to_string());
        }
    }

    let content_length: usize = headers
        .get("content-length")
        .and_then(|v| v.parse().ok())
        .unwrap_or(0)
        .min(32 * 1024 * 1024);

    let mut body = buf[header_end..].to_vec();
    while body.len() < content_length {
        let n = stream.read(&mut tmp).await.ok()?;
        if n == 0 {
            break;
        }
        body.extend_from_slice(&tmp[..n]);
    }
    body.truncate(content_length);

    let (path, query_str) = match raw_target.split_once('?') {
        Some((p, q)) => (p.to_string(), q),
        None => (raw_target, ""),
    };

    let mut query = HashMap::new();
    for pair in query_str.split('&') {
        if let Some((k, v)) = pair.split_once('=') {
            query.insert(k.to_string(), url_decode(v));
        }
    }

    Some(ParsedRequest {
        method,
        path,
        query,
        headers,
        body,
    })
}

fn url_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(hex) = std::str::from_utf8(&bytes[i + 1..i + 3]) {
                if let Ok(val) = u8::from_str_radix(hex, 16) {
                    out.push(val);
                    i += 3;
                    continue;
                }
            }
        } else if bytes[i] == b'+' {
            out.push(b' ');
            i += 1;
            continue;
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

fn is_authorized(req: &ParsedRequest, expected: &Option<String>) -> bool {
    let Some(secret) = expected else {
        return true;
    };
    if let Some(auth) = req.headers.get("authorization") {
        if let Some(tok) = auth.strip_prefix("Bearer ").or_else(|| auth.strip_prefix("bearer ")) {
            if tok.trim() == secret {
                return true;
            }
        }
    }
    if let Some(tok) = req.query.get("token") {
        if tok.trim() == secret {
            return true;
        }
    }
    false
}

async fn write_response(
    stream: &mut TcpStream,
    status: u16,
    reason: &str,
    content_type: &str,
    body: &[u8],
) -> std::io::Result<()> {
    let head = format!(
        "HTTP/1.1 {status} {reason}\r\n\
         Content-Type: {content_type}\r\n\
         Content-Length: {}\r\n\
         Access-Control-Allow-Origin: *\r\n\
         Access-Control-Allow-Headers: Authorization, Content-Type\r\n\
         Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n\
         Connection: close\r\n\r\n",
        body.len()
    );
    stream.write_all(head.as_bytes()).await?;
    stream.write_all(body).await?;
    stream.flush().await
}

async fn write_json(stream: &mut TcpStream, status: u16, reason: &str, val: &Value) -> std::io::Result<()> {
    let bytes = serde_json::to_vec(val).unwrap_or_else(|_| b"{}".to_vec());
    write_response(stream, status, reason, "application/json; charset=utf-8", &bytes).await
}

fn mime_for_path(p: &Path) -> &'static str {
    match p.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase().as_str() {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "application/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        "json" => "application/json; charset=utf-8",
        "woff2" => "font/woff2",
        "woff" => "font/woff",
        _ => "application/octet-stream",
    }
}

async fn handle_http_connection(mut stream: TcpStream, state: Arc<HeadlessState>) -> std::io::Result<()> {
    let Some(req) = read_http_request(&mut stream).await else {
        return Ok(());
    };

    if req.method == "OPTIONS" {
        return write_response(&mut stream, 204, "No Content", "text/plain", b"").await;
    }

    // Public healthcheck
    if req.method == "GET" && req.path == "/api/health" {
        return write_json(
            &mut stream,
            200,
            "OK",
            &json!({
                "ok": true,
                "mode": "headless",
                "version": env!("CARGO_PKG_VERSION"),
                "authRequired": state.auth_token.is_some(),
                "harnessRunning": state.engine.is_running(),
                "agentRunning": state.agent.is_running(),
            }),
        )
        .await;
    }

    // Token verification endpoint for Web Login Gate
    if req.method == "POST" && req.path == "/api/auth/verify" {
        if is_authorized(&req, &state.auth_token) {
            return write_json(&mut stream, 200, "OK", &json!({ "ok": true })).await;
        }
        return write_json(
            &mut stream,
            401,
            "Unauthorized",
            &json!({ "ok": false, "error": "Invalid authentication token" }),
        )
        .await;
    }

    // Protected API routes
    if req.path.starts_with("/api/") {
        if !is_authorized(&req, &state.auth_token) {
            return write_json(
                &mut stream,
                401,
                "Unauthorized",
                &json!({ "ok": false, "error": "Authentication required" }),
            )
            .await;
        }

        // Server-Sent Events stream
        if req.method == "GET" && req.path == "/api/events" {
            let head = "HTTP/1.1 200 OK\r\n\
                        Content-Type: text/event-stream\r\n\
                        Cache-Control: no-cache\r\n\
                        Connection: keep-alive\r\n\
                        Access-Control-Allow-Origin: *\r\n\r\n\
                        : connected\n\n";
            stream.write_all(head.as_bytes()).await?;
            stream.flush().await?;

            let mut rx = state.events_tx.subscribe();
            let mut ping = tokio::time::interval(Duration::from_secs(15));
            loop {
                tokio::select! {
                    ev = rx.recv() => {
                        match ev {
                            Ok((name, payload)) => {
                                let msg = json!({ "event": name, "payload": payload });
                                let frame = format!("data: {}\n\n", msg);
                                if stream.write_all(frame.as_bytes()).await.is_err() {
                                    break;
                                }
                                let _ = stream.flush().await;
                            }
                            Err(broadcast::error::RecvError::Lagged(_)) => continue,
                            Err(broadcast::error::RecvError::Closed) => break,
                        }
                    }
                    _ = ping.tick() => {
                        if stream.write_all(b": ping\n\n").await.is_err() {
                            break;
                        }
                        let _ = stream.flush().await;
                    }
                }
            }
            return Ok(());
        }

        // Unified RPC endpoint: POST /api/rpc/<cmd>
        if req.method == "POST" && req.path.starts_with("/api/rpc/") {
            let cmd = req.path.trim_start_matches("/api/rpc/").trim();
            let args: Value = if req.body.is_empty() {
                json!({})
            } else {
                serde_json::from_slice(&req.body).unwrap_or_else(|_| json!({}))
            };
            match dispatch_rpc(state, cmd, args).await {
                Ok(data) => {
                    return write_json(&mut stream, 200, "OK", &json!({ "ok": true, "data": data })).await;
                }
                Err(err) => {
                    return write_json(
                        &mut stream,
                        400,
                        "Bad Request",
                        &json!({ "ok": false, "error": err }),
                    )
                    .await;
                }
            }
        }

        // Clean REST endpoints for external automation / curl
        if req.method == "GET" && req.path == "/api/workflows" {
            return write_json(&mut stream, 200, "OK", &list_workflows_json()).await;
        }

        if req.method == "POST" && req.path == "/api/runs" {
            let body_val: Value = serde_json::from_slice(&req.body).unwrap_or_else(|_| json!({}));
            match dispatch_rpc(state, "start_workflow", body_val).await {
                Ok(run_id) => {
                    return write_json(&mut stream, 200, "OK", &json!({ "ok": true, "runId": run_id })).await;
                }
                Err(err) => {
                    return write_json(&mut stream, 400, "Bad Request", &json!({ "ok": false, "error": err })).await;
                }
            }
        }

        return write_json(&mut stream, 404, "Not Found", &json!({ "ok": false, "error": "API route not found" })).await;
    }

    // Serve static Web UI bundle (dist/)
    let Some(dist_root) = &state.dist_dir else {
        let msg = b"Loors Headless API is running.\nNo frontend dist/ bundle found. Run `npm run build` or pass `--dist <path>` to enable the Web Panel.\n";
        return write_response(&mut stream, 200, "OK", "text/plain; charset=utf-8", msg).await;
    };

    let rel_raw = req.path.trim_start_matches('/');
    let rel_clean = if rel_raw.is_empty() { "index.html" } else { rel_raw };
    let mut safe_path = dist_root.clone();
    for comp in Path::new(rel_clean).components() {
        if let Component::Normal(seg) = comp {
            safe_path.push(seg);
        }
    }

    let target = if safe_path.is_file() {
        safe_path
    } else {
        dist_root.join("index.html")
    };

    match fs::read(&target) {
        Ok(bytes) => write_response(&mut stream, 200, "OK", mime_for_path(&target), &bytes).await,
        Err(_) => write_response(&mut stream, 404, "Not Found", "text/plain", b"Not Found").await,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn headless_health_and_token_auth_work() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let state = HeadlessState::new(Some("secret-token-123".to_string()), None);

        let srv = tokio::spawn(async move {
            for _ in 0..4 {
                if let Ok((s, _)) = listener.accept().await {
                    let st = state.clone();
                    tokio::spawn(async move {
                        let _ = handle_http_connection(s, st).await;
                    });
                }
            }
        });

        let client = reqwest::Client::new();
        // 1. Public healthcheck works without token
        let health: Value = client
            .get(format!("http://127.0.0.1:{port}/api/health"))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(health["ok"], json!(true));
        assert_eq!(health["authRequired"], json!(true));

        // 2. Protected RPC rejects missing token
        let unauth = client
            .post(format!("http://127.0.0.1:{port}/api/rpc/ping_engine"))
            .send()
            .await
            .unwrap();
        assert_eq!(unauth.status().as_u16(), 401);

        // 3. Protected RPC succeeds with Bearer token
        let authed: Value = client
            .post(format!("http://127.0.0.1:{port}/api/rpc/ping_engine"))
            .bearer_auth("secret-token-123")
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(authed["ok"], json!(true));
        assert_eq!(authed["data"], json!("loors-core ready (headless)"));

        srv.abort();
    }
}
