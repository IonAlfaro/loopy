use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomFieldDef {
    pub key: String,
    pub label: String,
    pub field_type: String, // "text" | "textarea" | "number"
    #[serde(default)]
    pub default_value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomNodeDef {
    pub id: String,
    pub label: String,
    #[serde(default = "default_category")]
    pub category: String,
    #[serde(default = "default_accent")]
    pub accent: String,
    #[serde(default)]
    pub description: String,
    /// "shell" | "prompt" | "http"
    pub runner: String,
    #[serde(default)]
    pub command_template: String,
    #[serde(default)]
    pub prompt_template: String,
    #[serde(default)]
    pub http_method: String,
    #[serde(default)]
    pub http_url: String,
    #[serde(default)]
    pub http_headers: String,
    #[serde(default)]
    pub http_body: String,
    #[serde(default)]
    pub branch_on_exit: bool,
    #[serde(default)]
    pub fields: Vec<CustomFieldDef>,
}

fn default_category() -> String {
    "Custom".to_string()
}

fn default_accent() -> String {
    "#f472b6".to_string()
}

pub fn global_custom_nodes_dir() -> PathBuf {
    dirs::data_local_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("loopy")
        .join("custom_nodes")
}

pub fn list_custom_nodes(workspace: &str) -> Vec<CustomNodeDef> {
    let mut dirs_to_scan = vec![global_custom_nodes_dir()];

    let ws = if workspace.trim().is_empty() || workspace == "." {
        std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
    } else {
        PathBuf::from(workspace)
    };
    dirs_to_scan.push(ws.join(".loopy").join("nodes"));

    let mut nodes = Vec::new();
    for dir in dirs_to_scan {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path
                .extension()
                .and_then(|e| e.to_str())
                .map(|e| e.eq_ignore_ascii_case("json"))
                .unwrap_or(false)
            {
                if let Ok(raw) = fs::read_to_string(&path) {
                    if let Ok(def) = serde_json::from_str::<CustomNodeDef>(&raw) {
                        nodes.push(def);
                    }
                }
            }
        }
    }

    nodes.sort_by(|a, b| a.label.cmp(&b.label));
    nodes.dedup_by(|a, b| a.id == b.id);
    nodes
}

pub fn save_custom_node(mut def: CustomNodeDef) -> Result<String, String> {
    let safe_id: String = def
        .id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect();
    let final_id = if safe_id.trim_matches('-').is_empty() {
        format!("custom-{}", def.label.len())
    } else {
        safe_id
    };
    def.id = final_id.clone();

    let dir = global_custom_nodes_dir();
    fs::create_dir_all(&dir)
        .map_err(|e| format!("No se pudo crear carpeta custom_nodes: {e}"))?;
    let path = dir.join(format!("{final_id}.json"));
    let raw = serde_json::to_string_pretty(&def)
        .map_err(|e| format!("Error serializando custom node: {e}"))?;
    fs::write(&path, raw).map_err(|e| format!("Error guardando custom node: {e}"))?;
    Ok(path.to_string_lossy().to_string())
}

pub fn delete_custom_node(id: &str) -> Result<(), String> {
    let path = global_custom_nodes_dir().join(format!("{id}.json"));
    if path.exists() {
        fs::remove_file(&path).map_err(|e| format!("Error eliminando custom node: {e}"))?;
    }
    Ok(())
}
