mod agent_chat;
mod architect;
mod custom_nodes;
mod engine;
mod hardware;
pub mod headless;
mod inference;
mod knowledge;
mod mcp;
mod models;
mod runtime;
mod skills;
mod tools;
mod triggers;
mod updater;

use agent_chat::{
    clear_workspace_memory_file as do_clear_workspace_memory_file, delete_session_in,
    list_sessions_in, load_session_in, read_workspace_memory_files as do_read_workspace_memory_files,
    run_agent_turn as do_run_agent_turn, save_session_in, sessions_dir, undo_tool_call_in_dir,
    AgentChatState, AgentSession, AgentSessionSummary, PermissionDecision, QuestionDecision,
    WorkspaceMemoryFileInfo,
};
use architect::{
    ensure_and_load_architect_skill, run_architect_chat, ArchitectMessageInput, ArchitectSkillInfo,
    ArchitectState,
};
use custom_nodes::{
    delete_custom_node as do_delete_custom_node, list_custom_nodes as do_list_custom_nodes,
    save_custom_node as do_save_custom_node, CustomNodeDef,
};

use engine::{capture_git_diff, EngineManager, HumanDecision, WorkflowGraph};
use hardware::{detect_hardware_profile, HardwareProfile, RuntimeBackendKind};
use mcp::{
    load_saved_mcp_servers, probe_mcp_server, save_mcp_servers as do_save_mcp_servers,
    McpServerConfig, McpToolInfo, SavedMcpServer,
};
use models::{
    download_hf_model_cancellable as do_download_hf_model_cancellable,
    list_hf_gguf_files as do_list_hf_gguf_files, search_hf_models as do_search_hf_models,
    HfGgufFile, HfModelRepo, ModelDownloadEvent, ModelDownloadManager,
};
use skills::{discover_skills, SkillSummary};
use runtime::{
    get_runtime_status as runtime_status_snapshot, install_runtime as do_install_runtime,
    uninstall_runtime as do_uninstall_runtime, RuntimeInstallInfo, RuntimeStatusSnapshot,
};
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, Manager, RunEvent, State};
use triggers::{TriggerManager, TriggerStatus};

#[derive(Debug, Clone, Serialize)]
pub struct LocalModelFile {
    pub name: String,
    pub path: String,
    pub size_mb: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct SavedWorkflowEntry {
    pub name: String,
    pub path: String,
}

pub(crate) fn workflows_dir() -> PathBuf {
    dirs::data_local_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("loors")
        .join("workflows")
}

#[tauri::command]
fn list_saved_workflows() -> Vec<SavedWorkflowEntry> {
    let dir = workflows_dir();
    let Ok(entries) = fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut list = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_file() {
            let fname = path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or_default()
                .to_string();
            if fname.ends_with(".loors.json") || fname.ends_with(".json") {
                let name = fname
                    .trim_end_matches(".loors.json")
                    .trim_end_matches(".json")
                    .to_string();
                list.push(SavedWorkflowEntry {
                    name,
                    path: path.to_string_lossy().to_string(),
                });
            }
        }
    }
    list.sort_by(|a, b| a.name.cmp(&b.name));
    list
}

#[tauri::command]
fn save_workflow_to_library(name: String, content: String) -> Result<String, String> {
    let dir = workflows_dir();
    fs::create_dir_all(&dir).map_err(|e| format!("No se pudo crear carpeta workflows: {e}"))?;
    let safe_name: String = name
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .collect();
    let final_name = if safe_name.trim_matches('-').is_empty() {
        "workflow".to_string()
    } else {
        safe_name
    };
    let path = dir.join(format!("{final_name}.loors.json"));
    fs::write(&path, content).map_err(|e| format!("Error guardando flujo: {e}"))?;
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
fn load_workflow_from_library(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| format!("Error leyendo flujo: {e}"))
}

#[tauri::command]
fn delete_workflow_from_library(path: String) -> Result<(), String> {
    let p = Path::new(&path);
    if p.exists() {
        fs::remove_file(p).map_err(|e| format!("Error eliminando flujo: {e}"))?;
    }
    Ok(())
}

#[tauri::command]
fn detect_hardware() -> HardwareProfile {
    detect_hardware_profile()
}

#[tauri::command]
fn get_runtime_status() -> RuntimeStatusSnapshot {
    runtime_status_snapshot()
}

#[tauri::command]
async fn install_runtime(
    app: AppHandle,
    backend: RuntimeBackendKind,
) -> Result<RuntimeInstallInfo, String> {
    do_install_runtime(backend, move |progress| {
        let _ = app.emit("loors://runtime-download", progress);
    })
    .await
}

#[tauri::command]
fn uninstall_runtime(backend: RuntimeBackendKind) -> Result<(), String> {
    do_uninstall_runtime(backend)
}

#[tauri::command]
fn set_custom_runtime_binary(path: String) -> Result<(), String> {
    runtime::save_custom_runtime_path(&path)
}

#[tauri::command]
async fn search_hf_models(
    query: String,
    sort: Option<String>,
) -> Result<Vec<HfModelRepo>, String> {
    do_search_hf_models(&query, sort.as_deref()).await
}

#[tauri::command]
async fn list_hf_gguf_files(repo_id: String) -> Result<Vec<HfGgufFile>, String> {
    do_list_hf_gguf_files(&repo_id).await
}

#[tauri::command]
async fn download_hf_model(
    app: AppHandle,
    downloads: State<'_, ModelDownloadManager>,
    repo_id: String,
    filename: String,
) -> Result<String, String> {
    let cancel = downloads.register(&repo_id, &filename)?;
    let app_for_cb = app.clone();
    let res = do_download_hf_model_cancellable(&repo_id, &filename, cancel, move |progress| {
        if let Some(mgr) = app_for_cb.try_state::<ModelDownloadManager>() {
            mgr.update(&progress);
        }
        let _ = app_for_cb.emit("loors://model-download", progress);
    })
    .await;
    downloads.finish(&repo_id, &filename);
    res
}

#[tauri::command]
fn cancel_model_download(
    downloads: State<'_, ModelDownloadManager>,
    repo_id: String,
    filename: String,
) -> bool {
    downloads.cancel(&repo_id, &filename)
}

#[tauri::command]
fn list_active_model_downloads(
    downloads: State<'_, ModelDownloadManager>,
) -> Vec<ModelDownloadEvent> {
    downloads.list_active()
}

#[tauri::command]
fn scan_local_models() -> Vec<LocalModelFile> {
    let mut candidate_roots: Vec<PathBuf> = Vec::new();
    if let Some(home) = dirs::home_dir() {
        candidate_roots.push(home.join(".lmstudio").join("models"));
        candidate_roots.push(home.join(".cache").join("lm-studio").join("models"));
    }
    if let Some(local) = dirs::data_local_dir() {
        candidate_roots.push(local.join("loors").join("models"));
    }
    candidate_roots.push(PathBuf::from("models"));

    let mut seen_roots = std::collections::HashSet::<String>::new();
    let mut seen_files = std::collections::HashSet::<String>::new();
    let mut found = Vec::new();

    for root in candidate_roots {
        if !root.exists() {
            continue;
        }
        let canon_root = fs::canonicalize(&root).unwrap_or_else(|_| root.clone());
        let root_key = normalize_path_key(&canon_root);
        if !seen_roots.insert(root_key) {
            continue;
        }
        collect_gguf(&canon_root, &mut found, &mut seen_files, 0);
    }
    found.sort_by(|a, b| a.name.cmp(&b.name));
    found
}

fn strip_windows_verbatim_prefix(p: &Path) -> String {
    let s = p.to_string_lossy().to_string();
    if let Some(stripped) = s.strip_prefix(r"\\?\") {
        stripped.to_string()
    } else {
        s
    }
}

fn normalize_path_key(p: &Path) -> String {
    let clean = strip_windows_verbatim_prefix(p);
    if cfg!(target_os = "windows") {
        clean.to_lowercase()
    } else {
        clean
    }
}

fn collect_gguf(
    dir: &Path,
    out: &mut Vec<LocalModelFile>,
    seen_files: &mut std::collections::HashSet<String>,
    depth: usize,
) {
    if depth > 5 || out.len() >= 100 {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_gguf(&path, out, seen_files, depth + 1);
        } else if path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.eq_ignore_ascii_case("gguf"))
            .unwrap_or(false)
        {
            let canon = fs::canonicalize(&path).unwrap_or_else(|_| path.clone());
            let key = normalize_path_key(&canon);
            if !seen_files.insert(key) {
                continue;
            }
            let size_mb = entry.metadata().map(|m| m.len() / (1024 * 1024)).unwrap_or(0);
            let name = canon
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("model.gguf")
                .to_string();
            out.push(LocalModelFile {
                name,
                path: strip_windows_verbatim_prefix(&canon),
                size_mb,
            });
        }
    }
}

#[tauri::command]
async fn get_workspace_diff(workspace: String) -> String {
    capture_git_diff(&workspace).await
}

#[tauri::command]
fn list_custom_nodes(workspace: String) -> Vec<CustomNodeDef> {
    do_list_custom_nodes(&workspace)
}

#[tauri::command]
fn save_custom_node(def: CustomNodeDef) -> Result<String, String> {
    do_save_custom_node(def)
}

#[tauri::command]
fn delete_custom_node(id: String) -> Result<(), String> {
    do_delete_custom_node(&id)
}

#[tauri::command]
fn list_skills(workspace: String) -> Vec<SkillSummary> {
    discover_skills(&workspace)
}

#[tauri::command]
async fn test_mcp_server(
    config: McpServerConfig,
    workspace: String,
) -> Result<Vec<McpToolInfo>, String> {
    probe_mcp_server(config, workspace).await
}

#[tauri::command]
fn ping_engine() -> String {
    "loors-core ready (phase 4)".to_string()
}

#[derive(Serialize, Clone)]
struct EngineTabEvent {
    #[serde(rename = "tabId")]
    tab_id: String,
    #[serde(flatten)]
    event: engine::types::EngineEvent,
}

#[tauri::command]
async fn start_workflow(
    app: AppHandle,
    engine: State<'_, EngineManager>,
    graph: WorkflowGraph,
    backend: Option<RuntimeBackendKind>,
    start_node_id: Option<String>,
    tab_id: Option<String>,
) -> Result<String, String> {
    let tid = tab_id
        .clone()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "default".to_string());
    let emit_tid = tid.clone();
    engine.start_run_in_tab(
        Some(tid),
        graph,
        backend.unwrap_or(RuntimeBackendKind::Auto),
        start_node_id,
        move |event| {
            let _ = app.emit(
                "loors://engine-event",
                EngineTabEvent {
                    tab_id: emit_tid.clone(),
                    event,
                },
            );
        },
    )
}

#[tauri::command]
async fn pick_folder(initial_dir: Option<String>) -> Result<Option<String>, String> {
    #[cfg(target_os = "windows")]
    {
        let init = initial_dir
            .unwrap_or_default()
            .replace('\'', "''");
        let script = format!(
            "Add-Type -AssemblyName System.Windows.Forms; \
             $d = New-Object System.Windows.Forms.FolderBrowserDialog; \
             $d.Description = 'Selecciona la carpeta del proyecto (Workspace)'; \
             $d.UseDescriptionForTitle = $true; \
             if ('{init}' -ne '' -and (Test-Path '{init}')) {{ $d.SelectedPath = (Resolve-Path '{init}').Path }}; \
             $f = New-Object System.Windows.Forms.Form -Property @{{ TopMost = $true }}; \
             if ($d.ShowDialog($f) -eq [System.Windows.Forms.DialogResult]::OK) {{ Write-Output $d.SelectedPath }}"
        );
        let mut cmd = tokio::process::Command::new("powershell");
        cmd.args(["-NoProfile", "-STA", "-Command", &script]);
        cmd.creation_flags(0x0800_0000);
        let output = cmd
            .output()
            .await
            .map_err(|e| format!("No se pudo abrir el selector de carpetas: {e}"))?;
        let selected = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if selected.is_empty() {
            Ok(None)
        } else {
            Ok(Some(selected))
        }
    }

    #[cfg(target_os = "macos")]
    {
        let _ = initial_dir;
        let output = tokio::process::Command::new("osascript")
            .args([
                "-e",
                "POSIX path of (choose folder with prompt \"Selecciona la carpeta del proyecto (Workspace)\")",
            ])
            .output()
            .await
            .map_err(|e| format!("No se pudo abrir el selector de carpetas: {e}"))?;
        let selected = String::from_utf8_lossy(&output.stdout).trim().to_string();
        Ok(if selected.is_empty() { None } else { Some(selected) })
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let _ = initial_dir;
        let output = tokio::process::Command::new("zenity")
            .args(["--file-selection", "--directory", "--title=Selecciona Workspace"])
            .output()
            .await
            .map_err(|e| format!("No se pudo abrir el selector de carpetas (zenity): {e}"))?;
        let selected = String::from_utf8_lossy(&output.stdout).trim().to_string();
        Ok(if selected.is_empty() { None } else { Some(selected) })
    }
}

#[tauri::command]
async fn pick_files(initial_dir: Option<String>) -> Result<Vec<String>, String> {
    #[cfg(target_os = "windows")]
    {
        let init = initial_dir
            .unwrap_or_default()
            .replace('\'', "''");
        let script = format!(
            "Add-Type -AssemblyName System.Windows.Forms; \
             $d = New-Object System.Windows.Forms.OpenFileDialog; \
             $d.Title = 'Adjuntar archivos, documentos o imágenes'; \
             $d.Multiselect = $true; \
             $d.Filter = 'Soportados|*.pdf;*.docx;*.xlsx;*.pptx;*.epub;*.odt;*.txt;*.md;*.csv;*.json;*.png;*.jpg;*.jpeg;*.webp;*.rs;*.ts;*.tsx;*.js;*.py;*.cpp;*.c;*.h;*.html;*.css|Documentos (PDF, Office, EPUB)|*.pdf;*.docx;*.xlsx;*.pptx;*.epub;*.odt;*.txt;*.md;*.csv|Imágenes|*.png;*.jpg;*.jpeg;*.webp|Todos (*.*)|*.*'; \
             if ('{init}' -ne '' -and (Test-Path '{init}')) {{ $d.InitialDirectory = (Resolve-Path '{init}').Path }}; \
             $f = New-Object System.Windows.Forms.Form -Property @{{ TopMost = $true }}; \
             if ($d.ShowDialog($f) -eq [System.Windows.Forms.DialogResult]::OK) {{ $d.FileNames }}"
        );
        let mut cmd = tokio::process::Command::new("powershell");
        cmd.args(["-NoProfile", "-STA", "-Command", &script]);
        cmd.creation_flags(0x0800_0000);
        let output = cmd
            .output()
            .await
            .map_err(|e| format!("No se pudo abrir el selector de archivos: {e}"))?;
        let raw = String::from_utf8_lossy(&output.stdout);
        Ok(raw
            .lines()
            .map(|l| l.trim().to_string())
            .filter(|l| !l.is_empty())
            .collect())
    }

    #[cfg(target_os = "macos")]
    {
        let _ = initial_dir;
        let output = tokio::process::Command::new("osascript")
            .args([
                "-e",
                "set chosen to choose file with multiple selections allowed\nset out to \"\"\nrepeat with f in chosen\nset out to out & POSIX path of f & linefeed\nend repeat\nreturn out",
            ])
            .output()
            .await
            .map_err(|e| format!("No se pudo abrir el selector de archivos: {e}"))?;
        Ok(String::from_utf8_lossy(&output.stdout)
            .lines()
            .map(|l| l.trim().to_string())
            .filter(|l| !l.is_empty())
            .collect())
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let _ = initial_dir;
        let output = tokio::process::Command::new("zenity")
            .args([
                "--file-selection",
                "--multiple",
                "--separator=\n",
                "--title=Adjuntar archivos",
            ])
            .output()
            .await
            .map_err(|e| format!("No se pudo abrir el selector de archivos (zenity): {e}"))?;
        Ok(String::from_utf8_lossy(&output.stdout)
            .lines()
            .map(|l| l.trim().to_string())
            .filter(|l| !l.is_empty())
            .collect())
    }
}

#[tauri::command]
fn stage_uploaded_file(name: String, bytes: Vec<u8>) -> Result<String, String> {
    let uploads_dir = dirs::data_local_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("loors")
        .join("uploads");
    fs::create_dir_all(&uploads_dir)
        .map_err(|e| format!("No se pudo crear carpeta uploads: {e}"))?;
    let base_name = Path::new(name.trim())
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("adjunto.bin");
    let safe: String = base_name
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '.' || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let dest = uploads_dir.join(format!("{stamp}_{safe}"));
    fs::write(&dest, bytes)
        .map_err(|e| format!("No se pudo guardar archivo adjunto: {e}"))?;
    Ok(dest.to_string_lossy().to_string())
}

#[tauri::command]
fn get_architect_skill_info(workspace: Option<String>) -> ArchitectSkillInfo {
    let ws = workspace.unwrap_or_else(|| ".".to_string());
    let (_, info) = ensure_and_load_architect_skill(&ws);
    info
}

#[tauri::command]
fn get_app_version() -> String {
    updater::current_app_version()
}

#[tauri::command]
fn get_mcp_servers() -> Vec<SavedMcpServer> {
    load_saved_mcp_servers()
}

#[tauri::command]
fn save_mcp_servers(servers: Vec<SavedMcpServer>) -> Result<(), String> {
    do_save_mcp_servers(&servers)
}

#[tauri::command]
fn get_update_repo() -> String {
    updater::configured_update_repo().unwrap_or_default()
}

#[tauri::command]
fn set_update_repo(repo: String) -> Result<(), String> {
    updater::save_update_repo(&repo)
}

#[tauri::command]
async fn check_app_update(repo: Option<String>) -> Result<updater::UpdateCheckResult, String> {
    updater::check_for_updates(repo).await
}

#[tauri::command]
async fn install_app_update(
    app: AppHandle,
    expected_version: String,
) -> Result<bool, String> {
    static INSTALL_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let guard = INSTALL_LOCK
        .try_lock()
        .map_err(|_| "Ya hay una actualización en curso.".to_string())?;

    let release = updater::check_for_updates(None).await?;
    if !release.update_available || release.latest_version != expected_version {
        return Err("La versión disponible ha cambiado. Vuelve a buscar actualizaciones.".into());
    }
    let installer = updater::download_update_installer(&release, |ev| {
        let _ = app.emit("loors://update-progress", ev);
    })
    .await?;

    let should_exit = updater::launch_installer(&installer.path)?;
    if cfg!(target_os = "windows") || !should_exit {
        let _ = installer.directory.keep();
    }
    if should_exit {
        tokio::spawn(async move {
            let _guard = guard;
            tokio::time::sleep(std::time::Duration::from_millis(600)).await;
            app.exit(0);
        });
    }
    Ok(should_exit)
}

#[tauri::command]
fn get_cloud_providers() -> Vec<inference::cloud::CloudProviderConfig> {
    inference::cloud::load_cloud_providers()
}

#[tauri::command]
fn save_cloud_providers(
    providers: Vec<inference::cloud::CloudProviderConfig>,
) -> Result<(), String> {
    inference::cloud::save_cloud_providers(&providers)
}

#[tauri::command]
async fn fetch_cloud_provider_models(
    provider: inference::cloud::CloudProviderConfig,
) -> Result<Vec<String>, String> {
    inference::cloud::fetch_provider_models(&provider).await
}

#[tauri::command]
async fn architect_chat(
    app: AppHandle,
    engine: State<'_, EngineManager>,
    agent_state: State<'_, AgentChatState>,
    architect_state: State<'_, ArchitectState>,
    backend: Option<RuntimeBackendKind>,
    model_path: String,
    context_size: Option<u32>,
    reasoning_effort: Option<String>,
    messages: Vec<ArchitectMessageInput>,
    current_graph_json: String,
) -> Result<String, String> {
    if engine.is_running() {
        return Err("__GPU_BUSY_HARNESS__".to_string());
    }
    if agent_state.is_running() {
        return Err("__GPU_BUSY_AGENT__".to_string());
    }
    let is_cloud = inference::cloud::is_cloud_model(&model_path);
    if !is_cloud && (model_path.trim().is_empty() || !Path::new(&model_path).exists()) {
        return Err(
            "Selecciona un modelo GGUF válido o un modelo Cloud/API para usar el Chat Arquitecto."
                .to_string(),
        );
    }

    let (port, has_mmproj, cloud_model_opt) = if is_cloud {
        let model_short = inference::cloud::parse_cloud_model(&model_path)
            .map(|(p, m)| format!("{p}/{m}"))
            .unwrap_or_else(|| model_path.clone());
        let _ = app.emit(
            "loors://engine-event",
            engine::types::EngineEvent::ModelState {
                loaded: true,
                model_name: Some(model_short),
                context_size: Some(128_000),
            },
        );
        (0u16, true, Some(model_path.as_str()))
    } else {
        let rt = runtime::find_installed_binary(backend.unwrap_or(RuntimeBackendKind::Auto))
            .ok_or_else(|| {
                "No hay runtime llama.cpp instalado. Descárgalo primero en Runtime.".to_string()
            })?;

        let raw_ctx = context_size.unwrap_or(0);
        let effective_ctx = if raw_ctx == 0 {
            inference::compute_auto_context_size(&model_path)
        } else {
            raw_ctx
        };

        let model_short = Path::new(&model_path)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or(&model_path)
            .to_string();

        let (load_cfg, _profile) = inference::resolve_load_config_with_profile(
            rt.binary_path,
            &model_path,
            Some(effective_ctx),
            None,
        );

        let has_mmproj = load_cfg.mmproj_path.is_some();
        let port = engine.llama.ensure_loaded(load_cfg).await?;

        let _ = app.emit(
            "loors://engine-event",
            engine::types::EngineEvent::ModelState {
                loaded: true,
                model_name: Some(model_short),
                context_size: Some(effective_ctx),
            },
        );
        (port, has_mmproj, None)
    };

    let cancel = architect_state.start_turn();
    let app_stream = app.clone();
    let res = run_architect_chat(
        &engine.llama,
        cloud_model_opt,
        port,
        has_mmproj,
        reasoning_effort,
        messages,
        current_graph_json,
        Some(&cancel),
        move |ev| {
            let _ = app_stream.emit("loors://architect-event", ev);
        },
    )
    .await;
    architect_state.clear_turn();
    res
}

#[tauri::command]
fn stop_architect_chat(architect_state: State<'_, ArchitectState>) -> Result<(), String> {
    architect_state.stop_turn();
    Ok(())
}

#[tauri::command]
fn get_model_profile(model_path: String, agent_mode: Option<bool>) -> inference::ModelTuningProfile {
    inference::load_model_profile_for_ui(&model_path, agent_mode.unwrap_or(false))
}

#[tauri::command]
fn save_model_tuning_profile(
    model_path: String,
    profile: inference::ModelTuningProfile,
) -> Result<(), String> {
    inference::save_model_profile(&model_path, &profile)
}

#[tauri::command]
async fn reload_model_with_profile(
    app: AppHandle,
    engine: State<'_, EngineManager>,
    backend: Option<RuntimeBackendKind>,
    model_path: String,
    profile: inference::ModelTuningProfile,
) -> Result<(), String> {
    if model_path.trim().is_empty() || !Path::new(&model_path).exists() {
        return Err("Selecciona un archivo GGUF válido en disco.".to_string());
    }
    inference::save_model_profile(&model_path, &profile)?;
    let rt = runtime::find_installed_binary(backend.unwrap_or(RuntimeBackendKind::Auto))
        .ok_or_else(|| "No hay runtime llama.cpp instalado.".to_string())?;
    let (load_cfg, _saved) =
        inference::resolve_load_config_with_profile(rt.binary_path, &model_path, None, None);
    let effective_ctx = load_cfg.context_size;
    let model_short = Path::new(&model_path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(&model_path)
        .to_string();
    engine.llama.shutdown().await;
    engine.llama.ensure_loaded(load_cfg).await?;
    let _ = app.emit(
        "loors://engine-event",
        engine::types::EngineEvent::ModelState {
            loaded: true,
            model_name: Some(model_short),
            context_size: Some(effective_ctx),
        },
    );
    Ok(())
}

#[tauri::command]
async fn unload_model(
    app: AppHandle,
    engine: State<'_, EngineManager>,
) -> Result<(), String> {
    engine.llama.shutdown().await;
    let _ = app.emit(
        "loors://engine-event",
        engine::types::EngineEvent::ModelState {
            loaded: false,
            model_name: None,
            context_size: None,
        },
    );
    Ok(())
}

#[tauri::command]
async fn delete_local_model(
    app: AppHandle,
    engine: State<'_, EngineManager>,
    path: String,
) -> Result<(), String> {
    let target = Path::new(path.trim());
    let is_gguf = target
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case("gguf"))
        .unwrap_or(false);
    if !is_gguf {
        return Err("Solo se pueden eliminar archivos .gguf locales.".to_string());
    }
    if !target.exists() {
        return Err("El archivo del modelo no existe en disco.".to_string());
    }
    engine.llama.shutdown().await;
    let _ = app.emit(
        "loors://engine-event",
        engine::types::EngineEvent::ModelState {
            loaded: false,
            model_name: None,
            context_size: None,
        },
    );
    fs::remove_file(target)
        .map_err(|e| format!("No se pudo eliminar el archivo GGUF del disco: {e}"))?;
    Ok(())
}

#[tauri::command]
fn stop_workflow(engine: State<'_, EngineManager>, tab_id: Option<String>) -> Result<(), String> {
    engine.stop_run_for(tab_id.as_deref())
}

#[tauri::command]
fn send_agent_instruction(instruction: String) -> Result<(), String> {
    let trimmed = instruction.trim();
    if trimmed.is_empty() {
        return Err("La instrucción está vacía.".to_string());
    }
    engine::executor::push_live_instruction(trimmed.to_string());
    Ok(())
}

#[tauri::command]
fn resolve_human_gate(
    engine: State<'_, EngineManager>,
    decision: HumanDecision,
    tab_id: Option<String>,
) -> Result<(), String> {
    engine.resolve_human_gate_for(tab_id.as_deref(), decision)
}

#[tauri::command]
fn get_trigger_status(triggers: State<'_, TriggerManager>) -> TriggerStatus {
    triggers.status()
}

#[tauri::command]
async fn start_webhook_trigger(
    app: AppHandle,
    triggers: State<'_, TriggerManager>,
    port: u16,
    graph: WorkflowGraph,
    backend: Option<RuntimeBackendKind>,
) -> Result<String, String> {
    triggers
        .start_webhook(app, port, graph, backend.unwrap_or(RuntimeBackendKind::Auto))
        .await
}

#[tauri::command]
fn stop_webhook_trigger(triggers: State<'_, TriggerManager>) -> Result<(), String> {
    triggers.stop_webhook();
    Ok(())
}

#[tauri::command]
fn start_interval_trigger(
    app: AppHandle,
    triggers: State<'_, TriggerManager>,
    minutes: u64,
    graph: WorkflowGraph,
    backend: Option<RuntimeBackendKind>,
) -> Result<(), String> {
    triggers.start_interval(
        app,
        minutes,
        graph,
        backend.unwrap_or(RuntimeBackendKind::Auto),
    )
}

#[tauri::command]
fn stop_interval_trigger(triggers: State<'_, TriggerManager>) -> Result<(), String> {
    triggers.stop_interval();
    Ok(())
}

#[tauri::command]
fn start_telegram_trigger(
    app: AppHandle,
    triggers: State<'_, TriggerManager>,
    bot_token: String,
    allowed_chat_id: Option<String>,
    graph: WorkflowGraph,
    backend: Option<RuntimeBackendKind>,
) -> Result<(), String> {
    triggers.start_telegram(
        app,
        bot_token,
        allowed_chat_id.unwrap_or_default(),
        graph,
        backend.unwrap_or(RuntimeBackendKind::Auto),
    )
}

#[tauri::command]
fn stop_telegram_trigger(triggers: State<'_, TriggerManager>) -> Result<(), String> {
    triggers.stop_telegram();
    Ok(())
}

#[tauri::command]
fn list_agent_sessions() -> Vec<AgentSessionSummary> {
    list_sessions_in(&sessions_dir())
}

#[tauri::command]
fn load_agent_session(id: String) -> Result<AgentSession, String> {
    load_session_in(&sessions_dir(), &id)
}

#[tauri::command]
fn save_agent_session(session: AgentSession, agent_state: State<'_, AgentChatState>) -> Result<(), String> {
    agent_state.with_idle_session(&session.id, || save_session_in(&sessions_dir(), &session))
}

#[tauri::command]
fn delete_agent_session(id: String, agent_state: State<'_, AgentChatState>) -> Result<(), String> {
    agent_state.with_idle_session(&id, || delete_session_in(&sessions_dir(), &id))
}

#[tauri::command]
async fn run_agent_turn(
    app: AppHandle,
    engine: State<'_, EngineManager>,
    agent_state: State<'_, AgentChatState>,
    backend: Option<RuntimeBackendKind>,
    session: AgentSession,
    user_prompt: String,
    override_ctx: Option<u32>,
    attachments: Option<Vec<String>>,
    turn_id: Option<String>,
) -> Result<AgentSession, String> {
    let is_cloud = inference::cloud::is_cloud_model(&session.model_path);
    if !is_cloud && engine.is_running() {
        return Err("__GPU_BUSY_HARNESS__".to_string());
    }
    if !is_cloud
        && (session.model_path.trim().is_empty() || !Path::new(&session.model_path).exists())
    {
        return Err(
            "Selecciona un modelo GGUF válido o configura un proveedor Cloud/API para chatear en Modo Agente."
                .to_string(),
        );
    }

    let binary_path = if is_cloud {
        let model_short = inference::cloud::parse_cloud_model(&session.model_path)
            .map(|(p, m)| format!("{p}/{m}"))
            .unwrap_or_else(|| session.model_path.clone());
        let _ = app.emit(
            "loors://engine-event",
            engine::types::EngineEvent::ModelState {
                loaded: true,
                model_name: Some(model_short),
                context_size: Some(128_000),
            },
        );
        String::new()
    } else {
        let rt = runtime::find_installed_binary(backend.unwrap_or(RuntimeBackendKind::Auto))
            .ok_or_else(|| {
                "No hay runtime llama.cpp instalado. Abre Runtime para descargarlo.".to_string()
            })?;
        let model_short = Path::new(&session.model_path)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or(&session.model_path)
            .to_string();
        let (preview_cfg, _) = inference::resolve_load_config_with_profile(
            rt.binary_path.clone(),
            &session.model_path,
            override_ctx,
            None,
        );
        let _ = app.emit(
            "loors://engine-event",
            engine::types::EngineEvent::ModelState {
                loaded: true,
                model_name: Some(model_short),
                context_size: Some(inference::llama_cpp::agent_slot_context(preview_cfg.context_size)),
            },
        );
        rt.binary_path
    };

    let app_events = app.clone();

    do_run_agent_turn(
        &engine.llama,
        binary_path,
        &agent_state,
        session,
        user_prompt,
        override_ctx,
        attachments.unwrap_or_default(),
        move |ev| {
            if let Ok(mut payload) = serde_json::to_value(ev) {
                if let Some(object) = payload.as_object_mut() {
                    object.insert("turn_id".into(), serde_json::json!(turn_id));
                }
                let _ = app_events.emit("loors://agent-chat-event", payload);
            }
        },
    )
    .await
}

#[tauri::command]
fn stop_agent_turn(agent_state: State<'_, AgentChatState>, session_id: Option<String>) -> Result<(), String> {
    agent_state.stop_turn(session_id.as_deref());
    Ok(())
}

#[tauri::command]
fn resolve_agent_permission(
    agent_state: State<'_, AgentChatState>,
    decision: PermissionDecision,
    session_id: Option<String>,
) -> Result<(), String> {
    agent_state.resolve_permission(session_id.as_deref(), decision)
}

#[tauri::command]
fn resolve_agent_question(
    agent_state: State<'_, AgentChatState>,
    decision: QuestionDecision,
    session_id: Option<String>,
) -> Result<(), String> {
    agent_state.resolve_question(session_id.as_deref(), decision)
}

#[tauri::command]
fn undo_agent_tool_call(
    session_id: String,
    message_id: String,
    call_id: String,
    agent_state: State<'_, AgentChatState>,
) -> Result<AgentSession, String> {
    agent_state.with_idle_session(&session_id, || {
        undo_tool_call_in_dir(&sessions_dir(), &session_id, &message_id, &call_id)
    })
}

#[tauri::command]
fn get_engine_busy_state(
    engine: State<'_, EngineManager>,
    agent_state: State<'_, AgentChatState>,
) -> serde_json::Value {
    serde_json::json!({
        "harnessRunning": engine.is_running(),
        "agentRunning": agent_state.is_running()
    })
}

#[tauri::command]
fn read_workspace_memory_files(workspace: String) -> Vec<WorkspaceMemoryFileInfo> {
    do_read_workspace_memory_files(&workspace)
}

#[tauri::command]
fn clear_workspace_memory_file(workspace: String, rel_path: String) -> Result<(), String> {
    do_clear_workspace_memory_file(&workspace, &rel_path)
}

#[tauri::command]
async fn find_workspace_files(workspace: String, query: String) -> Vec<String> {
    let out = tools::execute_tool_cancellable(
        &workspace,
        "find_files",
        &serde_json::json!({ "pattern": if query.trim().is_empty() { "." } else { query.trim() } }),
        None,
    )
    .await;
    if out.starts_with("No se encontraron") {
        Vec::new()
    } else {
        out.lines()
            .map(|l| l.trim().to_string())
            .filter(|l| !l.is_empty())
            .take(600)
            .collect()
    }
}

#[tauri::command]
async fn read_workspace_file_preview(workspace: String, rel_path: String) -> Result<String, String> {
    let out = tools::execute_tool_cancellable(
        &workspace,
        "read_file",
        &serde_json::json!({ "path": rel_path, "start_line": 1, "end_line": 300 }),
        None,
    )
    .await;
    Ok(out)
}

#[tauri::command]
async fn browser_interact(
    request: tools::BrowserInteractRequest,
) -> Result<tools::BrowserInteractResponse, String> {
    tools::browser_interact(request).await
}

#[tauri::command]
fn read_screenshot_base64(path: String) -> Result<String, String> {
    use base64::Engine as _;
    let p = Path::new(&path);
    let lower = path.to_lowercase();
    let is_img = lower.ends_with(".png") || lower.ends_with(".jpg") || lower.ends_with(".jpeg") || lower.ends_with(".webp");
    if !is_img || (!lower.contains(".loors") && !p.is_relative()) {
        return Err("Solo se permite previsualizar capturas dentro de .loors/.".to_string());
    }
    let bytes = fs::read(p).map_err(|e| format!("Error leyendo captura: {e}"))?;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .manage(EngineManager::default())
        .manage(AgentChatState::default())
        .manage(ArchitectState::default())
        .manage(TriggerManager::default())
        .manage(ModelDownloadManager::default())
        .setup(|app| {
            let handle = app.handle().clone();
            let handle_cast = app.handle().clone();
            let handle_load = app.handle().clone();
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.maximize();
            }
            tools::set_browser_frame_listener(move |ev| {
                let _ = handle.emit("loors://browser-frame", ev);
            });
            tools::set_browser_screencast_listener(move |ev| {
                let _ = handle_cast.emit("loors://browser-screencast", ev);
            });
            inference::llama_cpp::set_model_load_listener(move |ev| {
                let _ = handle_load.emit("loors://model-load-progress", ev);
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            detect_hardware,
            get_runtime_status,
            install_runtime,
            uninstall_runtime,
            set_custom_runtime_binary,
            scan_local_models,
            search_hf_models,
            list_hf_gguf_files,
            download_hf_model,
            cancel_model_download,
            list_active_model_downloads,
            list_saved_workflows,
            save_workflow_to_library,
            load_workflow_from_library,
            delete_workflow_from_library,
            list_custom_nodes,
            save_custom_node,
            delete_custom_node,
            list_skills,
            test_mcp_server,
            get_workspace_diff,
            ping_engine,
            start_workflow,
            stop_workflow,
            send_agent_instruction,
            pick_folder,
            pick_files,
            stage_uploaded_file,
            get_architect_skill_info,
            get_app_version,
            get_update_repo,
            set_update_repo,
            check_app_update,
            install_app_update,
            get_cloud_providers,
            save_cloud_providers,
            fetch_cloud_provider_models,
            get_mcp_servers,
            save_mcp_servers,
            architect_chat,
            stop_architect_chat,
            unload_model,
            delete_local_model,
            get_model_profile,
            save_model_tuning_profile,
            reload_model_with_profile,
            resolve_human_gate,
            get_trigger_status,
            start_webhook_trigger,
            stop_webhook_trigger,
            start_interval_trigger,
            stop_interval_trigger,
            start_telegram_trigger,
            stop_telegram_trigger,
            list_agent_sessions,
            load_agent_session,
            save_agent_session,
            delete_agent_session,
            run_agent_turn,
            stop_agent_turn,
            resolve_agent_permission,
            resolve_agent_question,
            undo_agent_tool_call,
            get_engine_busy_state,
            read_workspace_memory_files,
            clear_workspace_memory_file,
            find_workspace_files,
            read_workspace_file_preview,
            read_screenshot_base64,
            browser_interact
        ])
        .build(tauri::generate_context!())
        .expect("error while building Loors Tauri application");

    app.run(|app_handle, event| {
        if let RunEvent::Exit = event {
            if let Some(triggers) = app_handle.try_state::<TriggerManager>() {
                triggers.stop_webhook();
                triggers.stop_interval();
                triggers.stop_telegram();
            }
            if let Some(agent_state) = app_handle.try_state::<AgentChatState>() {
                agent_state.stop_turn(None);
            }
            if let Some(architect_state) = app_handle.try_state::<ArchitectState>() {
                architect_state.stop_turn();
            }
            if let Some(engine) = app_handle.try_state::<EngineManager>() {
                let llama = engine.llama.clone();
                tauri::async_runtime::block_on(async move {
                    llama.shutdown().await;
                    tools::shutdown_browser().await;
                });
            }
        }
    });
}
