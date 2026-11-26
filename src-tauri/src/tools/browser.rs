use base64::Engine as _;
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs;
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use tokio::process::{Child, Command};
use tokio::sync::Mutex as AsyncMutex;
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message;

#[derive(Debug, Clone, Serialize)]
pub struct BrowserFrameEvent {
    pub url: String,
    pub title: String,
    pub action: String,
    pub target_label: Option<String>,
    pub cursor_x: Option<f64>,
    pub cursor_y: Option<f64>,
    pub frame_base64: String,
    pub console_errors: Vec<String>,
    pub network_errors: Vec<String>,
}

type FrameCallback = Arc<dyn Fn(BrowserFrameEvent) + Send + Sync>;

static FRAME_LISTENER: OnceLock<Mutex<Option<FrameCallback>>> = OnceLock::new();

pub fn set_browser_frame_listener<F>(cb: F)
where
    F: Fn(BrowserFrameEvent) + Send + Sync + 'static,
{
    let slot = FRAME_LISTENER.get_or_init(|| Mutex::new(None));
    if let Ok(mut guard) = slot.lock() {
        *guard = Some(Arc::new(cb));
    }
}

fn emit_browser_frame(ev: BrowserFrameEvent) {
    if let Some(slot) = FRAME_LISTENER.get() {
        if let Ok(guard) = slot.lock() {
            if let Some(cb) = guard.as_ref() {
                cb(ev);
            }
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BrowserTabInfo {
    pub id: String,
    pub title: String,
    pub url: String,
    pub active: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserInteractRequest {
    pub action: String,
    pub url: Option<String>,
    pub x: Option<f64>,
    pub y: Option<f64>,
    pub button: Option<String>,
    pub click_count: Option<u32>,
    pub delta_x: Option<f64>,
    pub delta_y: Option<f64>,
    pub text: Option<String>,
    pub key: Option<String>,
    pub code: Option<String>,
    pub modifiers: Option<u32>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub tab_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserInteractResponse {
    pub active: bool,
    pub url: String,
    pub title: String,
    pub can_go_back: bool,
    pub can_go_forward: bool,
    pub viewport_width: u32,
    pub viewport_height: u32,
    pub frame_base64: Option<String>,
    pub frame_mime: String,
    pub tabs: Vec<BrowserTabInfo>,
}

struct PersistentBrowser {
    child: Child,
    port: u16,
    headless: bool,
    profile_dir: PathBuf,
    persistent_profile: bool,
    ws_url: String,
    active_target_id: String,
    current_url: String,
    viewport_width: u32,
    viewport_height: u32,
}

static BROWSER_SESSION: OnceLock<AsyncMutex<Option<PersistentBrowser>>> = OnceLock::new();

fn session_mutex() -> &'static AsyncMutex<Option<PersistentBrowser>> {
    BROWSER_SESSION.get_or_init(|| AsyncMutex::new(None))
}

pub async fn shutdown_browser() {
    let mut guard = session_mutex().lock().await;
    if let Some(mut b) = guard.take() {
        let _ = b.child.kill().await;
        if !b.persistent_profile {
            let _ = fs::remove_dir_all(&b.profile_dir);
        }
    }
}

fn normalize_browser_url(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return "about:blank".to_string();
    }
    if trimmed.starts_with("http://")
        || trimmed.starts_with("https://")
        || trimmed.starts_with("about:")
        || trimmed.starts_with("file://")
    {
        return trimmed.to_string();
    }
    if trimmed.starts_with("localhost")
        || trimmed.starts_with("127.0.0.1")
        || trimmed.starts_with("0.0.0.0")
    {
        return format!("http://{trimmed}");
    }
    if !trimmed.contains(' ') && trimmed.contains('.') {
        return format!("https://{trimmed}");
    }
    let encoded: String = trimmed
        .chars()
        .map(|c| match c {
            ' ' => "+".to_string(),
            'A'..='Z' | 'a'..='z' | '0'..='9' | '-' | '_' | '.' | '~' => c.to_string(),
            other => format!("%{:02X}", other as u32),
        })
        .collect();
    format!("https://www.google.com/search?q={encoded}")
}

fn choose_profile_dir(port: u16) -> (PathBuf, bool) {
    if cfg!(test) {
        let dir = std::env::temp_dir().join(format!("loopy-cdp-{port}"));
        let _ = fs::create_dir_all(&dir);
        return (dir, false);
    }
    if let Some(base) = dirs::data_local_dir() {
        let dir = base.join("loopy").join("browser-profile");
        if fs::create_dir_all(&dir).is_ok() {
            return (dir, true);
        }
    }
    let dir = std::env::temp_dir().join(format!("loopy-cdp-{port}"));
    let _ = fs::create_dir_all(&dir);
    (dir, false)
}

async fn start_persistent_browser(width: u32, height: u32) -> Result<PersistentBrowser, String> {
    let browser_bin = match find_system_browser() {
        Some(path) => path,
        None => ensure_portable_browser().await?,
    };
    let port = pick_free_port()?;
    let (profile_dir, persistent_profile) = choose_profile_dir(port);
    let vw = width.clamp(360, 2400);
    let vh = height.clamp(300, 1600);

    let is_headless_shell = browser_bin
        .file_name()
        .and_then(|s| s.to_str())
        .map(|s| s.to_ascii_lowercase().contains("headless-shell"))
        .unwrap_or(false);

    let mut cmd = Command::new(&browser_bin);
    #[cfg(target_os = "windows")]
    cmd.creation_flags(0x0800_0000);
    if !is_headless_shell {
        cmd.arg("--headless=new");
    }
    if is_headless_shell && cfg!(target_os = "linux") {
        cmd.arg("--no-sandbox");
    }
    cmd.args([
        "--disable-gpu",
        "--no-first-run",
        "--no-default-browser-check",
        &format!("--window-size={vw},{vh}"),
        &format!("--remote-debugging-port={port}"),
        &format!("--user-data-dir={}", profile_dir.display()),
        "about:blank",
    ])
    .stdout(Stdio::null())
    .stderr(Stdio::null())
    .kill_on_drop(true);

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to start browser ({}): {e}", browser_bin.display()))?;

    let (target_id, ws_url) = match wait_for_page_target(port).await {
        Ok(res) => res,
        Err(err) => {
            let _ = child.kill().await;
            if !persistent_profile {
                let _ = fs::remove_dir_all(&profile_dir);
            }
            return Err(err);
        }
    };

    Ok(PersistentBrowser {
        child,
        port,
        headless: true,
        profile_dir,
        persistent_profile,
        ws_url,
        active_target_id: target_id,
        current_url: "about:blank".to_string(),
        viewport_width: vw,
        viewport_height: vh,
    })
}

async fn list_cdp_tabs(port: u16, active_id: &str) -> Vec<BrowserTabInfo> {
    let client = reqwest::Client::new();
    let list_url = format!("http://127.0.0.1:{port}/json/list");
    let Ok(resp) = client.get(&list_url).send().await else {
        return Vec::new();
    };
    let Ok(pages) = resp.json::<Vec<Value>>().await else {
        return Vec::new();
    };
    pages
        .into_iter()
        .filter(|p| p.get("type").and_then(|v| v.as_str()) == Some("page"))
        .filter_map(|p| {
            let id = p.get("id")?.as_str()?.to_string();
            let url = p.get("url").and_then(|v| v.as_str()).unwrap_or("about:blank").to_string();
            let raw_title = p.get("title").and_then(|v| v.as_str()).unwrap_or("").trim();
            let title = if raw_title.is_empty() || raw_title == "about:blank" {
                if url == "about:blank" { "New Tab".to_string() } else { url.clone() }
            } else {
                raw_title.to_string()
            };
            Some(BrowserTabInfo {
                active: id == active_id,
                id,
                title,
                url,
            })
        })
        .collect()
}

/// Interactive human-controlled browser command sharing the exact same persistent
/// Chromium CDP session and cookies as the AI agent's `browser_action` tool.
pub async fn browser_interact(req: BrowserInteractRequest) -> Result<BrowserInteractResponse, String> {
    let action = req.action.as_str();

    if action == "open_external" {
        if let Some(url) = req.url.as_deref().map(normalize_browser_url) {
            #[cfg(target_os = "windows")]
            {
                let mut cmd = std::process::Command::new("cmd");
                use std::os::windows::process::CommandExt;
                cmd.creation_flags(0x0800_0000)
                    .args(["/C", "start", "", &url]);
                let _ = cmd.spawn();
            }
            #[cfg(target_os = "macos")]
            {
                let _ = std::process::Command::new("open").arg(&url).spawn();
            }
            #[cfg(target_os = "linux")]
            {
                let _ = std::process::Command::new("xdg-open").arg(&url).spawn();
            }
        }
    }

    let mut guard = session_mutex().lock().await;

    let is_alive = match guard.as_mut() {
        Some(b) => matches!(b.child.try_wait(), Ok(None)),
        None => false,
    };

    if !is_alive {
        if let Some(mut old) = guard.take() {
            let _ = old.child.kill().await;
            if !old.persistent_profile {
                let _ = fs::remove_dir_all(&old.profile_dir);
            }
        }
        // For passive status/refresh/resize when no browser is open yet, don't eagerly spawn Chrome
        if matches!(action, "status" | "refresh" | "resize" | "open_external") {
            return Ok(BrowserInteractResponse {
                active: false,
                url: String::new(),
                title: String::new(),
                can_go_back: false,
                can_go_forward: false,
                viewport_width: req.width.unwrap_or(1024),
                viewport_height: req.height.unwrap_or(760),
                frame_base64: None,
                frame_mime: "image/jpeg".to_string(),
                tabs: Vec::new(),
            });
        }
        let w = req.width.unwrap_or(1024);
        let h = req.height.unwrap_or(760);
        let browser = start_persistent_browser(w, h).await?;
        *guard = Some(browser);
    }

    let session = guard.as_mut().unwrap();
    let client = reqwest::Client::new();

    // Handle tab lifecycle actions before connecting to page WS
    match action {
        "new_tab" => {
            let target_url = req
                .url
                .as_deref()
                .map(normalize_browser_url)
                .unwrap_or_else(|| "about:blank".to_string());
            let endpoint = format!("http://127.0.0.1:{}/json/new?{}", session.port, target_url);
            let resp = client
                .put(&endpoint)
                .send()
                .await
                .or(client.get(&endpoint).send().await)
                .map_err(|e| format!("Failed to create tab: {e}"))?;
            if let Ok(tab_val) = resp.json::<Value>().await {
                if let (Some(id), Some(ws)) = (
                    tab_val.get("id").and_then(|v| v.as_str()),
                    tab_val.get("webSocketDebuggerUrl").and_then(|v| v.as_str()),
                ) {
                    session.active_target_id = id.to_string();
                    session.ws_url = ws.to_string();
                    session.current_url = target_url;
                }
            }
            tokio::time::sleep(Duration::from_millis(350)).await;
        }
        "switch_tab" => {
            if let Some(tid) = req.tab_id.as_deref() {
                let list_url = format!("http://127.0.0.1:{}/json/list", session.port);
                if let Ok(resp) = client.get(&list_url).send().await {
                    if let Ok(pages) = resp.json::<Vec<Value>>().await {
                        if let Some(found) = pages.into_iter().find(|p| {
                            p.get("id").and_then(|v| v.as_str()) == Some(tid)
                        }) {
                            if let Some(ws) = found.get("webSocketDebuggerUrl").and_then(|v| v.as_str()) {
                                session.active_target_id = tid.to_string();
                                session.ws_url = ws.to_string();
                                session.current_url = found
                                    .get("url")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("about:blank")
                                    .to_string();
                                let _ = client
                                    .get(&format!("http://127.0.0.1:{}/json/activate/{}", session.port, tid))
                                    .send()
                                    .await;
                            }
                        }
                    }
                }
            }
        }
        "close_tab" => {
            if let Some(tid) = req.tab_id.as_deref() {
                let _ = client
                    .get(&format!("http://127.0.0.1:{}/json/close/{}", session.port, tid))
                    .send()
                    .await;
                tokio::time::sleep(Duration::from_millis(120)).await;
                let tabs = list_cdp_tabs(session.port, &session.active_target_id).await;
                if tabs.is_empty() {
                    if let Some(mut old) = guard.take() {
                        let _ = old.child.kill().await;
                        if !old.persistent_profile {
                            let _ = fs::remove_dir_all(&old.profile_dir);
                        }
                    }
                    return Ok(BrowserInteractResponse {
                        active: false,
                        url: String::new(),
                        title: String::new(),
                        can_go_back: false,
                        can_go_forward: false,
                        viewport_width: req.width.unwrap_or(1024),
                        viewport_height: req.height.unwrap_or(760),
                        frame_base64: None,
                        frame_mime: "image/jpeg".to_string(),
                        tabs: Vec::new(),
                    });
                }
                if tid == session.active_target_id {
                    if let Ok((new_id, new_ws)) = wait_for_page_target(session.port).await {
                        session.active_target_id = new_id;
                        session.ws_url = new_ws;
                    }
                }
            }
        }
        _ => {}
    }

    let (mut ws, _) = connect_async(&session.ws_url)
        .await
        .map_err(|e| format!("CDP WebSocket error: {e}"))?;
    let mut next_id: u64 = 1;

    // Apply viewport dimensions if requested or changed
    if let (Some(w), Some(h)) = (req.width, req.height) {
        let vw = w.clamp(360, 2400);
        let vh = h.clamp(300, 1600);
        if vw != session.viewport_width || vh != session.viewport_height || action == "resize" || action == "navigate" || action == "new_tab" {
            let _ = cdp_call(
                &mut ws,
                &mut next_id,
                "Emulation.setDeviceMetricsOverride",
                json!({
                    "width": vw,
                    "height": vh,
                    "deviceScaleFactor": 1,
                    "mobile": false
                }),
            )
            .await;
            session.viewport_width = vw;
            session.viewport_height = vh;
        }
    }

    match action {
        "navigate" => {
            if let Some(raw_url) = req.url.as_deref() {
                let norm = normalize_browser_url(raw_url);
                cdp_call(&mut ws, &mut next_id, "Page.enable", json!({})).await?;
                cdp_call(&mut ws, &mut next_id, "Page.navigate", json!({ "url": norm })).await?;
                session.current_url = norm;
                tokio::time::sleep(Duration::from_millis(850)).await;
            }
        }
        "reload" => {
            let _ = cdp_call(&mut ws, &mut next_id, "Page.reload", json!({ "ignoreCache": false })).await;
            tokio::time::sleep(Duration::from_millis(700)).await;
        }
        "back" | "forward" => {
            if let Ok(hist) = cdp_call(&mut ws, &mut next_id, "Page.getNavigationHistory", json!({})).await {
                let idx = hist.get("currentIndex").and_then(|v| v.as_i64()).unwrap_or(0);
                let entries = hist.get("entries").and_then(|v| v.as_array());
                let target_idx = if action == "back" { idx - 1 } else { idx + 1 };
                if let Some(entry_id) = entries
                    .and_then(|arr| arr.get(target_idx as usize))
                    .and_then(|e| e.get("id"))
                    .and_then(|v| v.as_i64())
                {
                    let _ = cdp_call(
                        &mut ws,
                        &mut next_id,
                        "Page.navigateToHistoryEntry",
                        json!({ "entryId": entry_id }),
                    )
                    .await;
                    tokio::time::sleep(Duration::from_millis(550)).await;
                }
            }
        }
        "click" => {
            let cx = req.x.unwrap_or(0.0);
            let cy = req.y.unwrap_or(0.0);
            let btn = req.button.as_deref().unwrap_or("left");
            let clicks = req.click_count.unwrap_or(1);
            let _ = cdp_call(
                &mut ws,
                &mut next_id,
                "Input.dispatchMouseEvent",
                json!({ "type": "mouseMoved", "x": cx, "y": cy }),
            )
            .await;
            let _ = cdp_call(
                &mut ws,
                &mut next_id,
                "Input.dispatchMouseEvent",
                json!({ "type": "mousePressed", "x": cx, "y": cy, "button": btn, "clickCount": clicks }),
            )
            .await;
            let _ = cdp_call(
                &mut ws,
                &mut next_id,
                "Input.dispatchMouseEvent",
                json!({ "type": "mouseReleased", "x": cx, "y": cy, "button": btn, "clickCount": clicks }),
            )
            .await;
            tokio::time::sleep(Duration::from_millis(180)).await;
        }
        "wheel" => {
            let cx = req.x.unwrap_or((session.viewport_width / 2) as f64);
            let cy = req.y.unwrap_or((session.viewport_height / 2) as f64);
            let dx = req.delta_x.unwrap_or(0.0);
            let dy = req.delta_y.unwrap_or(0.0);
            let _ = cdp_call(
                &mut ws,
                &mut next_id,
                "Input.dispatchMouseEvent",
                json!({ "type": "mouseWheel", "x": cx, "y": cy, "deltaX": dx, "deltaY": dy }),
            )
            .await;
            tokio::time::sleep(Duration::from_millis(60)).await;
        }
        "text" => {
            if let Some(txt) = req.text.as_deref() {
                if !txt.is_empty() {
                    let _ = cdp_call(&mut ws, &mut next_id, "Input.insertText", json!({ "text": txt })).await;
                    tokio::time::sleep(Duration::from_millis(60)).await;
                }
            }
        }
        "key" => {
            if let Some(k) = req.key.as_deref() {
                let code = req.code.as_deref().unwrap_or("");
                let mods = req.modifiers.unwrap_or(0);
                let mut payload_down = json!({ "type": "keyDown", "key": k, "modifiers": mods });
                let mut payload_up = json!({ "type": "keyUp", "key": k, "modifiers": mods });
                if !code.is_empty() {
                    payload_down["code"] = json!(code);
                    payload_up["code"] = json!(code);
                }
                if k == "Enter" {
                    payload_down["windowsVirtualKeyCode"] = json!(13);
                    payload_down["nativeVirtualKeyCode"] = json!(13);
                    payload_down["text"] = json!("\r");
                    payload_up["windowsVirtualKeyCode"] = json!(13);
                } else if k == "Backspace" {
                    payload_down["windowsVirtualKeyCode"] = json!(8);
                    payload_up["windowsVirtualKeyCode"] = json!(8);
                } else if k == "Tab" {
                    payload_down["windowsVirtualKeyCode"] = json!(9);
                    payload_up["windowsVirtualKeyCode"] = json!(9);
                } else if k == "Escape" {
                    payload_down["windowsVirtualKeyCode"] = json!(27);
                    payload_up["windowsVirtualKeyCode"] = json!(27);
                }
                let _ = cdp_call(&mut ws, &mut next_id, "Input.dispatchKeyEvent", payload_down).await;
                let _ = cdp_call(&mut ws, &mut next_id, "Input.dispatchKeyEvent", payload_up).await;
                let wait_ms = if k == "Enter" { 350 } else { 70 };
                tokio::time::sleep(Duration::from_millis(wait_ms)).await;
            }
        }
        _ => {}
    }

    // Query navigation history for back/forward state
    let (can_go_back, can_go_forward, hist_url, hist_title) =
        match cdp_call(&mut ws, &mut next_id, "Page.getNavigationHistory", json!({})).await {
            Ok(hist) => {
                let idx = hist.get("currentIndex").and_then(|v| v.as_i64()).unwrap_or(0);
                let entries = hist.get("entries").and_then(|v| v.as_array());
                let len = entries.map(|a| a.len() as i64).unwrap_or(0);
                let cur = entries.and_then(|a| a.get(idx as usize));
                let u = cur.and_then(|e| e.get("url")).and_then(|v| v.as_str()).unwrap_or("").to_string();
                let t = cur.and_then(|e| e.get("title")).and_then(|v| v.as_str()).unwrap_or("").to_string();
                (idx > 0, idx + 1 < len, u, t)
            }
            Err(_) => (false, false, String::new(), String::new()),
        };

    if !hist_url.is_empty() {
        session.current_url = hist_url.clone();
    }

    let frame_base64 = cdp_call(
        &mut ws,
        &mut next_id,
        "Page.captureScreenshot",
        json!({ "format": "jpeg", "quality": 86 }),
    )
    .await
    .ok()
    .and_then(|v| v.get("data").and_then(|d| d.as_str()).map(|s| s.to_string()));

    let tabs = list_cdp_tabs(session.port, &session.active_target_id).await;

    Ok(BrowserInteractResponse {
        active: true,
        url: if !hist_url.is_empty() { hist_url } else { session.current_url.clone() },
        title: hist_title,
        can_go_back,
        can_go_forward,
        viewport_width: session.viewport_width,
        viewport_height: session.viewport_height,
        frame_base64,
        frame_mime: "image/jpeg".to_string(),
        tabs,
    })
}

/// Pure-Rust embedded browser driver using Chrome DevTools Protocol (CDP).
/// Zero Node.js or Playwright dependencies: compiles directly into loopy.exe
/// and keeps a persistent Edge/Chrome session alive across steps with live mouse cursor overlay.
pub async fn run_browser_action(workspace: &str, args: &Value) -> String {
    let action = args
        .get("action")
        .and_then(|v| v.as_str())
        .unwrap_or("snapshot");

    if action == "close" {
        shutdown_browser().await;
        return json!({ "ok": true, "closed": true }).to_string();
    }

    // Always run headless so the browser stays embedded inside Loopy's Live Browser panel
    // instead of popping open external Edge/Chrome windows on the desktop.
    let want_headless = true;
    let selector = args.get("selector").and_then(|v| v.as_str()).unwrap_or("");
    let text = args.get("text").and_then(|v| v.as_str()).unwrap_or("");
    let key = args.get("key").and_then(|v| v.as_str()).unwrap_or("");
    let script = args.get("script").and_then(|v| v.as_str()).unwrap_or("");
    let direction = args
        .get("direction")
        .and_then(|v| v.as_str())
        .unwrap_or("down");
    let screenshot_rel = args.get("screenshotPath").and_then(|v| v.as_str());
    let req_url = args
        .get("url")
        .and_then(|v| v.as_str())
        .map(|s| s.trim())
        .filter(|s| !s.is_empty());

    let ws_root = if workspace.trim().is_empty() || workspace == "." {
        std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
    } else {
        PathBuf::from(workspace)
    };
    let state_path = ws_root.join(".loopy").join("browser_state.json");

    let mut guard = session_mutex().lock().await;

    let needs_restart = match guard.as_mut() {
        None => true,
        Some(b) => !matches!(b.child.try_wait(), Ok(None)) || b.headless != want_headless,
    };

    if needs_restart {
        if let Some(mut old) = guard.take() {
            let _ = old.child.kill().await;
            if !old.persistent_profile {
                let _ = fs::remove_dir_all(&old.profile_dir);
            }
        }

        let Some(first_url) = req_url.map(|s| s.to_string()).or_else(|| {
            fs::read_to_string(&state_path)
                .ok()
                .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
                .and_then(|v| v.get("lastUrl").and_then(|u| u.as_str()).map(|s| s.to_string()))
        }) else {
            return json!({
                "ok": false,
                "error": "Proporciona 'url' en la primera llamada a browser_action (ej. action='goto', url='https://...')."
            })
            .to_string();
        };

        let browser = match start_persistent_browser(1280, 840).await {
            Ok(b) => b,
            Err(err) => return json!({ "ok": false, "error": err }).to_string(),
        };

        *guard = Some(browser);

        let session = guard.as_mut().unwrap();
        let res = drive_cdp_action(
            session,
            action,
            Some(&first_url),
            selector,
            text,
            key,
            script,
            direction,
            screenshot_rel,
            &ws_root,
            &state_path,
        )
        .await;

        return match res {
            Ok(val) => val.to_string(),
            Err(err) => {
                if let Some(mut old) = guard.take() {
                    let _ = old.child.kill().await;
                    if !old.persistent_profile {
                        let _ = fs::remove_dir_all(&old.profile_dir);
                    }
                }
                json!({ "ok": false, "error": err }).to_string()
            }
        };
    }

    let session = guard.as_mut().unwrap();
    let res = drive_cdp_action(
        session,
        action,
        req_url,
        selector,
        text,
        key,
        script,
        direction,
        screenshot_rel,
        &ws_root,
        &state_path,
    )
    .await;

    match res {
        Ok(val) => val.to_string(),
        Err(err) => {
            if let Some(mut old) = guard.take() {
                let _ = old.child.kill().await;
                let _ = fs::remove_dir_all(&old.profile_dir);
            }
            json!({ "ok": false, "error": err }).to_string()
        }
    }
}

async fn wait_for_page_target(port: u16) -> Result<(String, String), String> {
    let client = reqwest::Client::new();
    let list_url = format!("http://127.0.0.1:{port}/json/list");

    for _ in 0..45 {
        if let Ok(resp) = client.get(&list_url).send().await {
            if let Ok(pages) = resp.json::<Vec<Value>>().await {
                if let Some(found) = pages.iter().find_map(|p| {
                    if p.get("type").and_then(|v| v.as_str()) == Some("page") {
                        let id = p.get("id").and_then(|v| v.as_str())?.to_string();
                        let ws = p
                            .get("webSocketDebuggerUrl")
                            .and_then(|v| v.as_str())?
                            .to_string();
                        Some((id, ws))
                    } else {
                        None
                    }
                }) {
                    return Ok(found);
                }
            }
        }
        tokio::time::sleep(Duration::from_millis(140)).await;
    }
    Err("Timeout connecting to local browser CDP port.".to_string())
}

const HOOK_SCRIPT: &str = r##"(() => {
    if (window.__loopyHooked) return;
    window.__loopyHooked = true;
    window.__loopyConsoleErrors = window.__loopyConsoleErrors || [];
    window.__loopyNetworkErrors = window.__loopyNetworkErrors || [];
    const origError = console.error;
    console.error = function(...args) {
        try {
            const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ').slice(0, 240);
            window.__loopyConsoleErrors.push(msg);
            if (window.__loopyConsoleErrors.length > 30) window.__loopyConsoleErrors.shift();
        } catch {}
        return origError.apply(console, args);
    };
    window.addEventListener('error', (e) => {
        try {
            window.__loopyConsoleErrors.push((e.message || 'JS Error') + ' @' + (e.filename || '') + ':' + (e.lineno || 0));
            if (window.__loopyConsoleErrors.length > 30) window.__loopyConsoleErrors.shift();
        } catch {}
    });
    window.addEventListener('unhandledrejection', (e) => {
        try {
            window.__loopyConsoleErrors.push('UnhandledRejection: ' + String(e.reason || '').slice(0, 200));
            if (window.__loopyConsoleErrors.length > 30) window.__loopyConsoleErrors.shift();
        } catch {}
    });
    if (window.fetch) {
        const origFetch = window.fetch;
        window.fetch = async function(...args) {
            try {
                const resp = await origFetch.apply(this, args);
                if (!resp.ok && resp.status >= 400) {
                    window.__loopyNetworkErrors.push(`HTTP ${resp.status} ${resp.url || ''}`.slice(0, 200));
                    if (window.__loopyNetworkErrors.length > 30) window.__loopyNetworkErrors.shift();
                }
                return resp;
            } catch (err) {
                window.__loopyNetworkErrors.push(`FETCH FAIL ${String(args[0] || '')}: ${String(err)}`.slice(0, 200));
                if (window.__loopyNetworkErrors.length > 30) window.__loopyNetworkErrors.shift();
                throw err;
            }
        };
    }
})()"##;

#[allow(clippy::too_many_arguments)]
async fn drive_cdp_action(
    session: &mut PersistentBrowser,
    action: &str,
    req_url: Option<&str>,
    selector: &str,
    text: &str,
    key: &str,
    script: &str,
    direction: &str,
    screenshot_rel: Option<&str>,
    ws_root: &Path,
    state_path: &Path,
) -> Result<Value, String> {
    let (mut ws, _) = connect_async(&session.ws_url)
        .await
        .map_err(|e| format!("Error WebSocket CDP: {e}"))?;

    let mut next_id: u64 = 1;
    cdp_call(&mut ws, &mut next_id, "Page.enable", json!({})).await?;
    cdp_call(&mut ws, &mut next_id, "Runtime.enable", json!({})).await?;
    let _ = cdp_call(
        &mut ws,
        &mut next_id,
        "Page.addScriptToEvaluateOnNewDocument",
        json!({ "source": HOOK_SCRIPT }),
    )
    .await;

    // Only navigate if action == "goto" or first load or url explicitly changed
    if let Some(url) = req_url {
        let should_nav = action == "goto"
            || session.current_url == "about:blank"
            || !same_url(&session.current_url, url);
        if should_nav {
            cdp_call(&mut ws, &mut next_id, "Page.navigate", json!({ "url": url })).await?;
            tokio::time::sleep(Duration::from_millis(1300)).await;
            session.current_url = url.to_string();
        }
    }

    let _ = cdp_eval(&mut ws, &mut next_id, HOOK_SCRIPT).await;

    let mut cursor_x: Option<f64> = None;
    let mut cursor_y: Option<f64> = None;
    let mut target_label: Option<String> = None;
    let mut action_note = String::new();
    let mut eval_result: Option<String> = None;

    match action {
        "click" | "hover" if !selector.is_empty() => {
            let sel_json = serde_json::to_string(selector).unwrap_or_else(|_| "\"\"".into());
            let act_label = if action == "hover" { "Hover" } else { "Click" };
            let locate_js = format!(
                r##"JSON.stringify((() => {{
                    const q = {sel_json}.trim();
                    const els = Array.from(document.querySelectorAll("a, button, input, textarea, select, [role='button']"));
                    let el = null;
                    const idxMatch = q.match(/^\[?(\d+)\]?$/);
                    if (idxMatch) {{
                        const idx = parseInt(idxMatch[1], 10) - 1;
                        if (idx >= 0 && idx < els.length) el = els[idx];
                    }}
                    if (!el) {{
                        try {{ el = document.querySelector(q); }} catch {{}}
                    }}
                    if (!el) {{
                        const ql = q.toLowerCase();
                        el = els.find(e => ((e.innerText || e.getAttribute("aria-label") || e.getAttribute("placeholder") || e.getAttribute("name") || "").toLowerCase().includes(ql)));
                    }}
                    if (!el) return {{ found: false, error: "Elemento no encontrado: " + q }};
                    el.scrollIntoView({{ block: "center", behavior: "instant" }});
                    const r = el.getBoundingClientRect();
                    const cx = Math.round(r.left + r.width / 2);
                    const cy = Math.round(r.top + r.height / 2);
                    const lbl = (el.innerText || el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.tagName).replace(/\s+/g, " ").trim().slice(0, 48);
                    let ov = document.getElementById("__loopy_ai_cursor__");
                    if (ov) ov.remove();
                    ov = document.createElement("div");
                    ov.id = "__loopy_ai_cursor__";
                    ov.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483647;";
                    ov.innerHTML = `
                        <div style="position:fixed;left:${{r.left-2}}px;top:${{r.top-2}}px;width:${{r.width+4}}px;height:${{r.height+4}}px;border:2px solid #6366f1;background:rgba(99,102,241,0.16);border-radius:6px;box-shadow:0 0 14px rgba(99,102,241,0.55);"></div>
                        <div style="position:fixed;left:${{cx-14}}px;top:${{cy-14}}px;width:28px;height:28px;border:2px solid #f59e0b;border-radius:999px;background:rgba(245,158,11,0.22);"></div>
                        <svg style="position:fixed;left:${{cx}}px;top:${{cy}}px;filter:drop-shadow(0 2px 4px rgba(0,0,0,0.8));" width="22" height="22" viewBox="0 0 24 24" fill="#fff" stroke="#0f172a" stroke-width="1.8"><path d="M4 2l15 9-7 2-3 7z"/></svg>
                        <div style="position:fixed;left:${{Math.min(cx+18, window.innerWidth-220)}}px;top:${{Math.max(cy+18, 8)}}px;background:#0f172a;color:#e2e8f0;border:1px solid #6366f1;border-radius:6px;padding:3px 8px;font:600 11px system-ui,sans-serif;white-space:nowrap;box-shadow:0 6px 16px rgba(0,0,0,0.5);">${{"{act_label}"}}: ${{lbl.replace(/</g,'&lt;')}}</div>
                    `;
                    document.documentElement.appendChild(ov);
                    return {{ found: true, cx, cy, label: lbl }};
                }})())"##
            );

            let loc_raw = cdp_eval(&mut ws, &mut next_id, &locate_js).await?;
            let loc: Value = serde_json::from_str(&loc_raw).unwrap_or_else(|_| json!({}));
            if loc.get("found").and_then(|v| v.as_bool()) == Some(true) {
                let cx = loc.get("cx").and_then(|v| v.as_f64()).unwrap_or(0.0);
                let cy = loc.get("cy").and_then(|v| v.as_f64()).unwrap_or(0.0);
                cursor_x = Some(cx);
                cursor_y = Some(cy);
                target_label = loc
                    .get("label")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());

                // Capture pre-click visual frame with cursor and highlight in place
                let _ = capture_and_emit(
                    &mut ws,
                    &mut next_id,
                    ws_root,
                    screenshot_rel,
                    action,
                    target_label.clone(),
                    cursor_x,
                    cursor_y,
                )
                .await;

                let _ = cdp_call(
                    &mut ws,
                    &mut next_id,
                    "Input.dispatchMouseEvent",
                    json!({ "type": "mouseMoved", "x": cx, "y": cy }),
                )
                .await;
                if action == "click" {
                    let _ = cdp_call(
                        &mut ws,
                        &mut next_id,
                        "Input.dispatchMouseEvent",
                        json!({ "type": "mousePressed", "x": cx, "y": cy, "button": "left", "clickCount": 1 }),
                    )
                    .await;
                    let _ = cdp_call(
                        &mut ws,
                        &mut next_id,
                        "Input.dispatchMouseEvent",
                        json!({ "type": "mouseReleased", "x": cx, "y": cy, "button": "left", "clickCount": 1 }),
                    )
                    .await;
                    tokio::time::sleep(Duration::from_millis(750)).await;
                }
                let _ = cdp_eval(
                    &mut ws,
                    &mut next_id,
                    "document.getElementById('__loopy_ai_cursor__')?.remove()",
                )
                .await;
                action_note = format!("{act_label} en ({cx}, {cy}) sobre {}", target_label.clone().unwrap_or_default());
            } else {
                action_note = loc
                    .get("error")
                    .and_then(|v| v.as_str())
                    .unwrap_or("Elemento no encontrado")
                    .to_string();
            }
        }
        "type" if !selector.is_empty() => {
            let sel_json = serde_json::to_string(selector).unwrap_or_else(|_| "\"\"".into());
            let txt_json = serde_json::to_string(text).unwrap_or_else(|_| "\"\"".into());
            let js = format!(
                r##"JSON.stringify((() => {{
                    const q = {sel_json}.trim();
                    const els = Array.from(document.querySelectorAll("a, button, input, textarea, select, [role='button']"));
                    let el = null;
                    const idxMatch = q.match(/^\[?(\d+)\]?$/);
                    if (idxMatch) {{
                        const idx = parseInt(idxMatch[1], 10) - 1;
                        if (idx >= 0 && idx < els.length) el = els[idx];
                    }}
                    if (!el) {{ try {{ el = document.querySelector(q); }} catch {{}} }}
                    if (!el) {{
                        const ql = q.toLowerCase();
                        el = els.find(e => ((e.getAttribute("placeholder") || e.getAttribute("aria-label") || e.getAttribute("name") || "").toLowerCase().includes(ql)));
                    }}
                    if (!el) return {{ ok: false, error: "Input no encontrado: " + q }};
                    el.scrollIntoView({{ block: "center", behavior: "instant" }});
                    el.focus();
                    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
                        || Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
                    if (nativeSetter && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) {{
                        nativeSetter.call(el, {txt_json});
                    }} else {{
                        el.value = {txt_json};
                    }}
                    el.dispatchEvent(new Event("input", {{ bubbles: true }}));
                    el.dispatchEvent(new Event("change", {{ bubbles: true }}));
                    const r = el.getBoundingClientRect();
                    return {{ ok: true, cx: Math.round(r.left + r.width/2), cy: Math.round(r.top + r.height/2) }};
                }})())"##
            );
            let res_raw = cdp_eval(&mut ws, &mut next_id, &js).await?;
            if let Ok(v) = serde_json::from_str::<Value>(&res_raw) {
                cursor_x = v.get("cx").and_then(|x| x.as_f64());
                cursor_y = v.get("cy").and_then(|y| y.as_f64());
                target_label = Some(format!("Escribir \"{text}\""));
            }
            action_note = format!("Typed en {selector}");
        }
        "press" if !key.is_empty() => {
            let _ = cdp_call(
                &mut ws,
                &mut next_id,
                "Input.dispatchKeyEvent",
                json!({ "type": "keyDown", "key": key }),
            )
            .await;
            let _ = cdp_call(
                &mut ws,
                &mut next_id,
                "Input.dispatchKeyEvent",
                json!({ "type": "keyUp", "key": key }),
            )
            .await;
            tokio::time::sleep(Duration::from_millis(650)).await;
            action_note = format!("Pressed key {key}");
        }
        "scroll" => {
            let delta = if direction == "up" { -650 } else { 650 };
            let _ = cdp_eval(&mut ws, &mut next_id, &format!("window.scrollBy(0, {delta})")).await;
            tokio::time::sleep(Duration::from_millis(350)).await;
            action_note = format!("Scroll {direction}");
        }
        "evaluate" if !script.is_empty() => {
            eval_result = Some(cdp_eval(&mut ws, &mut next_id, script).await?);
            action_note = "JS evaluado".to_string();
        }
        _ => {}
    }

    // Always capture final screenshot of the action so live viewer updates smoothly
    let (saved_screenshot, b64_frame) = capture_and_emit(
        &mut ws,
        &mut next_id,
        ws_root,
        screenshot_rel,
        action,
        target_label.clone(),
        cursor_x,
        cursor_y,
    )
    .await;

    // Capture structured DOM snapshot + JS console / network audit
    let snapshot_js = r##"JSON.stringify((() => {
        const els = Array.from(document.querySelectorAll("a, button, input, textarea, select, [role='button']"));
        const interactive = els.slice(0, 75).map((el, i) => {
            const tag = el.tagName.toLowerCase();
            const id = el.id ? "#" + el.id : "";
            const label = (el.innerText || el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.getAttribute("name") || el.getAttribute("href") || "").replace(/\s+/g, " ").trim().slice(0, 70);
            return `[${i + 1}] <${tag}${id}> ${label}`;
        });
        const text = (document.body?.innerText || "").replace(/\s+/g, " ").trim().slice(0, 3200);
        return {
            url: location.href,
            title: document.title,
            interactive,
            text,
            console_errors: window.__loopyConsoleErrors || [],
            network_errors: window.__loopyNetworkErrors || []
        };
    })())"##;

    let snap_raw = cdp_eval(&mut ws, &mut next_id, snapshot_js).await?;
    let snap: Value = serde_json::from_str(&snap_raw).unwrap_or_else(|_| json!({ "raw": snap_raw }));

    let final_url = snap
        .get("url")
        .and_then(|v| v.as_str())
        .unwrap_or(&session.current_url)
        .to_string();
    let final_title = snap
        .get("title")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let console_errors: Vec<String> = snap
        .get("console_errors")
        .and_then(|v| v.as_array())
        .map(|arr| arr.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect())
        .unwrap_or_default();
    let network_errors: Vec<String> = snap
        .get("network_errors")
        .and_then(|v| v.as_array())
        .map(|arr| arr.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect())
        .unwrap_or_default();

    session.current_url = final_url.clone();
    if let Some(parent) = state_path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let _ = fs::write(
        state_path,
        serde_json::to_string_pretty(&json!({ "lastUrl": final_url })).unwrap_or_default(),
    );

    if let Some(frame) = b64_frame {
        emit_browser_frame(BrowserFrameEvent {
            url: final_url.clone(),
            title: final_title.clone(),
            action: action.to_string(),
            target_label: target_label.clone(),
            cursor_x,
            cursor_y,
            frame_base64: frame,
            console_errors: console_errors.clone(),
            network_errors: network_errors.clone(),
        });
    }

    let interactive_val = snap.get("interactive").cloned().unwrap_or(json!([]));
    let text_val = snap.get("text").cloned().unwrap_or(json!(""));
    let interactive_len = interactive_val.as_array().map(|a| a.len()).unwrap_or(0);
    let text_trimmed_len = text_val.as_str().map(|s| s.trim().len()).unwrap_or(0);
    let lower_url = final_url.to_ascii_lowercase();
    let looks_parked_or_blank = (interactive_len <= 1 && text_trimmed_len < 40)
        || lower_url.ends_with("/lander")
        || lower_url.contains("sedoparking")
        || lower_url.contains("parkingcrew");

    let warning = if looks_parked_or_blank {
        Some(format!(
            "WARNING: The page '{}' appears BLANK or a PARKED DOMAIN ({} interactive elements, {} chars of visible text). Do NOT invent buttons or keep scrolling/clicking here — use web_search to find the official URL or navigate to another domain.",
            final_url, interactive_len, text_trimmed_len
        ))
    } else {
        None
    };

    Ok(json!({
        "ok": true,
        "engine": "persistent-rust-cdp",
        "port": session.port,
        "url": final_url,
        "title": final_title,
        "action_note": action_note,
        "warning": warning,
        "cursor": { "x": cursor_x, "y": cursor_y, "label": target_label },
        "screenshot": saved_screenshot,
        "console_errors": console_errors,
        "network_errors": network_errors,
        "eval_result": eval_result,
        "interactive": interactive_val,
        "text": text_val
    }))
}

#[allow(clippy::too_many_arguments)]
async fn capture_and_emit<S>(
    ws: &mut S,
    next_id: &mut u64,
    ws_root: &Path,
    screenshot_rel: Option<&str>,
    action: &str,
    target_label: Option<String>,
    cursor_x: Option<f64>,
    cursor_y: Option<f64>,
) -> (Option<String>, Option<String>)
where
    S: futures_util::Stream<Item = Result<Message, tokio_tungstenite::tungstenite::Error>>
        + futures_util::Sink<Message, Error = tokio_tungstenite::tungstenite::Error>
        + Unpin,
{
    let Ok(shot) = cdp_call(
        ws,
        next_id,
        "Page.captureScreenshot",
        json!({ "format": "png" }),
    )
    .await
    else {
        return (None, None);
    };

    let Some(b64) = shot.get("data").and_then(|v| v.as_str()) else {
        return (None, None);
    };

    let mut saved_path = None;
    if let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(b64) {
        let rel = screenshot_rel.unwrap_or(".loopy/screenshot.png");
        let out_path = ws_root.join(rel);
        if let Some(parent) = out_path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        if fs::write(&out_path, bytes).is_ok() {
            saved_path = Some(out_path.to_string_lossy().to_string());
        }
    }

    if cursor_x.is_some() {
        emit_browser_frame(BrowserFrameEvent {
            url: String::new(),
            title: String::new(),
            action: format!("{action} (cursor)"),
            target_label,
            cursor_x,
            cursor_y,
            frame_base64: b64.to_string(),
            console_errors: Vec::new(),
            network_errors: Vec::new(),
        });
    }

    (saved_path, Some(b64.to_string()))
}

fn same_url(a: &str, b: &str) -> bool {
    a.trim().trim_end_matches('/') == b.trim().trim_end_matches('/')
}

async fn cdp_eval<S>(ws: &mut S, next_id: &mut u64, expression: &str) -> Result<String, String>
where
    S: futures_util::Stream<Item = Result<Message, tokio_tungstenite::tungstenite::Error>>
        + futures_util::Sink<Message, Error = tokio_tungstenite::tungstenite::Error>
        + Unpin,
{
    let res = cdp_call(
        ws,
        next_id,
        "Runtime.evaluate",
        json!({
            "expression": expression,
            "returnByValue": true
        }),
    )
    .await?;
    Ok(res
        .get("result")
        .and_then(|r| r.get("value"))
        .and_then(|v| {
            v.as_str()
                .map(|s| s.to_string())
                .or_else(|| Some(v.to_string()))
        })
        .unwrap_or_default())
}

async fn cdp_call<S>(
    ws: &mut S,
    next_id: &mut u64,
    method: &str,
    params: Value,
) -> Result<Value, String>
where
    S: futures_util::Stream<Item = Result<Message, tokio_tungstenite::tungstenite::Error>>
        + futures_util::Sink<Message, Error = tokio_tungstenite::tungstenite::Error>
        + Unpin,
{
    let id = *next_id;
    *next_id += 1;

    let payload = json!({
        "id": id,
        "method": method,
        "params": params
    });

    ws.send(Message::Text(payload.to_string().into()))
        .await
        .map_err(|e| format!("Error enviando CDP '{method}': {e}"))?;

    let fut = async {
        while let Some(msg) = ws.next().await {
            let msg = msg.map_err(|e| format!("Error leyendo CDP: {e}"))?;
            if let Message::Text(txt) = msg {
                if let Ok(val) = serde_json::from_str::<Value>(&txt) {
                    if val.get("id").and_then(|v| v.as_u64()) == Some(id) {
                        if let Some(err) = val.get("error") {
                            return Err(format!("Error CDP '{method}': {err}"));
                        }
                        return Ok(val.get("result").cloned().unwrap_or(Value::Null));
                    }
                }
            }
        }
        Err("Conexión CDP cerrada inesperadamente.".to_string())
    };

    tokio::time::timeout(Duration::from_secs(20), fut)
        .await
        .map_err(|_| format!("Timeout esperando respuesta CDP '{method}'."))?
}

fn portable_browser_dir() -> PathBuf {
    dirs::data_local_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join("loopy")
        .join("browser")
}

fn find_portable_browser() -> Option<PathBuf> {
    let root = portable_browser_dir();
    if !root.exists() {
        return None;
    }
    let target_name = if cfg!(target_os = "windows") {
        "chrome-headless-shell.exe"
    } else {
        "chrome-headless-shell"
    };
    find_binary_recursive(&root, target_name, 4)
}

fn find_binary_recursive(dir: &Path, filename: &str, depth: usize) -> Option<PathBuf> {
    if depth == 0 {
        return None;
    }
    let entries = fs::read_dir(dir).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_file() {
            if path
                .file_name()
                .and_then(|s| s.to_str())
                .map(|s| s.eq_ignore_ascii_case(filename))
                .unwrap_or(false)
            {
                return Some(path);
            }
        } else if path.is_dir() {
            if let Some(found) = find_binary_recursive(&path, filename, depth - 1) {
                return Some(found);
            }
        }
    }
    None
}

async fn ensure_portable_browser() -> Result<PathBuf, String> {
    if let Some(existing) = find_portable_browser() {
        return Ok(existing);
    }

    let platform = if cfg!(target_os = "windows") {
        "win64"
    } else if cfg!(target_os = "macos") {
        if cfg!(target_arch = "aarch64") {
            "mac-arm64"
        } else {
            "mac-x64"
        }
    } else {
        "linux64"
    };

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(300))
        .user_agent("Loopy-Desktop/0.1")
        .build()
        .map_err(|e| format!("Error creando cliente HTTP: {e}"))?;

    let meta_url = "https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json";
    let meta: Value = client
        .get(meta_url)
        .send()
        .await
        .map_err(|e| format!("No se pudo consultar Chrome for Testing: {e}"))?
        .error_for_status()
        .map_err(|e| format!("Error HTTP consultando Chrome for Testing: {e}"))?
        .json()
        .await
        .map_err(|e| format!("JSON inválido de Chrome for Testing: {e}"))?;

    let download_url = meta
        .pointer("/channels/Stable/downloads/chrome-headless-shell")
        .and_then(|v| v.as_array())
        .and_then(|arr| {
            arr.iter().find(|item| {
                item.get("platform").and_then(|p| p.as_str()) == Some(platform)
            })
        })
        .and_then(|item| item.get("url").and_then(|u| u.as_str()))
        .ok_or_else(|| {
            format!("No se encontró descarga de chrome-headless-shell para '{platform}'.")
        })?
        .to_string();

    let resp = client
        .get(&download_url)
        .send()
        .await
        .map_err(|e| format!("Error descargando chrome-headless-shell: {e}"))?
        .error_for_status()
        .map_err(|e| format!("Error HTTP descargando chrome-headless-shell: {e}"))?;

    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("Error leyendo ZIP de chrome-headless-shell: {e}"))?;

    let target_dir = portable_browser_dir();
    fs::create_dir_all(&target_dir)
        .map_err(|e| format!("No se pudo crear directorio {}: {e}", target_dir.display()))?;

    let dir_clone = target_dir.clone();
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let cursor = std::io::Cursor::new(bytes);
        let mut archive = zip::ZipArchive::new(cursor)
            .map_err(|e| format!("ZIP inválido de chrome-headless-shell: {e}"))?;
        for i in 0..archive.len() {
            let mut file = archive
                .by_index(i)
                .map_err(|e| format!("Error leyendo entrada ZIP: {e}"))?;
            let Some(enclosed) = file.enclosed_name().map(|p| p.to_path_buf()) else {
                continue;
            };
            let out_path = dir_clone.join(enclosed);
            if file.is_dir() {
                let _ = fs::create_dir_all(&out_path);
            } else {
                if let Some(parent) = out_path.parent() {
                    let _ = fs::create_dir_all(parent);
                }
                let mut outfile = fs::File::create(&out_path)
                    .map_err(|e| format!("Error creando {}: {e}", out_path.display()))?;
                std::io::copy(&mut file, &mut outfile)
                    .map_err(|e| format!("Error extrayendo {}: {e}", out_path.display()))?;
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    let is_exec = file
                        .unix_mode()
                        .map(|m| (m & 0o111) != 0)
                        .unwrap_or(false)
                        || out_path
                            .file_name()
                            .and_then(|s| s.to_str())
                            .map(|s| s == "chrome-headless-shell")
                            .unwrap_or(false);
                    if is_exec {
                        let _ = fs::set_permissions(&out_path, fs::Permissions::from_mode(0o755));
                    }
                }
            }
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("Error en extracción de navegador: {e}"))??;

    find_portable_browser().ok_or_else(|| {
        "chrome-headless-shell se descargó pero no se encontró el ejecutable tras extraer."
            .to_string()
    })
}

fn find_system_browser() -> Option<PathBuf> {
    let candidates: Vec<&str> = if cfg!(target_os = "windows") {
        vec![
            r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
            r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
            r"C:\Program Files\Google\Chrome\Application\chrome.exe",
            r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
            r"C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe",
        ]
    } else if cfg!(target_os = "macos") {
        vec![
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
            "/Applications/Chromium.app/Contents/MacOS/Chromium",
            "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
        ]
    } else {
        vec![
            "/usr/bin/google-chrome",
            "/usr/bin/google-chrome-stable",
            "/usr/bin/chromium",
            "/usr/bin/chromium-browser",
            "/snap/bin/chromium",
            "/usr/bin/microsoft-edge",
            "/usr/bin/brave-browser",
            "/usr/bin/brave",
        ]
    };

    candidates
        .into_iter()
        .map(PathBuf::from)
        .find(|p| p.exists())
        .or_else(find_portable_browser)
}

fn pick_free_port() -> Result<u16, String> {
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    listener.local_addr().map(|a| a.port()).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[tokio::test]
    async fn e2e_browser_goto_type_click_and_screenshot() {
        // Spin up a local test page on 127.0.0.1 with an input and clickable button
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind local test server");
        let port = listener.local_addr().unwrap().port();
        let html = r#"<!doctype html><html><body style="font-family:sans-serif;padding:24px;">
            <h1>Loopy Browser E2E</h1>
            <input id="name-input" type="text" placeholder="Type name" style="padding:8px;font-size:16px;" />
            <button id="submit-btn" type="button" style="padding:8px 16px;font-size:16px;"
                onclick="document.getElementById('status-out').textContent = 'Clicked: ' + document.getElementById('name-input').value">
                Submit Action
            </button>
            <div id="status-out" style="margin-top:16px;font-size:18px;">Idle</div>
        </body></html>"#;

        let server_task = tokio::spawn(async move {
            loop {
                let Ok((mut sock, _)) = listener.accept().await else {
                    break;
                };
                let body = html.to_string();
                tokio::spawn(async move {
                    let mut buf = [0u8; 2048];
                    let _ = sock.read(&mut buf).await;
                    let resp = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        body.len(),
                        body
                    );
                    let _ = sock.write_all(resp.as_bytes()).await;
                    let _ = sock.shutdown().await;
                });
            }
        });

        let ts = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        let ws = std::env::temp_dir().join(format!("loopy-browser-e2e-{ts}"));
        fs::create_dir_all(&ws).unwrap();
        let ws_str = ws.to_string_lossy().to_string();
        let url = format!("http://127.0.0.1:{port}/");

        // 1. Navigate (goto) + inspect initial DOM & screenshot
        let goto_raw = run_browser_action(
            &ws_str,
            &json!({ "action": "goto", "url": url, "headless": true }),
        )
        .await;
        let goto_val: Value = serde_json::from_str(&goto_raw)
            .unwrap_or_else(|e| panic!("goto returned non-JSON ({e}): {goto_raw}"));
        assert_eq!(goto_val["ok"], true, "goto failed: {goto_raw}");
        let initial_text = goto_val["text"].as_str().unwrap_or("");
        assert!(
            initial_text.contains("Loopy Browser E2E") && initial_text.contains("Idle"),
            "Unexpected initial text: {initial_text}"
        );
        let shot1 = goto_val["screenshot"].as_str().unwrap_or("");
        assert!(
            !shot1.is_empty() && Path::new(shot1).exists() && fs::metadata(shot1).unwrap().len() > 1000,
            "Expected valid PNG screenshot, got: {shot1}"
        );

        // 2. Type into #name-input
        let type_raw = run_browser_action(
            &ws_str,
            &json!({ "action": "type", "selector": "#name-input", "text": "Loopy Agent" }),
        )
        .await;
        let type_val: Value = serde_json::from_str(&type_raw)
            .unwrap_or_else(|e| panic!("type returned non-JSON ({e}): {type_raw}"));
        assert_eq!(type_val["ok"], true, "type failed: {type_raw}");

        // 3. Click #submit-btn and verify DOM updated + cursor coordinates returned
        let click_raw = run_browser_action(
            &ws_str,
            &json!({ "action": "click", "selector": "#submit-btn" }),
        )
        .await;
        let click_val: Value = serde_json::from_str(&click_raw)
            .unwrap_or_else(|e| panic!("click returned non-JSON ({e}): {click_raw}"));
        assert_eq!(click_val["ok"], true, "click failed: {click_raw}");
        let after_text = click_val["text"].as_str().unwrap_or("");
        assert!(
            after_text.contains("Clicked: Loopy Agent"),
            "Expected click to update DOM to 'Clicked: Loopy Agent', got: {after_text}"
        );
        let cx = click_val["cursor"]["x"].as_f64().unwrap_or(0.0);
        let cy = click_val["cursor"]["y"].as_f64().unwrap_or(0.0);
        assert!(cx > 0.0 && cy > 0.0, "Expected positive cursor coords, got ({cx}, {cy})");

        // 4. Close browser cleanly
        let close_raw = run_browser_action(&ws_str, &json!({ "action": "close" })).await;
        let close_val: Value = serde_json::from_str(&close_raw).unwrap();
        assert_eq!(close_val["closed"], true);

        server_task.abort();
        let _ = fs::remove_dir_all(&ws);
    }
}
