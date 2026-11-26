use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::process::Stdio;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerConfig {
    pub name: String,
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
    #[serde(default)]
    pub allowed_tools: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpToolInfo {
    pub name: String,
    pub description: String,
    pub input_schema: Value,
}

pub struct McpSession {
    pub server_name: String,
    _child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    next_id: u64,
}

impl McpSession {
    pub async fn connect(config: &McpServerConfig, workspace: &str) -> Result<Self, String> {
        if config.command.trim().is_empty() {
            return Err(format!("MCP '{}' sin comando configurado.", config.name));
        }

        let mut cmd = Command::new(&config.command);
        #[cfg(target_os = "windows")]
        cmd.creation_flags(0x0800_0000);
        cmd.args(&config.args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);

        if !workspace.trim().is_empty() && workspace != "." {
            cmd.current_dir(workspace);
        }

        for (k, v) in &config.env {
            cmd.env(k, expand_env_vars(v));
        }

        let mut child = cmd.spawn().map_err(|e| {
            format!(
                "No se pudo arrancar servidor MCP '{}' ({}): {e}",
                config.name, config.command
            )
        })?;

        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "MCP stdin no disponible".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "MCP stdout no disponible".to_string())?;

        let mut session = Self {
            server_name: sanitize_server_name(&config.name),
            _child: child,
            stdin,
            stdout: BufReader::new(stdout),
            next_id: 1,
        };

        // MCP JSON-RPC 2.0 initialize handshake
        let _init_resp = session
            .request(
                "initialize",
                json!({
                    "protocolVersion": "2024-11-05",
                    "capabilities": {},
                    "clientInfo": {
                        "name": "loors-studio",
                        "version": "0.1.0"
                    }
                }),
            )
            .await?;

        session
            .notify("notifications/initialized", json!({}))
            .await?;

        Ok(session)
    }

    pub async fn list_tools(&mut self, allowlist: &[String]) -> Result<Vec<McpToolInfo>, String> {
        let resp = self.request("tools/list", json!({})).await?;
        let tools_arr = resp
            .get("tools")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();

        let mut tools = Vec::new();
        for item in tools_arr {
            let Some(name) = item.get("name").and_then(|v| v.as_str()) else {
                continue;
            };
            if !allowlist.is_empty() && !allowlist.iter().any(|a| a == name) {
                continue;
            }
            let description = item
                .get("description")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let input_schema = item
                .get("inputSchema")
                .cloned()
                .unwrap_or_else(|| json!({ "type": "object", "properties": {} }));
            tools.push(McpToolInfo {
                name: name.to_string(),
                description,
                input_schema,
            });
        }
        Ok(tools)
    }

    pub async fn call_tool(&mut self, name: &str, arguments: Value) -> Result<String, String> {
        let resp = self
            .request(
                "tools/call",
                json!({
                    "name": name,
                    "arguments": arguments
                }),
            )
            .await?;

        if let Some(content_arr) = resp.get("content").and_then(|v| v.as_array()) {
            let parts: Vec<String> = content_arr
                .iter()
                .filter_map(|c| {
                    c.get("text")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string())
                        .or_else(|| Some(c.to_string()))
                })
                .collect();
            return Ok(parts.join("\n"));
        }

        Ok(resp.to_string())
    }

    async fn notify(&mut self, method: &str, params: Value) -> Result<(), String> {
        let msg = json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params
        });
        let line = format!("{}\n", msg);
        self.stdin
            .write_all(line.as_bytes())
            .await
            .map_err(|e| format!("Error enviando notificación MCP: {e}"))?;
        self.stdin
            .flush()
            .await
            .map_err(|e| format!("Error flush MCP: {e}"))?;
        Ok(())
    }

    async fn request(&mut self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next_id;
        self.next_id += 1;

        let msg = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params
        });
        let line = format!("{}\n", msg);
        self.stdin
            .write_all(line.as_bytes())
            .await
            .map_err(|e| format!("Error escribiendo petición MCP '{method}': {e}"))?;
        self.stdin
            .flush()
            .await
            .map_err(|e| format!("Error flush MCP '{method}': {e}"))?;

        let read_fut = async {
            let mut raw = String::new();
            loop {
                raw.clear();
                let n = self
                    .stdout
                    .read_line(&mut raw)
                    .await
                    .map_err(|e| format!("Error leyendo stdout MCP: {e}"))?;
                if n == 0 {
                    return Err(format!(
                        "El servidor MCP '{}' cerró stdout inesperadamente.",
                        self.server_name
                    ));
                }
                let trimmed = raw.trim();
                if trimmed.is_empty() {
                    continue;
                }
                let Ok(val) = serde_json::from_str::<Value>(trimmed) else {
                    continue;
                };
                if val.get("id").and_then(|v| v.as_u64()) == Some(id) {
                    if let Some(err) = val.get("error") {
                        return Err(format!("Error MCP en '{method}': {err}"));
                    }
                    return Ok(val.get("result").cloned().unwrap_or(Value::Null));
                }
            }
        };

        tokio::time::timeout(Duration::from_secs(20), read_fut)
            .await
            .map_err(|_| format!("Timeout esperando respuesta MCP para '{method}'."))?
    }
}

pub fn mcp_prefixed_tool_name(server: &str, tool: &str) -> String {
    format!("mcp__{}__{}", sanitize_server_name(server), tool)
}

pub fn sanitize_server_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c.to_ascii_lowercase()
            } else {
                '_'
            }
        })
        .collect();
    let trimmed = cleaned.trim_matches('_');
    if trimmed.is_empty() {
        "server".to_string()
    } else {
        trimmed.to_string()
    }
}

fn expand_env_vars(input: &str) -> String {
    let mut out = input.to_string();
    while let Some(start) = out.find("${") {
        let Some(rel_end) = out[start + 2..].find('}') else {
            break;
        };
        let end = start + 2 + rel_end;
        let var_name = &out[start + 2..end];
        let val = std::env::var(var_name).unwrap_or_default();
        out.replace_range(start..=end, &val);
    }
    out
}

pub async fn probe_mcp_server(
    config: McpServerConfig,
    workspace: String,
) -> Result<Vec<McpToolInfo>, String> {
    let mut session = McpSession::connect(&config, &workspace).await?;
    session.list_tools(&config.allowed_tools).await
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedMcpServer {
    pub id: String,
    pub name: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
    #[serde(default)]
    pub allowed_tools: Vec<String>,
}

fn default_true() -> bool {
    true
}

impl SavedMcpServer {
    pub fn to_config(&self) -> McpServerConfig {
        McpServerConfig {
            name: self.name.clone(),
            command: self.command.clone(),
            args: self.args.clone(),
            env: self.env.clone(),
            allowed_tools: self.allowed_tools.clone(),
        }
    }
}

fn mcp_servers_path() -> std::path::PathBuf {
    dirs::data_local_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join("loors")
        .join("mcp_servers.json")
}

pub fn load_saved_mcp_servers() -> Vec<SavedMcpServer> {
    load_mcp_servers_from(&mcp_servers_path())
}

pub fn save_mcp_servers(servers: &[SavedMcpServer]) -> Result<(), String> {
    save_mcp_servers_to(&mcp_servers_path(), servers)
}

fn load_mcp_servers_from(path: &std::path::Path) -> Vec<SavedMcpServer> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str::<Vec<SavedMcpServer>>(&raw).ok())
        .unwrap_or_default()
}

fn save_mcp_servers_to(path: &std::path::Path, servers: &[SavedMcpServer]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create MCP config directory: {e}"))?;
    }
    let json = serde_json::to_string_pretty(servers)
        .map_err(|e| format!("Failed to serialize MCP servers: {e}"))?;
    std::fs::write(path, json).map_err(|e| format!("Failed to save mcp_servers.json: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn saves_and_loads_mcp_servers() {
        let tmp = std::env::temp_dir().join(format!(
            "loors-mcp-test-{}.json",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis()
        ));
        let list = vec![SavedMcpServer {
            id: "mcp-1".into(),
            name: "filesystem".into(),
            enabled: true,
            command: "npx".into(),
            args: vec!["-y".into(), "@modelcontextprotocol/server-filesystem".into(), ".".into()],
            env: HashMap::new(),
            allowed_tools: vec![],
        }];
        save_mcp_servers_to(&tmp, &list).unwrap();
        let loaded = load_mcp_servers_from(&tmp);
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].name, "filesystem");
        assert!(loaded[0].enabled);
        let _ = std::fs::remove_file(&tmp);
    }
}
