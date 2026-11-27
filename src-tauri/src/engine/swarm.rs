use crate::engine::executor::{capture_git_diff, parse_inline_tool_calls, EventEmitter};
use crate::engine::types::{EngineEvent, LogStreamKind};
use crate::hardware::RuntimeBackendKind;
use crate::inference::llama_cpp::LlamaCppManager;
use crate::inference::{resolve_load_config_with_profile, ChatMessage, ChatRequest};
use crate::runtime::find_installed_binary;
use crate::tools;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::sync::Semaphore;
use tokio::task::JoinSet;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SwarmWorkerSpec {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub role: String,
    #[serde(default)]
    pub system_prompt: String,
    #[serde(default)]
    pub model_path: String,
    #[serde(default)]
    pub tools: Vec<String>,
    #[serde(default)]
    pub max_steps: usize,
    #[serde(default)]
    pub use_worktree: Option<bool>,
}

#[derive(Debug, Clone)]
pub struct SwarmConfig {
    pub objective: String,
    pub coordinator_prompt: String,
    pub max_rounds: usize,
    pub max_concurrency: usize,
    pub use_worktrees: bool,
    pub workers: Vec<SwarmWorkerSpec>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SwarmBoardEntry {
    pub seq: u64,
    pub from: String,
    pub mentions: Vec<String>,
    pub content: String,
    pub timestamp: String,
}

pub struct SwarmBoard {
    entries: Mutex<Vec<SwarmBoardEntry>>,
    finished_summary: Mutex<Option<String>>,
    board_file: Option<PathBuf>,
}

impl SwarmBoard {
    pub fn new(workspace: &str, run_id: &str) -> Self {
        let safe_run: String = run_id
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
            .collect();
        let dir = Path::new(workspace)
            .join(".loors")
            .join("swarms")
            .join(safe_run);
        let board_file = if fs::create_dir_all(&dir).is_ok() {
            Some(dir.join("board.jsonl"))
        } else {
            None
        };
        Self {
            entries: Mutex::new(Vec::new()),
            finished_summary: Mutex::new(None),
            board_file,
        }
    }

    pub fn post(&self, from: &str, mentions: Vec<String>, content: &str) -> SwarmBoardEntry {
        let mut guard = self.entries.lock().unwrap();
        let seq = (guard.len() as u64) + 1;
        let ts = now_hhmmss();
        let entry = SwarmBoardEntry {
            seq,
            from: from.to_string(),
            mentions,
            content: content.to_string(),
            timestamp: ts,
        };
        guard.push(entry.clone());
        if let Some(ref path) = self.board_file {
            if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(path) {
                if let Ok(line) = serde_json::to_string(&entry) {
                    let _ = writeln!(f, "{line}");
                }
            }
        }
        entry
    }

    pub fn read_since(&self, since_seq: u64) -> Vec<SwarmBoardEntry> {
        let guard = self.entries.lock().unwrap();
        guard
            .iter()
            .filter(|e| e.seq > since_seq)
            .cloned()
            .collect()
    }

    pub fn latest_seq(&self) -> u64 {
        self.entries
            .lock()
            .map(|g| g.last().map(|e| e.seq).unwrap_or(0))
            .unwrap_or(0)
    }

    pub fn set_finished(&self, summary: String) {
        if let Ok(mut g) = self.finished_summary.lock() {
            *g = Some(summary);
        }
    }

    pub fn finished_summary(&self) -> Option<String> {
        self.finished_summary.lock().ok().and_then(|g| g.clone())
    }

    pub fn format_transcript(&self, max_entries: usize) -> String {
        let guard = self.entries.lock().unwrap();
        let start = guard.len().saturating_sub(max_entries);
        guard[start..]
            .iter()
            .map(|e| {
                let to_str = if e.mentions.is_empty() {
                    String::new()
                } else {
                    format!(
                        " -> {}",
                        e.mentions
                            .iter()
                            .map(|m| format!("@{m}"))
                            .collect::<Vec<_>>()
                            .join(" ")
                    )
                };
                format!("[#{} {} | @{}{}] {}", e.seq, e.timestamp, e.from, to_str, e.content)
            })
            .collect::<Vec<_>>()
            .join("\n")
    }
}

fn now_hhmmss() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let h = (secs / 3600) % 24;
    let m = (secs / 60) % 60;
    let s = secs % 60;
    format!("{h:02}:{m:02}:{s:02}")
}

pub fn parse_swarm_config(
    config: &HashMap<String, Value>,
    rendered_objective: String,
    rendered_coord_prompt: String,
) -> SwarmConfig {
    let max_rounds = config
        .get("maxRounds")
        .and_then(|v| v.as_u64())
        .map(|n| n.clamp(1, 30) as usize)
        .unwrap_or(8);
    let max_concurrency = config
        .get("maxConcurrency")
        .and_then(|v| v.as_u64())
        .map(|n| n.clamp(1, 8) as usize)
        .unwrap_or(3);
    let use_worktrees = config
        .get("useWorktrees")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    let mut workers: Vec<SwarmWorkerSpec> = config
        .get("workers")
        .and_then(|v| serde_json::from_value::<Vec<SwarmWorkerSpec>>(v.clone()).ok())
        .unwrap_or_default();

    // Sanitize worker IDs and provide sensible defaults if empty
    if workers.is_empty() {
        workers = vec![
            SwarmWorkerSpec {
                id: "builder".into(),
                name: "Builder".into(),
                role: "Implementation Specialist".into(),
                system_prompt: "Execute assigned implementation tasks accurately and post concrete results to @coordinator.".into(),
                model_path: String::new(),
                tools: vec![
                    "list_files".into(),
                    "grep_search".into(),
                    "read_file".into(),
                    "edit_file".into(),
                    "write_file".into(),
                    "run_cmd".into(),
                ],
                max_steps: 8,
                use_worktree: None,
            },
            SwarmWorkerSpec {
                id: "reviewer".into(),
                name: "Reviewer".into(),
                role: "QA & Verification".into(),
                system_prompt: "Verify changes, run tests or fact-checks, and report pass/fail clearly to @coordinator.".into(),
                model_path: String::new(),
                tools: vec![
                    "read_file".into(),
                    "grep_search".into(),
                    "run_cmd".into(),
                    "git_diff".into(),
                ],
                max_steps: 6,
                use_worktree: None,
            },
        ];
    } else {
        for (idx, w) in workers.iter_mut().enumerate() {
            let clean_id: String = w
                .id
                .trim()
                .to_lowercase()
                .chars()
                .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
                .collect();
            w.id = if clean_id.is_empty() || clean_id == "coordinator" || clean_id == "all" {
                format!("worker-{}", idx + 1)
            } else {
                clean_id
            };
            if w.name.trim().is_empty() {
                w.name = w.id.clone();
            }
            if w.max_steps == 0 {
                w.max_steps = 8;
            }
        }
    }

    SwarmConfig {
        objective: rendered_objective,
        coordinator_prompt: rendered_coord_prompt,
        max_rounds,
        max_concurrency,
        use_worktrees,
        workers,
    }
}

pub fn extract_mentions(
    explicit: Option<Vec<String>>,
    message: &str,
    valid_worker_ids: &[String],
) -> Vec<String> {
    let mut raw = Vec::new();
    if let Some(list) = explicit {
        for item in list {
            let cleaned = item.trim().trim_start_matches('@').to_lowercase();
            if !cleaned.is_empty() {
                raw.push(cleaned);
            }
        }
    }
    // Also parse @mentions inline from the message text
    for token in message.split_whitespace() {
        if let Some(rest) = token.strip_prefix('@') {
            let cleaned: String = rest
                .chars()
                .take_while(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
                .collect::<String>()
                .to_lowercase();
            if !cleaned.is_empty() {
                raw.push(cleaned);
            }
        }
    }

    let valid_set: HashSet<String> = valid_worker_ids.iter().cloned().collect();
    let mut out = Vec::new();
    for m in raw {
        if m == "all" {
            for wid in valid_worker_ids {
                if !out.contains(wid) {
                    out.push(wid.clone());
                }
            }
        } else if (m == "coordinator" || valid_set.contains(&m)) && !out.contains(&m) {
            out.push(m);
        }
    }
    out
}

pub fn swarm_tool_definitions(is_coordinator: bool) -> Vec<Value> {
    let mut defs = vec![
        json!({
            "type": "function",
            "function": {
                "name": "swarm_post",
                "description": "Post a message on the shared Swarm board and wake up any @mentioned agents (or ['all']).",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "message": {
                            "type": "string",
                            "description": "Concise update, assignment, question, or handoff note."
                        },
                        "mentions": {
                            "type": "array",
                            "items": { "type": "string" },
                            "description": "Agent IDs to wake up (e.g. ['backend', 'qa'] or ['all'] or ['coordinator'])."
                        }
                    },
                    "required": ["message"]
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "swarm_read_board",
                "description": "Read recent messages posted on the shared Swarm board.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "since_seq": {
                            "type": "integer",
                            "description": "Optional sequence number to read messages after (default 0)."
                        }
                    }
                }
            }
        }),
        json!({
            "type": "function",
            "function": {
                "name": "swarm_set_status",
                "description": "Update your live status badge in the Swarm UI.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "status": {
                            "type": "string",
                            "enum": ["working", "waiting", "blocked", "done"]
                        },
                        "summary": {
                            "type": "string",
                            "description": "Short 1-line summary of what you are doing or finished."
                        }
                    },
                    "required": ["status", "summary"]
                }
            }
        }),
    ];

    if is_coordinator {
        defs.push(json!({
            "type": "function",
            "function": {
                "name": "swarm_finish",
                "description": "Conclude the Swarm once the objective is met and deliver the final synthesized output to the downstream harness nodes.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "summary": {
                            "type": "string",
                            "description": "Complete synthesized final report/result for downstream nodes ({{swarm_output}})."
                        }
                    },
                    "required": ["summary"]
                }
            }
        }));
    }

    defs
}

pub struct SwarmRunResult {
    pub output: String,
    pub board_transcript: String,
    pub converged: bool,
}

#[derive(Clone)]
pub struct SwarmModelDefaults {
    pub model_path: String,
    pub context_size: Option<u32>,
    pub mmproj_path: Option<String>,
    pub temperature: f32,
    pub top_p: Option<f32>,
    pub max_tokens: Option<u32>,
    pub repeat_penalty: Option<f32>,
}

async fn run_git_cmd(workspace: &str, args: &[&str]) -> Result<String, String> {
    let mut cmd = tokio::process::Command::new("git");
    cmd.args(args).current_dir(workspace);
    #[cfg(target_os = "windows")]
    {
        cmd.creation_flags(0x08000000);
    }
    let out = cmd
        .output()
        .await
        .map_err(|e| format!("git error: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).to_string())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).to_string())
    }
}

#[allow(clippy::too_many_arguments)]
async fn run_single_swarm_agent_turn(
    run_id: &str,
    node_id: &str,
    node_title: &str,
    iteration: u32,
    agent_id: &str,
    agent_name: &str,
    agent_role: &str,
    is_coordinator: bool,
    system_prompt: &str,
    turn_prompt: &str,
    workspace: &str,
    model_path: &str,
    defaults: &SwarmModelDefaults,
    enabled_tools: &[String],
    max_steps: usize,
    valid_worker_ids: &[String],
    board: &Arc<SwarmBoard>,
    backend: &RuntimeBackendKind,
    llama: &LlamaCppManager,
    gpu_semaphore: &Arc<Semaphore>,
    cancel: &Arc<AtomicBool>,
    emit: &EventEmitter,
) -> Result<(String, Vec<String>), String> {
    let emit_status = |status: &str, summary: &str| {
        emit(EngineEvent::SwarmAgentStatus {
            run_id: run_id.to_string(),
            node_id: node_id.to_string(),
            agent_id: agent_id.to_string(),
            agent_name: agent_name.to_string(),
            role: agent_role.to_string(),
            status: status.to_string(),
            summary: summary.to_string(),
        });
    };

    emit_status("working", "Pensando y ejecutando turno...");

    let mut all_tool_defs = tools::tool_definitions(enabled_tools);
    all_tool_defs.extend(swarm_tool_definitions(is_coordinator));

    let mut messages = vec![
        ChatMessage {
            role: "system".into(),
            content: Some(system_prompt.to_string()),
            tool_calls: None,
            tool_call_id: None,
            image_paths: Vec::new(),
        },
        ChatMessage {
            role: "user".into(),
            content: Some(turn_prompt.to_string()),
            tool_calls: None,
            tool_call_id: None,
            image_paths: Vec::new(),
        },
    ];

    let is_cloud = crate::inference::cloud::is_cloud_model(model_path);
    let mut local_port: Option<u16> = None;

    if !is_cloud {
        let Some(rt) = find_installed_binary(backend.clone()) else {
            emit_status("error", "Runtime llama.cpp no instalado");
            return Err("No hay runtime llama.cpp instalado para ejecutar el modelo local.".into());
        };
        if !Path::new(model_path).exists() {
            emit_status("error", "Modelo GGUF no encontrado");
            return Err(format!("Modelo GGUF no encontrado: {model_path}"));
        }
        let (cfg, _prof) = resolve_load_config_with_profile(
            rt.binary_path,
            model_path,
            defaults.context_size,
            defaults.mmproj_path.clone(),
        );
        let _permit = gpu_semaphore
            .acquire()
            .await
            .map_err(|_| "Semaphore closed".to_string())?;
        let port = llama.ensure_loaded(cfg).await?;
        local_port = Some(port);
    }

    let mut final_text = String::new();
    let mut mentioned_targets: Vec<String> = Vec::new();
    let mut posted_this_turn = false;

    for step in 1..=max_steps.max(1) {
        if cancel.load(Ordering::SeqCst) {
            emit_status("waiting", "Detenido");
            return Err("__CANCELLED__".into());
        }

        let req = ChatRequest {
            messages: messages.clone(),
            tools: all_tool_defs.clone(),
            temperature: defaults.temperature,
            top_p: defaults.top_p,
            max_tokens: defaults.max_tokens,
            min_p: Some(0.05),
            repeat_penalty: defaults.repeat_penalty,
            seed: None,
            reasoning_effort: None,
        };

        let resp = if is_cloud {
            crate::inference::cloud::chat_stream_cloud(model_path, req, Some(cancel), |_, _| {})
                .await
        } else {
            let port = local_port.unwrap();
            let _permit = gpu_semaphore
                .acquire()
                .await
                .map_err(|_| "Semaphore closed".to_string())?;
            llama.chat_stream(port, req, Some(cancel), |_, _| {}).await
        };

        let resp = match resp {
            Ok(r) => r,
            Err(e) if e == "__CANCELLED__" => {
                emit_status("waiting", "Detenido");
                return Err("__CANCELLED__".into());
            }
            Err(e) => {
                emit_status("error", &e);
                return Err(e);
            }
        };

        if !resp.content.trim().is_empty() {
            final_text = resp.content.trim().to_string();
        }

        let mut effective_tool_calls = resp.tool_calls.clone();
        if effective_tool_calls.is_empty() && resp.content.contains("<tool_call>") {
            let rescued = parse_inline_tool_calls(&resp.content);
            if !rescued.is_empty() {
                effective_tool_calls = rescued;
            }
        }

        if effective_tool_calls.is_empty() {
            break;
        }

        messages.push(ChatMessage {
            role: "assistant".into(),
            content: if resp.content.is_empty() {
                None
            } else {
                Some(resp.content.clone())
            },
            tool_calls: Some(effective_tool_calls.clone()),
            tool_call_id: None,
            image_paths: Vec::new(),
        });

        for call in &effective_tool_calls {
            if cancel.load(Ordering::SeqCst) {
                return Err("__CANCELLED__".into());
            }
            let args: Value =
                serde_json::from_str(&call.function.arguments).unwrap_or_else(|_| json!({}));
            let tool_name = call.function.name.as_str();

            let result_text = match tool_name {
                "swarm_post" => {
                    let msg = args
                        .get("message")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .trim()
                        .to_string();
                    let explicit_mentions: Option<Vec<String>> = args
                        .get("mentions")
                        .and_then(|v| v.as_array())
                        .map(|arr| {
                            arr.iter()
                                .filter_map(|x| x.as_str().map(|s| s.to_string()))
                                .collect()
                        });
                    let mentions = extract_mentions(explicit_mentions, &msg, valid_worker_ids);
                    for m in &mentions {
                        if !mentioned_targets.contains(m) {
                            mentioned_targets.push(m.clone());
                        }
                    }
                    let entry = board.post(agent_id, mentions.clone(), &msg);
                    posted_this_turn = true;
                    emit(EngineEvent::SwarmBoardMessage {
                        run_id: run_id.to_string(),
                        node_id: node_id.to_string(),
                        seq: entry.seq,
                        from: entry.from.clone(),
                        mentions: entry.mentions.clone(),
                        content: entry.content.clone(),
                        timestamp: entry.timestamp.clone(),
                    });
                    emit(EngineEvent::NodeLog {
                        run_id: run_id.to_string(),
                        node_id: node_id.to_string(),
                        node_title: node_title.to_string(),
                        iteration,
                        stream: LogStreamKind::Agent,
                        text: format!(
                            "[Swarm @{}]{} {}",
                            agent_id,
                            if mentions.is_empty() {
                                String::new()
                            } else {
                                format!(
                                    " -> {}",
                                    mentions
                                        .iter()
                                        .map(|m| format!("@{m}"))
                                        .collect::<Vec<_>>()
                                        .join(" ")
                                )
                            },
                            msg
                        ),
                    });
                    format!("Posted on board as seq #{}.", entry.seq)
                }
                "swarm_read_board" => {
                    let since = args.get("since_seq").and_then(|v| v.as_u64()).unwrap_or(0);
                    let entries = board.read_since(since);
                    if entries.is_empty() {
                        "No new messages on the Swarm board.".to_string()
                    } else {
                        entries
                            .iter()
                            .map(|e| format!("[#{} @{}] {}", e.seq, e.from, e.content))
                            .collect::<Vec<_>>()
                            .join("\n")
                    }
                }
                "swarm_set_status" => {
                    let st = args
                        .get("status")
                        .and_then(|v| v.as_str())
                        .unwrap_or("working");
                    let summary = args
                        .get("summary")
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    emit_status(st, summary);
                    format!("Status updated to {st}.")
                }
                "swarm_finish" if is_coordinator => {
                    let summary = args
                        .get("summary")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .trim()
                        .to_string();
                    let final_summary = if summary.is_empty() {
                        final_text.clone()
                    } else {
                        summary
                    };
                    board.set_finished(final_summary.clone());
                    let entry = board.post(agent_id, Vec::new(), &format!("[DONE] {final_summary}"));
                    posted_this_turn = true;
                    emit(EngineEvent::SwarmBoardMessage {
                        run_id: run_id.to_string(),
                        node_id: node_id.to_string(),
                        seq: entry.seq,
                        from: entry.from.clone(),
                        mentions: Vec::new(),
                        content: entry.content.clone(),
                        timestamp: entry.timestamp.clone(),
                    });
                    emit_status("done", "Enjambre completado");
                    "Swarm marked finished.".to_string()
                }
                _ => {
                    emit_status("working", &format!("Paso {step}: {tool_name}"));
                    let mut res = tools::execute_tool(workspace, tool_name, &args).await;
                    if res.len() > 8000 {
                        let end = res.floor_char_boundary(8000);
                        res = format!("{}\n... [truncado]", &res[..end]);
                    }
                    res
                }
            };

            messages.push(ChatMessage {
                role: "tool".into(),
                content: Some(result_text),
                tool_calls: None,
                tool_call_id: Some(call.id.clone()),
                image_paths: Vec::new(),
            });

            if is_coordinator && board.finished_summary().is_some() {
                break;
            }
        }

        if is_coordinator && board.finished_summary().is_some() {
            break;
        }
    }

    // If the agent finished speaking without calling swarm_post, mirror its final response to the board so peers see it
    if !posted_this_turn && !final_text.is_empty() {
        let inferred_mentions = extract_mentions(None, &final_text, valid_worker_ids);
        for m in &inferred_mentions {
            if !mentioned_targets.contains(m) {
                mentioned_targets.push(m.clone());
            }
        }
        let default_mentions = if !is_coordinator && inferred_mentions.is_empty() {
            vec!["coordinator".to_string()]
        } else {
            inferred_mentions
        };
        let entry = board.post(agent_id, default_mentions.clone(), &final_text);
        emit(EngineEvent::SwarmBoardMessage {
            run_id: run_id.to_string(),
            node_id: node_id.to_string(),
            seq: entry.seq,
            from: entry.from.clone(),
            mentions: entry.mentions.clone(),
            content: entry.content.clone(),
            timestamp: entry.timestamp.clone(),
        });
    }

    if board.finished_summary().is_none() {
        emit_status(
            if is_coordinator { "waiting" } else { "done" },
            if is_coordinator {
                "Esperando entregas de los workers"
            } else {
                "Turno completado"
            },
        );
    }

    Ok((final_text, mentioned_targets))
}

#[allow(clippy::too_many_arguments)]
pub async fn run_swarm_node(
    run_id: &str,
    node_id: &str,
    node_title: &str,
    iteration: u32,
    workspace: &str,
    cfg: SwarmConfig,
    defaults: SwarmModelDefaults,
    extra_context: &str,
    backend: RuntimeBackendKind,
    llama: LlamaCppManager,
    cancel: Arc<AtomicBool>,
    emit: EventEmitter,
) -> Result<SwarmRunResult, String> {
    let board = Arc::new(SwarmBoard::new(workspace, run_id));
    let gpu_semaphore = Arc::new(Semaphore::new(1));
    let git_apply_lock = Arc::new(tokio::sync::Mutex::new(()));
    let valid_worker_ids: Vec<String> = cfg.workers.iter().map(|w| w.id.clone()).collect();

    // Emit initial roster statuses
    emit(EngineEvent::SwarmAgentStatus {
        run_id: run_id.to_string(),
        node_id: node_id.to_string(),
        agent_id: "coordinator".into(),
        agent_name: "Coordinator".into(),
        role: "Swarm Lead".into(),
        status: "waiting".into(),
        summary: "Inicializando enjambre".into(),
    });
    for w in &cfg.workers {
        emit(EngineEvent::SwarmAgentStatus {
            run_id: run_id.to_string(),
            node_id: node_id.to_string(),
            agent_id: w.id.clone(),
            agent_name: w.name.clone(),
            role: w.role.clone(),
            status: "waiting".into(),
            summary: "En espera de asignación".into(),
        });
    }

    let roster_desc = cfg
        .workers
        .iter()
        .map(|w| {
            format!(
                "- @{} ({} — {}): tools=[{}]",
                w.id,
                w.name,
                if w.role.is_empty() { "Worker" } else { &w.role },
                w.tools.join(", ")
            )
        })
        .collect::<Vec<_>>()
        .join("\n");

    let coord_system = format!(
        "{}\n\n## Equipo del Enjambre (usa swarm_post con mentions para asignar)\n{}\n\n## Reglas de Coordinación\n1. En la primera ronda, divide el objetivo y asigna tareas concretas usando `swarm_post` con `mentions` (ej. `mentions: [\"{}\"]` o `[\"all\"]`).\n2. Revisa las respuestas de los workers en la pizarra. Si falta algo o hay errores, vuelve a mencionar al worker correspondiente.\n3. Cuando el objetivo esté cumplido y verificado, llama OBLIGATORIAMENTE a `swarm_finish(summary)` con la síntesis final completa.",
        cfg.coordinator_prompt,
        roster_desc,
        valid_worker_ids.first().map(|s| s.as_str()).unwrap_or("all")
    );

    let mut coord_last_seq: u64 = 0;
    let mut worker_last_seq: HashMap<String, u64> = HashMap::new();

    for round in 1..=cfg.max_rounds {
        if cancel.load(Ordering::SeqCst) {
            return Err("__CANCELLED__".into());
        }

        emit(EngineEvent::NodeLog {
            run_id: run_id.to_string(),
            node_id: node_id.to_string(),
            node_title: node_title.to_string(),
            iteration,
            stream: LogStreamKind::System,
            text: format!("Swarm ronda {round}/{} — turno del Coordinador...", cfg.max_rounds),
        });

        let delta = board.read_since(coord_last_seq);
        let coord_turn_prompt = if round == 1 {
            let extra = if extra_context.trim().is_empty() {
                String::new()
            } else {
                format!("\n\n## Contexto adicional del arnés\n{extra_context}")
            };
            format!(
                "## Objetivo del Enjambre\n{}{}\n\nInicia la coordinación ahora: asigna las tareas iniciales a tus workers con `swarm_post`.",
                cfg.objective, extra
            )
        } else {
            let delta_text = if delta.is_empty() {
                "(Sin mensajes nuevos desde tu último turno)".to_string()
            } else {
                delta
                    .iter()
                    .map(|e| format!("[#{} @{}] {}", e.seq, e.from, e.content))
                    .collect::<Vec<_>>()
                    .join("\n")
            };
            format!(
                "Ronda {round}/{}. Nuevos mensajes en la pizarra:\n{delta_text}\n\nEvalúa el progreso: si ya está completo, llama a `swarm_finish(summary)`; si no, coordina los siguientes pasos con `swarm_post`.",
                cfg.max_rounds
            )
        };

        let (_, coord_mentions) = run_single_swarm_agent_turn(
            run_id,
            node_id,
            node_title,
            iteration,
            "coordinator",
            "Coordinator",
            "Swarm Lead",
            true,
            &coord_system,
            &coord_turn_prompt,
            workspace,
            &defaults.model_path,
            &defaults,
            &["list_files".into(), "read_file".into(), "git_diff".into()],
            4,
            &valid_worker_ids,
            &board,
            &backend,
            &llama,
            &gpu_semaphore,
            &cancel,
            &emit,
        )
        .await?;

        coord_last_seq = board.latest_seq();

        if let Some(summary) = board.finished_summary() {
            return Ok(SwarmRunResult {
                output: summary,
                board_transcript: board.format_transcript(40),
                converged: true,
            });
        }

        // Determine which workers to wake up this round
        let target_ids: Vec<String> = {
            let mentioned_workers: Vec<String> = coord_mentions
                .into_iter()
                .filter(|id| valid_worker_ids.contains(id))
                .collect();
            if mentioned_workers.is_empty() {
                valid_worker_ids.clone()
            } else {
                mentioned_workers
            }
        };

        let concurrency_sem = Arc::new(Semaphore::new(cfg.max_concurrency.max(1)));
        let mut join_set = JoinSet::new();

        for wid in target_ids {
            let Some(worker) = cfg.workers.iter().find(|w| w.id == wid).cloned() else {
                continue;
            };
            let prev_seq = *worker_last_seq.get(&wid).unwrap_or(&0);
            let new_msgs = board.read_since(prev_seq);
            let board_snapshot = new_msgs
                .iter()
                .map(|e| format!("[#{} @{}] {}", e.seq, e.from, e.content))
                .collect::<Vec<_>>()
                .join("\n");
            worker_last_seq.insert(wid.clone(), board.latest_seq());

            let run_id_c = run_id.to_string();
            let node_id_c = node_id.to_string();
            let node_title_c = node_title.to_string();
            let ws_orig = workspace.to_string();
            let objective_c = cfg.objective.clone();
            let defaults_c = defaults.clone();
            let valid_ids_c = valid_worker_ids.clone();
            let board_c = board.clone();
            let backend_c = backend.clone();
            let llama_c = llama.clone();
            let gpu_sem_c = gpu_semaphore.clone();
            let git_lock_c = git_apply_lock.clone();
            let conc_sem_c = concurrency_sem.clone();
            let cancel_c = cancel.clone();
            let emit_c = emit.clone();
            let use_wt = worker.use_worktree.unwrap_or(cfg.use_worktrees);

            join_set.spawn(async move {
                let _conc_permit = conc_sem_c
                    .acquire()
                    .await
                    .map_err(|_| "Concurrency semaphore closed".to_string())?;

                // Optional isolated git worktree per worker
                let mut wt_dir: Option<PathBuf> = None;
                let effective_ws = if use_wt {
                    let ts = SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_millis();
                    let wt = std::env::temp_dir().join(format!("loors-swarm-{}-{ts}", worker.id));
                    let wt_str = wt.to_string_lossy().to_string();
                    if run_git_cmd(&ws_orig, &["worktree", "add", "--detach", &wt_str, "HEAD"])
                        .await
                        .is_ok()
                        && wt.exists()
                    {
                        wt_dir = Some(wt);
                        wt_str
                    } else {
                        ws_orig.clone()
                    }
                } else {
                    ws_orig.clone()
                };

                let worker_model = if worker.model_path.trim().is_empty() {
                    defaults_c.model_path.clone()
                } else {
                    worker.model_path.clone()
                };

                let worker_sys = format!(
                    "Eres @{} ({}, rol: {}) en un enjambre coordinado de Loors.\n{}\n\nUsa `swarm_post(message, mentions)` para reportar resultados concretos a `@coordinator` (o a otro compañero si necesitas algo). Sé directo, basado en evidencia y conciso.",
                    worker.id, worker.name, worker.role, worker.system_prompt
                );
                let worker_prompt = format!(
                    "## Objetivo general\n{objective_c}\n\n## Mensajes recientes en la pizarra\n{board_snapshot}\n\nEjecuta tu parte ahora y reporta en la pizarra con `swarm_post`."
                );

                let res = run_single_swarm_agent_turn(
                    &run_id_c,
                    &node_id_c,
                    &node_title_c,
                    iteration,
                    &worker.id,
                    &worker.name,
                    &worker.role,
                    false,
                    &worker_sys,
                    &worker_prompt,
                    &effective_ws,
                    &worker_model,
                    &defaults_c,
                    &worker.tools,
                    worker.max_steps,
                    &valid_ids_c,
                    &board_c,
                    &backend_c,
                    &llama_c,
                    &gpu_sem_c,
                    &cancel_c,
                    &emit_c,
                )
                .await;

                // If worker ran in an isolated worktree, capture its diff and clean up
                let worker_diff = if let Some(ref wt) = wt_dir {
                    let diff = capture_git_diff(&effective_ws).await;
                    let wt_str = wt.to_string_lossy().to_string();
                    let _ = run_git_cmd(&ws_orig, &["worktree", "remove", "--force", &wt_str]).await;
                    let _ = fs::remove_dir_all(wt);
                    diff
                } else {
                    String::new()
                };

                if !worker_diff.trim().is_empty() {
                    let _git_guard = git_lock_c.lock().await;
                    let patch_path = Path::new(&ws_orig)
                        .join(".loors")
                        .join("swarms")
                        .join(format!("patch-{}.diff", worker.id));
                    let _ = fs::write(&patch_path, &worker_diff);
                    let apply_res = run_git_cmd(
                        &ws_orig,
                        &["apply", "--3way", &patch_path.to_string_lossy()],
                    )
                    .await;
                    let note = match apply_res {
                        Ok(_) => format!(
                            "[Worktree] Cambios de @{} aplicados limpiamente al workspace ({} bytes de diff).",
                            worker.id,
                            worker_diff.len()
                        ),
                        Err(err) => format!(
                            "[Worktree] Conflicto al aplicar diff de @{}: {}. Patch guardado en {}.",
                            worker.id,
                            err.trim(),
                            patch_path.display()
                        ),
                    };
                    let entry = board_c.post(&worker.id, vec!["coordinator".into()], &note);
                    emit_c(EngineEvent::SwarmBoardMessage {
                        run_id: run_id_c.clone(),
                        node_id: node_id_c.clone(),
                        seq: entry.seq,
                        from: entry.from,
                        mentions: entry.mentions,
                        content: entry.content,
                        timestamp: entry.timestamp,
                    });
                }

                res.map(|_| worker.id)
            });
        }

        while let Some(joined) = join_set.join_next().await {
            match joined {
                Ok(Ok(_wid)) => {}
                Ok(Err(e)) if e == "__CANCELLED__" => return Err("__CANCELLED__".into()),
                Ok(Err(e)) => {
                    emit(EngineEvent::NodeLog {
                        run_id: run_id.to_string(),
                        node_id: node_id.to_string(),
                        node_title: node_title.to_string(),
                        iteration,
                        stream: LogStreamKind::Stderr,
                        text: format!("Error en worker del enjambre: {e}"),
                    });
                }
                Err(e) => {
                    emit(EngineEvent::NodeLog {
                        run_id: run_id.to_string(),
                        node_id: node_id.to_string(),
                        node_title: node_title.to_string(),
                        iteration,
                        stream: LogStreamKind::Stderr,
                        text: format!("Fallo de tarea worker: {e}"),
                    });
                }
            }
        }
    }

    // Reached maxRounds without explicit swarm_finish: synthesize transcript cleanly
    let transcript = board.format_transcript(40);
    Ok(SwarmRunResult {
        output: format!(
            "Enjambre alcanzó el límite de {} rondas. Última actividad:\n\n{}",
            cfg.max_rounds, transcript
        ),
        board_transcript: transcript,
        converged: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn board_persists_jsonl_and_tracks_deltas() {
        let tmp = std::env::temp_dir().join(format!(
            "loors-swarm-test-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        fs::create_dir_all(&tmp).unwrap();
        let board = SwarmBoard::new(&tmp.to_string_lossy(), "run-1");
        let e1 = board.post("coordinator", vec!["backend".into()], "Implementa API");
        let e2 = board.post("backend", vec!["qa".into()], "API lista");
        assert_eq!(e1.seq, 1);
        assert_eq!(e2.seq, 2);
        assert_eq!(board.read_since(0).len(), 2);
        assert_eq!(board.read_since(1).len(), 1);
        assert_eq!(board.read_since(1)[0].from, "backend");
        assert!(board.format_transcript(10).contains("@backend"));
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn extract_mentions_normalizes_and_expands_all() {
        let workers = vec!["backend".to_string(), "frontend".to_string(), "qa".to_string()];
        let m1 = extract_mentions(Some(vec!["@Backend".into()]), "avisa a @qa cuando acabes", &workers);
        assert_eq!(m1, vec!["backend".to_string(), "qa".to_string()]);

        let m2 = extract_mentions(Some(vec!["all".into()]), "arrancad", &workers);
        assert_eq!(m2, workers);

        let m3 = extract_mentions(None, "reportando a @coordinator y @ghost", &workers);
        assert_eq!(m3, vec!["coordinator".to_string()]);
    }

    #[test]
    fn swarm_config_parses_defaults_and_workers() {
        let cfg = parse_swarm_config(&HashMap::new(), "Objetivo".into(), "Coordina".into());
        assert_eq!(cfg.max_rounds, 8);
        assert_eq!(cfg.workers.len(), 2);
        assert!(!cfg.use_worktrees);

        let mut raw = HashMap::new();
        raw.insert("maxRounds".into(), json!(5));
        raw.insert("useWorktrees".into(), json!(true));
        raw.insert(
            "workers".into(),
            json!([
                { "id": "Backend Dev!", "name": "Backend", "role": "API", "tools": ["read_file"] }
            ]),
        );
        let cfg2 = parse_swarm_config(&raw, "Obj".into(), "Coord".into());
        assert_eq!(cfg2.max_rounds, 5);
        assert!(cfg2.use_worktrees);
        assert_eq!(cfg2.workers.len(), 1);
        assert_eq!(cfg2.workers[0].id, "backend-dev-");
    }

    #[test]
    fn swarm_tool_definitions_restricts_finish_to_coordinator() {
        let coord_tools = swarm_tool_definitions(true);
        let worker_tools = swarm_tool_definitions(false);
        assert!(coord_tools
            .iter()
            .any(|t| t["function"]["name"] == "swarm_finish"));
        assert!(!worker_tools
            .iter()
            .any(|t| t["function"]["name"] == "swarm_finish"));
    }

    #[test]
    fn execution_context_renders_swarm_variables() {
        let mut ctx = crate::engine::types::ExecutionContext::default();
        ctx.last_swarm_output = "Feature shipped and verified".into();
        ctx.last_swarm_board = "[#1 @coordinator -> @backend] Build API".into();
        let rendered = ctx.render_template("OUT={{swarm_output}} | BOARD={{swarm_board}}");
        assert!(rendered.contains("Feature shipped and verified"));
        assert!(rendered.contains("[#1 @coordinator -> @backend] Build API"));
    }
}
