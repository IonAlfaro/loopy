use crate::inference::{ChatMessage, ChatRequest, ChatResponse, ToolCall, ToolCallFunction};
use base64::Engine as _;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CloudProviderConfig {
    pub id: String,
    pub name: String,
    /// "openai_compat" | "anthropic"
    pub kind: String,
    pub base_url: String,
    pub api_key: String,
    pub models: Vec<String>,
    pub enabled: bool,
}

pub fn default_providers() -> Vec<CloudProviderConfig> {
    vec![
        CloudProviderConfig {
            id: "openai".to_string(),
            name: "OpenAI / ChatGPT".to_string(),
            kind: "openai_compat".to_string(),
            base_url: "https://api.openai.com/v1".to_string(),
            api_key: String::new(),
            models: Vec::new(),
            enabled: false,
        },
        CloudProviderConfig {
            id: "anthropic".to_string(),
            name: "Anthropic / Claude".to_string(),
            kind: "anthropic".to_string(),
            base_url: "https://api.anthropic.com".to_string(),
            api_key: String::new(),
            models: Vec::new(),
            enabled: false,
        },
        CloudProviderConfig {
            id: "gemini".to_string(),
            name: "Google Gemini".to_string(),
            kind: "openai_compat".to_string(),
            base_url: "https://generativelanguage.googleapis.com/v1beta/openai".to_string(),
            api_key: String::new(),
            models: Vec::new(),
            enabled: false,
        },
        CloudProviderConfig {
            id: "github".to_string(),
            name: "GitHub Models / Copilot".to_string(),
            kind: "openai_compat".to_string(),
            base_url: "https://models.inference.ai.azure.com".to_string(),
            api_key: String::new(),
            models: Vec::new(),
            enabled: false,
        },
        CloudProviderConfig {
            id: "openrouter".to_string(),
            name: "OpenRouter / OpenCode".to_string(),
            kind: "openai_compat".to_string(),
            base_url: "https://openrouter.ai/api/v1".to_string(),
            api_key: String::new(),
            models: Vec::new(),
            enabled: false,
        },
        CloudProviderConfig {
            id: "lmstudio".to_string(),
            name: "LM Studio".to_string(),
            kind: "openai_compat".to_string(),
            base_url: "http://127.0.0.1:1234/v1".to_string(),
            api_key: String::new(),
            models: Vec::new(),
            enabled: false,
        },
        CloudProviderConfig {
            id: "ollama".to_string(),
            name: "Ollama".to_string(),
            kind: "openai_compat".to_string(),
            base_url: "http://127.0.0.1:11434/v1".to_string(),
            api_key: String::new(),
            models: Vec::new(),
            enabled: false,
        },
    ]
}

fn providers_config_path() -> PathBuf {
    dirs::data_local_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join("loopy")
        .join("providers.json")
}

pub fn load_cloud_providers() -> Vec<CloudProviderConfig> {
    load_cloud_providers_from(&providers_config_path())
}

pub fn load_cloud_providers_from(path: &Path) -> Vec<CloudProviderConfig> {
    if let Ok(raw) = fs::read_to_string(path) {
        if let Ok(mut list) = serde_json::from_str::<Vec<CloudProviderConfig>>(&raw) {
            if !list.is_empty() {
                for p in &mut list {
                    if p.id == "ollama" && p.name.contains("LM Studio") {
                        p.name = "Ollama".to_string();
                    }
                }
                if !list.iter().any(|p| p.id == "lmstudio") {
                    if let Some(lm) = default_providers().into_iter().find(|p| p.id == "lmstudio") {
                        list.push(lm);
                    }
                }
                return list;
            }
        }
    }
    default_providers()
}

pub fn save_cloud_providers(providers: &[CloudProviderConfig]) -> Result<(), String> {
    save_cloud_providers_to(&providers_config_path(), providers)
}

pub fn save_cloud_providers_to(
    path: &Path,
    providers: &[CloudProviderConfig],
) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("No se pudo crear carpeta de proveedores: {e}"))?;
    }
    let json = serde_json::to_string_pretty(providers)
        .map_err(|e| format!("Error serializando proveedores: {e}"))?;
    fs::write(path, json).map_err(|e| format!("No se pudo guardar providers.json: {e}"))
}

pub fn is_cloud_model(model_path: &str) -> bool {
    model_path.trim().starts_with("cloud::")
}

pub fn parse_cloud_model(model_path: &str) -> Option<(String, String)> {
    let trimmed = model_path.trim();
    let mut parts = trimmed.splitn(3, "::");
    let prefix = parts.next()?;
    if prefix != "cloud" {
        return None;
    }
    let provider_id = parts.next()?.trim();
    let model_id = parts.next()?.trim();
    if provider_id.is_empty() || model_id.is_empty() {
        return None;
    }
    Some((provider_id.to_string(), model_id.to_string()))
}

pub fn expand_env_key(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.starts_with("${") && trimmed.ends_with('}') && trimmed.len() > 3 {
        let var_name = &trimmed[2..trimmed.len() - 1];
        std::env::var(var_name).unwrap_or_default()
    } else {
        trimmed.to_string()
    }
}

pub async fn fetch_provider_models(provider: &CloudProviderConfig) -> Result<Vec<String>, String> {
    let base_url = provider.base_url.trim().trim_end_matches('/');
    if base_url.is_empty() {
        return Err(format!(
            "Introduce la URL base para '{}' antes de cargar los modelos.",
            provider.name
        ));
    }

    let api_key = expand_env_key(&provider.api_key);
    let is_local_url = base_url.contains("127.0.0.1") || base_url.contains("localhost");
    if api_key.is_empty() && !is_local_url {
        return Err(format!(
            "Introduce tu API Key para '{}' antes de conectar.",
            provider.name
        ));
    }

    let url = if provider.kind == "anthropic" {
        if base_url.ends_with("/v1") {
            format!("{base_url}/models")
        } else {
            format!("{base_url}/v1/models")
        }
    } else if base_url.ends_with("/models") {
        base_url.to_string()
    } else {
        format!("{base_url}/models")
    };

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| format!("Error creando cliente HTTP: {e}"))?;

    let mut req = client.get(&url);
    if provider.kind == "anthropic" {
        req = req
            .header("x-api-key", &api_key)
            .header("anthropic-version", "2023-06-01");
    } else if !api_key.is_empty() {
        req = req.bearer_auth(&api_key);
    }

    let resp = req
        .send()
        .await
        .map_err(|e| format!("No se pudo conectar con {} ({url}): {e}", provider.name))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        let brief: String = body.chars().take(240).collect();
        return Err(format!(
            "Error {status} al consultar modelos de '{}': {brief}",
            provider.name
        ));
    }

    let val: Value = resp
        .json()
        .await
        .map_err(|e| format!("Respuesta JSON inválida desde {url}: {e}"))?;

    let raw_items: Vec<&Value> = if let Some(arr) = val.get("data").and_then(|v| v.as_array()) {
        arr.iter().collect()
    } else if let Some(arr) = val.get("models").and_then(|v| v.as_array()) {
        arr.iter().collect()
    } else if let Some(arr) = val.as_array() {
        arr.iter().collect()
    } else {
        Vec::new()
    };

    let is_openai_official = base_url.contains("api.openai.com");
    let mut ids: Vec<String> = Vec::new();
    for item in raw_items {
        let raw_id = item
            .get("id")
            .or_else(|| item.get("name"))
            .and_then(|v| v.as_str())
            .map(|s| s.trim())
            .filter(|s| !s.is_empty());
        let Some(id) = raw_id else {
            continue;
        };
        let cleaned = id.strip_prefix("models/").unwrap_or(id);
        let lower = cleaned.to_ascii_lowercase();
        if is_openai_official
            && (lower.contains("embedding")
                || lower.contains("whisper")
                || lower.contains("tts")
                || lower.contains("dall-e")
                || lower.contains("moderation")
                || lower.contains("babbage")
                || lower.contains("davinci")
                || lower.contains("realtime")
                || lower.contains("transcribe")
                || lower.contains("audio")
                || lower.contains("sora")
                || lower.contains("image"))
        {
            continue;
        }
        if !ids.iter().any(|existing| existing == cleaned) {
            ids.push(cleaned.to_string());
        }
    }

    ids.sort();
    if ids.is_empty() {
        return Err(format!(
            "La API de '{}' respondió correctamente pero no devolvió modelos disponibles.",
            provider.name
        ));
    }
    Ok(ids)
}

pub async fn chat_stream_cloud<F>(
    model_path: &str,
    request: ChatRequest,
    cancel: Option<&Arc<AtomicBool>>,
    on_token: F,
) -> Result<ChatResponse, String>
where
    F: FnMut(bool, &str),
{
    let (provider_id, model_id) = parse_cloud_model(model_path)
        .ok_or_else(|| format!("Identificador de modelo cloud inválido: '{model_path}'"))?;

    let providers = load_cloud_providers();
    let provider = providers
        .into_iter()
        .find(|p| p.id == provider_id)
        .ok_or_else(|| {
            format!(
                "Proveedor '{provider_id}' no encontrado. Configúralo en Modelos -> APIs / Cloud."
            )
        })?;

    let base_url = provider.base_url.trim().trim_end_matches('/').to_string();
    if base_url.is_empty() {
        return Err(format!(
            "El proveedor '{}' no tiene Base URL configurada.",
            provider.name
        ));
    }

    let api_key = expand_env_key(&provider.api_key);
    let is_local_url = base_url.contains("127.0.0.1") || base_url.contains("localhost");
    if api_key.is_empty() && !is_local_url {
        return Err(format!(
            "Falta la API Key para '{}'. Configúrala en Modelos -> APIs / Cloud.",
            provider.name
        ));
    }

    if provider.kind == "anthropic" {
        stream_anthropic(&base_url, &api_key, &model_id, request, cancel, on_token).await
    } else {
        stream_openai_compat(&base_url, &api_key, &model_id, request, cancel, on_token).await
    }
}

async fn stream_openai_compat<F>(
    base_url: &str,
    api_key: &str,
    model_id: &str,
    request: ChatRequest,
    cancel: Option<&Arc<AtomicBool>>,
    mut on_token: F,
) -> Result<ChatResponse, String>
where
    F: FnMut(bool, &str),
{
    let url = if base_url.ends_with("/chat/completions") {
        base_url.to_string()
    } else {
        format!("{base_url}/chat/completions")
    };

    let serialized_messages: Vec<Value> = request
        .messages
        .iter()
        .map(|m| m.to_openai_json())
        .collect();

    let lower_model = model_id.to_ascii_lowercase();
    let is_openai_reasoning =
        lower_model.starts_with("o1") || lower_model.starts_with("o3") || lower_model.starts_with("o4");

    let mut body = json!({
        "model": model_id,
        "messages": serialized_messages,
        "stream": true,
    });

    if !is_openai_reasoning {
        body["temperature"] = json!(request.temperature);
        if let Some(top_p) = request.top_p {
            body["top_p"] = json!(top_p);
        }
    }
    if let Some(max_tokens) = request.max_tokens.filter(|&v| v > 0) {
        if is_openai_reasoning {
            body["max_completion_tokens"] = json!(max_tokens);
        } else {
            body["max_tokens"] = json!(max_tokens);
        }
    }
    if !request.tools.is_empty() {
        body["tools"] = json!(request.tools);
        body["tool_choice"] = json!("auto");
    }
    if let Some(ref effort) = request.reasoning_effort {
        let trimmed = effort.trim().to_ascii_lowercase();
        if matches!(trimmed.as_str(), "low" | "medium" | "high") && is_openai_reasoning {
            body["reasoning_effort"] = json!(trimmed);
        }
    }

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(300))
        .build()
        .map_err(|e| format!("Error creando cliente HTTP: {e}"))?;

    let mut req_builder = client
        .post(&url)
        .header("content-type", "application/json")
        .header("HTTP-Referer", "https://github.com/loopy")
        .header("X-Title", "Loopy");
    if !api_key.is_empty() {
        req_builder = req_builder.bearer_auth(api_key);
    }

    let resp = req_builder
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Error conectando con API ({url}): {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("API error {status} ({model_id}): {text}"));
    }

    let mut stream = resp.bytes_stream();
    let mut sse_buf = String::new();
    let mut full_content = String::new();
    let mut finish_reason: Option<String> = None;
    let mut tool_calls_map: BTreeMap<usize, ToolCall> = BTreeMap::new();

    while let Some(chunk_res) = stream.next().await {
        if cancel.map(|c| c.load(Ordering::Relaxed)).unwrap_or(false) {
            return Err("__CANCELLED__".to_string());
        }
        let chunk = chunk_res.map_err(|e| format!("Error leyendo stream API: {e}"))?;
        sse_buf.push_str(&String::from_utf8_lossy(&chunk));

        while let Some(nl_pos) = sse_buf.find('\n') {
            let line = sse_buf[..nl_pos].trim().to_string();
            sse_buf.drain(..=nl_pos);

            if !line.starts_with("data:") {
                continue;
            }
            let data = line.trim_start_matches("data:").trim();
            if data.is_empty() || data == "[DONE]" {
                continue;
            }
            let Ok(parsed) = serde_json::from_str::<Value>(data) else {
                continue;
            };
            let Some(choice) = parsed
                .get("choices")
                .and_then(|c| c.as_array())
                .and_then(|a| a.first())
            else {
                continue;
            };

            if let Some(fr) = choice.get("finish_reason").and_then(|v| v.as_str()) {
                finish_reason = Some(fr.to_string());
            }

            if let Some(delta) = choice.get("delta") {
                if let Some(reason_tok) = delta
                    .get("reasoning_content")
                    .or_else(|| delta.get("reasoning"))
                    .and_then(|v| v.as_str())
                {
                    if !reason_tok.is_empty() {
                        on_token(true, reason_tok);
                    }
                }
                if let Some(tok) = delta.get("content").and_then(|v| v.as_str()) {
                    if !tok.is_empty() {
                        full_content.push_str(tok);
                        on_token(false, tok);
                    }
                }
                if let Some(tcs) = delta.get("tool_calls").and_then(|v| v.as_array()) {
                    for (fallback_idx, tc) in tcs.iter().enumerate() {
                        let idx = tc
                            .get("index")
                            .and_then(|v| v.as_u64())
                            .map(|v| v as usize)
                            .unwrap_or(fallback_idx);
                        let entry = tool_calls_map.entry(idx).or_insert_with(|| ToolCall {
                            id: format!("call_{idx}"),
                            call_type: "function".to_string(),
                            function: ToolCallFunction {
                                name: String::new(),
                                arguments: String::new(),
                            },
                        });
                        if let Some(id) = tc.get("id").and_then(|v| v.as_str()) {
                            if !id.is_empty() {
                                entry.id = id.to_string();
                            }
                        }
                        if let Some(func) = tc.get("function") {
                            if let Some(name) = func.get("name").and_then(|v| v.as_str()) {
                                entry.function.name.push_str(name);
                            }
                            if let Some(args) = func.get("arguments").and_then(|v| v.as_str()) {
                                entry.function.arguments.push_str(args);
                            }
                        }
                    }
                }
            }
        }
    }

    Ok(ChatResponse {
        content: full_content,
        tool_calls: tool_calls_map.into_values().collect(),
        finish_reason,
    })
}

fn build_anthropic_messages(messages: &[ChatMessage]) -> (String, Vec<Value>) {
    let mut system_parts: Vec<String> = Vec::new();
    let mut out: Vec<Value> = Vec::new();

    for msg in messages {
        match msg.role.as_str() {
            "system" => {
                if let Some(ref txt) = msg.content {
                    if !txt.trim().is_empty() {
                        system_parts.push(txt.clone());
                    }
                }
            }
            "tool" => {
                let block = json!({
                    "type": "tool_result",
                    "tool_use_id": msg.tool_call_id.clone().unwrap_or_else(|| "tool_0".to_string()),
                    "content": msg.content.clone().unwrap_or_default(),
                });
                // Merge consecutive tool_result blocks into the same user message (Anthropic requirement)
                let merged = if let Some(last) = out.last_mut() {
                    if last.get("role").and_then(|r| r.as_str()) == Some("user") {
                        if let Some(arr) = last.get_mut("content").and_then(|c| c.as_array_mut()) {
                            if arr
                                .first()
                                .and_then(|b| b.get("type"))
                                .and_then(|t| t.as_str())
                                == Some("tool_result")
                            {
                                arr.push(block.clone());
                                true
                            } else {
                                false
                            }
                        } else {
                            false
                        }
                    } else {
                        false
                    }
                } else {
                    false
                };
                if !merged {
                    out.push(json!({
                        "role": "user",
                        "content": [block],
                    }));
                }
            }
            "assistant" => {
                let mut blocks: Vec<Value> = Vec::new();
                if let Some(ref txt) = msg.content {
                    if !txt.is_empty() {
                        blocks.push(json!({ "type": "text", "text": txt }));
                    }
                }
                if let Some(ref tcs) = msg.tool_calls {
                    for tc in tcs {
                        let input: Value = serde_json::from_str(&tc.function.arguments)
                            .unwrap_or_else(|_| json!({}));
                        blocks.push(json!({
                            "type": "tool_use",
                            "id": tc.id,
                            "name": tc.function.name,
                            "input": input,
                        }));
                    }
                }
                if !blocks.is_empty() {
                    out.push(json!({ "role": "assistant", "content": blocks }));
                }
            }
            _ => {
                let mut blocks: Vec<Value> = Vec::new();
                for img_path in &msg.image_paths {
                    if let Ok(bytes) = fs::read(img_path) {
                        let mime = if img_path.to_lowercase().ends_with(".jpg")
                            || img_path.to_lowercase().ends_with(".jpeg")
                        {
                            "image/jpeg"
                        } else if img_path.to_lowercase().ends_with(".webp") {
                            "image/webp"
                        } else {
                            "image/png"
                        };
                        let b64 = base64::engine::general_purpose::STANDARD.encode(bytes);
                        blocks.push(json!({
                            "type": "image",
                            "source": {
                                "type": "base64",
                                "media_type": mime,
                                "data": b64,
                            }
                        }));
                    }
                }
                if let Some(ref txt) = msg.content {
                    blocks.push(json!({ "type": "text", "text": txt }));
                }
                if blocks.is_empty() {
                    blocks.push(json!({ "type": "text", "text": "" }));
                }
                out.push(json!({ "role": "user", "content": blocks }));
            }
        }
    }

    (system_parts.join("\n\n"), out)
}

fn convert_tools_to_anthropic(tools: &[Value]) -> Vec<Value> {
    tools
        .iter()
        .filter_map(|t| {
            let func = t.get("function")?;
            let name = func.get("name")?.as_str()?;
            let description = func
                .get("description")
                .and_then(|d| d.as_str())
                .unwrap_or("");
            let schema = func
                .get("parameters")
                .cloned()
                .unwrap_or_else(|| json!({ "type": "object", "properties": {} }));
            Some(json!({
                "name": name,
                "description": description,
                "input_schema": schema,
            }))
        })
        .collect()
}

async fn stream_anthropic<F>(
    base_url: &str,
    api_key: &str,
    model_id: &str,
    request: ChatRequest,
    cancel: Option<&Arc<AtomicBool>>,
    mut on_token: F,
) -> Result<ChatResponse, String>
where
    F: FnMut(bool, &str),
{
    let url = if base_url.ends_with("/messages") {
        base_url.to_string()
    } else if base_url.ends_with("/v1") {
        format!("{base_url}/messages")
    } else {
        format!("{base_url}/v1/messages")
    };

    let (system_prompt, messages) = build_anthropic_messages(&request.messages);
    let mut max_tokens = request.max_tokens.filter(|&v| v > 0).unwrap_or(8192);

    let thinking_budget = request.reasoning_effort.as_deref().and_then(|eff| {
        match eff.trim().to_ascii_lowercase().as_str() {
            "low" => Some(1024u32),
            "medium" => Some(4096u32),
            "high" => Some(10240u32),
            _ => None,
        }
    });

    if let Some(budget) = thinking_budget {
        if max_tokens <= budget {
            max_tokens = budget + 4096;
        }
    }

    let mut body = json!({
        "model": model_id,
        "max_tokens": max_tokens,
        "messages": messages,
        "stream": true,
    });

    if !system_prompt.is_empty() {
        body["system"] = json!(system_prompt);
    }
    if let Some(budget) = thinking_budget {
        body["thinking"] = json!({ "type": "enabled", "budget_tokens": budget });
    } else {
        body["temperature"] = json!(request.temperature);
    }
    if !request.tools.is_empty() {
        body["tools"] = json!(convert_tools_to_anthropic(&request.tools));
    }

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(300))
        .build()
        .map_err(|e| format!("Error creando cliente HTTP: {e}"))?;

    let resp = client
        .post(&url)
        .header("x-api-key", api_key)
        .header("anthropic-version", "2023-06-01")
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Error conectando con Anthropic ({url}): {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("Anthropic API error {status} ({model_id}): {text}"));
    }

    let mut stream = resp.bytes_stream();
    let mut sse_buf = String::new();
    let mut full_content = String::new();
    let mut finish_reason: Option<String> = None;
    let mut tool_calls_map: BTreeMap<usize, ToolCall> = BTreeMap::new();

    while let Some(chunk_res) = stream.next().await {
        if cancel.map(|c| c.load(Ordering::Relaxed)).unwrap_or(false) {
            return Err("__CANCELLED__".to_string());
        }
        let chunk = chunk_res.map_err(|e| format!("Error leyendo stream Anthropic: {e}"))?;
        sse_buf.push_str(&String::from_utf8_lossy(&chunk));

        while let Some(nl_pos) = sse_buf.find('\n') {
            let line = sse_buf[..nl_pos].trim().to_string();
            sse_buf.drain(..=nl_pos);

            if !line.starts_with("data:") {
                continue;
            }
            let data = line.trim_start_matches("data:").trim();
            if data.is_empty() {
                continue;
            }
            let Ok(parsed) = serde_json::from_str::<Value>(data) else {
                continue;
            };
            let ev_type = parsed.get("type").and_then(|t| t.as_str()).unwrap_or("");
            match ev_type {
                "content_block_start" => {
                    let idx = parsed.get("index").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
                    if let Some(block) = parsed.get("content_block") {
                        if block.get("type").and_then(|t| t.as_str()) == Some("tool_use") {
                            let id = block
                                .get("id")
                                .and_then(|v| v.as_str())
                                .unwrap_or("tool_0")
                                .to_string();
                            let name = block
                                .get("name")
                                .and_then(|v| v.as_str())
                                .unwrap_or("")
                                .to_string();
                            tool_calls_map.insert(
                                idx,
                                ToolCall {
                                    id,
                                    call_type: "function".to_string(),
                                    function: ToolCallFunction {
                                        name,
                                        arguments: String::new(),
                                    },
                                },
                            );
                        }
                    }
                }
                "content_block_delta" => {
                    let idx = parsed.get("index").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
                    if let Some(delta) = parsed.get("delta") {
                        let d_type = delta.get("type").and_then(|t| t.as_str()).unwrap_or("");
                        match d_type {
                            "text_delta" => {
                                if let Some(txt) = delta.get("text").and_then(|v| v.as_str()) {
                                    full_content.push_str(txt);
                                    on_token(false, txt);
                                }
                            }
                            "thinking_delta" => {
                                if let Some(txt) = delta.get("thinking").and_then(|v| v.as_str()) {
                                    on_token(true, txt);
                                }
                            }
                            "input_json_delta" => {
                                if let Some(partial) =
                                    delta.get("partial_json").and_then(|v| v.as_str())
                                {
                                    if let Some(tc) = tool_calls_map.get_mut(&idx) {
                                        tc.function.arguments.push_str(partial);
                                    }
                                }
                            }
                            _ => {}
                        }
                    }
                }
                "message_delta" => {
                    if let Some(sr) = parsed
                        .get("delta")
                        .and_then(|d| d.get("stop_reason"))
                        .and_then(|v| v.as_str())
                    {
                        finish_reason = Some(sr.to_string());
                    }
                }
                "error" => {
                    let msg = parsed
                        .get("error")
                        .and_then(|e| e.get("message"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("Error desconocido de Anthropic");
                    return Err(format!("Anthropic stream error: {msg}"));
                }
                _ => {}
            }
        }
    }

    for tc in tool_calls_map.values_mut() {
        if tc.function.arguments.trim().is_empty() {
            tc.function.arguments = "{}".to_string();
        }
    }

    Ok(ChatResponse {
        content: full_content,
        tool_calls: tool_calls_map.into_values().collect(),
        finish_reason,
    })
}

pub async fn generate_image_cloud(
    prompt: &str,
    size: &str,
    model_opt: Option<&str>,
    out_dir: &Path,
) -> Result<String, String> {
    let providers = load_cloud_providers();
    let provider = providers
        .into_iter()
        .find(|p| {
            p.enabled
                && !p.id.eq_ignore_ascii_case("anthropic")
                && !p.base_url.trim().is_empty()
                && (!expand_env_key(&p.api_key).trim().is_empty()
                    || p.base_url.contains("127.0.0.1")
                    || p.base_url.contains("localhost"))
        })
        .ok_or_else(|| {
            "No enabled OpenAI-compatible image provider found. Configure OpenAI or a local image endpoint in Settings -> APIs / Cloud.".to_string()
        })?;

    let api_key = expand_env_key(&provider.api_key);
    let url = format!("{}/images/generations", provider.base_url.trim_end_matches('/'));
    let model = model_opt
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .unwrap_or("gpt-image-1");

    let body = json!({
        "model": model,
        "prompt": prompt,
        "size": if size.trim().is_empty() { "1024x1024" } else { size.trim() },
        "n": 1,
        "response_format": "b64_json",
    });

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|e| format!("HTTP client error: {e}"))?;

    let mut req = client.post(&url).json(&body);
    if !api_key.trim().is_empty() {
        req = req.bearer_auth(api_key.trim());
    }

    let resp = req
        .send()
        .await
        .map_err(|e| format!("Image generation request failed ({url}): {e}"))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("Image API error {status}: {text}"));
    }

    let payload: Value = resp
        .json()
        .await
        .map_err(|e| format!("Invalid image API JSON: {e}"))?;
    let first = payload
        .get("data")
        .and_then(|d| d.as_array())
        .and_then(|a| a.first())
        .ok_or_else(|| "Image API returned empty data array.".to_string())?;

    let bytes = if let Some(b64) = first.get("b64_json").and_then(|v| v.as_str()) {
        use base64::Engine;
        base64::engine::general_purpose::STANDARD
            .decode(b64)
            .map_err(|e| format!("Failed to decode base64 image: {e}"))?
    } else if let Some(img_url) = first.get("url").and_then(|v| v.as_str()) {
        client
            .get(img_url)
            .send()
            .await
            .map_err(|e| format!("Failed downloading generated image: {e}"))?
            .bytes()
            .await
            .map_err(|e| format!("Failed reading image bytes: {e}"))?
            .to_vec()
    } else {
        return Err("Image API response contained neither b64_json nor url.".to_string());
    };

    fs::create_dir_all(out_dir).map_err(|e| format!("Failed creating output dir: {e}"))?;
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let dest = out_dir.join(format!("img-{ts}.png"));
    fs::write(&dest, bytes).map_err(|e| format!("Failed writing generated image: {e}"))?;
    Ok(dest.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn parses_cloud_model_uris() {
        assert!(is_cloud_model("cloud::openai::gpt-4o"));
        assert!(!is_cloud_model("C:\\models\\qwen.gguf"));
        assert_eq!(
            parse_cloud_model("cloud::anthropic::claude-sonnet-4-5"),
            Some(("anthropic".to_string(), "claude-sonnet-4-5".to_string()))
        );
        assert_eq!(
            parse_cloud_model("cloud::ollama::qwen2.5-coder:14b"),
            Some(("ollama".to_string(), "qwen2.5-coder:14b".to_string()))
        );
        assert_eq!(parse_cloud_model("cloud::openai"), None);
    }

    #[test]
    fn saves_and_loads_cloud_providers() {
        let tmp = std::env::temp_dir().join(format!(
            "loopy-cloud-test-{}.json",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let mut list = default_providers();
        list[0].enabled = true;
        list[0].api_key = "${OPENAI_API_KEY}".to_string();
        save_cloud_providers_to(&tmp, &list).unwrap();
        let loaded = load_cloud_providers_from(&tmp);
        assert_eq!(loaded.len(), list.len());
        assert!(loaded[0].enabled);
        assert_eq!(loaded[0].api_key, "${OPENAI_API_KEY}");
        let _ = fs::remove_file(&tmp);
    }
}
