use crate::custom_nodes::list_custom_nodes;
use crate::inference::llama_cpp::LlamaCppManager;
use crate::inference::{ChatMessage, ChatRequest};
use crate::skills::{discover_skills, global_skills_dir, load_skill_file, parse_skill_md};
use crate::tools;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

pub const ALL_AGENT_TOOLS: &[&str] = &[
    "list_files",
    "find_files",
    "grep_search",
    "code_symbols",
    "binary_inspect",
    "read_file",
    "edit_file",
    "write_file",
    "delete_file",
    "run_cmd",
    "git_diff",
    "git_log",
    "debug_crash",
    "differential_test",
    "web_search",
    "fetch_url",
    "browser_action",
    "sql_query",
    "docker_exec",
];

pub const DEFAULT_ARCHITECT_SKILL_MD: &str = r#"---
name: architect-loopy
description: "Guía completa de arquitectura de arneses Loopy: nodos, puertos, variables, herramientas, patrones cíclicos y reglas de generación .loopy.json."
---

# Arquitecto de Arneses Loopy (v4)

Eres el **Arquitecto de Arneses de Loopy**, una aplicación visual de grafos cíclicos para ejecutar agentes autónomos locales con `llama.cpp`. Tu trabajo es ayudar al usuario a diseñar, auditar, depurar y mejorar arneses (`.loopy.json`).

## 1. Cómo trabajar (MUY IMPORTANTE)
- **Inspección rápida y acotada (máx. 2–3 lecturas)**: Tienes herramientas de solo lectura (`list_files`, `find_files`, `grep_search`, `read_file`, `list_loopy_capabilities`, `read_skill`).
  - Revisa primero la sección **Repositorios locales detectados** del inventario antes de buscar carpetas a ciegas.
  - Si el usuario menciona un proyecto concreto, haz como máximo **2 o 3 lecturas rápidas** (`README.md`, `AGENTS.md` o `SKILL.md`). **NO** leas carpetas `output/`, registros históricos, logs ni código fuente extenso.
- **Pregunta antes de generar si el diseño tiene decisiones abiertas**:
  - Cuando el usuario pida crear un arnés nuevo o transformar un proyecto en arnés y NO haya especificado todas las piezas (o diga algo abierto), **NO sueltes todavía el `.loopy.json` gigante**.
  - En su lugar, tras tu inspección rápida, presenta un resumen breve con **2 opciones claras** (p. ej. **Opción A: Pipeline modular por fases** —recomendada— vs **Opción B: Flujo compacto**) y **2–3 preguntas rápidas** (disparador: Cron / Telegram / Manual; si quiere `llm_judge` + `loop_guard`; si quiere notificación `notify` por Telegram/Discord).
  - En cuanto el usuario responda (o si desde el principio pide explícitamente *"genéralo ya sin preguntar"* o da la arquitectura cerrada), genera directamente el bloque ```json ... ``` completo y válido.
- **Arquitectura modular por fases (evita mega-agentes monolíticos)**:
  - Un arnés visual brilla cuando cada fase es un nodo especializado y pequeño (p. ej. `Shell` determinista para descubrir/validar → `Agent Selector` → `Condition` de salida temprana → `Agent Investigador` → `Agent Redactor` → `LLM Judge` + `Loop Guard` solo sobre el redactor → `Shell/Agent Publicador` → `Notify`).
  - Pasa resultados entre fases con `{{node:<id>}}`, `{{stdout}}` y `{{agent_output}}`. Así el modelo local no contamina su contexto y los reintentos son quirúrgicos.
- **Principio de mínimo privilegio**: Dale a cada nodo `agent` SOLO las herramientas que realmente necesita para su fase (ej. un Redactor puro puede ir sin `run_cmd` ni `web_search`).
- **NO añadas un nodo `workspace` redundante** si el arnés trabaja sobre un único proyecto: basta con poner esa carpeta en `task_input.config.workspace`. El nodo `workspace` solo se usa en arneses multi-repositorio.
- **Conserva el modelo del usuario**: Usa el `modelPath` real del grafo actual o del inventario de modelos descargados.

## 2. Tipos de nodos, puertos exactos y `config`
Usa **exactamente** estos `kind` y nombres de puertos (`sourceHandle` / `targetHandle`):

- `trigger`: out `[exec, payload]` | config: `{ triggerType ("webhook"|"interval"|"telegram"), webhookPort (14290), intervalMinutes (60), botToken, allowedChatId, payloadTemplate }` — Pieza de entrada que dispara el arnés por Webhook HTTP, Cron cada N minutos o Bot de Telegram (long polling) al pulsar Ejecutar.
- `task_input`: in `[exec]` out `[exec, prompt]` | config: `{ workspace, prompt }` — Puede recibir `exec` desde un `trigger` o iniciar directamente.
- `workspace`: in `[exec]` out `[exec, workspace_ref]` | config: `{ path, inlineExec }` — Solo para multi-repositorio. Si se conecta en línea pon `inlineExec: true`.
- `local_model`: out `[model_ref]` | config: `{ modelPath, mmprojPath, contextSize (0=Auto RAM), gpuLayers (-1), temperature, topP, maxTokens (0=sin límite), flashAttn }`
- `skill`: out `[skill_ref]` | config: `{ mode ("inject"|"on_demand"), skillPath, description, inlineInstructions }`
- `mcp_server`: out `[mcp_ref]` | config: `{ serverName, command, args, envJson, allowedTools }`
- `agent`: in `[exec, model_ref, skill_ref, mcp_ref, knowledge_ref, workspace_ref, feedback]` out `[exec, response]` | config: `{ systemPrompt, tools (array), maxSteps (0=sin límite/Auto), workspace (opcional) }`
- `knowledge_rag`: in `[exec, workspace_ref]` out `[exec, knowledge_ref]` | config: `{ mode ("hybrid"|"tree"|"rag"), subpath, queryTemplate, topK, maxChars, workspace (opcional), inlineExec (true si va en línea) }`
- `llm_judge`: in `[exec, model_ref]` out `[pass, fail]` | config: `{ rubric, inputTemplate }`
- `shell`: in `[exec, workspace_ref]` out `[exec, stderr]` | config: `{ command, dockerImage, timeoutSec, workspace (opcional) }`
- `notify`: in `[exec]` out `[exec]` | config: `{ channel ("telegram"|"discord"|"webhook"), botToken, chatId, webhookUrl, messageTemplate ("{{agent_output}}") }` — Envía notificaciones o respuestas a Telegram (si viene de un Trigger Telegram hereda token/chatId si se dejan vacíos), Discord o Webhook.
- `http_request`: in `[exec]` out `[ok, error]` | config: `{ method, url, headersJson, bodyTemplate }`
- `memory_file`: in `[exec]` out `[exec]` | config: `{ mode ("read"|"append"|"write"), filePath, template, workspace (opcional) }`
- `condition`: in `[exec]` out `[true, false]` | config: `{ expression }`
- `loop_guard`: in `[exec, feedback]` out `[retry, exhausted]` | config: `{ maxIterations (0=Continuo infinito), feedbackTemplate }`
- `git_checkpoint`: in `[exec]` out `[exec]` | config: `{ mode ("diff"|"snapshot"|"rollback"), workspace (opcional) }`
- `context_compactor`: in `[exec]` out `[exec]` | config: `{ maxChars, template }`
- `human_gate`: in `[exec]` out `[approved, rejected]` | config: `{ message }`
- `parallel_fanout`: in `[exec]` out `[branch_a, branch_b, merged]` | config: `{ useWorktrees }`
- `subgraph`: in `[exec]` out `[ok, error]` | config: `{ workflowPath, inputTemplate }`
- `custom`: in `[exec, model_ref]` out `[ok, error]` | config: `{ customNodeId, runner ("shell"|"prompt"|"http"), commandTemplate, promptTemplate, httpMethod, httpUrl, httpHeaders, httpBody, branchOnExit }`
- `output`: in `[exec]` | config: `{ label }`

## 3. Variables de plantilla (`{{...}}`)
Soportadas en `agent.systemPrompt`, `shell.command`, `memory_file.template`, `loop_guard.feedbackTemplate`, `context_compactor.template`, `llm_judge.inputTemplate`, `http_request.url/bodyTemplate`, `subgraph.inputTemplate`:
- `{{prompt}}`: objetivo inicial de `task_input`
- `{{current_prompt}}`: prompt activo (actualizado por `loop_guard` o `context_compactor`)
- `{{stdout}}`, `{{stderr}}`, `{{exit_code}}`: salida del último nodo `shell`
- `{{agent_output}}`: respuesta final del último nodo `agent`
- `{{node:<id o título>}}`: salida específica de cualquier nodo previo
- `{{loop_ledger}}`: bitácora episódica automática de ciclos anteriores
- `{{git_diff}}`: diff capturado por `git_checkpoint`
- `{{memory}}`: contenido leído por `memory_file` (`mode: "read"`)
- `{{rag_context}}`: árbol de conocimiento y/o fragmentos RAG de `knowledge_rag`
- `{{judge_reason}}`: razón devuelta por `llm_judge`
- `{{http_response}}`, `{{http_status}}`: respuesta del último `http_request`
- `{{custom_output}}`: salida del último nodo `custom`
- `{{iteration}}`: número de iteración actual

## 4. Sintaxis exacta de `condition.expression`
- `exit_code == 0` / `exit_code != 0`
- `iteration <= 5` / `iteration < 5` / `iteration >= 3`
- `stdout contains "TEXTO"`
- `stderr contains "TEXTO"`
- `agent_output contains "TEXTO"`

## 5. Herramientas nativas válidas para `agent.tools`
- **Archivos**: `list_files`, `find_files`, `read_file`, `edit_file`, `write_file`, `delete_file`
- **Búsqueda y AST**: `grep_search`, `code_symbols`
- **Ejecución y Git**: `run_cmd`, `git_diff`, `git_log`
- **Ciberseguridad / Reversing / Testing**: `binary_inspect` (PE/ELF/Mach-O, entropía, strings, disasm, Ghidra headless), `debug_crash` (ASan/UBSan), `differential_test`
- **Web y Navegador**: `web_search`, `fetch_url`, `browser_action` (CDP en vivo)
- **Datos y Contenedores**: `sql_query`, `docker_exec`

## 6. Patrones de diseño probados en Loopy
1. **Sin cortes artificiales**: Usa `contextSize: 0` (Auto RAM), `maxTokens: 0` (sin límite por paso en `local_model`) y `maxSteps: 0` (Auto) en `agent`. Para bucles indefinidos de auditoría usa `maxIterations: 0` en `loop_guard`.
2. **Arneses programados (Cron / Webhook)**: Coloca `trigger` (`triggerType: "interval"`, `intervalMinutes: 60`) -> `task_input` (o conecta ambos al primer `shell`/`agent`).
3. **Memoria persistente anti-repetición**: Usa `memory_file` (`mode: "append"`) y léelo al inicio con `memory_file` (`mode: "read"`).
4. **Auditoría sin falsos positivos (Devil's Advocate)**: `Auditor (agent)` -> `Refutador (agent)` -> `LLM Judge (llm_judge)` -> `Context Compactor -> Loop Guard -> Auditor`.
5. **Conexiones de modelo obligatorias**: Todo nodo `agent` y `llm_judge` debe recibir una arista desde `local_model` (`sourceHandle: "model_ref"`, `targetHandle: "model_ref"`).

## 7. Reglas de salida JSON
Cuando el usuario pida crear, modificar o mejorar un arnés:
1. Explica brevemente tus decisiones y mejoras.
2. Devuelve el grafo **COMPLETO** dentro de un bloque ```` ```json ... ``` ```` con este formato exacto:
   ```json
   {
     "schemaVersion": 1,
     "name": "Nombre del Arnés",
     "nodes": [
       {
         "id": "n-1",
         "type": "loopyNode",
         "position": { "x": 80, "y": 140 },
         "data": { "kind": "task_input", "title": "Task Input", "status": "idle", "config": { "workspace": ".", "prompt": "..." } }
       }
     ],
     "edges": [
       { "id": "e-1", "source": "n-1", "sourceHandle": "exec", "target": "n-2", "targetHandle": "exec" }
     ]
   }
   ```
3. Distribuye las posiciones `(x, y)` de izquierda a derecha con separación clara (~300px horizontal, ~200px vertical).
"#;

#[derive(Debug, Clone, Deserialize)]
pub struct ArchitectMessageInput {
    pub role: String,
    pub content: String,
    #[serde(default)]
    pub attachments: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ArchitectSkillInfo {
    pub name: String,
    pub path: String,
    pub source: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ArchitectStreamEvent {
    Token {
        is_thinking: bool,
        token: String,
    },
    ToolStarted {
        id: String,
        name: String,
        args_json: String,
    },
    ToolFinished {
        id: String,
        name: String,
        output_preview: String,
        duration_ms: u64,
        status: String,
    },
}

#[derive(Default)]
pub struct ArchitectState {
    cancel: Mutex<Option<Arc<AtomicBool>>>,
}

impl ArchitectState {
    pub fn start_turn(&self) -> Arc<AtomicBool> {
        let mut guard = self.cancel.lock().unwrap();
        if let Some(prev) = guard.as_ref() {
            prev.store(true, Ordering::SeqCst);
        }
        let flag = Arc::new(AtomicBool::new(false));
        *guard = Some(flag.clone());
        flag
    }

    pub fn stop_turn(&self) {
        if let Ok(guard) = self.cancel.lock() {
            if let Some(flag) = guard.as_ref() {
                flag.store(true, Ordering::SeqCst);
            }
        }
    }

    pub fn clear_turn(&self) {
        if let Ok(mut guard) = self.cancel.lock() {
            *guard = None;
        }
    }
}

fn workflows_dir() -> PathBuf {
    dirs::data_local_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("loopy")
        .join("workflows")
}

pub fn extract_workspace_from_graph(graph_json: &str) -> String {
    let Ok(val) = serde_json::from_str::<Value>(graph_json) else {
        return ".".to_string();
    };
    if let Some(nodes) = val.get("nodes").and_then(|v| v.as_array()) {
        for n in nodes {
            let kind = n
                .get("data")
                .and_then(|d| d.get("kind"))
                .and_then(|k| k.as_str());
            if kind == Some("task_input") {
                if let Some(ws) = n
                    .get("data")
                    .and_then(|d| d.get("config"))
                    .and_then(|c| c.get("workspace"))
                    .and_then(|w| w.as_str())
                {
                    let trimmed = ws.trim();
                    if !trimmed.is_empty() {
                        return trimmed.to_string();
                    }
                }
            }
        }
    }
    ".".to_string()
}

pub fn ensure_and_load_architect_skill(workspace: &str) -> (String, ArchitectSkillInfo) {
    // 1. Check workspace override first: <workspace>/.loopy/skills/architect-loopy/SKILL.md
    if !workspace.trim().is_empty() && workspace != "." {
        let ws_skill = PathBuf::from(workspace)
            .join(".loopy")
            .join("skills")
            .join("architect-loopy")
            .join("SKILL.md");
        if ws_skill.is_file() {
            if let Ok(loaded) = load_skill_file(&ws_skill) {
                return (
                    loaded.body,
                    ArchitectSkillInfo {
                        name: loaded.name,
                        path: loaded.path,
                        source: "workspace".to_string(),
                    },
                );
            }
        }
    }

    // 2. Global skill: %LOCALAPPDATA%\loopy\skills\architect-loopy\SKILL.md (auto-seeded and auto-upgraded if old v1)
    let global_dir = global_skills_dir().join("architect-loopy");
    let global_skill = global_dir.join("SKILL.md");

    let needs_seed = if !global_skill.is_file() {
        true
    } else if let Ok(existing) = fs::read_to_string(&global_skill) {
        existing.contains("# Arquitecto de Arneses Loopy") && !existing.contains("(v4)")
    } else {
        false
    };

    if needs_seed {
        let _ = fs::create_dir_all(&global_dir);
        let _ = fs::write(&global_skill, DEFAULT_ARCHITECT_SKILL_MD);
    }

    if let Ok(loaded) = load_skill_file(&global_skill) {
        return (
            loaded.body,
            ArchitectSkillInfo {
                name: loaded.name,
                path: loaded.path,
                source: "global".to_string(),
            },
        );
    }

    // 3. Built-in fallback
    let parsed = parse_skill_md(DEFAULT_ARCHITECT_SKILL_MD, "architect-loopy", "builtin");
    (
        parsed.body,
        ArchitectSkillInfo {
            name: parsed.name,
            path: "builtin".to_string(),
            source: "builtin".to_string(),
        },
    )
}

fn scan_models_summary() -> Vec<String> {
    let mut out: Vec<String> = crate::scan_local_models()
        .into_iter()
        .map(|m| format!("- {} ({} MB) => {}", m.name, m.size_mb, m.path))
        .collect();
    out.sort();
    out
}

fn scan_workflows_summary() -> Vec<String> {
    let dir = workflows_dir();
    let Ok(entries) = fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path
            .file_name()
            .and_then(|n| n.to_str())
            .map(|n| n.ends_with(".loopy.json"))
            .unwrap_or(false)
        {
            let name = path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("")
                .trim_end_matches(".loopy.json");
            out.push(format!("- {name} => {}", path.display()));
        }
    }
    out.sort();
    out
}

fn scan_github_repos_summary() -> Vec<String> {
    let mut repos = Vec::new();
    if let Some(docs) = dirs::document_dir() {
        let gh = docs.join("GitHub");
        if let Ok(entries) = fs::read_dir(&gh) {
            for e in entries.flatten() {
                let p = e.path();
                if p.is_dir() {
                    if let Some(name) = p.file_name().and_then(|n| n.to_str()) {
                        repos.push(format!("- {name} => {}", p.display()));
                    }
                }
            }
        }
    }
    repos.sort();
    repos
}

pub fn build_environment_inventory(workspace: &str, skill_info: &ArchitectSkillInfo) -> String {
    let models = scan_models_summary();
    let skills = discover_skills(workspace);
    let custom_nodes = list_custom_nodes(workspace);
    let workflows = scan_workflows_summary();
    let repos = scan_github_repos_summary();

    let mut out = String::new();
    out.push_str("## INVENTARIO EN VIVO DEL ENTORNO DEL USUARIO\n");
    out.push_str(&format!("- **Workspace activo**: `{workspace}`\n"));
    out.push_str(&format!(
        "- **Skill activa del Arquitecto**: `{}` ({})\n\n",
        skill_info.path, skill_info.source
    ));

    if !repos.is_empty() {
        out.push_str("### Repositorios locales detectados\n");
        for r in repos.iter().take(25) {
            out.push_str(r);
            out.push('\n');
        }
        out.push('\n');
    }

    out.push_str("### Modelos GGUF locales descargados\n");
    if models.is_empty() {
        out.push_str("- (ninguno detectado todavía)\n");
    } else {
        for m in models.iter().take(20) {
            out.push_str(m);
            out.push('\n');
        }
    }

    out.push_str("\n### Skills disponibles (usables en nodos `skill`)\n");
    if skills.is_empty() {
        out.push_str("- (ninguna)\n");
    } else {
        for s in skills.iter().take(30) {
            if s.name == "architect-loopy" {
                continue;
            }
            out.push_str(&format!(
                "- `{}` [{}]: {} => {}\n",
                s.name, s.source, s.description, s.path
            ));
        }
    }

    out.push_str("\n### Custom Nodes instalados (usables en nodos `custom_node`)\n");
    if custom_nodes.is_empty() {
        out.push_str("- (ninguno)\n");
    } else {
        for cn in custom_nodes.iter().take(30) {
            out.push_str(&format!(
                "- id=`{}` | label=`{}` | runner=`{}`: {}\n",
                cn.id, cn.label, cn.runner, cn.description
            ));
        }
    }

    out.push_str("\n### Workflows guardados (usables en nodos `subgraph`)\n");
    if workflows.is_empty() {
        out.push_str("- (ninguno)\n");
    } else {
        for w in workflows.iter().take(30) {
            out.push_str(w);
            out.push('\n');
        }
    }

    out
}

fn architect_tool_definitions() -> Vec<Value> {
    let readonly_ws_tools = vec![
        "list_files".to_string(),
        "find_files".to_string(),
        "grep_search".to_string(),
        "read_file".to_string(),
    ];
    let mut defs = tools::tool_definitions(&readonly_ws_tools);

    defs.push(json!({
        "type": "function",
        "function": {
            "name": "list_loopy_capabilities",
            "description": "Devuelve el catálogo detallado de las 18 herramientas nativas de agente (con sus parámetros exactos), modelos locales, skills, custom nodes y workflows guardados.",
            "parameters": {
                "type": "object",
                "properties": {
                    "filter": {
                        "type": "string",
                        "description": "Opcional: 'all' (por defecto), 'tools', 'skills', 'models', 'custom_nodes', 'workflows'"
                    }
                }
            }
        }
    }));

    defs.push(json!({
        "type": "function",
        "function": {
            "name": "read_skill",
            "description": "Lee el contenido completo de un archivo SKILL.md instalado para conocer sus instrucciones exactas antes de añadirlo a un arnés.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Ruta exacta al SKILL.md (obtenida del inventario o de list_loopy_capabilities)"
                    }
                },
                "required": ["path"]
            }
        }
    }));

    defs
}

fn open_architect_log() -> Option<std::fs::File> {
    let dir = dirs::data_local_dir()?.join("loopy").join("logs");
    let _ = fs::create_dir_all(&dir);
    std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(dir.join("architect.log"))
        .ok()
}

fn append_architect_log(file: &mut Option<std::fs::File>, line: &str) {
    use std::io::Write;
    if let Some(ref mut f) = file {
        let _ = writeln!(f, "{line}");
        let _ = f.flush();
    }
}

fn validate_architect_workflow_json(reply: &str) -> Option<String> {
    let json_str = if let Some(start_tag) = reply.find("```json") {
        let rest = &reply[start_tag + 7..];
        rest.find("```").map(|end| rest[..end].trim())
    } else if let Some(start_tag) = reply.find("```") {
        let rest = &reply[start_tag + 3..];
        rest.find("```").map(|end| rest[..end].trim())
    } else {
        None
    };

    let raw = json_str?;
    let parsed: Value = match serde_json::from_str(raw) {
        Ok(v) => v,
        Err(e) => return Some(format!("JSON inválido o truncado: {e}")),
    };
    let Some(nodes) = parsed.get("nodes").and_then(|v| v.as_array()) else {
        return Some("Falta el array 'nodes' en el JSON.".to_string());
    };
    let Some(edges) = parsed.get("edges").and_then(|v| v.as_array()) else {
        return Some("Falta el array 'edges' en el JSON.".to_string());
    };

    let mut problems = Vec::new();
    for n in nodes {
        let id = n.get("id").and_then(|v| v.as_str()).unwrap_or("");
        let kind = n
            .get("data")
            .and_then(|d| d.get("kind"))
            .and_then(|k| k.as_str())
            .unwrap_or("");
        if kind == "agent" || kind == "llm_judge" {
            let has_model = edges.iter().any(|e| {
                e.get("target").and_then(|v| v.as_str()) == Some(id)
                    && e.get("targetHandle").and_then(|v| v.as_str()) == Some("model_ref")
            });
            if !has_model {
                problems.push(format!(
                    "El nodo '{id}' ({kind}) no tiene conectado un 'local_model' al puerto targetHandle='model_ref'."
                ));
            }
        }
    }

    if problems.is_empty() {
        None
    } else {
        Some(problems.join(" | "))
    }
}

async fn execute_architect_tool(workspace: &str, skill_info: &ArchitectSkillInfo, name: &str, args: &Value) -> String {
    match name {
        "list_files" | "find_files" | "grep_search" | "read_file" => {
            // Allow inspecting an external project folder mentioned by the user (read-only)
            if let Some(p_str) = args.get("path").and_then(|v| v.as_str()) {
                let p = Path::new(p_str.trim());
                if p.is_absolute() && p.exists() {
                    if name == "list_files" && p.is_dir() {
                        let mut patched = args.clone();
                        if let Some(obj) = patched.as_object_mut() {
                            obj.insert("path".into(), json!("."));
                        }
                        return tools::execute_tool(&p.to_string_lossy(), name, &patched).await;
                    }
                    if name == "grep_search" {
                        let base = if p.is_dir() {
                            p.to_path_buf()
                        } else {
                            p.parent().unwrap_or(p).to_path_buf()
                        };
                        let mut patched = args.clone();
                        if let Some(obj) = patched.as_object_mut() {
                            let rel = if p.is_dir() {
                                ".".to_string()
                            } else {
                                p.file_name()
                                    .and_then(|n| n.to_str())
                                    .unwrap_or(".")
                                    .to_string()
                            };
                            obj.insert("path".into(), json!(rel));
                        }
                        return tools::execute_tool(&base.to_string_lossy(), name, &patched).await;
                    }
                }
            }
            tools::execute_tool(workspace, name, args).await
        }
        "list_loopy_capabilities" => {
            let filter = args
                .get("filter")
                .and_then(|v| v.as_str())
                .unwrap_or("all");
            let mut sections = Vec::new();

            if filter == "all" || filter == "tools" {
                let all_names: Vec<String> = ALL_AGENT_TOOLS.iter().map(|s| s.to_string()).collect();
                let defs = tools::tool_definitions(&all_names);
                let mut lines = vec!["=== 18 HERRAMIENTAS NATIVAS DE AGENTE ===".to_string()];
                for d in defs {
                    if let Some(f) = d.get("function") {
                        let tname = f.get("name").and_then(|v| v.as_str()).unwrap_or("");
                        let desc = f.get("description").and_then(|v| v.as_str()).unwrap_or("");
                        let params = f
                            .get("parameters")
                            .and_then(|p| p.get("properties"))
                            .and_then(|p| p.as_object())
                            .map(|obj| obj.keys().cloned().collect::<Vec<_>>().join(", "))
                            .unwrap_or_default();
                        lines.push(format!("- {tname}({params}): {desc}"));
                    }
                }
                sections.push(lines.join("\n"));
            }

            if filter != "tools" {
                sections.push(build_environment_inventory(workspace, skill_info));
            }

            sections.join("\n\n")
        }
        "read_skill" => {
            let Some(path_str) = args.get("path").and_then(|v| v.as_str()) else {
                return "Error: falta el parámetro 'path'.".to_string();
            };
            let p = Path::new(path_str);
            let is_skill_md = p
                .file_name()
                .and_then(|n| n.to_str())
                .map(|n| n.eq_ignore_ascii_case("SKILL.md"))
                .unwrap_or(false);
            if !is_skill_md {
                return "Error: read_skill solo permite leer archivos SKILL.md.".to_string();
            }
            match load_skill_file(p) {
                Ok(loaded) => format!(
                    "Skill: {}\nDescripción: {}\nRuta: {}\n\n{}",
                    loaded.name, loaded.description, loaded.path, loaded.body
                ),
                Err(e) => e,
            }
        }
        other => format!("Herramienta no permitida para el Arquitecto: {other}"),
    }
}

fn is_image_file(path: &str) -> bool {
    let lower = path.to_lowercase();
    lower.ends_with(".png")
        || lower.ends_with(".jpg")
        || lower.ends_with(".jpeg")
        || lower.ends_with(".webp")
        || lower.ends_with(".gif")
        || lower.ends_with(".bmp")
}

pub async fn run_architect_chat<F>(
    llama: &LlamaCppManager,
    cloud_model: Option<&str>,
    port: u16,
    has_mmproj: bool,
    reasoning_effort: Option<String>,
    messages: Vec<ArchitectMessageInput>,
    current_graph_json: String,
    cancel: Option<&Arc<AtomicBool>>,
    mut on_event: F,
) -> Result<String, String>
where
    F: FnMut(ArchitectStreamEvent),
{
    let run_started = Instant::now();
    let workspace = extract_workspace_from_graph(&current_graph_json);
    let (skill_body, skill_info) = ensure_and_load_architect_skill(&workspace);
    let inventory = build_environment_inventory(&workspace, &skill_info);
    let compact_graph = serde_json::from_str::<Value>(&current_graph_json)
        .and_then(|v| serde_json::to_string(&v))
        .unwrap_or_else(|_| current_graph_json.clone());

    let system_prompt = format!(
        "{skill_body}\n\n{inventory}\n\n## GRAFO ACTUAL EN EL CANVAS\n```json\n{compact_graph}\n```"
    );

    let mut chat_msgs = vec![ChatMessage {
        role: "system".into(),
        content: Some(system_prompt),
        tool_calls: None,
        tool_call_id: None,
        image_paths: Vec::new(),
    }];

    let total_msgs = messages.len();
    for (idx, m) in messages.into_iter().enumerate() {
        let is_latest_user = idx + 1 == total_msgs && m.role == "user";
        if is_latest_user && !m.attachments.is_empty() {
            let mut txt = m.content;
            let mut img_paths = Vec::new();
            for att in &m.attachments {
                let p = Path::new(att);
                let fname = p
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or(att);
                if p.is_dir() {
                    let mut entries = Vec::new();
                    if let Ok(rd) = fs::read_dir(p) {
                        for e in rd.flatten().take(40) {
                            let n = e.file_name().to_string_lossy().to_string();
                            if n == ".git" || n == "node_modules" || n == "target" {
                                continue;
                            }
                            let is_d = e.file_type().map(|t| t.is_dir()).unwrap_or(false);
                            entries.push(if is_d { format!("{n}/") } else { n });
                        }
                    }
                    entries.sort();
                    txt.push_str(&format!(
                        "\n\n<carpeta_adjunta nombre=\"{fname}\" ruta=\"{att}\">\n{}\n</carpeta_adjunta>",
                        entries.join("\n")
                    ));
                } else if is_image_file(att) {
                    if has_mmproj {
                        img_paths.push(att.clone());
                        txt.push_str(&format!("\n\n[Imagen adjunta para visión: `{fname}` ({att})]"));
                    } else {
                        txt.push_str(&format!(
                            "\n\n[Imagen adjunta: `{fname}` ({att}). Nota: no hay proyector multimodal mmproj configurado en el modelo actual.]"
                        ));
                    }
                } else {
                    match crate::tools::docs::read_document_or_text(p).await {
                        Ok(doc_text) => {
                            let snippet: String = doc_text.chars().take(6000).collect();
                            txt.push_str(&format!(
                                "\n\n<archivo_adjunto nombre=\"{fname}\" ruta=\"{att}\">\n{snippet}\n</archivo_adjunto>"
                            ));
                        }
                        Err(err) => {
                            txt.push_str(&format!(
                                "\n\n[Archivo adjunto `{fname}` ({att}): error al leer: {err}]"
                            ));
                        }
                    }
                }
            }
            chat_msgs.push(ChatMessage {
                role: m.role,
                content: Some(txt),
                tool_calls: None,
                tool_call_id: None,
                image_paths: img_paths,
            });
        } else {
            let mut txt = m.content;
            if !m.attachments.is_empty() {
                let names: Vec<String> = m
                    .attachments
                    .iter()
                    .map(|a| {
                        Path::new(a)
                            .file_name()
                            .and_then(|n| n.to_str())
                            .unwrap_or(a)
                            .to_string()
                    })
                    .collect();
                txt.push_str(&format!("\n[Adjuntos: {}]", names.join(", ")));
            }
            chat_msgs.push(ChatMessage {
                role: m.role,
                content: Some(txt),
                tool_calls: None,
                tool_call_id: None,
                image_paths: Vec::new(),
            });
        }
    }

    let mut log_file = open_architect_log();
    append_architect_log(&mut log_file, &format!("[ARCHITECT START] workspace={workspace}"));

    let tool_defs = architect_tool_definitions();
    let max_tool_steps = 10usize;
    let mut self_repair_attempts = 0u8;

    for step in 0..=max_tool_steps {
        if cancel.map(|c| c.load(Ordering::SeqCst)).unwrap_or(false) {
            return Err("Generación detenida por el usuario.".to_string());
        }
        let allow_tools = step < max_tool_steps;
        append_architect_log(
            &mut log_file,
            &format!(
                "[+{:.1}s][STEP {step}] allow_tools={allow_tools} effort={:?}",
                run_started.elapsed().as_secs_f32(),
                reasoning_effort
            ),
        );

        let req = ChatRequest {
            messages: chat_msgs.clone(),
            tools: if allow_tools {
                tool_defs.clone()
            } else {
                Vec::new()
            },
            temperature: 0.25,
            top_p: Some(0.95),
            max_tokens: None,
            min_p: None,
            repeat_penalty: None,
            seed: None,
            reasoning_effort: reasoning_effort.clone(),
        };

        let resp = if let Some(cm) = cloud_model {
            crate::inference::cloud::chat_stream_cloud(cm, req, cancel, |is_thinking, tok| {
                on_event(ArchitectStreamEvent::Token {
                    is_thinking,
                    token: tok.to_string(),
                });
            })
            .await?
        } else {
            llama
                .chat_stream(port, req, cancel, |is_thinking, tok| {
                    on_event(ArchitectStreamEvent::Token {
                        is_thinking,
                        token: tok.to_string(),
                    });
                })
                .await?
        };

        if cancel.map(|c| c.load(Ordering::SeqCst)).unwrap_or(false) {
            return Err("Generación detenida por el usuario.".to_string());
        }

        if resp.tool_calls.is_empty() || !allow_tools {
            append_architect_log(
                &mut log_file,
                &format!(
                    "[REPLY len={} finish_reason={:?}]\n{}",
                    resp.content.len(),
                    resp.finish_reason,
                    resp.content
                ),
            );
            if let Some(validation_err) = validate_architect_workflow_json(&resp.content) {
                if self_repair_attempts < 1 && step < max_tool_steps {
                    self_repair_attempts += 1;
                    append_architect_log(
                        &mut log_file,
                        &format!("[AUTO-REPAIR] {validation_err}"),
                    );
                    on_event(ArchitectStreamEvent::Token {
                        is_thinking: true,
                        token: format!("\nValidando JSON del arnés: corrigiendo {validation_err}...\n"),
                    });
                    chat_msgs.push(ChatMessage {
                        role: "assistant".into(),
                        content: Some(resp.content),
                        tool_calls: None,
                        tool_call_id: None,
                        image_paths: Vec::new(),
                    });
                    chat_msgs.push(ChatMessage {
                        role: "user".into(),
                        content: Some(format!(
                            "El JSON generado tiene un error de validación: {validation_err}. Corrige el JSON y devuelve el bloque ```json ... ``` completo y válido."
                        )),
                        tool_calls: None,
                        tool_call_id: None,
                        image_paths: Vec::new(),
                    });
                    continue;
                }
            }
            return Ok(resp.content);
        }

        chat_msgs.push(ChatMessage {
            role: "assistant".into(),
            content: if resp.content.is_empty() {
                None
            } else {
                Some(resp.content)
            },
            tool_calls: Some(resp.tool_calls.clone()),
            tool_call_id: None,
            image_paths: Vec::new(),
        });

        for call in &resp.tool_calls {
            if cancel.map(|c| c.load(Ordering::SeqCst)).unwrap_or(false) {
                return Err("Generación detenida por el usuario.".to_string());
            }
            let preview_args: String = call.function.arguments.chars().take(160).collect();
            append_architect_log(
                &mut log_file,
                &format!("[TOOL] {}({})", call.function.name, preview_args),
            );
            on_event(ArchitectStreamEvent::ToolStarted {
                id: call.id.clone(),
                name: call.function.name.clone(),
                args_json: call.function.arguments.clone(),
            });

            let started = Instant::now();
            let args_val: Value =
                serde_json::from_str(&call.function.arguments).unwrap_or_else(|_| json!({}));
            let mut result =
                execute_architect_tool(&workspace, &skill_info, &call.function.name, &args_val)
                    .await;
            let duration_ms = started.elapsed().as_millis() as u64;

            // Cap tool output to keep architect context crisp
            if result.len() > 8000 {
                let end = result.floor_char_boundary(8000);
                result = format!("{}\n... [truncado]", &result[..end]);
            }
            let status = if result.starts_with("Error:") || result.starts_with("Herramienta no permitida") {
                "error"
            } else {
                "success"
            };
            let out_preview: String = result.chars().take(1200).collect();
            append_architect_log(
                &mut log_file,
                &format!(
                    "[TOOL RESULT] {}",
                    result.chars().take(300).collect::<String>()
                ),
            );
            on_event(ArchitectStreamEvent::ToolFinished {
                id: call.id.clone(),
                name: call.function.name.clone(),
                output_preview: out_preview,
                duration_ms,
                status: status.to_string(),
            });

            chat_msgs.push(ChatMessage {
                role: "tool".into(),
                content: Some(result),
                tool_calls: None,
                tool_call_id: Some(call.id.clone()),
                image_paths: Vec::new(),
            });
        }
    }

    Ok("No se pudo completar la respuesta del Arquitecto.".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_workspace_from_graph_json() {
        let json = r#"{
            "schemaVersion": 1,
            "name": "Test",
            "nodes": [
                { "id": "1", "type": "loopyNode", "position": {"x":0,"y":0}, "data": { "kind": "task_input", "title": "In", "status": "idle", "config": { "workspace": "C:/repo/demo", "prompt": "hi" } } }
            ],
            "edges": []
        }"#;
        assert_eq!(extract_workspace_from_graph(json), "C:/repo/demo");
        assert_eq!(extract_workspace_from_graph("{}"), ".");
    }

    #[test]
    fn default_architect_skill_parses_cleanly() {
        let parsed = parse_skill_md(DEFAULT_ARCHITECT_SKILL_MD, "fallback", "builtin");
        assert_eq!(parsed.name, "architect-loopy");
        assert!(parsed.body.contains("{{current_prompt}}"));
        assert!(parsed.body.contains("list_loopy_capabilities"));
    }
}
