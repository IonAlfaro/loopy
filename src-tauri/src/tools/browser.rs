use base64::Engine as _;
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
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
    pub session_id: String,
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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserScreencastEvent {
    pub session_id: String,
    pub frame_base64: String,
    pub viewport_width: u32,
    pub viewport_height: u32,
}

type FrameCallback = Arc<dyn Fn(BrowserFrameEvent) + Send + Sync>;
type ScreencastCallback = Arc<dyn Fn(BrowserScreencastEvent) + Send + Sync>;

static FRAME_LISTENER: OnceLock<Mutex<Option<FrameCallback>>> = OnceLock::new();
static SCREENCAST_LISTENER: OnceLock<Mutex<Option<ScreencastCallback>>> = OnceLock::new();

pub fn set_browser_frame_listener<F>(cb: F)
where
    F: Fn(BrowserFrameEvent) + Send + Sync + 'static,
{
    let slot = FRAME_LISTENER.get_or_init(|| Mutex::new(None));
    if let Ok(mut guard) = slot.lock() {
        *guard = Some(Arc::new(cb));
    }
}

pub fn set_browser_screencast_listener<F>(cb: F)
where
    F: Fn(BrowserScreencastEvent) + Send + Sync + 'static,
{
    let slot = SCREENCAST_LISTENER.get_or_init(|| Mutex::new(None));
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

fn emit_browser_screencast(ev: BrowserScreencastEvent) {
    if let Some(slot) = SCREENCAST_LISTENER.get() {
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
    pub device_scale_factor: Option<f64>,
    pub tab_id: Option<String>,
    pub session_id: Option<String>,
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

struct CdpReq {
    method: String,
    params: Value,
    reply: tokio::sync::oneshot::Sender<Result<Value, String>>,
}

struct CdpActor {
    ws_url: String,
    session_key: String,
    screencast_dims: Option<(u32, u32)>,
    tx: tokio::sync::mpsc::UnboundedSender<CdpReq>,
    handle: tokio::task::JoinHandle<()>,
}

impl Drop for CdpActor {
    fn drop(&mut self) {
        self.handle.abort();
    }
}

impl CdpActor {
    async fn connect(ws_url: String, session_key: String) -> Result<Self, String> {
        let (mut ws, _) = connect_async(&ws_url)
            .await
            .map_err(|e| format!("CDP WebSocket error: {e}"))?;
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<CdpReq>();
        let sk = session_key.clone();

        let handle = tokio::spawn(async move {
            let mut next_id: u64 = 1;
            let mut pending: HashMap<u64, tokio::sync::oneshot::Sender<Result<Value, String>>> =
                HashMap::new();

            loop {
                tokio::select! {
                    maybe_req = rx.recv() => {
                        let Some(req) = maybe_req else { break };
                        let id = next_id;
                        next_id += 1;
                        let payload = json!({
                            "id": id,
                            "method": req.method,
                            "params": req.params
                        });
                        if let Err(e) = ws.send(Message::Text(payload.to_string().into())).await {
                            let _ = req.reply.send(Err(format!("Error enviando CDP '{}': {e}", req.method)));
                            break;
                        }
                        pending.insert(id, req.reply);
                    }
                    maybe_msg = ws.next() => {
                        let Some(Ok(msg)) = maybe_msg else { break };
                        let Message::Text(txt) = msg else { continue };
                        let Ok(val) = serde_json::from_str::<Value>(&txt) else { continue };

                        if let Some(id) = val.get("id").and_then(|v| v.as_u64()) {
                            if let Some(reply) = pending.remove(&id) {
                                if let Some(err) = val.get("error") {
                                    let _ = reply.send(Err(format!("Error CDP: {err}")));
                                } else {
                                    let _ = reply.send(Ok(val.get("result").cloned().unwrap_or(Value::Null)));
                                }
                            }
                            continue;
                        }

                        if val.get("method").and_then(|m| m.as_str()) == Some("Page.screencastFrame") {
                            if let Some(params) = val.get("params") {
                                if let (Some(frame_sid), Some(data)) = (
                                    params.get("sessionId").and_then(|v| v.as_i64()),
                                    params.get("data").and_then(|v| v.as_str()),
                                ) {
                                    let ack_id = next_id;
                                    next_id += 1;
                                    let ack = json!({
                                        "id": ack_id,
                                        "method": "Page.screencastFrameAck",
                                        "params": { "sessionId": frame_sid }
                                    });
                                    if ws.send(Message::Text(ack.to_string().into())).await.is_err() {
                                        break;
                                    }
                                    let meta = params.get("metadata");
                                    let vw = meta
                                        .and_then(|m| m.get("deviceWidth"))
                                        .and_then(|v| v.as_f64())
                                        .map(|v| v.round() as u32)
                                        .unwrap_or(0);
                                    let vh = meta
                                        .and_then(|m| m.get("deviceHeight"))
                                        .and_then(|v| v.as_f64())
                                        .map(|v| v.round() as u32)
                                        .unwrap_or(0);
                                    emit_browser_screencast(BrowserScreencastEvent {
                                        session_id: sk.clone(),
                                        frame_base64: data.to_string(),
                                        viewport_width: vw,
                                        viewport_height: vh,
                                    });
                                }
                            }
                        }
                    }
                }
            }

            for (_, reply) in pending.drain() {
                let _ = reply.send(Err("Conexión CDP cerrada inesperadamente.".to_string()));
            }
        });

        Ok(Self {
            ws_url,
            session_key,
            screencast_dims: None,
            tx,
            handle,
        })
    }

    fn is_alive_for(&self, ws_url: &str, session_key: &str) -> bool {
        self.ws_url == ws_url
            && self.session_key == session_key
            && !self.handle.is_finished()
            && !self.tx.is_closed()
    }

    async fn call(&self, method: &str, params: Value) -> Result<Value, String> {
        let (reply_tx, reply_rx) = tokio::sync::oneshot::channel();
        self.tx
            .send(CdpReq {
                method: method.to_string(),
                params,
                reply: reply_tx,
            })
            .map_err(|_| format!("Canal CDP cerrado enviando '{method}'"))?;
        tokio::time::timeout(Duration::from_secs(15), reply_rx)
            .await
            .map_err(|_| format!("Timeout esperando respuesta CDP '{method}'."))?
            .map_err(|_| format!("Conexión CDP cerrada esperando '{method}'."))?
    }

    async fn eval(&self, expression: &str) -> Result<String, String> {
        let res = self
            .call(
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
    device_scale_factor: f64,
    actor: Option<CdpActor>,
    session_tabs: HashMap<String, Vec<String>>,
    session_active_tab: HashMap<String, String>,
}

async fn ensure_actor<'a>(
    session: &'a mut PersistentBrowser,
    session_key: &str,
) -> Result<(&'a mut CdpActor, bool), String> {
    let alive = session
        .actor
        .as_ref()
        .map(|a| a.is_alive_for(&session.ws_url, session_key))
        .unwrap_or(false);
    if !alive {
        session.actor = None;
        let actor = CdpActor::connect(session.ws_url.clone(), session_key.to_string()).await?;
        let _ = actor.call("Page.enable", json!({})).await;
        session.actor = Some(actor);
        return Ok((session.actor.as_mut().unwrap(), true));
    }
    Ok((session.actor.as_mut().unwrap(), false))
}

static BROWSER_SESSION: OnceLock<AsyncMutex<Option<PersistentBrowser>>> = OnceLock::new();
static PREFERRED_VIEWPORT: OnceLock<std::sync::Mutex<(u32, u32, f64)>> = OnceLock::new();
static HTTP_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

fn http_client() -> &'static reqwest::Client {
    HTTP_CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .connect_timeout(Duration::from_millis(500))
            .timeout(Duration::from_secs(3))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new())
    })
}

fn set_preferred_viewport(w: u32, h: u32, dpr: f64) {
    let slot = PREFERRED_VIEWPORT.get_or_init(|| std::sync::Mutex::new((1024, 840, 1.0)));
    if let Ok(mut g) = slot.lock() {
        *g = (w.clamp(360, 2400), h.clamp(300, 1600), dpr.clamp(1.0, 1.5));
    }
}

fn get_preferred_viewport() -> (u32, u32, f64) {
    let slot = PREFERRED_VIEWPORT.get_or_init(|| std::sync::Mutex::new((1024, 840, 1.0)));
    slot.lock().map(|g| *g).unwrap_or((1024, 840, 1.0))
}

fn session_mutex() -> &'static AsyncMutex<Option<PersistentBrowser>> {
    BROWSER_SESSION.get_or_init(|| AsyncMutex::new(None))
}

pub async fn shutdown_browser() {
    let mut guard = session_mutex().lock().await;
    if let Some(mut b) = guard.take() {
        b.actor = None;
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
        let dir = std::env::temp_dir().join(format!("loors-cdp-{port}"));
        let _ = fs::create_dir_all(&dir);
        return (dir, false);
    }
    if let Some(base) = dirs::data_local_dir() {
        let dir = base.join("loors").join("browser-profile");
        if fs::create_dir_all(&dir).is_ok() {
            return (dir, true);
        }
    }
    let dir = std::env::temp_dir().join(format!("loors-cdp-{port}"));
    let _ = fs::create_dir_all(&dir);
    (dir, false)
}

async fn spawn_browser_with_profile(
    browser_bin: &Path,
    port: u16,
    profile_dir: PathBuf,
    persistent_profile: bool,
    vw: u32,
    vh: u32,
) -> Result<PersistentBrowser, String> {
    let is_headless_shell = browser_bin
        .file_name()
        .and_then(|s| s.to_str())
        .map(|s| s.to_ascii_lowercase().contains("headless-shell"))
        .unwrap_or(false);

    let mut cmd = Command::new(browser_bin);
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
        "--disable-extensions",
        "--no-first-run",
        "--no-default-browser-check",
        "--remote-debugging-address=127.0.0.1",
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

    let (target_id, ws_url) = match wait_for_page_target_checked(port, Some(&mut child)).await {
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
        device_scale_factor: 1.0,
        actor: None,
        session_tabs: HashMap::new(),
        session_active_tab: HashMap::new(),
    })
}

async fn start_persistent_browser(width: u32, height: u32) -> Result<PersistentBrowser, String> {
    let browser_bin = match find_system_browser() {
        Some(path) => path,
        None => ensure_portable_browser().await?,
    };
    let vw = width.clamp(360, 2400);
    let vh = height.clamp(300, 1600);
    let port = pick_free_port()?;
    let (profile_dir, persistent_profile) = choose_profile_dir(port);

    match spawn_browser_with_profile(&browser_bin, port, profile_dir, persistent_profile, vw, vh).await {
        Ok(b) => Ok(b),
        Err(first_err) if persistent_profile => {
            // Persistent profile may be locked by an orphaned browser instance — fall back cleanly to an isolated temp profile
            let fallback_port = pick_free_port()?;
            let temp_dir = std::env::temp_dir().join(format!("loors-cdp-{fallback_port}"));
            let _ = fs::create_dir_all(&temp_dir);
            spawn_browser_with_profile(&browser_bin, fallback_port, temp_dir, false, vw, vh)
                .await
                .map_err(|e| format!("{first_err} (fallback also failed: {e})"))
        }
        Err(err) => Err(err),
    }
}

async fn list_cdp_tabs(port: u16, active_id: &str) -> Vec<BrowserTabInfo> {
    let client = http_client();
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

async fn list_cdp_tabs_for_session(
    session: &mut PersistentBrowser,
    session_key: &str,
) -> Vec<BrowserTabInfo> {
    let all = list_cdp_tabs(session.port, &session.active_target_id).await;
    let live_ids: HashSet<String> = all.iter().map(|t| t.id.clone()).collect();
    if let Some(owned) = session.session_tabs.get_mut(session_key) {
        owned.retain(|id| live_ids.contains(id));
    }
    let allowed: HashSet<String> = session
        .session_tabs
        .get(session_key)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .collect();
    let active_for_sess = session
        .session_active_tab
        .get(session_key)
        .cloned()
        .unwrap_or_else(|| session.active_target_id.clone());
    all.into_iter()
        .filter(|t| allowed.contains(&t.id))
        .map(|mut t| {
            t.active = t.id == active_for_sess;
            t
        })
        .collect()
}

async fn ensure_session_tab(
    session: &mut PersistentBrowser,
    session_key: &str,
    create_if_missing: bool,
) -> Result<bool, String> {
    let client = http_client();
    let list_url = format!("http://127.0.0.1:{}/json/list", session.port);
    let pages: Vec<Value> = match client.get(&list_url).send().await {
        Ok(resp) => resp.json::<Vec<Value>>().await.unwrap_or_default(),
        Err(_) => Vec::new(),
    };

    let page_map: HashMap<String, (String, String)> = pages
        .into_iter()
        .filter(|p| p.get("type").and_then(|v| v.as_str()) == Some("page"))
        .filter_map(|p| {
            let id = p.get("id")?.as_str()?.to_string();
            let ws = p.get("webSocketDebuggerUrl")?.as_str()?.to_string();
            let url = p.get("url").and_then(|v| v.as_str()).unwrap_or("about:blank").to_string();
            Some((id, (ws, url)))
        })
        .collect();

    // Prune closed tabs for this session
    if let Some(owned) = session.session_tabs.get_mut(session_key) {
        owned.retain(|id| page_map.contains_key(id));
    }

    // If this session already owns at least one live tab, activate its preferred tab
    if let Some(owned) = session.session_tabs.get(session_key) {
        if !owned.is_empty() {
            let preferred = session
                .session_active_tab
                .get(session_key)
                .filter(|id| owned.contains(id))
                .cloned()
                .unwrap_or_else(|| owned[0].clone());
            if let Some((ws, url)) = page_map.get(&preferred) {
                session.active_target_id = preferred.clone();
                session.ws_url = ws.clone();
                session.current_url = url.clone();
                session.session_active_tab.insert(session_key.to_string(), preferred);
                return Ok(true);
            }
        }
    }

    if !create_if_missing {
        return Ok(false);
    }

    // Claim an unclaimed bootstrap about:blank tab if available; otherwise open a fresh CDP tab
    let all_claimed: HashSet<String> = session
        .session_tabs
        .values()
        .flat_map(|v| v.iter().cloned())
        .collect();

    if let Some((free_id, (free_ws, free_url))) = page_map
        .iter()
        .find(|(id, (_, url))| !all_claimed.contains(*id) && url == "about:blank")
    {
        session
            .session_tabs
            .entry(session_key.to_string())
            .or_default()
            .push(free_id.clone());
        session
            .session_active_tab
            .insert(session_key.to_string(), free_id.clone());
        session.active_target_id = free_id.clone();
        session.ws_url = free_ws.clone();
        session.current_url = free_url.clone();
        return Ok(true);
    }

    let endpoint = format!("http://127.0.0.1:{}/json/new?about:blank", session.port);
    let resp = client
        .put(&endpoint)
        .send()
        .await
        .or(client.get(&endpoint).send().await)
        .map_err(|e| format!("Failed to create conversation tab: {e}"))?;
    let tab_val: Value = resp
        .json()
        .await
        .map_err(|e| format!("Invalid new-tab response: {e}"))?;
    let id = tab_val
        .get("id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "Missing target id for new tab".to_string())?
        .to_string();
    let ws = tab_val
        .get("webSocketDebuggerUrl")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "Missing ws url for new tab".to_string())?
        .to_string();

    session
        .session_tabs
        .entry(session_key.to_string())
        .or_default()
        .push(id.clone());
    session
        .session_active_tab
        .insert(session_key.to_string(), id.clone());
    session.active_target_id = id;
    session.ws_url = ws;
    session.current_url = "about:blank".to_string();
    tokio::time::sleep(Duration::from_millis(200)).await;
    Ok(true)
}

/// Interactive human-controlled browser command sharing the exact same persistent
/// Chromium CDP session and cookies as the AI agent's `browser_action` tool.
pub async fn browser_interact(req: BrowserInteractRequest) -> Result<BrowserInteractResponse, String> {
    let action = req.action.as_str();
    let session_key = req
        .session_id
        .as_deref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .unwrap_or("default")
        .to_string();

    // Always remember the UI pane's preferred logical viewport so when the AI agent launches Chromium,
    // it opens immediately at the exact pane proportions instead of jumping from a square to full size.
    if let (Some(w), Some(h)) = (req.width, req.height) {
        let dpr = req.device_scale_factor.unwrap_or(1.0);
        set_preferred_viewport(w, h, dpr);
    }

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

    // For passive polling/status/resize, never block or collide if the AI agent is actively driving Chromium
    let mut guard = if matches!(action, "status" | "refresh" | "resize") {
        match session_mutex().try_lock() {
            Ok(g) => g,
            Err(_) => return Err("__BROWSER_BUSY__".to_string()),
        }
    } else {
        session_mutex().lock().await
    };

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
    let client = http_client();
    let is_fast_input = matches!(action, "click" | "wheel" | "text" | "key");
    let is_light_input = matches!(action, "wheel" | "text" | "key");

    // Handle tab lifecycle actions scoped strictly to this conversation (`session_key`)
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
                    session
                        .session_tabs
                        .entry(session_key.clone())
                        .or_default()
                        .push(id.to_string());
                    session
                        .session_active_tab
                        .insert(session_key.clone(), id.to_string());
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
                                session
                                    .session_active_tab
                                    .insert(session_key.clone(), tid.to_string());
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
            // Support closing either an explicit CDP tab id or the synthetic "agent-active" placeholder
            let target_id = req
                .tab_id
                .as_deref()
                .filter(|id| !id.is_empty() && *id != "agent-active")
                .map(|s| s.to_string())
                .or_else(|| session.session_active_tab.get(&session_key).cloned())
                .or_else(|| {
                    session
                        .session_tabs
                        .get(&session_key)
                        .and_then(|v| v.first().cloned())
                });
            if let Some(tid) = target_id {
                // Only call /json/close if other tabs exist in Chromium; closing the sole remaining page target
                // in headless Chromium terminates or stalls the whole browser process.
                let all_pages = list_cdp_tabs(session.port, &session.active_target_id).await;
                if all_pages.len() > 1 {
                    let _ = client
                        .get(&format!("http://127.0.0.1:{}/json/close/{}", session.port, tid))
                        .send()
                        .await;
                } else if let Ok((mut cws, _)) = connect_async(&session.ws_url).await {
                    let mut cid: u64 = 1;
                    let _ = cdp_call(&mut cws, &mut cid, "Page.navigate", json!({ "url": "about:blank" })).await;
                    session.current_url = "about:blank".to_string();
                }
                if let Some(owned) = session.session_tabs.get_mut(&session_key) {
                    owned.retain(|id| id != &tid);
                }
                tokio::time::sleep(Duration::from_millis(120)).await;
                let sess_tabs = list_cdp_tabs_for_session(session, &session_key).await;
                if sess_tabs.is_empty() {
                    session.session_active_tab.remove(&session_key);
                    session.actor = None;
                    return Ok(BrowserInteractResponse {
                        active: false,
                        url: String::new(),
                        title: String::new(),
                        can_go_back: false,
                        can_go_forward: false,
                        viewport_width: session.viewport_width,
                        viewport_height: session.viewport_height,
                        frame_base64: None,
                        frame_mime: "image/jpeg".to_string(),
                        tabs: Vec::new(),
                    });
                }
                let _ = ensure_session_tab(session, &session_key, false).await;
            }
        }
        _ => {
            // Fast path: if this conversation already owns the active ws_url, skip HTTP /json/list on rapid inputs
            let already_bound = is_fast_input
                && !session.ws_url.is_empty()
                && session
                    .session_active_tab
                    .get(&session_key)
                    .map(|id| id == &session.active_target_id)
                    .unwrap_or(false);
            if !already_bound {
                let create_if_missing = matches!(action, "navigate");
                if !ensure_session_tab(session, &session_key, create_if_missing).await? {
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
            }
        }
    }

    // Update target viewport dimensions ONLY on layout/navigation actions (never on click/wheel/key)
    let dims_updated = if matches!(action, "resize" | "navigate" | "new_tab" | "status") {
        let mut changed = false;
        if let (Some(w), Some(h)) = (req.width, req.height) {
            let vw = w.clamp(360, 2400);
            let vh = h.clamp(300, 1600);
            if vw != session.viewport_width || vh != session.viewport_height {
                session.viewport_width = vw;
                session.viewport_height = vh;
                changed = true;
            }
        }
        if let Some(dpr) = req.device_scale_factor {
            let clamped = dpr.clamp(1.0, 1.5);
            if (clamped - session.device_scale_factor).abs() > 0.01 {
                session.device_scale_factor = clamped;
                changed = true;
            }
        }
        changed || action == "resize"
    } else {
        false
    };

    let target_id_for_bounds = session.active_target_id.clone();
    let mut current_url_after = session.current_url.clone();
    let vw_now = session.viewport_width;
    let vh_now = session.viewport_height;
    let dpr_now = session.device_scale_factor;

    let (actor, freshly_connected) = ensure_actor(session, &session_key).await?;

    // Persist window bounds on Chromium when layout changes so closing/reconnecting keeps exact size
    if dims_updated {
        if let Ok(win) = actor
            .call(
                "Browser.getWindowForTarget",
                json!({ "targetId": target_id_for_bounds }),
            )
            .await
        {
            if let Some(window_id) = win.get("windowId").and_then(|v| v.as_i64()) {
                let _ = actor
                    .call(
                        "Browser.setWindowBounds",
                        json!({
                            "windowId": window_id,
                            "bounds": {
                                "width": vw_now,
                                "height": vh_now,
                                "windowState": "normal"
                            }
                        }),
                    )
                    .await;
            }
        }
    }

    // Apply Emulation.setDeviceMetricsOverride ONLY when dimensions changed or WS freshly connected
    if dims_updated || freshly_connected {
        let _ = actor
            .call(
                "Emulation.setDeviceMetricsOverride",
                json!({
                    "width": vw_now,
                    "height": vh_now,
                    "deviceScaleFactor": dpr_now,
                    "mobile": false
                }),
            )
            .await;
    }

    match action {
        "navigate" => {
            if let Some(raw_url) = req.url.as_deref() {
                let norm = normalize_browser_url(raw_url);
                actor.call("Page.navigate", json!({ "url": norm })).await?;
                current_url_after = norm;
                tokio::time::sleep(Duration::from_millis(650)).await;
            }
        }
        "reload" => {
            let _ = actor.call("Page.reload", json!({ "ignoreCache": false })).await;
            tokio::time::sleep(Duration::from_millis(550)).await;
        }
        "back" | "forward" => {
            if let Ok(hist) = actor.call("Page.getNavigationHistory", json!({})).await {
                let idx = hist.get("currentIndex").and_then(|v| v.as_i64()).unwrap_or(0);
                let entries = hist.get("entries").and_then(|v| v.as_array());
                let target_idx = if action == "back" { idx - 1 } else { idx + 1 };
                if let Some(entry_id) = entries
                    .and_then(|arr| arr.get(target_idx as usize))
                    .and_then(|e| e.get("id"))
                    .and_then(|v| v.as_i64())
                {
                    let _ = actor
                        .call(
                            "Page.navigateToHistoryEntry",
                            json!({ "entryId": entry_id }),
                        )
                        .await;
                    tokio::time::sleep(Duration::from_millis(400)).await;
                }
            }
        }
        "click" => {
            let cx = req.x.unwrap_or(0.0);
            let cy = req.y.unwrap_or(0.0);
            let btn = req.button.as_deref().unwrap_or("left");
            let clicks = req.click_count.unwrap_or(1);
            let _ = actor
                .call(
                    "Input.dispatchMouseEvent",
                    json!({ "type": "mouseMoved", "x": cx, "y": cy }),
                )
                .await;
            let _ = actor
                .call(
                    "Input.dispatchMouseEvent",
                    json!({ "type": "mousePressed", "x": cx, "y": cy, "button": btn, "clickCount": clicks }),
                )
                .await;
            let _ = actor
                .call(
                    "Input.dispatchMouseEvent",
                    json!({ "type": "mouseReleased", "x": cx, "y": cy, "button": btn, "clickCount": clicks }),
                )
                .await;
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        "wheel" => {
            let cx = req.x.unwrap_or((vw_now / 2) as f64);
            let cy = req.y.unwrap_or((vh_now / 2) as f64);
            let dx = req.delta_x.unwrap_or(0.0);
            let dy = req.delta_y.unwrap_or(0.0);
            let _ = actor
                .call(
                    "Input.dispatchMouseEvent",
                    json!({ "type": "mouseWheel", "x": cx, "y": cy, "deltaX": dx, "deltaY": dy }),
                )
                .await;
        }
        "text" => {
            if let Some(txt) = req.text.as_deref() {
                if !txt.is_empty() {
                    let _ = actor.call("Input.insertText", json!({ "text": txt })).await;
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
                let _ = actor.call("Input.dispatchKeyEvent", payload_down).await;
                let _ = actor.call("Input.dispatchKeyEvent", payload_up).await;
                if k == "Enter" {
                    tokio::time::sleep(Duration::from_millis(140)).await;
                }
            }
        }
        _ => {}
    }

    // Skip navigation history / innerWidth / tab-list queries on rapid wheel/text/key inputs
    let (can_go_back, can_go_forward, hist_url, hist_title) = if is_light_input {
        (false, false, current_url_after.clone(), String::new())
    } else {
        match actor.call("Page.getNavigationHistory", json!({})).await {
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
        }
    };

    // Read actual CSS viewport dimensions on layout/navigation actions so click coordinates match 1:1
    let (actual_vw, actual_vh) = if is_fast_input {
        (vw_now, vh_now)
    } else {
        match actor
            .eval("JSON.stringify([Math.round(window.innerWidth || 0), Math.round(window.innerHeight || 0)])")
            .await
        {
            Ok(raw) => serde_json::from_str::<[u32; 2]>(&raw)
                .ok()
                .filter(|[w, h]| *w >= 200 && *h >= 200)
                .map(|[w, h]| (w, h))
                .unwrap_or((vw_now, vh_now)),
            Err(_) => (vw_now, vh_now),
        }
    };

    let next_url = if !hist_url.is_empty() {
        hist_url.clone()
    } else {
        current_url_after
    };

    // Start or update Page.startScreencast on the SAME multiplexed WebSocket!
    let screencast_running = if next_url != "about:blank" {
        let max_w = ((actual_vw as f64) * dpr_now).round().clamp(360.0, 2400.0) as u32;
        let max_h = ((actual_vh as f64) * dpr_now).round().clamp(300.0, 1600.0) as u32;
        if actor.screencast_dims != Some((max_w, max_h)) {
            let _ = actor.call("Page.stopScreencast", json!({})).await;
            if actor
                .call(
                    "Page.startScreencast",
                    json!({
                        "format": "jpeg",
                        "quality": 72,
                        "maxWidth": max_w,
                        "maxHeight": max_h,
                        "everyNthFrame": 1
                    }),
                )
                .await
                .is_ok()
            {
                actor.screencast_dims = Some((max_w, max_h));
            }
        }
        actor.screencast_dims.is_some()
    } else {
        if actor.screencast_dims.is_some() {
            let _ = actor.call("Page.stopScreencast", json!({})).await;
            actor.screencast_dims = None;
        }
        false
    };

    // When Page.startScreencast is pushing live frames on this WebSocket, skip synchronous
    // Page.captureScreenshot on rapid click/wheel/text/key inputs (~2-5ms round-trip!).
    let mut drop_actor = false;
    let frame_base64 = if is_fast_input && screencast_running {
        None
    } else {
        match actor
            .call(
                "Page.captureScreenshot",
                json!({ "format": "jpeg", "quality": 72, "optimizeForSpeed": true }),
            )
            .await
        {
            Ok(v) => v.get("data").and_then(|d| d.as_str()).map(|s| s.to_string()),
            Err(_) => {
                drop_actor = true;
                None
            }
        }
    };

    if drop_actor {
        session.actor = None;
    }
    session.current_url = next_url;

    let tabs = if is_light_input {
        Vec::new()
    } else {
        list_cdp_tabs_for_session(session, &session_key).await
    };

    Ok(BrowserInteractResponse {
        active: true,
        url: if !hist_url.is_empty() { hist_url } else { session.current_url.clone() },
        title: hist_title,
        can_go_back,
        can_go_forward,
        viewport_width: actual_vw,
        viewport_height: actual_vh,
        frame_base64,
        frame_mime: "image/jpeg".to_string(),
        tabs,
    })
}

/// Pure-Rust embedded browser driver using Chrome DevTools Protocol (CDP).
/// Zero Node.js or Playwright dependencies: compiles directly into loors.exe
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

    // Always run headless so the browser stays embedded inside Loors's Live Browser panel
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
    let state_path = ws_root.join(".loors").join("browser_state.json");

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

        let (pref_w, pref_h, pref_dpr) = get_preferred_viewport();
        let mut browser = match start_persistent_browser(pref_w, pref_h).await {
            Ok(b) => b,
            Err(err) => return json!({ "ok": false, "error": err }).to_string(),
        };
        browser.device_scale_factor = pref_dpr;

        *guard = Some(browser);

        let session = guard.as_mut().unwrap();
        let agent_session_key = args
            .get("__session_id")
            .and_then(|v| v.as_str())
            .filter(|s| !s.trim().is_empty())
            .unwrap_or("default");
        if let Err(err) = ensure_session_tab(session, agent_session_key, true).await {
            return json!({ "ok": false, "error": err }).to_string();
        }
        let res = drive_cdp_action(
            session,
            agent_session_key,
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
    let agent_session_key = args
        .get("__session_id")
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        .unwrap_or("default");
    if let Err(err) = ensure_session_tab(session, agent_session_key, true).await {
        return json!({ "ok": false, "error": err }).to_string();
    }
    let res = drive_cdp_action(
        session,
        agent_session_key,
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

async fn wait_for_page_target_checked(
    port: u16,
    mut child: Option<&mut Child>,
) -> Result<(String, String), String> {
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_millis(300))
        .timeout(Duration::from_millis(600))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());
    let list_url = format!("http://127.0.0.1:{port}/json/list");

    for _ in 0..35 {
        if let Some(c) = child.as_deref_mut() {
            if let Ok(Some(status)) = c.try_wait() {
                return Err(format!(
                    "Browser process exited early ({status}) before opening CDP port {port}."
                ));
            }
        }
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
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
    Err("Timeout connecting to local browser CDP port.".to_string())
}

const HOOK_SCRIPT: &str = r##"(() => {
    if (window.__loorsHooked) return;
    window.__loorsHooked = true;
    window.__loorsConsoleErrors = window.__loorsConsoleErrors || [];
    window.__loorsNetworkErrors = window.__loorsNetworkErrors || [];
    const origError = console.error;
    console.error = function(...args) {
        try {
            const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ').slice(0, 240);
            window.__loorsConsoleErrors.push(msg);
            if (window.__loorsConsoleErrors.length > 30) window.__loorsConsoleErrors.shift();
        } catch {}
        return origError.apply(console, args);
    };
    window.addEventListener('error', (e) => {
        try {
            window.__loorsConsoleErrors.push((e.message || 'JS Error') + ' @' + (e.filename || '') + ':' + (e.lineno || 0));
            if (window.__loorsConsoleErrors.length > 30) window.__loorsConsoleErrors.shift();
        } catch {}
    });
    window.addEventListener('unhandledrejection', (e) => {
        try {
            window.__loorsConsoleErrors.push('UnhandledRejection: ' + String(e.reason || '').slice(0, 200));
            if (window.__loorsConsoleErrors.length > 30) window.__loorsConsoleErrors.shift();
        } catch {}
    });
    if (window.fetch) {
        const origFetch = window.fetch;
        window.fetch = async function(...args) {
            try {
                const resp = await origFetch.apply(this, args);
                if (!resp.ok && resp.status >= 400) {
                    window.__loorsNetworkErrors.push(`HTTP ${resp.status} ${resp.url || ''}`.slice(0, 200));
                    if (window.__loorsNetworkErrors.length > 30) window.__loorsNetworkErrors.shift();
                }
                return resp;
            } catch (err) {
                window.__loorsNetworkErrors.push(`FETCH FAIL ${String(args[0] || '')}: ${String(err)}`.slice(0, 200));
                if (window.__loorsNetworkErrors.length > 30) window.__loorsNetworkErrors.shift();
                throw err;
            }
        };
    }
})()"##;

#[allow(clippy::too_many_arguments)]
async fn drive_cdp_action(
    session: &mut PersistentBrowser,
    session_id: &str,
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
    // Release any UI screencast actor before the AI agent opens its exclusive CDP connection
    session.actor = None;
    let (mut ws, _) = connect_async(&session.ws_url)
        .await
        .map_err(|e| format!("Error WebSocket CDP: {e}"))?;

    let mut next_id: u64 = 1;
    cdp_call(&mut ws, &mut next_id, "Page.enable", json!({})).await?;
    cdp_call(&mut ws, &mut next_id, "Runtime.enable", json!({})).await?;
    // Match the UI browser pane's exact proportions & DPR during agent navigation so there is no
    // jarring square-then-expand jump when the agent hands off to the user.
    let (pref_w, pref_h, pref_dpr) = get_preferred_viewport();
    session.viewport_width = pref_w;
    session.viewport_height = pref_h;
    session.device_scale_factor = pref_dpr;
    let _ = cdp_call(
        &mut ws,
        &mut next_id,
        "Emulation.setDeviceMetricsOverride",
        json!({
            "width": pref_w,
            "height": pref_h,
            "deviceScaleFactor": pref_dpr,
            "mobile": false
        }),
    )
    .await;
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
            // Emit immediate visual frame so the right Browser pane updates live right away
            if let Ok(shot) = cdp_call(
                &mut ws,
                &mut next_id,
                "Page.captureScreenshot",
                json!({ "format": "jpeg", "quality": 82 }),
            )
            .await
            {
                if let Some(b64) = shot.get("data").and_then(|v| v.as_str()) {
                    emit_browser_frame(BrowserFrameEvent {
                        session_id: session_id.to_owned(),
                        url: url.to_string(),
                        title: String::new(),
                        action: "goto".to_string(),
                        target_label: None,
                        cursor_x: None,
                        cursor_y: None,
                        frame_base64: b64.to_string(),
                        console_errors: Vec::new(),
                        network_errors: Vec::new(),
                    });
                }
            }
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
                    let ov = document.getElementById("__loors_ai_cursor__");
                    if (ov) ov.remove();
                    ov = document.createElement("div");
                    ov.id = "__loors_ai_cursor__";
                    ov.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483647;";
                    ov.innerHTML = `
                        <div style="position:fixed;left:${{r.left-2}}px;top:${{r.top-2}}px;width:${{r.width+4}}px;height:${{r.height+4}}px;border:2px solid #8b5cf6;background:rgba(139,92,246,0.18);border-radius:6px;box-shadow:0 0 14px rgba(139,92,246,0.55);"></div>
                        <div style="position:fixed;left:${{cx-14}}px;top:${{cy-14}}px;width:28px;height:28px;border:2px solid #f59e0b;border-radius:999px;background:rgba(245,158,11,0.22);"></div>
                        <svg style="position:fixed;left:${{cx}}px;top:${{cy}}px;filter:drop-shadow(0 2px 4px rgba(0,0,0,0.8));" width="22" height="22" viewBox="0 0 24 24" fill="#fff" stroke="#09090b" stroke-width="1.8"><path d="M4 2l15 9-7 2-3 7z"/></svg>
                        <div style="position:fixed;left:${{Math.min(cx+18, window.innerWidth-220)}}px;top:${{Math.max(cy+18, 8)}}px;background:#09090b;color:#f4f4f5;border:1px solid #8b5cf6;border-radius:6px;padding:3px 8px;font:600 11px system-ui,sans-serif;white-space:nowrap;box-shadow:0 6px 16px rgba(0,0,0,0.5);">${{"{act_label}"}}: ${{lbl.replace(/</g,'&lt;')}}</div>
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

                // Emit pre-click visual frame with cursor and highlight in place
                emit_live_jpeg(
                    session_id,
                    &mut ws,
                    &mut next_id,
                    &session.current_url,
                    action,
                    target_label.clone(),
                    cursor_x,
                    cursor_y,
                )
                .await;
                tokio::time::sleep(Duration::from_millis(220)).await;

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
                    tokio::time::sleep(Duration::from_millis(260)).await;
                    emit_live_jpeg(
                        session_id,
                        &mut ws,
                        &mut next_id,
                        &session.current_url,
                        action,
                        target_label.clone(),
                        cursor_x,
                        cursor_y,
                    )
                    .await;
                    tokio::time::sleep(Duration::from_millis(500)).await;
                }
                let _ = cdp_eval(
                    &mut ws,
                    &mut next_id,
                    "document.getElementById('__loors_ai_cursor__')?.remove()",
                )
                .await;
                action_note = format!("{act_label} at ({cx}, {cy}) on {}", target_label.clone().unwrap_or_default());
            } else {
                action_note = loc
                    .get("error")
                    .and_then(|v| v.as_str())
                    .unwrap_or("Element not found")
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
                    if (!el) return {{ ok: false, error: "Input not found: " + q }};
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
                    const cx = Math.round(r.left + r.width/2);
                    const cy = Math.round(r.top + r.height/2);
                    let ov = document.getElementById("__loors_ai_cursor__");
                    if (ov) ov.remove();
                    ov = document.createElement("div");
                    ov.id = "__loors_ai_cursor__";
                    ov.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483647;";
                    ov.innerHTML = `<div style="position:fixed;left:${{r.left-2}}px;top:${{r.top-2}}px;width:${{r.width+4}}px;height:${{r.height+4}}px;border:2px solid #8b5cf6;background:rgba(139,92,246,0.12);border-radius:6px;box-shadow:0 0 12px rgba(139,92,246,0.45);"></div>`;
                    document.documentElement.appendChild(ov);
                    return {{ ok: true, cx, cy }};
                }})())"##
            );
            let res_raw = cdp_eval(&mut ws, &mut next_id, &js).await?;
            if let Ok(v) = serde_json::from_str::<Value>(&res_raw) {
                cursor_x = v.get("cx").and_then(|x| x.as_f64());
                cursor_y = v.get("cy").and_then(|y| y.as_f64());
                target_label = Some(format!("Type \"{text}\""));
            }
            emit_live_jpeg(
                session_id,
                &mut ws,
                &mut next_id,
                &session.current_url,
                action,
                target_label.clone(),
                cursor_x,
                cursor_y,
            )
            .await;
            tokio::time::sleep(Duration::from_millis(180)).await;
            let _ = cdp_eval(
                &mut ws,
                &mut next_id,
                "document.getElementById('__loors_ai_cursor__')?.remove()",
            )
            .await;
            action_note = format!("Typed into {selector}");
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
            let step = if direction == "up" { -220 } else { 220 };
            for _ in 0..3 {
                let _ = cdp_eval(&mut ws, &mut next_id, &format!("window.scrollBy(0, {step})")).await;
                tokio::time::sleep(Duration::from_millis(120)).await;
                emit_live_jpeg(
                    session_id,
                    &mut ws,
                    &mut next_id,
                    &session.current_url,
                    "scroll",
                    Some(format!("Scroll {direction}")),
                    None,
                    None,
                )
                .await;
            }
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
        session_id,
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
            console_errors: window.__loorsConsoleErrors || [],
            network_errors: window.__loorsNetworkErrors || []
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
            session_id: session_id.to_owned(),
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
    let text_str = text_val.as_str().unwrap_or("");
    let text_trimmed_len = text_str.trim().len();
    let lower_url = final_url.to_ascii_lowercase();
    let lower_title = final_title.to_ascii_lowercase();
    let lower_text = text_str.to_ascii_lowercase();
    let looks_parked_or_blank = (interactive_len <= 1 && text_trimmed_len < 40)
        || lower_url.ends_with("/lander")
        || lower_url.contains("sedoparking")
        || lower_url.contains("parkingcrew");

    let needs_human_takeover = lower_text.contains("verify you are human")
        || lower_text.contains("prove your humanity")
        || lower_text.contains("complete the captcha")
        || lower_text.contains("i'm not a robot")
        || lower_text.contains("blocked by network security")
        || lower_text.contains("checking your browser")
        || lower_title.contains("just a moment")
        || lower_text.contains("log in to continue")
        || lower_text.contains("sign in to continue");

    let warning = if needs_human_takeover {
        Some(format!(
            "HUMAN INTERVENTION REQUIRED: The page '{}' is showing a human verification, CAPTCHA, or login gate. Do NOT attempt to click through or bypass it. Pause and ask the user to sign in or complete the verification directly in Loors's right-side Browser panel, then continue once the user confirms.",
            final_url
        ))
    } else if looks_parked_or_blank {
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
        "human_action_required": needs_human_takeover,
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
async fn emit_live_jpeg<S>(
    session_id: &str,
    ws: &mut S,
    next_id: &mut u64,
    url: &str,
    action: &str,
    target_label: Option<String>,
    cursor_x: Option<f64>,
    cursor_y: Option<f64>,
) where
    S: futures_util::Stream<Item = Result<Message, tokio_tungstenite::tungstenite::Error>>
        + futures_util::Sink<Message, Error = tokio_tungstenite::tungstenite::Error>
        + Unpin,
{
    if let Ok(shot) = cdp_call(
        ws,
        next_id,
        "Page.captureScreenshot",
        json!({ "format": "jpeg", "quality": 80 }),
    )
    .await
    {
        if let Some(b64) = shot.get("data").and_then(|v| v.as_str()) {
            emit_browser_frame(BrowserFrameEvent {
                session_id: session_id.to_owned(),
                url: url.to_string(),
                title: String::new(),
                action: action.to_string(),
                target_label,
                cursor_x,
                cursor_y,
                frame_base64: b64.to_string(),
                console_errors: Vec::new(),
                network_errors: Vec::new(),
            });
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn capture_and_emit<S>(
    session_id: &str,
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
        let rel = screenshot_rel.unwrap_or(".loors/screenshot.png");
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
            session_id: session_id.to_owned(),
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
        .join("loors")
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
        .user_agent("Loors-Desktop/0.1")
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

pub(super) fn find_system_browser() -> Option<PathBuf> {
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

    // Both tests drive and close the same process-wide browser session.
    static BROWSER_TEST_LOCK: AsyncMutex<()> = AsyncMutex::const_new(());

    #[tokio::test]
    async fn e2e_browser_goto_type_click_and_screenshot() {
        let _browser = BROWSER_TEST_LOCK.lock().await;
        // Spin up a local test page on 127.0.0.1 with an input and clickable button
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind local test server");
        let port = listener.local_addr().unwrap().port();
        let html = r#"<!doctype html><html><body style="font-family:sans-serif;padding:24px;">
            <h1>Loors Browser E2E</h1>
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
        let ws = std::env::temp_dir().join(format!("loors-browser-e2e-{ts}"));
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
            initial_text.contains("Loors Browser E2E") && initial_text.contains("Idle"),
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
            &json!({ "action": "type", "selector": "#name-input", "text": "Loors Agent" }),
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
            after_text.contains("Clicked: Loors Agent"),
            "Expected click to update DOM to 'Clicked: Loors Agent', got: {after_text}"
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

    #[tokio::test]
    async fn e2e_browser_interact_screencast_navigate_click_scroll_and_tabs() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        use tokio::net::TcpListener;

        let _browser = BROWSER_TEST_LOCK.lock().await;
        if find_system_browser().is_none() && find_portable_browser().is_none() {
            eprintln!("Skipping E2E browser_interact test: no local browser installed");
            return;
        }

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server_task = tokio::spawn(async move {
            loop {
                let Ok((mut sock, _)) = listener.accept().await else {
                    break;
                };
                let mut buf = [0u8; 2048];
                let n = sock.read(&mut buf).await.unwrap_or(0);
                let req_str = String::from_utf8_lossy(&buf[..n]);
                let html = if req_str.contains("GET /page2") {
                    "<!doctype html><html><head><title>Page Two</title></head><body><h1>Page Two Loaded</h1></body></html>"
                } else {
                    r#"<!doctype html>
<html>
<head>
  <title>Interactive Test</title>
  <style>
    body { margin: 0; padding: 0; height: 2400px; font-family: sans-serif; background: #fff; }
    #btn { position: fixed; top: 40px; left: 40px; width: 160px; height: 50px; font-size: 16px; }
    #inp { position: fixed; top: 110px; left: 40px; width: 220px; height: 34px; }
    #status { position: fixed; top: 160px; left: 40px; font-size: 18px; }
  </style>
</head>
<body>
  <button id="btn" onclick="window.__clicks=(window.__clicks||0)+1; document.getElementById('status').textContent='Clicks:'+window.__clicks;">Click Me</button>
  <input id="inp" type="text" placeholder="Type here" />
  <div id="status">Clicks:0</div>
</body>
</html>"#
                };
                let resp = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    html.len(),
                    html
                );
                let _ = sock.write_all(resp.as_bytes()).await;
            }
        });

        let cast_frames = Arc::new(AtomicUsize::new(0));
        let cast_frames_cb = cast_frames.clone();
        set_browser_screencast_listener(move |ev| {
            if !ev.frame_base64.is_empty() {
                cast_frames_cb.fetch_add(1, Ordering::Relaxed);
            }
        });

        let base_req = |action: &str| BrowserInteractRequest {
            action: action.to_string(),
            url: None,
            x: None,
            y: None,
            button: None,
            click_count: None,
            delta_x: None,
            delta_y: None,
            text: None,
            key: None,
            code: None,
            modifiers: None,
            width: Some(900),
            height: Some(700),
            device_scale_factor: Some(1.25),
            tab_id: None,
            session_id: Some("sess-e2e-1".to_string()),
        };

        // 1. Navigate to page 1
        let mut nav = base_req("navigate");
        nav.url = Some(format!("http://127.0.0.1:{port}/"));
        let r1 = browser_interact(nav).await.expect("navigate page 1 failed");
        assert!(r1.active);
        assert!(r1.url.contains(&format!("127.0.0.1:{port}")), "unexpected url: {}", r1.url);
        assert!(r1.frame_base64.is_some(), "navigate should return initial frame");
        assert_eq!(r1.tabs.len(), 1, "should have 1 tab for sess-e2e-1");

        // 2. Click exact coordinates of #btn (left: 40..200, top: 40..90 -> center 120, 65)
        let t_click = std::time::Instant::now();
        let mut clk = base_req("click");
        clk.x = Some(120.0);
        clk.y = Some(65.0);
        let _ = browser_interact(clk).await.expect("click #btn failed");
        let click_ms = t_click.elapsed().as_millis();
        eprintln!("[E2E] click latency: {click_ms}ms");

        // 3. Wheel scroll down
        let t_wheel = std::time::Instant::now();
        let mut whl = base_req("wheel");
        whl.x = Some(400.0);
        whl.y = Some(300.0);
        whl.delta_y = Some(420.0);
        let _ = browser_interact(whl).await.expect("wheel failed");
        let wheel_ms = t_wheel.elapsed().as_millis();
        eprintln!("[E2E] wheel latency: {wheel_ms}ms");

        // 4. Focus #inp (left: 40..260, top: 110..144 -> center 120, 127) and type text
        let mut focus_inp = base_req("click");
        focus_inp.x = Some(120.0);
        focus_inp.y = Some(127.0);
        let _ = browser_interact(focus_inp).await.expect("click #inp failed");

        let t_text = std::time::Instant::now();
        let mut txt = base_req("text");
        txt.text = Some("Hello Screencast".to_string());
        let _ = browser_interact(txt).await.expect("text failed");
        let text_ms = t_text.elapsed().as_millis();
        eprintln!("[E2E] text latency: {text_ms}ms");

        // Allow screencast to deliver frames & verify DOM state directly via CDP actor
        tokio::time::sleep(Duration::from_millis(200)).await;
        let frames_received = cast_frames.load(Ordering::Relaxed);
        eprintln!("[E2E] live screencast frames pushed: {frames_received}");
        assert!(frames_received >= 1, "Expected live Page.startScreencast frames, got 0");

        {
            let guard = session_mutex().lock().await;
            let sess = guard.as_ref().unwrap();
            let actor = sess.actor.as_ref().unwrap();
            let state = actor
                .eval("JSON.stringify({ clicks: window.__clicks || 0, scrollY: Math.round(window.scrollY), val: document.getElementById('inp').value })")
                .await
                .unwrap();
            eprintln!("[E2E] DOM state after click+wheel+text: {state}");
            let v: Value = serde_json::from_str(&state).unwrap();
            assert_eq!(v["clicks"].as_i64(), Some(1), "Click missed #btn! state={state}");
            assert!(v["scrollY"].as_i64().unwrap_or(0) > 100, "Wheel did not scroll! state={state}");
            assert_eq!(v["val"].as_str(), Some("Hello Screencast"), "Text input missed! state={state}");
        }

        // 5. Navigate to /page2, then Back, then Forward
        let mut nav2 = base_req("navigate");
        nav2.url = Some(format!("http://127.0.0.1:{port}/page2"));
        let r2 = browser_interact(nav2).await.expect("navigate page2 failed");
        assert!(r2.url.contains("/page2"), "expected /page2, got {}", r2.url);
        assert!(r2.can_go_back, "expected can_go_back after navigating to /page2");

        let r_back = browser_interact(base_req("back")).await.expect("back failed");
        assert!(!r_back.url.contains("/page2"), "back did not return to page1: {}", r_back.url);

        // 6. New tab (about:blank), then close tab
        let mut nt = base_req("new_tab");
        nt.url = Some("about:blank".to_string());
        let r_nt = browser_interact(nt).await.expect("new_tab failed");
        assert_eq!(r_nt.tabs.len(), 2, "expected 2 tabs after new_tab");

        let tab_to_close = r_nt.tabs.iter().find(|t| t.active).unwrap().id.clone();
        let mut ct = base_req("close_tab");
        ct.tab_id = Some(tab_to_close);
        let r_ct = browser_interact(ct).await.expect("close_tab failed");
        assert_eq!(r_ct.tabs.len(), 1, "expected 1 tab after closing second tab");

        shutdown_browser().await;
        server_task.abort();
    }
}
