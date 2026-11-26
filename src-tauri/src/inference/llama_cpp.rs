use crate::inference::{ChatRequest, ChatResponse, ModelLoadConfig, ToolCall, ToolCallFunction};
use futures_util::StreamExt;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::net::TcpListener;
use std::path::Path;
use std::process::Stdio;
use std::sync::{Arc, OnceLock};
use std::time::Duration;
use tokio::process::{Child, Command};
use tokio::sync::Mutex;

#[derive(Debug, Clone, Serialize)]
pub struct ModelLoadProgressEvent {
    pub stage: String,
    pub model_name: String,
    pub percent: Option<u8>,
    pub message: String,
}

type LoadListener = Arc<dyn Fn(ModelLoadProgressEvent) + Send + Sync>;
static MODEL_LOAD_LISTENER: OnceLock<std::sync::Mutex<Option<LoadListener>>> = OnceLock::new();

pub fn set_model_load_listener<F>(f: F)
where
    F: Fn(ModelLoadProgressEvent) + Send + Sync + 'static,
{
    let cell = MODEL_LOAD_LISTENER.get_or_init(|| std::sync::Mutex::new(None));
    if let Ok(mut guard) = cell.lock() {
        *guard = Some(Arc::new(f));
    }
}

fn emit_load_progress(stage: &str, model_name: &str, percent: Option<u8>, message: impl Into<String>) {
    if let Some(cell) = MODEL_LOAD_LISTENER.get() {
        if let Ok(guard) = cell.lock() {
            if let Some(cb) = guard.as_ref() {
                cb(ModelLoadProgressEvent {
                    stage: stage.to_string(),
                    model_name: model_name.to_string(),
                    percent,
                    message: message.into(),
                });
            }
        }
    }
}

fn short_model_name(path: &str) -> String {
    Path::new(path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(path)
        .to_string()
}

struct ActiveRuntime {
    config: ModelLoadConfig,
    port: u16,
    child: Child,
}

#[derive(Clone, Default)]
pub struct LlamaCppManager {
    active: Arc<Mutex<Option<ActiveRuntime>>>,
    client: reqwest::Client,
}

impl LlamaCppManager {
    pub fn new() -> Self {
        Self {
            active: Arc::new(Mutex::new(None)),
            client: reqwest::Client::new(),
        }
    }

    pub async fn ensure_loaded(&self, config: ModelLoadConfig) -> Result<u16, String> {
        let mut guard = self.active.lock().await;
        let target_name = short_model_name(&config.model_path);

        if let Some(ref mut current) = *guard {
            let still_alive = matches!(current.child.try_wait(), Ok(None));
            if still_alive && current.config == config {
                return Ok(current.port);
            }
            let prev_name = short_model_name(&current.config.model_path);
            emit_load_progress(
                "unloading",
                &prev_name,
                Some(5),
                format!("Unloading {prev_name} from VRAM…"),
            );
            let _ = current.child.kill().await;
            let _ = current.child.wait().await;
            *guard = None;
        }

        emit_load_progress(
            "starting",
            &target_name,
            Some(10),
            format!("Starting llama-server for {target_name}…"),
        );

        let port = pick_free_port()?;
        let mut cmd = Command::new(&config.binary_path);
        #[cfg(target_os = "windows")]
        cmd.creation_flags(0x0800_0000);
        cmd.args([
            "--model",
            &config.model_path,
            "--host",
            "127.0.0.1",
            "--port",
            &port.to_string(),
            "--ctx-size",
            &config.context_size.to_string(),
            "--n-gpu-layers",
            &config.gpu_layers.to_string(),
            "--jinja",
        ]);
        if config.flash_attn {
            cmd.args(["--flash-attn", "on"]);
        } else {
            cmd.args(["--flash-attn", "off"]);
        }
        if !config.cache_type_k.trim().is_empty() {
            cmd.args(["--cache-type-k", config.cache_type_k.trim()]);
        }
        if !config.cache_type_v.trim().is_empty() {
            cmd.args(["--cache-type-v", config.cache_type_v.trim()]);
        }
        if config.batch_size > 0 {
            cmd.args(["-b", &config.batch_size.to_string()]);
        }
        if config.ubatch_size > 0 {
            cmd.args(["-ub", &config.ubatch_size.to_string()]);
        }
        if config.threads > 0 {
            cmd.args(["-t", &config.threads.to_string()]);
        }
        if config.mlock {
            cmd.arg("--mlock");
        }
        if config.no_mmap {
            cmd.arg("--no-mmap");
        }
        let has_parallel_override = config
            .extra_args
            .split_whitespace()
            .any(|f| f == "--parallel" || f == "-np");
        if !has_parallel_override {
            // Enable 2 concurrent inference slots so Agent Mode and a Harness can share the loaded model
            cmd.args(["--parallel", "2"]);
        }
        for flag in config.extra_args.split_whitespace() {
            if !flag.is_empty() {
                cmd.arg(flag);
            }
        }
        if let Some(ref mmproj) = config.mmproj_path {
            if !mmproj.trim().is_empty() && std::path::Path::new(mmproj).exists() {
                cmd.args(["--mmproj", mmproj]);
            }
        }
        cmd.stdout(Stdio::null())
            .stderr(Stdio::piped())
            .kill_on_drop(true);

        let mut child = cmd.spawn().map_err(|e| {
            format!(
                "No se pudo arrancar llama-server ({}): {e}",
                config.binary_path
            )
        })?;

        let stderr_tail = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        if let Some(stderr) = child.stderr.take() {
            let tail_clone = stderr_tail.clone();
            let model_for_log = target_name.clone();
            tokio::spawn(async move {
                use tokio::io::AsyncReadExt;
                let mut reader = stderr;
                let mut buf = [0u8; 512];
                let mut pending_line = String::new();
                let mut dot_count: u32 = 0;
                let mut last_pct: u8 = 10;

                while let Ok(n) = reader.read(&mut buf).await {
                    if n == 0 {
                        break;
                    }
                    let chunk = String::from_utf8_lossy(&buf[..n]);
                    // llama.cpp prints progress dots '.' during tensor loading
                    let dots_in_chunk = chunk.chars().filter(|&c| c == '.').count() as u32;
                    if dots_in_chunk > 0 && last_pct < 82 {
                        dot_count = dot_count.saturating_add(dots_in_chunk);
                        // Typical GGUF load prints ~40-80 dots; ease smoothly 16% -> 82%
                        let next_pct = (16 + ((dot_count.min(66)) as u8)).min(82);
                        if next_pct > last_pct {
                            last_pct = next_pct;
                            emit_load_progress(
                                "loading",
                                &model_for_log,
                                Some(last_pct),
                                format!("Loading tensors to GPU ({last_pct}%)…"),
                            );
                        }
                    }

                    pending_line.push_str(&chunk);
                    while let Some(pos) = pending_line.find('\n') {
                        let line = pending_line[..pos].trim().to_string();
                        pending_line.drain(..=pos);
                        if line.is_empty() {
                            continue;
                        }
                        let lower = line.to_lowercase();
                        if lower.contains("llama_model_loader") && last_pct < 16 {
                            last_pct = 16;
                            emit_load_progress(
                                "loading",
                                &model_for_log,
                                Some(last_pct),
                                "Reading GGUF metadata…",
                            );
                        } else if lower.contains("offloaded") && lower.contains("layers") {
                            if last_pct < 85 {
                                last_pct = 85;
                            }
                            emit_load_progress(
                                "loading",
                                &model_for_log,
                                Some(last_pct),
                                format!("Layers offloaded to GPU ({last_pct}%)…"),
                            );
                        } else if (lower.contains("kv_cache") || lower.contains("create_context") || lower.contains("graph_reserve")) && last_pct < 92 {
                            last_pct = 92;
                            emit_load_progress(
                                "loading",
                                &model_for_log,
                                Some(last_pct),
                                "Allocating KV cache and context…",
                            );
                        } else if (lower.contains("warming up") || lower.contains("server is listening") || lower.contains("model loaded")) && last_pct < 97 {
                            last_pct = 97;
                            emit_load_progress(
                                "loading",
                                &model_for_log,
                                Some(last_pct),
                                "Finalizing initialization…",
                            );
                        }

                        if let Ok(mut tbuf) = tail_clone.lock() {
                            tbuf.push(line);
                            if tbuf.len() > 20 {
                                tbuf.remove(0);
                            }
                        }
                    }
                }
            });
        }

        let health_url = format!("http://127.0.0.1:{port}/health");
        let mut ready = false;
        // Allow up to 180 seconds for large GGUF models and first-time Vulkan/CUDA shader compilation
        for _ in 0..720 {
            if let Ok(Some(status)) = child.try_wait() {
                let tail = stderr_tail
                    .lock()
                    .map(|b| b.join("\n"))
                    .unwrap_or_default();
                emit_load_progress(
                    "error",
                    &target_name,
                    None,
                    format!("Error loading {target_name}"),
                );
                let clean_tail = regex::Regex::new(r"\x1b\[[0-9;]*[a-zA-Z]")
                    .map(|re| re.replace_all(&tail, "").into_owned())
                    .unwrap_or(tail);
                return Err(format!(
                    "llama-server terminó inesperadamente al cargar el modelo (código {:?}).\n{clean_tail}",
                    status.code()
                ));
            }
            if let Ok(resp) = self.client.get(&health_url).send().await {
                if resp.status().is_success() {
                    ready = true;
                    break;
                }
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }

        if !ready {
            let _ = child.kill().await;
            let tail = stderr_tail
                .lock()
                .map(|b| b.join("\n"))
                .unwrap_or_default();
            emit_load_progress(
                "error",
                &target_name,
                None,
                format!("Timeout loading {target_name}"),
            );
            return Err(format!(
                "Timeout (180s) waiting for llama-server to load the GGUF model.\n{tail}"
            ));
        }

        emit_load_progress(
            "ready",
            &target_name,
            Some(100),
            format!("{target_name} ready"),
        );

        *guard = Some(ActiveRuntime {
            config,
            port,
            child,
        });
        Ok(port)
    }

    pub async fn shutdown(&self) {
        let mut guard = self.active.lock().await;
        if let Some(ref mut current) = *guard {
            let prev_name = short_model_name(&current.config.model_path);
            emit_load_progress(
                "unloading",
                &prev_name,
                Some(50),
                format!("Unloading {prev_name} from VRAM…"),
            );
            let _ = current.child.kill().await;
            let _ = current.child.wait().await;
            emit_load_progress("unloaded", &prev_name, None, "VRAM cleared");
        }
        *guard = None;
    }

    pub async fn chat_stream<F>(
        &self,
        port: u16,
        request: ChatRequest,
        cancel: Option<&std::sync::Arc<std::sync::atomic::AtomicBool>>,
        mut on_token: F,
    ) -> Result<ChatResponse, String>
    where
        F: FnMut(bool, &str),
    {
        let serialized_messages: Vec<Value> = request
            .messages
            .iter()
            .map(|m| m.to_openai_json())
            .collect();

        let mut body = json!({
            "model": "local-gguf",
            "messages": serialized_messages,
            "temperature": request.temperature,
            "stream": true,
        });

        if let Some(top_p) = request.top_p {
            body["top_p"] = json!(top_p);
        }
        if let Some(min_p) = request.min_p {
            body["min_p"] = json!(min_p);
        }
        if let Some(rp) = request.repeat_penalty {
            body["repeat_penalty"] = json!(rp);
        }
        if let Some(seed) = request.seed {
            if seed >= 0 {
                body["seed"] = json!(seed);
            }
        }
        if let Some(max_t) = request.max_tokens {
            if max_t > 0 {
                body["max_tokens"] = json!(max_t);
            }
        }
        if let Some(ref effort) = request.reasoning_effort {
            match effort.as_str() {
                "off" => {
                    body["chat_template_kwargs"] = json!({ "enable_thinking": false });
                    body["reasoning_effort"] = json!("none");
                    body["reasoning_budget"] = json!(0);
                }
                "low" => {
                    body["chat_template_kwargs"] = json!({ "enable_thinking": true });
                    body["reasoning_effort"] = json!("low");
                    body["reasoning_budget"] = json!(1024);
                }
                "medium" => {
                    body["chat_template_kwargs"] = json!({ "enable_thinking": true });
                    body["reasoning_effort"] = json!("medium");
                    body["reasoning_budget"] = json!(4096);
                }
                "high" => {
                    body["chat_template_kwargs"] = json!({ "enable_thinking": true });
                    body["reasoning_effort"] = json!("high");
                    body["reasoning_budget"] = json!(-1);
                }
                _ => {}
            }
        }

        if !request.tools.is_empty() {
            body["tools"] = Value::Array(request.tools);
            body["tool_choice"] = json!("auto");
        }

        let url = format!("http://127.0.0.1:{port}/v1/chat/completions");
        let send_fut = self.client.post(&url).json(&body).send();
        let resp = if let Some(flag) = cancel {
            tokio::select! {
                r = send_fut => r.map_err(|e| format!("Error conectando con llama-server embebido: {e}"))?,
                _ = wait_until_cancelled(flag) => {
                    return Err("__CANCELLED__".to_string());
                }
            }
        } else {
            send_fut
                .await
                .map_err(|e| format!("Error conectando con llama-server embebido: {e}"))?
        };

        if !resp.status().is_success() {
            let status = resp.status();
            let err_body = resp.text().await.unwrap_or_default();
            return Err(format!("llama-server devolvió HTTP {status}: {err_body}"));
        }

        let mut stream = resp.bytes_stream();
        let mut line_buf = String::new();
        let mut full_content = String::new();
        let mut tool_acc: BTreeMap<usize, (String, String, String)> = BTreeMap::new();
        let mut finish_reason: Option<String> = None;

        loop {
            if let Some(flag) = cancel {
                if flag.load(std::sync::atomic::Ordering::SeqCst) {
                    return Err("__CANCELLED__".to_string());
                }
            }

            let next_item = if let Some(flag) = cancel {
                tokio::select! {
                    item = stream.next() => item,
                    _ = wait_until_cancelled(flag) => {
                        return Err("__CANCELLED__".to_string());
                    }
                }
            } else {
                stream.next().await
            };

            let Some(chunk_res) = next_item else {
                break;
            };
            let chunk = chunk_res.map_err(|e| format!("Error leyendo stream de tokens: {e}"))?;
            line_buf.push_str(&String::from_utf8_lossy(&chunk));

            while let Some(pos) = line_buf.find('\n') {
                let raw_line = line_buf[..pos].trim().to_string();
                line_buf.drain(..=pos);

                let Some(data) = raw_line.strip_prefix("data:") else {
                    continue;
                };
                let data = data.trim();
                if data.is_empty() || data == "[DONE]" {
                    continue;
                }

                let Ok(parsed) = serde_json::from_str::<Value>(data) else {
                    continue;
                };
                let Some(choice0) = parsed.get("choices").and_then(|c| c.get(0)) else {
                    continue;
                };
                if let Some(fr) = choice0.get("finish_reason").and_then(|v| v.as_str()) {
                    if !fr.is_empty() {
                        finish_reason = Some(fr.to_string());
                    }
                }
                let Some(delta) = choice0.get("delta") else {
                    continue;
                };

                if let Some(thinking) = delta
                    .get("reasoning_content")
                    .or_else(|| delta.get("reasoning"))
                    .or_else(|| delta.get("thinking"))
                    .and_then(|v| v.as_str())
                {
                    if !thinking.is_empty() {
                        on_token(true, thinking);
                    }
                }

                if let Some(text) = delta.get("content").and_then(|v| v.as_str()) {
                    if !text.is_empty() {
                        full_content.push_str(text);
                        on_token(false, text);
                    }
                }

                if let Some(tcs) = delta.get("tool_calls").and_then(|v| v.as_array()) {
                    for tc in tcs {
                        let idx = tc.get("index").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
                        let entry = tool_acc.entry(idx).or_insert_with(|| {
                            (format!("call_{idx}"), String::new(), String::new())
                        });
                        if let Some(id) = tc.get("id").and_then(|v| v.as_str()) {
                            if !id.is_empty() {
                                entry.0 = id.to_string();
                            }
                        }
                        if let Some(func) = tc.get("function") {
                            if let Some(name) = func.get("name").and_then(|v| v.as_str()) {
                                if entry.1.is_empty() && !name.is_empty() {
                                    on_token(true, &format!("\n[Preparando llamada a herramienta: {name}...]\n"));
                                }
                                entry.1.push_str(name);
                            }
                            if let Some(args) = func.get("arguments").and_then(|v| v.as_str()) {
                                entry.2.push_str(args);
                            }
                        }
                    }
                }
            }
        }

        let tool_calls = tool_acc
            .into_values()
            .filter(|(_, name, _)| !name.is_empty())
            .map(|(id, name, arguments)| ToolCall {
                id,
                call_type: "function".to_string(),
                function: ToolCallFunction { name, arguments },
            })
            .collect();

        Ok(ChatResponse {
            content: full_content,
            tool_calls,
            finish_reason,
        })
    }
}

async fn wait_until_cancelled(flag: &std::sync::Arc<std::sync::atomic::AtomicBool>) {
    loop {
        if flag.load(std::sync::atomic::Ordering::SeqCst) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(120)).await;
    }
}

fn pick_free_port() -> Result<u16, String> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .map_err(|e| format!("No se pudo asignar puerto local libre: {e}"))?;
    listener
        .local_addr()
        .map(|addr| addr.port())
        .map_err(|e| format!("No se pudo leer puerto local: {e}"))
}
