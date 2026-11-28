use crate::engine::executor::{parse_inline_tool_calls, EventEmitter};
use crate::engine::types::{EngineEvent, LogStreamKind};
use crate::hardware::{detect_hardware_profile, HardwareProfile, RuntimeBackendKind};
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
    pub task: String,
    #[serde(default)]
    pub model_path: String,
    #[serde(default = "default_worker_tools")]
    pub tools: Vec<String>,
    #[serde(default)]
    pub max_steps: usize,
    #[serde(default)]
    pub use_worktree: Option<bool>,
}

#[derive(Debug, Clone)]
pub struct SwarmConfig {
    pub planning_mode: String,
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

pub fn compute_hardware_concurrency(
    hw: &HardwareProfile,
    model_path: &str,
    use_worktrees: bool,
) -> (usize, String) {
    let is_cloud = crate::inference::cloud::is_cloud_model(model_path);
    let cores = hw.cpu_cores.max(2);
    let total_ram_mb = hw.total_ram_mb.max(4096);
    let max_vram_mb = hw.gpus.iter().filter_map(|g| g.vram_mb).max().unwrap_or(0);

    if is_cloud {
        let cap = if use_worktrees { 6 } else { 12 };
        let slots = (cores / 2).clamp(4, cap);
        let note = format!(
            "Cloud API · {} CPU cores · {} GB RAM => pool paralelo automático de {} slots{}",
            cores,
            total_ram_mb / 1024,
            slots,
            if use_worktrees { " (worktrees)" } else { "" }
        );
        return (slots, note);
    }

    let model_mb = if !model_path.trim().is_empty() {
        fs::metadata(model_path)
            .map(|m| m.len() / (1024 * 1024))
            .unwrap_or(0)
    } else {
        0
    };
    let free_ram_mb = total_ram_mb.saturating_sub(model_mb + 4096);
    let ram_slots = ((free_ram_mb / 1536) as usize).max(1);
    let cpu_slots = (cores / 4).max(2);
    let cap = if use_worktrees { 3 } else { 4 };
    let slots = cpu_slots.min(ram_slots).clamp(1, cap);
    let vram_note = if max_vram_mb > 0 {
        format!(" · {} GB VRAM", max_vram_mb / 1024)
    } else {
        String::new()
    };
    let note = format!(
        "Local GGUF ({} MB) · {} CPU cores · {} GB RAM{} => GPU serializada + {} slots paralelos de I/O{}",
        model_mb,
        cores,
        total_ram_mb / 1024,
        vram_note,
        slots,
        if use_worktrees { " (worktrees)" } else { "" }
    );
    (slots, note)
}

fn default_worker_tools() -> Vec<String> {
    vec!["list_files".into(), "grep_search".into(), "read_file".into()]
}

fn sanitize_worker_spec(mut w: SwarmWorkerSpec, fallback_idx: usize) -> SwarmWorkerSpec {
    let clean_id: String = w
        .id
        .trim()
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
        .collect();
    w.id = if clean_id.is_empty() || clean_id == "coordinator" || clean_id == "all" {
        format!("worker-{}", fallback_idx + 1)
    } else {
        clean_id
    };
    if w.name.trim().is_empty() {
        w.name = w.id.clone();
    }
    if w.max_steps == 0 {
        w.max_steps = 8;
    }
    w
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
        .map(|n| n.min(24) as usize)
        .unwrap_or(0);
    let use_worktrees = config
        .get("useWorktrees")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    let mut workers: Vec<SwarmWorkerSpec> = config
        .get("workers")
        .and_then(|v| serde_json::from_value::<Vec<SwarmWorkerSpec>>(v.clone()).ok())
        .unwrap_or_default();

    let raw_mode = config
        .get("planningMode")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_lowercase())
        .unwrap_or_else(|| {
            if workers.is_empty() {
                "auto".to_string()
            } else {
                "manual".to_string()
            }
        });
    let planning_mode = if raw_mode == "manual" {
        "manual".to_string()
    } else {
        "auto".to_string()
    };

    if planning_mode == "manual" && workers.is_empty() {
        workers = vec![
            SwarmWorkerSpec {
                id: "builder".into(),
                name: "Builder".into(),
                role: "Implementation Specialist".into(),
                system_prompt: "Execute assigned implementation tasks accurately and post concrete results to @coordinator.".into(),
                task: String::new(),
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
                task: String::new(),
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
        workers = workers
            .into_iter()
            .enumerate()
            .map(|(idx, w)| sanitize_worker_spec(w, idx))
            .collect();
    }

    SwarmConfig {
        planning_mode,
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

pub fn swarm_tool_definitions(is_coordinator: bool, allow_spawn: bool) -> Vec<Value> {
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
        if allow_spawn {
            defs.push(json!({
                "type": "function",
                "function": {
                    "name": "swarm_spawn_worker",
                    "description": "Dynamically create and add a specialist worker to the Swarm roster.",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "id": { "type": "string", "description": "Short lowercase ID without spaces (e.g. 'auth-dev', 'task-1')." },
                            "role": { "type": "string", "description": "Short role title." },
                            "system_prompt": { "type": "string", "description": "Specialist instructions for this worker." },
                            "task": { "type": "string", "description": "Concrete task slice assigned to this worker." },
                            "tools": { "type": "array", "items": { "type": "string" }, "description": "Optional tool list (e.g. ['list_files','read_file','edit_file','run_cmd'] or ['web_search','fetch_url'])." },
                            "max_steps": { "type": "integer", "description": "Optional max tool steps (default 8)." }
                        },
                        "required": ["id", "role", "task"]
                    }
                }
            }));
            defs.push(json!({
                "type": "function",
                "function": {
                    "name": "swarm_spawn_batch",
                    "description": "Spawn multiple workers/subtasks in one single call (up to 200). They are automatically queued and executed through the hardware-aware worker pool.",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "workers": {
                                "type": "array",
                                "items": {
                                    "type": "object",
                                    "properties": {
                                        "id": { "type": "string" },
                                        "role": { "type": "string" },
                                        "system_prompt": { "type": "string" },
                                        "task": { "type": "string" },
                                        "tools": { "type": "array", "items": { "type": "string" } },
                                        "max_steps": { "type": "integer" }
                                    },
                                    "required": ["id", "task"]
                                }
                            }
                        },
                        "required": ["workers"]
                    }
                }
            }));
        }
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

async fn run_git_cmd(workspace: &str, args: &[&str]) -> Result<Vec<u8>, String> {
    run_git_with_index(workspace, args, None).await
}

async fn run_git_with_index(
    workspace: &str,
    args: &[&str],
    index: Option<&Path>,
) -> Result<Vec<u8>, String> {
    let mut cmd = tokio::process::Command::new("git");
    cmd.args(args).current_dir(workspace).kill_on_drop(true);
    if let Some(index) = index {
        cmd.env("GIT_INDEX_FILE", index);
    }
    #[cfg(target_os = "windows")]
    {
        cmd.creation_flags(0x08000000);
    }
    let out = cmd
        .output()
        .await
        .map_err(|e| format!("git error: {e}"))?;
    if out.status.success() {
        Ok(out.stdout)
    } else {
        Err(String::from_utf8_lossy(&out.stderr).to_string())
    }
}

async fn create_worker_checkout(workspace: &str) -> Result<(PathBuf, String), String> {
    let base = run_git_cmd(workspace, &["rev-parse", "HEAD"]).await?;
    let base = String::from_utf8_lossy(&base).trim().to_owned();
    let dir = tempfile::Builder::new()
        .prefix("loors-swarm-")
        .tempdir()
        .map_err(|err| err.to_string())?;
    let index = dir.path().join("snapshot.index");
    run_git_with_index(workspace, &["read-tree", &base], Some(&index)).await?;
    run_git_with_index(workspace, &["add", "-A", "--", ".", ":(exclude).loors/swarms"], Some(&index)).await?;
    let snapshot = run_git_with_index(workspace, &["write-tree"], Some(&index)).await?;
    let snapshot = String::from_utf8_lossy(&snapshot).trim().to_owned();
    let checkout = dir.keep().join("checkout");
    let checkout_path = checkout.to_string_lossy();
    let result = async {
        run_git_cmd(workspace, &["worktree", "add", "--detach", &checkout_path, &base]).await?;
        run_git_cmd(&checkout_path, &["read-tree", "--reset", "-u", &snapshot]).await?;
        Ok::<_, String>(())
    }.await;
    result
        .map_err(|err| format!("Cannot create isolated worktree at {}: {err}", checkout.display()))?;
    Ok((checkout, snapshot))
}

async fn integrate_worker_checkout(workspace: &str, checkout: &Path, base: &str) -> Result<(), String> {
    let checkout_path = checkout.to_string_lossy();
    let result = async {
        run_git_cmd(&checkout_path, &["add", "-A", "--", "."]).await?;
        let patch = run_git_cmd(
            &checkout_path,
            &["diff", "--cached", "--binary", "--no-ext-diff", "--no-color", base, "--"],
        ).await?;
        let artifact_dir = checkout.parent().expect("worker checkout has an artifact directory");
        let patch_path = artifact_dir.join("delivery.diff");
        if !patch.is_empty() {
            fs::write(&patch_path, patch).map_err(|err| err.to_string())?;
            run_git_cmd(workspace, &["apply", "--", &patch_path.to_string_lossy()]).await?;
        }
        run_git_cmd(workspace, &["worktree", "remove", "--force", &checkout_path]).await
            .map_err(|err| format!("Delivery applied but checkout cleanup failed: {err}"))?;
        let _ = fs::remove_file(patch_path);
        let _ = fs::remove_file(artifact_dir.join("snapshot.index"));
        let _ = fs::remove_dir(artifact_dir);
        Ok::<_, String>(())
    }.await;
    result.map_err(|err| format!("{err}. Worktree preserved at {}", checkout.display()))
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
    allow_spawn: bool,
    can_finish: bool,
    system_prompt: &str,
    turn_prompt: &str,
    workspace: &str,
    model_path: &str,
    defaults: &SwarmModelDefaults,
    enabled_tools: &[String],
    max_steps: usize,
    roster: &Arc<Mutex<Vec<SwarmWorkerSpec>>>,
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
    all_tool_defs.extend(swarm_tool_definitions(is_coordinator, allow_spawn));

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
        let port = llama.ensure_loaded_cancellable(cfg, Some(cancel)).await?;
        local_port = Some(port);
    }

    let mut final_text = String::new();
    let mut mentioned_targets: Vec<String> = Vec::new();
    let mut posted_this_turn = false;
    let current_worker_ids = || -> Vec<String> {
        roster
            .lock()
            .map(|g| g.iter().map(|w| w.id.clone()).collect())
            .unwrap_or_default()
    };

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
                    let valid_ids_now = current_worker_ids();
                    let mentions = extract_mentions(explicit_mentions, &msg, &valid_ids_now);
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
                "swarm_spawn_worker" if is_coordinator && allow_spawn => {
                    let raw_id = args.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
                    let raw_role = args.get("role").and_then(|v| v.as_str()).unwrap_or("Specialist").to_string();
                    let raw_prompt = args.get("system_prompt").and_then(|v| v.as_str()).unwrap_or("").to_string();
                    let raw_task = args.get("task").and_then(|v| v.as_str()).unwrap_or("").to_string();
                    let raw_tools: Vec<String> = args
                        .get("tools")
                        .and_then(|v| v.as_array())
                        .map(|a| a.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect())
                        .unwrap_or_else(default_worker_tools);
                    let raw_steps = args.get("max_steps").and_then(|v| v.as_u64()).unwrap_or(8) as usize;

                    let mut guard = roster.lock().unwrap();
                    let idx = guard.len();
                    let spec = sanitize_worker_spec(
                        SwarmWorkerSpec {
                            id: raw_id,
                            name: raw_role.clone(),
                            role: raw_role,
                            system_prompt: if raw_prompt.trim().is_empty() {
                                "Execute your assigned task accurately and report back to @coordinator.".into()
                            } else {
                                raw_prompt
                            },
                            task: raw_task.clone(),
                            model_path: String::new(),
                            tools: raw_tools,
                            max_steps: raw_steps,
                            use_worktree: None,
                        },
                        idx,
                    );
                    let wid = spec.id.clone();
                    if let Some(existing) = guard.iter_mut().find(|w| w.id == wid) {
                        *existing = spec.clone();
                    } else if guard.len() < 200 {
                        guard.push(spec.clone());
                    }
                    drop(guard);

                    if !mentioned_targets.contains(&wid) {
                        mentioned_targets.push(wid.clone());
                    }
                    emit(EngineEvent::SwarmAgentStatus {
                        run_id: run_id.to_string(),
                        node_id: node_id.to_string(),
                        agent_id: wid.clone(),
                        agent_name: spec.name.clone(),
                        role: spec.role.clone(),
                        status: "queued".into(),
                        summary: if raw_task.is_empty() {
                            "Asignado por el Coordinador".into()
                        } else {
                            raw_task.chars().take(80).collect()
                        },
                    });
                    format!("Spawned worker @{wid} (role='{}').", spec.role)
                }
                "swarm_spawn_batch" if is_coordinator && allow_spawn => {
                    let arr = args
                        .get("workers")
                        .and_then(|v| v.as_array())
                        .cloned()
                        .unwrap_or_default();
                    let mut spawned_ids = Vec::new();
                    let mut guard = roster.lock().unwrap();
                    for item in arr.into_iter().take(200) {
                        let raw_id = item.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
                        let raw_role = item.get("role").and_then(|v| v.as_str()).unwrap_or("Worker").to_string();
                        let raw_prompt = item.get("system_prompt").and_then(|v| v.as_str()).unwrap_or("").to_string();
                        let raw_task = item.get("task").and_then(|v| v.as_str()).unwrap_or("").to_string();
                        let raw_tools: Vec<String> = item
                            .get("tools")
                            .and_then(|v| v.as_array())
                            .map(|a| a.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect())
                            .unwrap_or_else(default_worker_tools);
                        let raw_steps = item.get("max_steps").and_then(|v| v.as_u64()).unwrap_or(8) as usize;
                        let idx = guard.len();
                        let spec = sanitize_worker_spec(
                            SwarmWorkerSpec {
                                id: raw_id,
                                name: raw_role.clone(),
                                role: raw_role,
                                system_prompt: if raw_prompt.trim().is_empty() {
                                    "Execute your assigned task accurately and report back to @coordinator.".into()
                                } else {
                                    raw_prompt
                                },
                                task: raw_task.clone(),
                                model_path: String::new(),
                                tools: raw_tools,
                                max_steps: raw_steps,
                                use_worktree: None,
                            },
                            idx,
                        );
                        let wid = spec.id.clone();
                        if let Some(existing) = guard.iter_mut().find(|w| w.id == wid) {
                            *existing = spec.clone();
                        } else if guard.len() < 200 {
                            guard.push(spec.clone());
                        }
                        spawned_ids.push((wid, spec.name, spec.role, raw_task));
                    }
                    drop(guard);

                    for (wid, wname, wrole, wtask) in &spawned_ids {
                        if !mentioned_targets.contains(wid) {
                            mentioned_targets.push(wid.clone());
                        }
                        emit(EngineEvent::SwarmAgentStatus {
                            run_id: run_id.to_string(),
                            node_id: node_id.to_string(),
                            agent_id: wid.clone(),
                            agent_name: wname.clone(),
                            role: wrole.clone(),
                            status: "queued".into(),
                            summary: if wtask.is_empty() {
                                "En cola del pool".into()
                            } else {
                                wtask.chars().take(80).collect()
                            },
                        });
                    }
                    let list_preview: Vec<String> = spawned_ids.iter().map(|(id, _, _, _)| format!("@{id}")).collect();
                    format!("Batch spawned {} workers: {}", spawned_ids.len(), list_preview.join(", "))
                }
                "swarm_finish" if is_coordinator && (!can_finish || mentioned_targets.iter().any(|id| id != "coordinator")) => {
                    "There are pending or failed worker tasks. Resolve them before finishing.".into()
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
                    if final_summary.is_empty() {
                        messages.push(ChatMessage {
                            role: "tool".into(),
                            content: Some("Provide a non-empty final summary.".into()),
                            tool_calls: None,
                            tool_call_id: Some(call.id.clone()),
                            image_paths: Vec::new(),
                        });
                        continue;
                    }
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
                _ if !enabled_tools.iter().any(|name| name == tool_name) => {
                    format!("Tool '{tool_name}' is disabled for this agent.")
                }
                _ => {
                    emit_status("working", &format!("Paso {step}: {tool_name}"));
                    let mut res = tools::execute_tool_cancellable(
                        workspace, tool_name, &args, Some(cancel),
                    ).await;
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

    // Wrap-up turn: if the agent spent all max_steps on exploration tools without posting or speaking,
    // force one final reporting turn with ONLY swarm coordination tools so the board never stays silent.
    if !posted_this_turn
        && final_text.is_empty()
        && !(is_coordinator && board.finished_summary().is_some())
        && !cancel.load(Ordering::SeqCst)
    {
        emit_status("working", "Sintetizando entrega final...");
        messages.push(ChatMessage {
            role: "user".into(),
            content: Some(if is_coordinator {
                "Límite de pasos de exploración alcanzado. Publica ya tus asignaciones con `swarm_post(message, mentions)` o cierra con `swarm_finish(summary)`.".into()
            } else {
                "Límite de pasos de exploración alcanzado. Resume ahora lo que has encontrado (archivos, líneas, hallazgos o bloqueos) y publícalo con `swarm_post(message, mentions: [\"coordinator\"])`.".into()
            }),
            tool_calls: None,
            tool_call_id: None,
            image_paths: Vec::new(),
        });
        let wrap_req = ChatRequest {
            messages: messages.clone(),
            tools: swarm_tool_definitions(is_coordinator, allow_spawn),
            temperature: defaults.temperature,
            top_p: defaults.top_p,
            max_tokens: defaults.max_tokens,
            min_p: Some(0.05),
            repeat_penalty: defaults.repeat_penalty,
            seed: None,
            reasoning_effort: None,
        };
        let wrap_res = if is_cloud {
            crate::inference::cloud::chat_stream_cloud(model_path, wrap_req, Some(cancel), |_, _| {}).await
        } else if let Some(port) = local_port {
            let _permit = gpu_semaphore.acquire().await.map_err(|_| "Semaphore closed".to_string())?;
            llama.chat_stream(port, wrap_req, Some(cancel), |_, _| {}).await
        } else {
            Err("No model port".into())
        };
        if let Ok(wresp) = wrap_res {
            if !wresp.content.trim().is_empty() {
                final_text = wresp.content.trim().to_string();
            }
            let mut wcalls = wresp.tool_calls;
            if wcalls.is_empty() && wresp.content.contains("<tool_call>") {
                wcalls = parse_inline_tool_calls(&wresp.content);
            }
            for call in wcalls {
                let args: Value = serde_json::from_str(&call.function.arguments).unwrap_or_else(|_| json!({}));
                match call.function.name.as_str() {
                    "swarm_post" => {
                        let msg = args.get("message").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
                        if !msg.is_empty() {
                            let explicit_mentions: Option<Vec<String>> = args
                                .get("mentions")
                                .and_then(|v| v.as_array())
                                .map(|arr| arr.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect());
                            let valid_ids_now = current_worker_ids();
                            let mentions = extract_mentions(explicit_mentions, &msg, &valid_ids_now);
                            for m in &mentions {
                                if !mentioned_targets.contains(m) {
                                    mentioned_targets.push(m.clone());
                                }
                            }
                            let entry = board.post(agent_id, mentions, &msg);
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
                        }
                    }
                    "swarm_finish" if is_coordinator && can_finish && mentioned_targets.iter().all(|id| id == "coordinator") => {
                        let summary = args.get("summary").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
                        let final_summary = if summary.is_empty() { final_text.clone() } else { summary };
                        if !final_summary.is_empty() {
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
                        }
                    }
                    _ => {}
                }
            }
        }
    }

    // If the agent finished speaking without calling swarm_post, mirror its final response to the board so peers see it
    if !posted_this_turn && !final_text.is_empty() {
        let valid_ids_now = current_worker_ids();
        let inferred_mentions = extract_mentions(None, &final_text, &valid_ids_now);
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
            "waiting",
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
    let roster = Arc::new(Mutex::new(cfg.workers.clone()));
    let allow_spawn = cfg.planning_mode == "auto";

    let hw = detect_hardware_profile();
    let (hw_slots, hw_note) = compute_hardware_concurrency(&hw, &defaults.model_path, cfg.use_worktrees);
    let effective_concurrency = if cfg.max_concurrency == 0 {
        hw_slots
    } else {
        cfg.max_concurrency.max(1)
    };

    emit(EngineEvent::NodeLog {
        run_id: run_id.to_string(),
        node_id: node_id.to_string(),
        node_title: node_title.to_string(),
        iteration,
        stream: LogStreamKind::System,
        text: format!(
            "Swarm modo={} | Pool={} slots ({})",
            cfg.planning_mode, effective_concurrency, hw_note
        ),
    });

    // Emit initial roster statuses
    emit(EngineEvent::SwarmAgentStatus {
        run_id: run_id.to_string(),
        node_id: node_id.to_string(),
        agent_id: "coordinator".into(),
        agent_name: "Coordinator".into(),
        role: if allow_spawn { "Planner & Lead".into() } else { "Swarm Lead".into() },
        status: "waiting".into(),
        summary: format!("Pool: {effective_concurrency} slots"),
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

    let roster_desc = if cfg.workers.is_empty() {
        "(Sin workers fijos aún — eres el Planner: analiza la tarea y créalos dinámicamente con `swarm_spawn_worker` o `swarm_spawn_batch`)".to_string()
    } else {
        cfg.workers
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
            .join("\n")
    };

    let coord_rules = if allow_spawn {
        format!(
            "## Capacidad del Hardware\n- {}\n- Pool de ejecución paralela: {} workers simultáneos (si creas 10, 50 o 200 tareas con `swarm_spawn_batch`, Loors las encola y ejecuta automáticamente de {} en {}).\n\n## Reglas de Planificación y Coordinación (Modo Auto)\n1. En la Ronda 1, analiza la complejidad real de la tarea (puedes usar `list_files` / `read_file` si necesitas ver el proyecto) y decide cuántos workers hacen falta.\n2. Usa `swarm_spawn_worker` (para 1–3 especialistas) o `swarm_spawn_batch` (para muchas subtareas independientes en una sola llamada) especificando `id`, `role`, `task`, `system_prompt` y `tools` mínimas.\n3. Opcionalmente publica instrucciones adicionales con `swarm_post(message, mentions)`.\n4. Revisa entregas en la pizarra; cuando todo esté completo y verificado, llama OBLIGATORIAMENTE a `swarm_finish(summary)`.",
            hw_note, effective_concurrency, effective_concurrency, effective_concurrency
        )
    } else {
        let first_id = cfg.workers.first().map(|s| s.id.as_str()).unwrap_or("all");
        format!(
            "## Reglas de Coordinación\n1. En la primera ronda, divide el objetivo y asigna tareas concretas usando `swarm_post` con `mentions` (ej. `mentions: [\"{first_id}\"]` o `[\"all\"]`).\n2. Revisa las respuestas de los workers en la pizarra. Si falta algo o hay errores, vuelve a mencionar al worker correspondiente.\n3. Cuando el objetivo esté cumplido y verificado, llama OBLIGATORIAMENTE a `swarm_finish(summary)` con la síntesis final completa."
        )
    };

    let coord_system = format!(
        "{}\n\n## Equipo Inicial del Enjambre\n{}\n\n{}",
        cfg.coordinator_prompt, roster_desc, coord_rules
    );

    let mut coord_last_seq: u64 = 0;
    let mut worker_last_seq: HashMap<String, u64> = HashMap::new();
    let mut pending_workers = HashSet::new();
    let mut failed_workers = HashSet::new();

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
                "## Objetivo del Enjambre\n{}{}\n\n{}",
                cfg.objective,
                extra,
                if allow_spawn {
                    "Planifica el equipo necesario según la tarea y el hardware, créalo con `swarm_spawn_worker` o `swarm_spawn_batch` y arranca la ejecución."
                } else {
                    "Inicia la coordinación ahora: asigna las tareas iniciales a tus workers con `swarm_post`."
                }
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
                "Ronda {round}/{}. Nuevos mensajes en la pizarra:\n{delta_text}\n\nEvalúa el progreso. Reintenta las tareas fallidas mencionando al worker. Despacha las tareas dependientes, como QA, tras recibir la entrega que necesitan. Cuando todo esté verificado llama a `swarm_finish(summary)`; usa `swarm_post` para asignar los siguientes pasos{}.",
                cfg.max_rounds,
                if allow_spawn { " (o crea nuevos workers si hacen falta)" } else { "" }
            )
        };

        let (_, coord_mentions) = run_single_swarm_agent_turn(
            run_id,
            node_id,
            node_title,
            iteration,
            "coordinator",
            "Coordinator",
            if allow_spawn { "Planner & Lead" } else { "Swarm Lead" },
            true,
            allow_spawn,
            pending_workers.is_empty() && failed_workers.is_empty()
                && (round > 1 || cfg.workers.is_empty()),
            &coord_system,
            &coord_turn_prompt,
            workspace,
            &defaults.model_path,
            &defaults,
            &["list_files".into(), "read_file".into(), "git_diff".into()],
            6,
            &roster,
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

        let current_roster: Vec<SwarmWorkerSpec> = roster.lock().unwrap().clone();
        let valid_worker_ids: Vec<String> = current_roster.iter().map(|w| w.id.clone()).collect();
        if valid_worker_ids.is_empty() {
            continue;
        }

        pending_workers.extend(coord_mentions);
        if round == 1 && pending_workers.iter().all(|id| id == "coordinator") {
            pending_workers.extend(current_roster.iter()
                .filter(|worker| !worker.task.trim().is_empty())
                .map(|worker| worker.id.clone()));
        }
        let target_ids: Vec<_> = valid_worker_ids.into_iter()
            .filter(|id| pending_workers.contains(id))
            .collect();
        pending_workers.clear();

        let concurrency_sem = Arc::new(Semaphore::new(effective_concurrency.max(1)));
        let mut join_set = JoinSet::new();
        let round_seq = board.latest_seq();

        for wid in target_ids {
            let Some(worker) = current_roster.iter().find(|w| w.id == wid).cloned() else {
                continue;
            };
            let prev_seq = *worker_last_seq.get(&wid).unwrap_or(&0);
            let new_msgs = board.read_since(prev_seq);
            let board_snapshot = new_msgs
                .iter()
                .take_while(|entry| entry.seq <= round_seq)
                .map(|e| format!("[#{} @{}] {}", e.seq, e.from, e.content))
                .collect::<Vec<_>>()
                .join("\n");
            worker_last_seq.insert(wid.clone(), round_seq);

            let run_id_c = run_id.to_string();
            let node_id_c = node_id.to_string();
            let node_title_c = node_title.to_string();
            let ws_orig = workspace.to_string();
            let objective_c = cfg.objective.clone();
            let defaults_c = defaults.clone();
            let roster_c = roster.clone();
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
                let worker_id = worker.id.clone();
                let result = async {
                    emit_c(EngineEvent::SwarmAgentStatus {
                        run_id: run_id_c.clone(),
                        node_id: node_id_c.clone(),
                        agent_id: worker.id.clone(),
                        agent_name: worker.name.clone(),
                        role: worker.role.clone(),
                        status: "queued".into(),
                        summary: if worker.task.is_empty() {
                            "Esperando turno en el pool".into()
                        } else {
                            worker.task.chars().take(80).collect()
                        },
                    });
                    let _conc_permit = conc_sem_c
                        .acquire()
                        .await
                        .map_err(|_| "Concurrency semaphore closed".to_string())?;

                    if cancel_c.load(Ordering::SeqCst) {
                        return Err("__CANCELLED__".into());
                    }
                    let isolated = if use_wt {
                        let _guard = git_lock_c.lock().await;
                        let root = run_git_cmd(&ws_orig, &["rev-parse", "--show-toplevel"]).await?;
                        let prefix = run_git_cmd(&ws_orig, &["rev-parse", "--show-prefix"]).await?;
                        let root = String::from_utf8_lossy(&root).trim_end_matches(['\r', '\n']).to_owned();
                        let prefix = String::from_utf8_lossy(&prefix).trim_end_matches(['\r', '\n']).to_owned();
                        let (checkout, base) = create_worker_checkout(&root).await?;
                        Some((root, checkout, base, prefix))
                    } else {
                        None
                    };
                    let effective_ws = isolated.as_ref()
                        .map(|(_, checkout, _, prefix)| checkout.join(prefix).to_string_lossy().into_owned())
                        .unwrap_or_else(|| ws_orig.clone());

                    let worker_model = if worker.model_path.trim().is_empty() {
                        defaults_c.model_path.clone()
                    } else {
                        worker.model_path.clone()
                    };

                    let worker_sys = format!(
                        "Eres @{} ({}, rol: {}) en un enjambre coordinado de Loors.\n{}\n\nUsa `swarm_post(message, mentions)` para reportar resultados concretos a `@coordinator` (o a otro compañero si necesitas algo). Sé directo, basado en evidencia y conciso.",
                        worker.id, worker.name, worker.role, worker.system_prompt
                    );
                    let task_block = if worker.task.trim().is_empty() {
                        String::new()
                    } else {
                        format!("\n\n## Tu tarea asignada\n{}", worker.task)
                    };
                    let worker_prompt = format!(
                        "## Objetivo general\n{objective_c}{task_block}\n\n## Mensajes recientes en la pizarra\n{board_snapshot}\n\nEjecuta tu parte ahora y reporta en la pizarra con `swarm_post`."
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
                        false,
                        false,
                        &worker_sys,
                        &worker_prompt,
                        &effective_ws,
                        &worker_model,
                        &defaults_c,
                        &worker.tools,
                        worker.max_steps,
                        &roster_c,
                        &board_c,
                        &backend_c,
                        &llama_c,
                        &gpu_sem_c,
                        &cancel_c,
                        &emit_c,
                    )
                    .await;

                    let (_, mentions) = res.map_err(|err| {
                        if use_wt && err != "__CANCELLED__" {
                            format!("{err}. Worktree preserved at {effective_ws}")
                        } else {
                            err
                        }
                    })?;
                    if cancel_c.load(Ordering::SeqCst) {
                        return Err("__CANCELLED__".into());
                    }
                    if let Some((root, checkout, base, _)) = isolated {
                        let _guard = git_lock_c.lock().await;
                        if cancel_c.load(Ordering::SeqCst) {
                            return Err("__CANCELLED__".into());
                        }
                        integrate_worker_checkout(&root, &checkout, &base).await?;
                    }
                    emit_c(EngineEvent::SwarmAgentStatus {
                        run_id: run_id_c,
                        node_id: node_id_c,
                        agent_id: worker.id,
                        agent_name: worker.name,
                        role: worker.role,
                        status: "done".into(),
                        summary: "Entrega completada".into(),
                    });
                    Ok::<_, String>(mentions)
                }.await;
                (worker_id, result)
            });
        }

        let mut cancelled = false;
        while let Some(joined) = join_set.join_next().await {
            let (worker, error) = match joined {
                Ok((worker, Ok(mentions))) => {
                    failed_workers.remove(&worker);
                    pending_workers.extend(mentions.into_iter().filter(|id| id != "coordinator"));
                    continue;
                }
                Ok((_, Err(error))) if error == "__CANCELLED__" => {
                    cancelled = true;
                    continue;
                }
                Ok((worker, Err(error))) => (worker, error),
                Err(error) => ("runtime".into(), error.to_string()),
            };
            failed_workers.insert(worker.clone());
            let entry = board.post(&worker, vec!["coordinator".into()], &format!("[FAILED] {error}"));
            emit(EngineEvent::SwarmBoardMessage {
                run_id: run_id.into(), node_id: node_id.into(), seq: entry.seq,
                from: entry.from, mentions: entry.mentions, content: entry.content, timestamp: entry.timestamp,
            });
            if let Some(spec) = current_roster.iter().find(|spec| spec.id == worker) {
                emit(EngineEvent::SwarmAgentStatus {
                    run_id: run_id.into(), node_id: node_id.into(), agent_id: worker,
                    agent_name: spec.name.clone(), role: spec.role.clone(),
                    status: "blocked".into(), summary: error,
                });
            }
        }
        if cancelled || cancel.load(Ordering::SeqCst) {
            return Err("__CANCELLED__".into());
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

    #[tokio::test]
    async fn worktree_integrates_committed_staged_and_new_files_and_preserves_conflicts() {
        let repo = tempfile::tempdir().unwrap();
        let workspace = repo.path().to_str().unwrap();
        run_git_cmd(workspace, &["init"]).await.unwrap();
        run_git_cmd(workspace, &["config", "core.autocrlf", "false"]).await.unwrap();
        let commit = ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "test"];
        fs::write(repo.path().join("tracked"), "original\n").unwrap();
        run_git_cmd(workspace, &["add", "."]).await.unwrap();
        run_git_cmd(workspace, &commit).await.unwrap();
        fs::write(repo.path().join("user-change"), "keep me\n").unwrap();

        let (checkout, base) = create_worker_checkout(workspace).await.unwrap();
        let worker = checkout.to_str().unwrap();
        assert_eq!(fs::read_to_string(checkout.join("user-change")).unwrap(), "keep me\n");
        fs::write(checkout.join("tracked"), "committed\n").unwrap();
        run_git_cmd(worker, &["add", "tracked"]).await.unwrap();
        run_git_cmd(worker, &commit).await.unwrap();
        fs::write(checkout.join("staged"), "staged\n").unwrap();
        run_git_cmd(worker, &["add", "staged"]).await.unwrap();
        let binary = [0, 255, 42];
        fs::write(checkout.join("new"), binary).unwrap();
        integrate_worker_checkout(workspace, &checkout, &base).await.unwrap();
        assert!(!checkout.exists());
        assert_eq!(fs::read_to_string(repo.path().join("tracked")).unwrap(), "committed\n");
        assert_eq!(fs::read_to_string(repo.path().join("staged")).unwrap(), "staged\n");
        assert_eq!(fs::read(repo.path().join("new")).unwrap(), binary);
        assert!(run_git_cmd(workspace, &["diff", "--cached", "--quiet"]).await.is_ok());

        let (checkout, base) = create_worker_checkout(workspace).await.unwrap();
        assert_eq!(fs::read(checkout.join("new")).unwrap(), binary);
        fs::write(checkout.join("tracked"), "worker\n").unwrap();
        fs::write(repo.path().join("tracked"), "user\n").unwrap();
        let err = integrate_worker_checkout(workspace, &checkout, &base).await.unwrap_err();
        assert!(err.contains("Worktree preserved"));
        assert!(checkout.parent().unwrap().join("delivery.diff").is_file());
        assert_eq!(fs::read_to_string(repo.path().join("tracked")).unwrap(), "user\n");
        run_git_cmd(workspace, &["worktree", "remove", "--force", checkout.to_str().unwrap()])
            .await.unwrap();
        let _ = fs::remove_file(checkout.parent().unwrap().join("delivery.diff"));
        let _ = fs::remove_file(checkout.parent().unwrap().join("snapshot.index"));
        let _ = fs::remove_dir(checkout.parent().unwrap());
    }

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
        assert_eq!(cfg.planning_mode, "auto");
        assert_eq!(cfg.max_rounds, 8);
        assert_eq!(cfg.max_concurrency, 0);
        assert!(cfg.workers.is_empty());
        assert!(!cfg.use_worktrees);

        let mut raw = HashMap::new();
        raw.insert("planningMode".into(), json!("manual"));
        raw.insert("maxRounds".into(), json!(5));
        raw.insert("useWorktrees".into(), json!(true));
        raw.insert(
            "workers".into(),
            json!([
                { "id": "Backend Dev!", "name": "Backend", "role": "API", "tools": ["read_file"] }
            ]),
        );
        let cfg2 = parse_swarm_config(&raw, "Obj".into(), "Coord".into());
        assert_eq!(cfg2.planning_mode, "manual");
        assert_eq!(cfg2.max_rounds, 5);
        assert!(cfg2.use_worktrees);
        assert_eq!(cfg2.workers.len(), 1);
        assert_eq!(cfg2.workers[0].id, "backend-dev-");
        raw.insert("workers".into(), json!([
            { "id": "no-tools", "name": "No tools", "tools": [] },
            { "id": "default-tools", "name": "Default tools" }
        ]));
        let cfg = parse_swarm_config(&raw, "Obj".into(), "Coord".into());
        assert!(cfg.workers[0].tools.is_empty());
        assert_eq!(cfg.workers[1].tools, default_worker_tools());
    }

    #[test]
    fn swarm_tool_definitions_restricts_finish_and_spawn_to_coordinator() {
        let coord_auto = swarm_tool_definitions(true, true);
        let coord_manual = swarm_tool_definitions(true, false);
        let worker_tools = swarm_tool_definitions(false, false);
        assert!(coord_auto.iter().any(|t| t["function"]["name"] == "swarm_finish"));
        assert!(coord_auto.iter().any(|t| t["function"]["name"] == "swarm_spawn_worker"));
        assert!(coord_auto.iter().any(|t| t["function"]["name"] == "swarm_spawn_batch"));
        assert!(!coord_manual.iter().any(|t| t["function"]["name"] == "swarm_spawn_worker"));
        assert!(!worker_tools.iter().any(|t| t["function"]["name"] == "swarm_finish"));
    }

    #[test]
    fn hardware_concurrency_scales_for_cloud_vs_local() {
        let hw = HardwareProfile {
            os: "windows".into(),
            arch: "x86_64".into(),
            cpu_brand: "Ryzen".into(),
            cpu_cores: 16,
            total_ram_mb: 32768,
            gpus: vec![crate::hardware::GpuInfo {
                name: "RTX 4090".into(),
                vendor: "NVIDIA".into(),
                vram_mb: Some(24576),
            }],
            recommended_backend: RuntimeBackendKind::Cuda,
            available_backends: vec![RuntimeBackendKind::Cuda],
        };
        let (cloud_slots, _) = compute_hardware_concurrency(&hw, "cloud::openai::gpt-4o", false);
        let (local_slots, _) = compute_hardware_concurrency(&hw, "C:/models/qwen.gguf", false);
        assert!(cloud_slots >= 6);
        assert!(local_slots >= 2 && local_slots <= 4);
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
