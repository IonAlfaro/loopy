use crate::engine::{EngineManager, WorkflowGraph};
use crate::hardware::RuntimeBackendKind;
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

#[derive(Debug, Clone, Serialize)]
pub struct TriggerStatus {
    pub webhook_running: bool,
    pub webhook_port: u16,
    pub interval_running: bool,
    pub interval_minutes: u64,
    pub telegram_running: bool,
}

pub struct TriggerManager {
    webhook_stop: Mutex<Option<Arc<AtomicBool>>>,
    webhook_port: Mutex<u16>,
    interval_stop: Mutex<Option<Arc<AtomicBool>>>,
    interval_minutes: Mutex<u64>,
    telegram_stop: Mutex<Option<Arc<AtomicBool>>>,
}

impl Default for TriggerManager {
    fn default() -> Self {
        Self {
            webhook_stop: Mutex::new(None),
            webhook_port: Mutex::new(14290),
            interval_stop: Mutex::new(None),
            interval_minutes: Mutex::new(30),
            telegram_stop: Mutex::new(None),
        }
    }
}

impl TriggerManager {
    pub fn status(&self) -> TriggerStatus {
        let webhook_running = self
            .webhook_stop
            .lock()
            .ok()
            .and_then(|g| g.as_ref().map(|f| !f.load(Ordering::SeqCst)))
            .unwrap_or(false);
        let webhook_port = self.webhook_port.lock().map(|g| *g).unwrap_or(14290);
        let interval_running = self
            .interval_stop
            .lock()
            .ok()
            .and_then(|g| g.as_ref().map(|f| !f.load(Ordering::SeqCst)))
            .unwrap_or(false);
        let interval_minutes = self.interval_minutes.lock().map(|g| *g).unwrap_or(30);
        let telegram_running = self
            .telegram_stop
            .lock()
            .ok()
            .and_then(|g| g.as_ref().map(|f| !f.load(Ordering::SeqCst)))
            .unwrap_or(false);

        TriggerStatus {
            webhook_running,
            webhook_port,
            interval_running,
            interval_minutes,
            telegram_running,
        }
    }

    pub fn stop_webhook(&self) {
        if let Ok(mut guard) = self.webhook_stop.lock() {
            if let Some(flag) = guard.take() {
                flag.store(true, Ordering::SeqCst);
            }
        }
    }

    pub fn stop_interval(&self) {
        if let Ok(mut guard) = self.interval_stop.lock() {
            if let Some(flag) = guard.take() {
                flag.store(true, Ordering::SeqCst);
            }
        }
    }

    pub fn stop_telegram(&self) {
        if let Ok(mut guard) = self.telegram_stop.lock() {
            if let Some(flag) = guard.take() {
                flag.store(true, Ordering::SeqCst);
            }
        }
    }

    pub async fn start_webhook(
        &self,
        app: AppHandle,
        port: u16,
        graph: WorkflowGraph,
        backend: RuntimeBackendKind,
    ) -> Result<String, String> {
        self.stop_webhook();

        let listener = TcpListener::bind(("127.0.0.1", port))
            .await
            .map_err(|e| format!("No se pudo abrir puerto webhook 127.0.0.1:{port}: {e}"))?;

        let stop_flag = Arc::new(AtomicBool::new(false));
        if let Ok(mut guard) = self.webhook_stop.lock() {
            *guard = Some(stop_flag.clone());
        }
        if let Ok(mut p) = self.webhook_port.lock() {
            *p = port;
        }

        tauri::async_runtime::spawn(async move {
            while !stop_flag.load(Ordering::SeqCst) {
                let accept = tokio::time::timeout(Duration::from_millis(500), listener.accept()).await;
                let Ok(Ok((mut socket, _))) = accept else {
                    continue;
                };

                let mut buf = vec![0u8; 32_768];
                let n = match socket.read(&mut buf).await {
                    Ok(n) if n > 0 => n,
                    _ => continue,
                };
                let req_str = String::from_utf8_lossy(&buf[..n]);
                let body = req_str
                    .split("\r\n\r\n")
                    .nth(1)
                    .unwrap_or("")
                    .trim()
                    .to_string();

                let mut run_graph = graph.clone();
                if !body.is_empty() {
                    if let Some(trig) = run_graph.nodes.iter_mut().find(|n| n.data.kind == "trigger") {
                        trig.data.config.insert(
                            "payloadTemplate".to_string(),
                            serde_json::Value::String(format!("[Webhook Payload]:\n{body}")),
                        );
                    } else if let Some(inp) = run_graph.nodes.iter_mut().find(|n| n.data.kind == "task_input") {
                        let base_prompt = inp
                            .data
                            .config
                            .get("prompt")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string();
                        inp.data.config.insert(
                            "prompt".to_string(),
                            serde_json::Value::String(format!(
                                "{base_prompt}\n\n[Webhook Payload]:\n{body}"
                            )),
                        );
                    }
                }

                let app_clone = app.clone();
                let resp_body = if let Some(engine) = app.try_state::<EngineManager>() {
                    match engine.start_run(run_graph, backend.clone(), move |ev| {
                        let _ = app_clone.emit("loopy://engine-event", ev);
                    }) {
                        Ok(run_id) => format!("{{\"status\":\"triggered\",\"run_id\":\"{run_id}\"}}"),
                        Err(e) => format!("{{\"status\":\"error\",\"error\":\"{e}\"}}"),
                    }
                } else {
                    "{\"status\":\"error\",\"error\":\"EngineManager unavailable\"}".to_string()
                };

                let http_resp = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    resp_body.len(),
                    resp_body
                );
                let _ = socket.write_all(http_resp.as_bytes()).await;
            }
        });

        Ok(format!("http://127.0.0.1:{port}/trigger"))
    }

    pub fn start_interval(
        &self,
        app: AppHandle,
        minutes: u64,
        graph: WorkflowGraph,
        backend: RuntimeBackendKind,
    ) -> Result<(), String> {
        self.stop_interval();
        let mins = minutes.max(1);

        let stop_flag = Arc::new(AtomicBool::new(false));
        if let Ok(mut guard) = self.interval_stop.lock() {
            *guard = Some(stop_flag.clone());
        }
        if let Ok(mut m) = self.interval_minutes.lock() {
            *m = mins;
        }

        tauri::async_runtime::spawn(async move {
            let mut ticker = tokio::time::interval(Duration::from_secs(mins * 60));
            // Skip immediate first tick so user decides when to run or waits one interval
            ticker.tick().await;
            loop {
                tokio::select! {
                    _ = ticker.tick() => {
                        if stop_flag.load(Ordering::SeqCst) {
                            break;
                        }
                        if let Some(engine) = app.try_state::<EngineManager>() {
                            let app_clone = app.clone();
                            let _ = engine.start_run(graph.clone(), backend.clone(), move |ev| {
                                let _ = app_clone.emit("loopy://engine-event", ev);
                            });
                        }
                    }
                    _ = tokio::time::sleep(Duration::from_secs(1)) => {
                        if stop_flag.load(Ordering::SeqCst) {
                            break;
                        }
                    }
                }
            }
        });

        Ok(())
    }

    pub fn start_telegram(
        &self,
        app: AppHandle,
        bot_token: String,
        allowed_chat_id: String,
        graph: WorkflowGraph,
        backend: RuntimeBackendKind,
    ) -> Result<(), String> {
        self.stop_telegram();
        let token = bot_token.trim().to_string();
        if token.is_empty() {
            return Err("Falta el Bot Token de Telegram en el nodo Trigger.".to_string());
        }
        let allowed = allowed_chat_id.trim().to_string();

        let stop_flag = Arc::new(AtomicBool::new(false));
        if let Ok(mut guard) = self.telegram_stop.lock() {
            *guard = Some(stop_flag.clone());
        }

        tauri::async_runtime::spawn(async move {
            let client = reqwest::Client::builder()
                .timeout(Duration::from_secs(35))
                .build()
                .unwrap_or_default();
            let base_url = format!("https://api.telegram.org/bot{token}/getUpdates");
            let mut offset: i64 = 0;

            // Drain stale updates once on startup so we only react to new messages
            if let Ok(resp) = client
                .get(&base_url)
                .query(&[("timeout", "0"), ("limit", "50")])
                .send()
                .await
            {
                if let Ok(val) = resp.json::<serde_json::Value>().await {
                    if let Some(arr) = val.get("result").and_then(|r| r.as_array()) {
                        for u in arr {
                            if let Some(uid) = u.get("update_id").and_then(|v| v.as_i64()) {
                                offset = offset.max(uid + 1);
                            }
                        }
                    }
                }
            }

            while !stop_flag.load(Ordering::SeqCst) {
                let req = client
                    .get(&base_url)
                    .query(&[
                        ("timeout", "20"),
                        ("offset", &offset.to_string()),
                    ])
                    .send();

                let resp_res = tokio::select! {
                    r = req => r,
                    _ = async {
                        while !stop_flag.load(Ordering::SeqCst) {
                            tokio::time::sleep(Duration::from_millis(250)).await;
                        }
                    } => break,
                };

                let Ok(resp) = resp_res else {
                    tokio::time::sleep(Duration::from_secs(3)).await;
                    continue;
                };
                let Ok(val) = resp.json::<serde_json::Value>().await else {
                    tokio::time::sleep(Duration::from_secs(2)).await;
                    continue;
                };
                let Some(arr) = val.get("result").and_then(|r| r.as_array()) else {
                    continue;
                };

                for u in arr {
                    if let Some(uid) = u.get("update_id").and_then(|v| v.as_i64()) {
                        offset = offset.max(uid + 1);
                    }
                    let Some(msg) = u.get("message") else {
                        continue;
                    };
                    let chat_id = msg
                        .get("chat")
                        .and_then(|c| c.get("id"))
                        .and_then(|v| v.as_i64())
                        .map(|i| i.to_string())
                        .unwrap_or_default();
                    let text = msg
                        .get("text")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .trim()
                        .to_string();

                    if text.is_empty() || chat_id.is_empty() {
                        continue;
                    }
                    if !allowed.is_empty() && allowed != chat_id {
                        continue;
                    }

                    let mut run_graph = graph.clone();
                    if let Some(trig) = run_graph.nodes.iter_mut().find(|n| n.data.kind == "trigger") {
                        trig.data.config.insert(
                            "payloadTemplate".to_string(),
                            serde_json::Value::String(text.clone()),
                        );
                        trig.data.config.insert(
                            "lastChatId".to_string(),
                            serde_json::Value::String(chat_id.clone()),
                        );
                    }
                    // Also propagate chat_id & token to any notify node that left chatId/botToken empty
                    for n in run_graph.nodes.iter_mut() {
                        if n.data.kind == "notify" {
                            let has_chat = n
                                .data
                                .config
                                .get("chatId")
                                .and_then(|v| v.as_str())
                                .map(|s| !s.trim().is_empty())
                                .unwrap_or(false);
                            if !has_chat {
                                n.data.config.insert(
                                    "chatId".to_string(),
                                    serde_json::Value::String(chat_id.clone()),
                                );
                            }
                            let has_tok = n
                                .data
                                .config
                                .get("botToken")
                                .and_then(|v| v.as_str())
                                .map(|s| !s.trim().is_empty())
                                .unwrap_or(false);
                            if !has_tok {
                                n.data.config.insert(
                                    "botToken".to_string(),
                                    serde_json::Value::String(token.clone()),
                                );
                            }
                        }
                    }

                    if let Some(engine) = app.try_state::<EngineManager>() {
                        let app_clone = app.clone();
                        let _ = engine.start_run(run_graph, backend.clone(), move |ev| {
                            let _ = app_clone.emit("loopy://engine-event", ev);
                        });
                    }
                }
            }
        });

        Ok(())
    }
}
