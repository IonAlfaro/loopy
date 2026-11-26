pub mod cloud;
pub mod llama_cpp;

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<ToolCall>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    /// Optional local image paths (for multimodal VLM models with --mmproj)
    #[serde(skip)]
    pub image_paths: Vec<String>,
}

impl ChatMessage {
    pub fn to_openai_json(&self) -> Value {
        let mut obj = serde_json::Map::new();
        obj.insert("role".into(), json!(self.role));

        if !self.image_paths.is_empty() {
            let mut parts = Vec::new();
            if let Some(ref txt) = self.content {
                parts.push(json!({ "type": "text", "text": txt }));
            }
            for img_path in &self.image_paths {
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
                    parts.push(json!({
                        "type": "image_url",
                        "image_url": { "url": format!("data:{mime};base64,{b64}") }
                    }));
                }
            }
            obj.insert("content".into(), Value::Array(parts));
        } else if let Some(ref txt) = self.content {
            obj.insert("content".into(), json!(txt));
        }

        if let Some(ref tcs) = self.tool_calls {
            obj.insert("tool_calls".into(), json!(tcs));
        }
        if let Some(ref id) = self.tool_call_id {
            obj.insert("tool_call_id".into(), json!(id));
        }
        Value::Object(obj)
    }
}

pub fn resolve_image_path(workspace: &str, raw_path: &str) -> Option<String> {
    let trimmed = raw_path.trim();
    if trimmed.is_empty() {
        return None;
    }
    let p = Path::new(trimmed);
    if p.is_absolute() && p.exists() {
        return Some(trimmed.to_string());
    }
    let base = if workspace.trim().is_empty() || workspace == "." {
        std::env::current_dir().ok()?
    } else {
        Path::new(workspace).to_path_buf()
    };
    let joined = base.join(p);
    if joined.exists() {
        Some(joined.to_string_lossy().to_string())
    } else {
        None
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCall {
    pub id: String,
    #[serde(rename = "type")]
    pub call_type: String,
    pub function: ToolCallFunction,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCallFunction {
    pub name: String,
    pub arguments: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ModelLoadConfig {
    pub binary_path: String,
    pub model_path: String,
    pub mmproj_path: Option<String>,
    pub context_size: u32,
    pub gpu_layers: i32,
    pub flash_attn: bool,
    pub cache_type_k: String,
    pub cache_type_v: String,
    pub batch_size: u32,
    pub ubatch_size: u32,
    pub threads: u32,
    pub mlock: bool,
    pub no_mmap: bool,
    pub extra_args: String,
}

fn default_cache_type() -> String {
    "f16".to_string()
}
fn default_true() -> bool {
    true
}
fn default_gpu_layers() -> i32 {
    -1
}
fn default_batch_size() -> u32 {
    2048
}
fn default_ubatch_size() -> u32 {
    512
}
fn default_temp() -> f32 {
    0.2
}
fn default_top_p() -> f32 {
    0.95
}
fn default_min_p() -> f32 {
    0.05
}
fn default_repeat_penalty() -> f32 {
    1.05
}
fn default_max_tokens() -> u32 {
    0
}
fn default_seed() -> i64 {
    -1
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ModelTuningProfile {
    #[serde(default)]
    pub context_size: u32,
    #[serde(default)]
    pub compact_at_tokens: u32,
    #[serde(default = "default_cache_type")]
    pub cache_type_k: String,
    #[serde(default = "default_cache_type")]
    pub cache_type_v: String,
    #[serde(default = "default_true")]
    pub flash_attn: bool,
    #[serde(default = "default_gpu_layers")]
    pub gpu_layers: i32,
    #[serde(default = "default_batch_size")]
    pub batch_size: u32,
    #[serde(default = "default_ubatch_size")]
    pub ubatch_size: u32,
    #[serde(default)]
    pub threads: u32,
    #[serde(default)]
    pub mlock: bool,
    #[serde(default)]
    pub no_mmap: bool,
    #[serde(default)]
    pub extra_args: String,
    #[serde(default = "default_temp")]
    pub temperature: f32,
    #[serde(default = "default_top_p")]
    pub top_p: f32,
    #[serde(default = "default_min_p")]
    pub min_p: f32,
    #[serde(default = "default_repeat_penalty")]
    pub repeat_penalty: f32,
    #[serde(default = "default_max_tokens")]
    pub max_tokens: u32,
    #[serde(default = "default_seed")]
    pub seed: i64,
    #[serde(default)]
    pub mmproj_path: String,
    #[serde(default)]
    pub effective_context_size: u32,
}

impl Default for ModelTuningProfile {
    fn default() -> Self {
        Self {
            context_size: 0,
            compact_at_tokens: 0,
            cache_type_k: default_cache_type(),
            cache_type_v: default_cache_type(),
            flash_attn: true,
            gpu_layers: -1,
            batch_size: 2048,
            ubatch_size: 512,
            threads: 0,
            mlock: false,
            no_mmap: false,
            extra_args: String::new(),
            temperature: 0.2,
            top_p: 0.95,
            min_p: 0.05,
            repeat_penalty: 1.05,
            max_tokens: 6144,
            seed: -1,
            mmproj_path: String::new(),
            effective_context_size: 0,
        }
    }
}

pub fn profiles_file_path() -> PathBuf {
    dirs::data_local_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("loors")
        .join("model_profiles.json")
}

pub fn model_key(model_path: &str) -> String {
    let trimmed = model_path.trim();
    trimmed
        .rsplit(['/', '\\'])
        .find(|seg| !seg.is_empty())
        .map(|s| s.to_lowercase())
        .unwrap_or_else(|| trimmed.to_lowercase())
}

pub fn load_model_profile_from(path: &Path, model_path: &str) -> ModelTuningProfile {
    let key = model_key(model_path);
    let Ok(raw) = fs::read_to_string(path) else {
        return ModelTuningProfile::default();
    };
    let Ok(map) = serde_json::from_str::<HashMap<String, ModelTuningProfile>>(&raw) else {
        return ModelTuningProfile::default();
    };
    map.get(&key).cloned().unwrap_or_default()
}

pub fn save_model_profile_to(
    path: &Path,
    model_path: &str,
    profile: &ModelTuningProfile,
) -> Result<(), String> {
    let key = model_key(model_path);
    if key.is_empty() {
        return Err("Ruta de modelo vacía al guardar perfil.".to_string());
    }
    let mut map: HashMap<String, ModelTuningProfile> = fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default();
    let mut normalized = profile.clone();
    normalized.effective_context_size = 0;
    if normalized.cache_type_v != "f16" && !normalized.cache_type_v.trim().is_empty() {
        normalized.flash_attn = true;
    }
    map.insert(key, normalized);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Error creando carpeta de perfiles: {e}"))?;
    }
    let json_str = serde_json::to_string_pretty(&map)
        .map_err(|e| format!("Error serializando perfiles de modelo: {e}"))?;
    fs::write(path, json_str).map_err(|e| format!("Error guardando model_profiles.json: {e}"))
}

pub fn load_model_profile(model_path: &str) -> ModelTuningProfile {
    let mut prof = load_model_profile_from(&profiles_file_path(), model_path);
    prof.effective_context_size = if prof.context_size > 0 {
        prof.context_size
    } else if !model_path.trim().is_empty() {
        compute_auto_context_size(model_path)
    } else {
        32768
    };
    prof
}

pub fn save_model_profile(model_path: &str, profile: &ModelTuningProfile) -> Result<(), String> {
    save_model_profile_to(&profiles_file_path(), model_path, profile)
}

pub fn resolve_load_config_with_profile(
    binary_path: String,
    model_path: &str,
    override_ctx: Option<u32>,
    override_mmproj: Option<String>,
) -> (ModelLoadConfig, ModelTuningProfile) {
    let mut profile = load_model_profile(model_path);
    let raw_ctx = match override_ctx {
        Some(c) if c > 0 => c,
        _ => profile.context_size,
    };
    let effective_ctx = if raw_ctx == 0 {
        compute_auto_context_size(model_path)
    } else {
        raw_ctx
    };
    let mmproj = match override_mmproj {
        Some(m) if !m.trim().is_empty() => Some(m),
        _ if !profile.mmproj_path.trim().is_empty() => Some(profile.mmproj_path.clone()),
        _ => None,
    };
    let flash_attn = profile.flash_attn || (profile.cache_type_v != "f16" && !profile.cache_type_v.is_empty());
    profile.flash_attn = flash_attn;

    let load_cfg = ModelLoadConfig {
        binary_path,
        model_path: model_path.to_string(),
        mmproj_path: mmproj,
        context_size: effective_ctx,
        gpu_layers: profile.gpu_layers,
        flash_attn,
        cache_type_k: if profile.cache_type_k.trim().is_empty() {
            "f16".to_string()
        } else {
            profile.cache_type_k.clone()
        },
        cache_type_v: if profile.cache_type_v.trim().is_empty() {
            "f16".to_string()
        } else {
            profile.cache_type_v.clone()
        },
        batch_size: profile.batch_size,
        ubatch_size: profile.ubatch_size,
        threads: profile.threads,
        mlock: profile.mlock,
        no_mmap: profile.no_mmap,
        extra_args: profile.extra_args.clone(),
    };
    (load_cfg, profile)
}

pub fn compute_auto_context_size(model_path: &str) -> u32 {
    let mut sys = sysinfo::System::new();
    sys.refresh_memory();
    let total_ram_gb = sys.total_memory() as f64 / (1024.0 * 1024.0 * 1024.0);
    let model_gb = fs::metadata(model_path)
        .map(|m| m.len() as f64 / (1024.0 * 1024.0 * 1024.0))
        .unwrap_or(8.0);
    // Reserve ~6 GB for OS + Loors + apps
    let headroom_gb = (total_ram_gb - model_gb - 6.0).max(0.0);

    if headroom_gb >= 24.0 {
        65536
    } else if headroom_gb >= 12.0 {
        32768
    } else if headroom_gb >= 6.0 {
        16384
    } else {
        8192
    }
}

#[derive(Debug, Clone)]
pub struct ChatRequest {
    pub messages: Vec<ChatMessage>,
    pub tools: Vec<Value>,
    pub temperature: f32,
    pub top_p: Option<f32>,
    pub max_tokens: Option<u32>,
    pub min_p: Option<f32>,
    pub repeat_penalty: Option<f32>,
    pub seed: Option<i64>,
    pub reasoning_effort: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ChatResponse {
    pub content: String,
    pub tool_calls: Vec<ToolCall>,
    pub finish_reason: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn saves_and_loads_model_tuning_profile_forcing_flash_attn_for_kv_quant() {
        let tmp = std::env::temp_dir().join(format!(
            "loors-prof-test-{}.json",
            SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()
        ));
        let mut prof = ModelTuningProfile::default();
        prof.context_size = 131072;
        prof.cache_type_k = "q8_0".to_string();
        prof.cache_type_v = "q4_0".to_string();
        prof.flash_attn = false;
        prof.batch_size = 4096;

        save_model_profile_to(&tmp, "C:\\models\\Inkling-2-Mini-UD-Q4_K_XL.gguf", &prof).unwrap();
        let loaded = load_model_profile_from(&tmp, "D:\\other\\Inkling-2-Mini-UD-Q4_K_XL.gguf");
        assert_eq!(loaded.context_size, 131072);
        assert_eq!(loaded.cache_type_k, "q8_0");
        assert_eq!(loaded.cache_type_v, "q4_0");
        assert!(loaded.flash_attn);
        assert_eq!(loaded.batch_size, 4096);

        let _ = fs::remove_file(&tmp);
    }
}
