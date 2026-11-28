pub mod bg_tasks;
mod browser;
pub mod docs;
pub mod scheduler;
pub(crate) mod report;
pub(crate) mod spreadsheet;

pub use bg_tasks::{get_bg_task_status, kill_bg_task, start_bg_task};
pub use browser::{
    browser_interact, set_browser_frame_listener, set_browser_screencast_listener,
    shutdown_browser, BrowserInteractRequest, BrowserInteractResponse,
};
pub use scheduler::{cancel_scheduled_task, list_scheduled_tasks, schedule_task};

use serde_json::{json, Value};
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::process::Command;

const IGNORED_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "dist",
    "build",
    ".next",
    "__pycache__",
];

pub fn tool_definitions(enabled: &[String]) -> Vec<Value> {
    let has = |name: &str| enabled.iter().any(|t| t == name);
    let mut defs = Vec::new();

    if has("list_files") {
        defs.push(json!({
            "type": "function",
            "function": {
                "name": "list_files",
                "description": "Lista archivos y directorios dentro del workspace.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": { "type": "string", "description": "Ruta relativa (por defecto '.')" },
                        "recursive": { "type": "boolean", "description": "Si true, lista subcarpetas ignorando node_modules/target/.git" }
                    }
                }
            }
        }));
    }

    if has("find_files") {
        defs.push(json!({
            "type": "function",
            "function": {
                "name": "find_files",
                "description": "Busca archivos en el workspace cuyo nombre o ruta contenga el patrón indicado.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "pattern": { "type": "string", "description": "Subcadena o extensión (ej. '.rs', 'App.tsx', 'test')" }
                    },
                    "required": ["pattern"]
                }
            }
        }));
    }

    if has("grep_search") {
        defs.push(json!({
            "type": "function",
            "function": {
                "name": "grep_search",
                "description": "Busca texto o expresiones regulares (regex case-insensitive) en un archivo o carpeta del workspace y devuelve archivo:línea: contenido.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "pattern": { "type": "string", "description": "Texto o regex (ej. 'boundsCheck|checkBounds', 'WasmBoundsCheckValue')" },
                        "path": { "type": "string", "description": "Archivo o subcarpeta opcional donde buscar" }
                    },
                    "required": ["pattern"]
                }
            }
        }));
    }

    if has("read_file") {
        defs.push(json!({
            "type": "function",
            "function": {
                "name": "read_file",
                "description": "Lee un archivo de texto o documento (.pdf, .docx, .xlsx, .csv, .pptx, .odt, .epub) del workspace con números de línea (soporta rango start_line..end_line).",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": { "type": "string", "description": "Ruta relativa del archivo" },
                        "start_line": { "type": "integer", "description": "Línea inicial (1-indexed, opcional)" },
                        "end_line": { "type": "integer", "description": "Línea final inclusiva (opcional)" }
                    },
                    "required": ["path"]
                }
            }
        }));
    }

    for (name, extension) in [("create_excel", "xlsx"), ("create_csv", "csv")] {
        if !has(name) {
            continue;
        }
        defs.push(json!({
            "type": "function",
            "function": {
                "name": name,
                "description": format!("Crea un archivo .{extension} nuevo en el workspace a partir de una lista de objetos JSON. Devuelve la ruta relativa del archivo."),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": { "type": "string", "description": format!("Ruta relativa del nuevo archivo .{extension}") },
                        "rows": { "type": "array", "items": { "type": "object", "additionalProperties": true } },
                        "columns": { "type": "array", "items": { "type": "string" }, "description": "Claves de las columnas en orden. Si se omiten, se usan todas las claves." }
                    },
                    "required": ["path", "rows"]
                }
            }
        }));
    }

    for (name, extension) in [("create_word", "docx"), ("create_pdf", "pdf")] {
        if has(name) {
            defs.push(json!({
                "type": "function",
                "function": {
                    "name": name,
                    "description": format!("Crea un informe .{extension} nuevo en el workspace y devuelve su ruta."),
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "path": { "type": "string", "description": format!("Ruta relativa del nuevo archivo .{extension}") },
                            "content": {
                                "type": "object",
                                "properties": {
                                    "title": { "type": "string" },
                                    "sections": { "type": "array", "items": {
                                        "type": "object", "properties": {
                                            "heading": { "type": "string" },
                                            "paragraphs": { "type": "array", "items": { "type": "string" } },
                                            "table": { "type": "object", "properties": {
                                                "headers": { "type": "array", "items": { "type": "string" } },
                                                "rows": { "type": "array", "items": { "type": "array", "items": { "type": "string" } } }
                                            }, "required": ["headers", "rows"] }
                                        }
                                    }}
                                },
                                "required": ["title", "sections"]
                            }
                        },
                        "required": ["path", "content"]
                    }
                }
            }));
        }
    }

    if has("edit_file") {
        defs.push(json!({
            "type": "function",
            "function": {
                "name": "edit_file",
                "description": "Edita quirúrgicamente un archivo reemplazando exactamente old_text por new_text.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": { "type": "string", "description": "Ruta relativa del archivo" },
                        "old_text": { "type": "string", "description": "Fragmento exacto existente a reemplazar" },
                        "new_text": { "type": "string", "description": "Nuevo contenido de reemplazo" }
                    },
                    "required": ["path", "old_text", "new_text"]
                }
            }
        }));
    }

    if has("write_file") {
        defs.push(json!({
            "type": "function",
            "function": {
                "name": "write_file",
                "description": "Crea o sobrescribe un archivo completo dentro del workspace.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": { "type": "string", "description": "Ruta relativa del archivo" },
                        "content": { "type": "string", "description": "Contenido completo del archivo" }
                    },
                    "required": ["path", "content"]
                }
            }
        }));
    }

    if has("delete_file") {
        defs.push(json!({
            "type": "function",
            "function": {
                "name": "delete_file",
                "description": "Elimina un archivo dentro del workspace.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": { "type": "string", "description": "Ruta relativa del archivo a eliminar" }
                    },
                    "required": ["path"]
                }
            }
        }));
    }

    if has("run_cmd") {
        defs.push(json!({
            "type": "function",
            "function": {
                "name": "run_cmd",
                "description": "Ejecuta un comando de terminal dentro del workspace y devuelve exit_code, stdout y stderr.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "command": { "type": "string", "description": "Comando a ejecutar" }
                    },
                    "required": ["command"]
                }
            }
        }));
    }

    if has("git_diff") {
        defs.push(json!({
            "type": "function",
            "function": {
                "name": "git_diff",
                "description": "Muestra git status y git diff actuales del workspace (o de un archivo concreto).",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": { "type": "string", "description": "Archivo opcional para filtrar el diff" }
                    }
                }
            }
        }));
    }

    if has("web_search") {
        defs.push(json!({
            "type": "function",
            "function": {
                "name": "web_search",
                "description": "Busca información técnica, documentación o errores en Internet.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": { "type": "string", "description": "Consulta de búsqueda" }
                    },
                    "required": ["query"]
                }
            }
        }));
    }

    if has("fetch_url") {
        defs.push(json!({
            "type": "function",
            "function": {
                "name": "fetch_url",
                "description": "Descarga y lee el texto limpio de una URL (documentación, APIs, páginas).",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "url": { "type": "string", "description": "URL completa (https://...)" }
                    },
                    "required": ["url"]
                }
            }
        }));
    }

    if has("browser_action") {
        defs.push(json!({
            "type": "function",
            "function": {
                "name": "browser_action",
                "description": "Controla un navegador real persistente (Edge/Chrome) con puntero visual en vivo: abrir URLs, ver elementos interactivos, hacer click, hover, escribir en inputs, pulsar teclas, scroll, evaluar JS, auditar errores de consola/red y sacar screenshots.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "action": {
                            "type": "string",
                            "enum": ["goto", "snapshot", "click", "hover", "type", "press", "scroll", "evaluate", "screenshot", "close"],
                            "description": "Acción a ejecutar en el navegador"
                        },
                        "url": { "type": "string", "description": "URL a abrir (obligatorio en goto o primera acción)" },
                        "selector": { "type": "string", "description": "Selector CSS, índice '[3]' del snapshot o texto visible del botón/input" },
                        "text": { "type": "string", "description": "Texto a escribir (para type)" },
                        "key": { "type": "string", "description": "Tecla a pulsar (Enter, Tab, Escape...)" },
                        "direction": { "type": "string", "enum": ["down", "up"], "description": "Dirección del scroll" },
                        "script": { "type": "string", "description": "Código JS a ejecutar (para evaluate)" },
                        "screenshotPath": { "type": "string", "description": "Ruta relativa donde guardar captura PNG" }
                    },
                    "required": ["action"]
                }
            }
        }));
    }

    if has("code_symbols") {
        defs.push(json!({
            "type": "function",
            "function": {
                "name": "code_symbols",
                "description": "Busca definiciones (class/struct/fn/function/method) y callers de un símbolo en C++/Rust/TS/Python dentro del workspace.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "symbol": { "type": "string", "description": "Nombre del símbolo, clase o función" },
                        "path": { "type": "string", "description": "Subcarpeta opcional para acotar la búsqueda" }
                    },
                    "required": ["symbol"]
                }
            }
        }));
    }

    if has("git_log") {
        defs.push(json!({
            "type": "function",
            "function": {
                "name": "git_log",
                "description": "Muestra los últimos commits del repo (o el diff de un commit concreto con 'commit') para auditar regresiones.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "count": { "type": "integer", "description": "Número de commits a listar (por defecto 15)" },
                        "path": { "type": "string", "description": "Subcarpeta o archivo opcional" },
                        "commit": { "type": "string", "description": "Hash de commit opcional para ver git show" }
                    }
                }
            }
        }));
    }

    if has("debug_crash") {
        defs.push(json!({
            "type": "function",
            "function": {
                "name": "debug_crash",
                "description": "Ejecuta un binario o PoC con opciones de ASan/UBSan simbolizadas (ej. jsc, test binario, fuzzer target) y reporta crashes, assertions y stacktraces.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "command": { "type": "string", "description": "Comando completo a ejecutar (ej. './WebKitBuild/Debug/bin/jsc poc.js')" },
                        "timeout_sec": { "type": "integer", "description": "Timeout en segundos (por defecto 30)" }
                    },
                    "required": ["command"]
                }
            }
        }));
    }

    if has("differential_test") {
        defs.push(json!({
            "type": "function",
            "function": {
                "name": "differential_test",
                "description": "Ejecuta dos comandos (ej. intérprete vs JIT, o dos versiones) y detecta discrepancias de exit_code o stdout (differential testing).",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "cmd_a": { "type": "string", "description": "Primer comando (ej. 'jsc --useJIT=false poc.js')" },
                        "cmd_b": { "type": "string", "description": "Segundo comando (ej. 'jsc --useJIT=true poc.js')" }
                    },
                    "required": ["cmd_a", "cmd_b"]
                }
            }
        }));
    }

    if has("binary_inspect") {
        defs.push(json!({
            "type": "function",
            "function": {
                "name": "binary_inspect",
                "description": "Analiza un binario ejecutable o librería (PE .exe/.dll, ELF, Mach-O) estilo Ghidra/Reverse Engineering: cabeceras, arquitectura, secciones, entropía, imports/exports, strings, desensamblado (objdump/llvm-objdump/dumpbin) o análisis con Ghidra Headless (analyzeHeadless).",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": { "type": "string", "description": "Ruta al binario a analizar" },
                        "mode": {
                            "type": "string",
                            "enum": ["summary", "strings", "disasm", "ghidra_headless"],
                            "description": "Modo: 'summary' (cabeceras PE/ELF/Mach-O, secciones, entropía, imports/símbolos), 'strings' (cadenas ASCII/UTF-16 con filtro opcional), 'disasm' (desensamblado de sección o símbolo), 'ghidra_headless' (ejecuta analyzeHeadless de Ghidra si está instalado)"
                        },
                        "filter": { "type": "string", "description": "Filtro opcional (para 'strings') o nombre de función/símbolo (para 'disasm')" },
                        "ghidra_script": { "type": "string", "description": "Script postScript opcional para ghidra_headless" }
                    },
                    "required": ["path"]
                }
            }
        }));
    }

    if has("sql_query") {
        defs.push(json!({
            "type": "function",
            "function": {
                "name": "sql_query",
                "description": "Ejecuta una consulta SQL en SQLite (archivo .db/.sqlite) o PostgreSQL (connection string).",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "engine": { "type": "string", "enum": ["sqlite", "postgres"], "description": "Motor de base de datos" },
                        "target": { "type": "string", "description": "Ruta relativa del .db/.sqlite o URL postgres://..." },
                        "query": { "type": "string", "description": "Consulta SQL a ejecutar" }
                    },
                    "required": ["engine", "target", "query"]
                }
            }
        }));
    }

    if has("docker_exec") {
        defs.push(json!({
            "type": "function",
            "function": {
                "name": "docker_exec",
                "description": "Ejecuta un comando de forma aislada dentro de un contenedor Docker efímero montando el workspace en /workspace.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "image": { "type": "string", "description": "Imagen Docker (ej. 'ubuntu:24.04', 'python:3.12-slim', 'node:22-alpine')" },
                        "command": { "type": "string", "description": "Comando a ejecutar dentro del contenedor" }
                    },
                    "required": ["image", "command"]
                }
            }
        }));
    }

    defs
}

fn workspace_root(workspace: &str) -> Result<PathBuf, String> {
    if workspace.trim().is_empty() || workspace == "." {
        std::env::current_dir().map_err(|e| format!("Error obteniendo directorio actual: {e}"))
    } else {
        Ok(PathBuf::from(workspace))
    }
}

pub(crate) fn resolve_safe_path(workspace: &str, rel: &str) -> Result<PathBuf, String> {
    let base = workspace_root(workspace)?;
    let rel_path = Path::new(rel);
    if rel_path.has_root() || matches!(rel_path.components().next(), Some(Component::Prefix(_))) {
        return Err("Solo se permiten rutas relativas dentro del workspace.".to_string());
    }
    for comp in rel_path.components() {
        if matches!(comp, Component::ParentDir) {
            return Err("Ruta rechazada: no se permite salir del workspace con '..'.".to_string());
        }
    }
    let root = base.canonicalize().map_err(|err| err.to_string())?;
    let mut resolved = root.clone();
    for component in rel_path.components() {
        let Component::Normal(part) = component else { continue };
        resolved.push(part);
        match fs::symlink_metadata(&resolved) {
            Ok(_) => {
                resolved = resolved.canonicalize().map_err(|err| err.to_string())?;
                if !resolved.starts_with(&root) {
                    return Err("Ruta rechazada: el destino queda fuera del workspace.".into());
                }
            }
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            Err(err) => return Err(err.to_string()),
        }
    }
    Ok(resolved)
}

pub fn capture_file_state(workspace: &str, rel_path: &str) -> Result<(PathBuf, Option<String>), String> {
    let abs = resolve_safe_path(workspace, rel_path)?;
    let existing = fs::read_to_string(&abs).ok();
    Ok((abs, existing))
}

pub fn compute_compact_diff(
    old: Option<&str>,
    new: Option<&str>,
    rel_path: &str,
) -> (String, usize, usize) {
    let old_lines: Vec<&str> = old.map(|s| s.lines().collect()).unwrap_or_default();
    let new_lines: Vec<&str> = new.map(|s| s.lines().collect()).unwrap_or_default();

    let mut prefix = 0usize;
    while prefix < old_lines.len()
        && prefix < new_lines.len()
        && old_lines[prefix] == new_lines[prefix]
    {
        prefix += 1;
    }

    let mut suffix = 0usize;
    while suffix + prefix < old_lines.len()
        && suffix + prefix < new_lines.len()
        && old_lines[old_lines.len() - 1 - suffix] == new_lines[new_lines.len() - 1 - suffix]
    {
        suffix += 1;
    }

    let old_mid_end = old_lines.len().saturating_sub(suffix);
    let new_mid_end = new_lines.len().saturating_sub(suffix);
    let removed = old_mid_end.saturating_sub(prefix);
    let added = new_mid_end.saturating_sub(prefix);

    let ctx_start = prefix.saturating_sub(2);
    let ctx_old_end = (old_mid_end + 2).min(old_lines.len());
    let ctx_new_end = (new_mid_end + 2).min(new_lines.len());

    let mut diff = format!("--- a/{rel_path}\n+++ b/{rel_path}\n");
    for l in &old_lines[ctx_start..prefix] {
        diff.push_str(&format!("  {l}\n"));
    }
    for l in old_lines[prefix..old_mid_end].iter().take(40) {
        diff.push_str(&format!("- {l}\n"));
    }
    if removed > 40 {
        diff.push_str(&format!("- ... (+{} líneas eliminadas)\n", removed - 40));
    }
    for l in new_lines[prefix..new_mid_end].iter().take(40) {
        diff.push_str(&format!("+ {l}\n"));
    }
    if added > 40 {
        diff.push_str(&format!("+ ... (+{} líneas añadidas)\n", added - 40));
    }
    for l in &new_lines[new_mid_end..ctx_new_end] {
        if ctx_old_end > old_mid_end || !l.is_empty() {
            diff.push_str(&format!("  {l}\n"));
        }
    }

    if diff.len() > 4000 {
        let end = diff.floor_char_boundary(4000);
        diff = format!("{}\n... [diff truncado]", &diff[..end]);
    }

    (diff.trim_end().to_string(), added, removed)
}

pub async fn execute_tool_cancellable(
    workspace: &str,
    name: &str,
    args: &Value,
    cancel: Option<&Arc<AtomicBool>>,
) -> String {
    let Some(flag) = cancel else {
        return execute_tool(workspace, name, args).await;
    };
    if flag.load(Ordering::SeqCst) {
        return format!("Herramienta '{name}' cancelada por el usuario.");
    }
    tokio::select! {
        res = execute_tool(workspace, name, args) => res,
        _ = async {
            while !flag.load(Ordering::SeqCst) {
                tokio::time::sleep(std::time::Duration::from_millis(90)).await;
            }
        } => format!("Herramienta '{name}' cancelada por el usuario.")
    }
}

pub async fn execute_tool(workspace: &str, name: &str, args: &Value) -> String {
    match name {
        "list_files" => {
            let rel = args.get("path").and_then(|v| v.as_str()).unwrap_or(".");
            let recursive = args
                .get("recursive")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            match resolve_safe_path(workspace, rel) {
                Ok(dir) => {
                    if recursive {
                        let mut out = Vec::new();
                        walk_files(&dir, &dir, &mut out, 0, 250);
                        out.sort();
                        out.join("\n")
                    } else {
                        match fs::read_dir(&dir) {
                            Ok(entries) => {
                                let mut names: Vec<String> = entries
                                    .flatten()
                                    .map(|e| {
                                        let suffix = if e.path().is_dir() { "/" } else { "" };
                                        format!("{}{}", e.file_name().to_string_lossy(), suffix)
                                    })
                                    .collect();
                                names.sort();
                                names.truncate(200);
                                names.join("\n")
                            }
                            Err(e) => format!("Error listando '{}': {e}", rel),
                        }
                    }
                }
                Err(e) => e,
            }
        }

        "find_files" => {
            let Some(pattern) = args.get("pattern").and_then(|v| v.as_str()) else {
                return "Falta el parámetro obligatorio 'pattern'.".to_string();
            };
            let needle = pattern.to_lowercase();
            match workspace_root(workspace) {
                Ok(root) => {
                    let mut all = Vec::new();
                    walk_files(&root, &root, &mut all, 0, 1500);
                    let matches: Vec<String> = all
                        .into_iter()
                        .filter(|p| p.to_lowercase().contains(&needle))
                        .take(100)
                        .collect();
                    if matches.is_empty() {
                        format!("No se encontraron archivos que coincidan con '{pattern}'.")
                    } else {
                        matches.join("\n")
                    }
                }
                Err(e) => e,
            }
        }

        "grep_search" => {
            let Some(pattern) = args.get("pattern").and_then(|v| v.as_str()) else {
                return "Falta el parámetro obligatorio 'pattern'.".to_string();
            };
            let rel = args.get("path").and_then(|v| v.as_str()).unwrap_or(".");
            let compiled_re = regex::RegexBuilder::new(pattern)
                .case_insensitive(true)
                .build()
                .ok();
            let needle_lower = pattern.to_lowercase();

            match resolve_safe_path(workspace, rel) {
                Ok(target_path) => {
                    let file_pairs: Vec<(String, PathBuf)> = if target_path.is_file() {
                        vec![(rel.to_string(), target_path)]
                    } else {
                        let mut files = Vec::new();
                        walk_files(&target_path, &target_path, &mut files, 0, 1500);
                        files
                            .into_iter()
                            .map(|f| {
                                let full = target_path.join(&f);
                                (f, full)
                            })
                            .collect()
                    };

                    let mut hits = Vec::new();
                    for (display_name, full) in file_pairs {
                        if hits.len() >= 80 {
                            break;
                        }
                        let Ok(meta) = fs::metadata(&full) else {
                            continue;
                        };
                        if meta.len() > 1024 * 1024 {
                            continue;
                        }
                        let Ok(content) = fs::read_to_string(&full) else {
                            continue;
                        };
                        for (idx, line) in content.lines().enumerate() {
                            let matched = match &compiled_re {
                                Some(re) => re.is_match(line),
                                None => line.to_lowercase().contains(&needle_lower),
                            };
                            if matched {
                                hits.push(format!("{}:{}: {}", display_name, idx + 1, line.trim()));
                                if hits.len() >= 80 {
                                    break;
                                }
                            }
                        }
                    }
                    if hits.is_empty() {
                        format!("Sin coincidencias para '{pattern}'.")
                    } else {
                        hits.join("\n")
                    }
                }
                Err(e) => e,
            }
        }

        "create_excel" | "create_csv" => {
            let path = args.get("path").and_then(Value::as_str).unwrap_or_default();
            let rows = args.get("rows").cloned().unwrap_or(Value::Null);
            let columns = args.get("columns").cloned();
            let format = if name == "create_csv" {
                spreadsheet::TableFormat::Csv
            } else {
                spreadsheet::TableFormat::Excel
            };
            match spreadsheet::create_table(workspace, path, rows, columns, format).await {
                Ok(path) => json!({ "path": path }).to_string(),
                Err(error) => json!({ "error": error }).to_string(),
            }
        }
        "create_word" | "create_pdf" => {
            let path = args.get("path").and_then(Value::as_str).unwrap_or_default();
            let content = args.get("content").cloned().unwrap_or(Value::Null);
            let format = if name == "create_word" { "docx" } else { "pdf" };
            match report::create_report(workspace, path, format, content).await {
                Ok(path) => json!({ "path": path }).to_string(),
                Err(error) => json!({ "error": error }).to_string(),
            }
        }
        "read_file" => {
            let Some(rel) = args.get("path").and_then(|v| v.as_str()) else {
                return "Falta el parámetro obligatorio 'path'.".to_string();
            };
            let start_line = args
                .get("start_line")
                .and_then(|v| v.as_u64())
                .map(|v| v.max(1) as usize);
            let end_line = args.get("end_line").and_then(|v| v.as_u64()).map(|v| v as usize);

            let abs_candidate = Path::new(rel);
            let target_path = if abs_candidate.is_absolute() && abs_candidate.is_file() {
                Ok(abs_candidate.to_path_buf())
            } else {
                resolve_safe_path(workspace, rel)
            };

            match target_path {
                Ok(path) => match docs::read_document_or_text(&path).await {
                    Ok(content) => {
                        let lines: Vec<&str> = content.lines().collect();
                        let total = lines.len();
                        let s = start_line.unwrap_or(1).saturating_sub(1).min(total);
                        let default_end = (s + 200).min(total);
                        let e = end_line.unwrap_or(default_end).min(total).max(s);
                        let numbered: Vec<String> = lines[s..e]
                            .iter()
                            .enumerate()
                            .map(|(i, l)| format!("{:>4} | {l}", s + i + 1))
                            .collect();
                        let mut out = numbered.join("\n");
                        if e < total {
                            out.push_str(&format!(
                                "\n... [Mostrando líneas {}..{} de {} totales; usa start_line/end_line para leer más]",
                                s + 1,
                                e,
                                total
                            ));
                        }
                        if out.len() > 18_000 {
                            let end = out.floor_char_boundary(18_000);
                            format!("{}\n... [truncado a 18KB; usa start_line/end_line]", &out[..end])
                        } else {
                            out
                        }
                    }
                    Err(e) => format!("Error leyendo '{}': {e}", rel),
                },
                Err(e) => e,
            }
        }

        "edit_file" => {
            let Some(rel) = args.get("path").and_then(|v| v.as_str()) else {
                return "Falta el parámetro obligatorio 'path'.".to_string();
            };
            let Some(old_text) = args.get("old_text").and_then(|v| v.as_str()) else {
                return "Falta el parámetro obligatorio 'old_text'.".to_string();
            };
            let Some(new_text) = args.get("new_text").and_then(|v| v.as_str()) else {
                return "Falta el parámetro obligatorio 'new_text'.".to_string();
            };

            match resolve_safe_path(workspace, rel) {
                Ok(path) => match fs::read_to_string(&path) {
                    Ok(content) => {
                        let Some((updated, match_line)) = apply_fuzzy_edit(&content, old_text, new_text) else {
                            return format!(
                                "No se encontró el bloque 'old_text' en '{rel}' (ni con normalización CRLF ni por líneas). Lee el archivo primero con read_file."
                            );
                        };
                        match fs::write(&path, &updated) {
                            Ok(_) => {
                                let lines: Vec<&str> = updated.lines().collect();
                                let new_line_count = new_text.lines().count().max(1);
                                let snippet_start = match_line.saturating_sub(4);
                                let snippet_end = (match_line + new_line_count + 5).min(lines.len());
                                let snippet: String = lines[snippet_start..snippet_end]
                                    .iter()
                                    .enumerate()
                                    .map(|(i, l)| format!("{:>4} | {l}", snippet_start + i + 1))
                                    .collect::<Vec<_>>()
                                    .join("\n");
                                format!(
                                    "Archivo '{rel}' editado correctamente.\nLíneas actualizadas ({}..{}):\n{snippet}",
                                    snippet_start + 1,
                                    snippet_end
                                )
                            }
                            Err(e) => format!("Error guardando '{rel}': {e}"),
                        }
                    }
                    Err(e) => format!("Error leyendo '{}': {e}", rel),
                },
                Err(e) => e,
            }
        }

        "write_file" => {
            let Some(rel) = args.get("path").and_then(|v| v.as_str()) else {
                return "Falta el parámetro obligatorio 'path'.".to_string();
            };
            let Some(content) = args.get("content").and_then(|v| v.as_str()) else {
                return "Falta el parámetro obligatorio 'content'.".to_string();
            };
            match resolve_safe_path(workspace, rel) {
                Ok(path) => {
                    if let Some(parent) = path.parent() {
                        let _ = fs::create_dir_all(parent);
                    }
                    match fs::write(&path, content) {
                        Ok(_) => format!("Archivo '{}' escrito ({} bytes).", rel, content.len()),
                        Err(e) => format!("Error escribiendo '{}': {e}", rel),
                    }
                }
                Err(e) => e,
            }
        }

        "delete_file" => {
            let Some(rel) = args.get("path").and_then(|v| v.as_str()) else {
                return "Falta el parámetro obligatorio 'path'.".to_string();
            };
            match resolve_safe_path(workspace, rel) {
                Ok(path) => match fs::remove_file(&path) {
                    Ok(_) => format!("Archivo '{rel}' eliminado."),
                    Err(e) => format!("Error eliminando '{rel}': {e}"),
                },
                Err(e) => e,
            }
        }

        "run_cmd" => {
            let Some(cmd_str) = args.get("command").and_then(|v| v.as_str()) else {
                return "Falta el parámetro obligatorio 'command'.".to_string();
            };
            let mut cmd = if cfg!(target_os = "windows") {
                let mut c = Command::new("powershell");
                c.args(["-NoProfile", "-Command", cmd_str]);
                #[cfg(target_os = "windows")]
                c.creation_flags(0x0800_0000);
                c
            } else {
                let mut c = Command::new("sh");
                c.args(["-c", cmd_str]);
                c
            };

            if !workspace.trim().is_empty() && workspace != "." {
                cmd.current_dir(workspace);
            }
            cmd.kill_on_drop(true);

            match cmd.output().await {
                Ok(out) => {
                    let code = out.status.code().unwrap_or(-1);
                    let stdout = String::from_utf8_lossy(&out.stdout);
                    let stderr = String::from_utf8_lossy(&out.stderr);
                    format!("exit_code: {code}\nstdout:\n{stdout}\nstderr:\n{stderr}")
                }
                Err(e) => format!("Error ejecutando comando: {e}"),
            }
        }

        "git_diff" => {
            let target = args.get("path").and_then(|v| v.as_str());
            let mut status_cmd = Command::new("git");
            status_cmd.args(["status", "--short"]).kill_on_drop(true);
            #[cfg(target_os = "windows")]
            status_cmd.creation_flags(0x0800_0000);
            let mut diff_cmd = Command::new("git");
            diff_cmd.args(["diff", "--no-color"]).kill_on_drop(true);
            #[cfg(target_os = "windows")]
            diff_cmd.creation_flags(0x0800_0000);
            if let Some(p) = target {
                diff_cmd.arg("--").arg(p);
            }
            if !workspace.trim().is_empty() && workspace != "." {
                status_cmd.current_dir(workspace);
                diff_cmd.current_dir(workspace);
            }
            let status_out = status_cmd
                .output()
                .await
                .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
                .unwrap_or_default();
            let diff_out = diff_cmd
                .output()
                .await
                .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
                .unwrap_or_default();
            format!("STATUS:\n{status_out}\nDIFF:\n{diff_out}")
        }

        "fetch_url" => {
            let Some(url) = args.get("url").and_then(|v| v.as_str()) else {
                return "Falta el parámetro obligatorio 'url'.".to_string();
            };
            fetch_clean_text(url).await
        }

        "web_search" => {
            let Some(query) = args.get("query").and_then(|v| v.as_str()) else {
                return "Falta el parámetro obligatorio 'query'.".to_string();
            };
            web_search_ddg(query).await
        }

        "browser_action" => browser::run_browser_action(workspace, args).await,

        "code_symbols" => {
            let Some(symbol) = args.get("symbol").and_then(|v| v.as_str()) else {
                return "Falta el parámetro obligatorio 'symbol'.".to_string();
            };
            let rel = args.get("path").and_then(|v| v.as_str()).unwrap_or(".");
            match resolve_safe_path(workspace, rel) {
                Ok(start_dir) => {
                    let mut files = Vec::new();
                    walk_files(&start_dir, &start_dir, &mut files, 0, 1500);
                    let mut defs_found = Vec::new();
                    let mut refs_found = Vec::new();
                    let def_keywords = [
                        "class ", "struct ", "enum ", "fn ", "function ", "def ", "void ",
                        "bool ", "int ", "auto ", "impl ", "interface ", "type ",
                    ];

                    for rel_file in files {
                        if defs_found.len() >= 30 && refs_found.len() >= 40 {
                            break;
                        }
                        let full = start_dir.join(&rel_file);
                        let Ok(meta) = fs::metadata(&full) else {
                            continue;
                        };
                        if meta.len() > 512 * 1024 {
                            continue;
                        }
                        let Ok(content) = fs::read_to_string(&full) else {
                            continue;
                        };
                        for (idx, line) in content.lines().enumerate() {
                            if !line.contains(symbol) {
                                continue;
                            }
                            let trimmed = line.trim();
                            let is_def = def_keywords.iter().any(|kw| trimmed.contains(kw))
                                && (trimmed.contains(&format!("{symbol}("))
                                    || trimmed.contains(&format!("{symbol} "))
                                    || trimmed.contains(&format!("{symbol}:"))
                                    || trimmed.contains(&format!("{symbol}<"))
                                    || trimmed.contains(&format!("::{symbol}(")));
                            if is_def && defs_found.len() < 30 {
                                defs_found.push(format!("{}:{}: {}", rel_file, idx + 1, trimmed));
                            } else if refs_found.len() < 40 {
                                refs_found.push(format!("{}:{}: {}", rel_file, idx + 1, trimmed));
                            }
                        }
                    }

                    format!(
                        "DEFINITIONS ({}):\n{}\n\nREFERENCES / CALLERS ({}):\n{}",
                        defs_found.len(),
                        if defs_found.is_empty() {
                            "(ninguna)".to_string()
                        } else {
                            defs_found.join("\n")
                        },
                        refs_found.len(),
                        if refs_found.is_empty() {
                            "(ninguna)".to_string()
                        } else {
                            refs_found.join("\n")
                        }
                    )
                }
                Err(e) => e,
            }
        }

        "git_log" => {
            let commit = args.get("commit").and_then(|v| v.as_str());
            let count = args.get("count").and_then(|v| v.as_u64()).unwrap_or(15);
            let rel_path = args.get("path").and_then(|v| v.as_str());

            let mut cmd = Command::new("git");
            cmd.kill_on_drop(true);
            #[cfg(target_os = "windows")]
            cmd.creation_flags(0x0800_0000);
            if let Some(hash) = commit {
                cmd.args(["show", "--stat", "--patch", "--no-color", hash]);
                if let Some(p) = rel_path {
                    if !p.trim().is_empty() {
                        cmd.arg("--").arg(p);
                    }
                }
            } else {
                cmd.args(["log", "-n", &count.to_string(), "--oneline", "--no-color"]);
                if let Some(p) = rel_path {
                    if !p.trim().is_empty() {
                        cmd.arg("--").arg(p);
                    }
                }
            }
            if !workspace.trim().is_empty() && workspace != "." {
                cmd.current_dir(workspace);
            }
            cmd.kill_on_drop(true);
            match cmd.output().await {
                Ok(out) => {
                    let stdout = String::from_utf8_lossy(&out.stdout).to_string();
                    let stderr = String::from_utf8_lossy(&out.stderr).to_string();
                    let combined = if stdout.trim().is_empty() { stderr } else { stdout };
                    if combined.len() > 16_000 {
                        let end = combined.floor_char_boundary(16_000);
                        format!("{}... [truncado]", &combined[..end])
                    } else {
                        combined
                    }
                }
                Err(e) => format!("Error ejecutando git log: {e}"),
            }
        }

        "debug_crash" => {
            let Some(cmd_str) = args.get("command").and_then(|v| v.as_str()) else {
                return "Falta el parámetro obligatorio 'command'.".to_string();
            };
            let timeout_sec = args.get("timeout_sec").and_then(|v| v.as_u64()).unwrap_or(30);
            run_debug_crash(workspace, cmd_str, timeout_sec).await
        }

        "differential_test" => {
            let Some(cmd_a) = args.get("cmd_a").and_then(|v| v.as_str()) else {
                return "Falta el parámetro obligatorio 'cmd_a'.".to_string();
            };
            let Some(cmd_b) = args.get("cmd_b").and_then(|v| v.as_str()) else {
                return "Falta el parámetro obligatorio 'cmd_b'.".to_string();
            };
            run_differential_test(workspace, cmd_a, cmd_b).await
        }

        "binary_inspect" => {
            let Some(path) = args.get("path").and_then(|v| v.as_str()) else {
                return "Falta el parámetro obligatorio 'path'.".to_string();
            };
            let mode = args
                .get("mode")
                .and_then(|v| v.as_str())
                .unwrap_or("summary");
            let filter = args.get("filter").and_then(|v| v.as_str());
            let ghidra_script = args.get("ghidra_script").and_then(|v| v.as_str());
            run_binary_inspect(workspace, path, mode, filter, ghidra_script).await
        }

        "sql_query" => {
            let engine = args
                .get("engine")
                .and_then(|v| v.as_str())
                .unwrap_or("sqlite");
            let Some(target) = args.get("target").and_then(|v| v.as_str()) else {
                return "Falta el parámetro obligatorio 'target'.".to_string();
            };
            let Some(query) = args.get("query").and_then(|v| v.as_str()) else {
                return "Falta el parámetro obligatorio 'query'.".to_string();
            };
            run_sql_query(workspace, engine, target, query).await
        }

        "docker_exec" => {
            let Some(image) = args.get("image").and_then(|v| v.as_str()) else {
                return "Falta el parámetro obligatorio 'image'.".to_string();
            };
            let Some(command) = args.get("command").and_then(|v| v.as_str()) else {
                return "Falta el parámetro obligatorio 'command'.".to_string();
            };
            run_docker_exec(workspace, image, command).await
        }

        other => format!("Herramienta desconocida: '{other}'"),
    }
}

async fn run_debug_crash(workspace: &str, cmd_str: &str, timeout_sec: u64) -> String {
    let mut cmd = if cfg!(target_os = "windows") {
        let mut c = Command::new("powershell");
        c.args(["-NoProfile", "-Command", cmd_str]);
        c
    } else {
        let mut c = Command::new("sh");
        c.args(["-c", cmd_str]);
        c
    };

    if !workspace.trim().is_empty() && workspace != "." {
        cmd.current_dir(workspace);
    }

    cmd.env(
        "ASAN_OPTIONS",
        "symbolize=1:abort_on_error=1:detect_leaks=0:halt_on_error=1",
    )
    .env("UBSAN_OPTIONS", "print_stacktrace=1:halt_on_error=1")
    .kill_on_drop(true);

    match tokio::time::timeout(std::time::Duration::from_secs(timeout_sec.max(1)), cmd.output())
        .await
    {
        Ok(Ok(out)) => {
            let code = out.status.code().unwrap_or(-1);
            let stdout = String::from_utf8_lossy(&out.stdout).to_string();
            let stderr = String::from_utf8_lossy(&out.stderr).to_string();
            let combined_lower = format!("{stdout}\n{stderr}").to_lowercase();
            let crash_detected = code != 0
                || combined_lower.contains("addresssanitizer")
                || combined_lower.contains("undefinedbehaviorsanitizer")
                || combined_lower.contains("assertion failed")
                || combined_lower.contains("sigsegv")
                || combined_lower.contains("segmentation fault");
            json!({
                "crash_detected": crash_detected,
                "exit_code": code,
                "stdout": stdout.chars().take(6000).collect::<String>(),
                "stderr": stderr.chars().take(10000).collect::<String>()
            })
            .to_string()
        }
        Ok(Err(e)) => json!({ "crash_detected": false, "error": format!("No se pudo ejecutar: {e}") }).to_string(),
        Err(_) => json!({ "crash_detected": false, "timeout": true, "error": format!("Timeout tras {timeout_sec}s") }).to_string(),
    }
}

async fn run_differential_test(workspace: &str, cmd_a: &str, cmd_b: &str) -> String {
    let run_one = |command_str: &str| {
        let ws = workspace.to_string();
        let cs = command_str.to_string();
        async move {
            let mut cmd = if cfg!(target_os = "windows") {
                let mut c = Command::new("powershell");
                c.args(["-NoProfile", "-Command", &cs]);
                c
            } else {
                let mut c = Command::new("sh");
                c.args(["-c", &cs]);
                c
            };
            if !ws.trim().is_empty() && ws != "." {
                cmd.current_dir(&ws);
            }
            cmd.kill_on_drop(true);
            match tokio::time::timeout(std::time::Duration::from_secs(30), cmd.output()).await {
                Ok(Ok(out)) => (
                    out.status.code().unwrap_or(-1),
                    String::from_utf8_lossy(&out.stdout).trim().to_string(),
                    String::from_utf8_lossy(&out.stderr).trim().to_string(),
                ),
                Ok(Err(e)) => (-1, String::new(), format!("Error: {e}")),
                Err(_) => (-2, String::new(), "Timeout 30s".to_string()),
            }
        }
    };

    let (code_a, out_a, err_a) = run_one(cmd_a).await;
    let (code_b, out_b, err_b) = run_one(cmd_b).await;
    let mismatch = code_a != code_b || out_a != out_b;

    json!({
        "mismatch": mismatch,
        "a": { "cmd": cmd_a, "exit_code": code_a, "stdout": out_a, "stderr": err_a },
        "b": { "cmd": cmd_b, "exit_code": code_b, "stdout": out_b, "stderr": err_b }
    })
    .to_string()
}

async fn run_sql_query(workspace: &str, engine: &str, target: &str, query: &str) -> String {
    match engine {
        "postgres" => {
            let mut cmd = Command::new("psql");
            cmd.args([target, "-c", query]).kill_on_drop(true);
            match cmd.output().await {
                Ok(out) => {
                    let stdout = String::from_utf8_lossy(&out.stdout);
                    let stderr = String::from_utf8_lossy(&out.stderr);
                    format!("exit_code: {:?}\nstdout:\n{stdout}\nstderr:\n{stderr}", out.status.code())
                }
                Err(e) => format!("No se pudo ejecutar psql (instala PostgreSQL client): {e}"),
            }
        }
        _ => {
            let db_path = match resolve_safe_path(workspace, target) {
                Ok(p) => p,
                Err(e) => return e,
            };
            // Try sqlite3 CLI first, then fallback to python sqlite3 module
            if let Ok(out) = Command::new("sqlite3")
                .args([
                    "-header",
                    "-column",
                    &db_path.to_string_lossy(),
                    query,
                ])
                .kill_on_drop(true)
                .output()
                .await
            {
                let stdout = String::from_utf8_lossy(&out.stdout);
                let stderr = String::from_utf8_lossy(&out.stderr);
                return format!(
                    "exit_code: {:?}\nstdout:\n{stdout}\nstderr:\n{stderr}",
                    out.status.code()
                );
            }

            let py_script = "import sqlite3, json, sys; c=sqlite3.connect(sys.argv[1]); cur=c.execute(sys.argv[2]); rows=cur.fetchall(); cols=[d[0] for d in cur.description] if cur.description else []; c.commit(); print(json.dumps({'columns': cols, 'rows': rows[:200]}, default=str))";
            match Command::new("python")
                .args(["-c", py_script, &db_path.to_string_lossy(), query])
                .kill_on_drop(true)
                .output()
                .await
            {
                Ok(out) => {
                    let stdout = String::from_utf8_lossy(&out.stdout);
                    let stderr = String::from_utf8_lossy(&out.stderr);
                    format!(
                        "exit_code: {:?}\nstdout:\n{stdout}\nstderr:\n{stderr}",
                        out.status.code()
                    )
                }
                Err(e) => format!("No se encontró sqlite3 ni python para consultar SQLite: {e}"),
            }
        }
    }
}

async fn run_docker_exec(workspace: &str, image: &str, command_str: &str) -> String {
    let ws = match workspace_root(workspace) {
        Ok(p) => p,
        Err(e) => return e,
    };
    let mount = format!("{}:/workspace", ws.to_string_lossy());
    let mut cmd = Command::new("docker");
    cmd.args([
        "run",
        "--rm",
        "-v",
        &mount,
        "-w",
        "/workspace",
        image,
        "sh",
        "-c",
        command_str,
    ])
    .kill_on_drop(true);

    match tokio::time::timeout(std::time::Duration::from_secs(120), cmd.output()).await {
        Ok(Ok(out)) => {
            let code = out.status.code().unwrap_or(-1);
            let stdout = String::from_utf8_lossy(&out.stdout);
            let stderr = String::from_utf8_lossy(&out.stderr);
            format!("exit_code: {code}\nstdout:\n{stdout}\nstderr:\n{stderr}")
        }
        Ok(Err(e)) => format!("Docker no disponible o error al lanzar contenedor: {e}"),
        Err(_) => "Timeout de 120s ejecutando comando en Docker.".to_string(),
    }
}

fn walk_files(root: &Path, dir: &Path, out: &mut Vec<String>, depth: usize, limit: usize) {
    if depth > 8 || out.len() >= limit {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        if out.len() >= limit {
            break;
        }
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if path.is_dir() {
            if IGNORED_DIRS.iter().any(|d| *d == name) {
                continue;
            }
            walk_files(root, &path, out, depth + 1, limit);
        } else if let Ok(rel) = path.strip_prefix(root) {
            out.push(rel.to_string_lossy().replace('\\', "/"));
        }
    }
}

fn apply_fuzzy_edit(content: &str, old_text: &str, new_text: &str) -> Option<(String, usize)> {
    if let Some(pos) = content.find(old_text) {
        let line_idx = content[..pos].matches('\n').count();
        return Some((content.replacen(old_text, new_text, 1), line_idx));
    }

    let uses_crlf = content.contains("\r\n");
    let norm_content = content.replace("\r\n", "\n");
    let norm_old = old_text.replace("\r\n", "\n");
    let norm_new = new_text.replace("\r\n", "\n");

    if let Some(pos) = norm_content.find(&norm_old) {
        let line_idx = norm_content[..pos].matches('\n').count();
        let replaced = norm_content.replacen(&norm_old, &norm_new, 1);
        let final_txt = if uses_crlf {
            replaced.replace('\n', "\r\n")
        } else {
            replaced
        };
        return Some((final_txt, line_idx));
    }

    // Fallback: unique line-trimmed block match
    let file_lines: Vec<&str> = norm_content.lines().collect();
    let old_lines: Vec<&str> = norm_old.lines().collect();
    if old_lines.is_empty() || old_lines.len() > file_lines.len() {
        return None;
    }

    let mut matched_starts = Vec::new();
    for i in 0..=file_lines.len() - old_lines.len() {
        let all_eq = old_lines
            .iter()
            .enumerate()
            .all(|(j, ol)| file_lines[i + j].trim() == ol.trim());
        if all_eq {
            matched_starts.push(i);
        }
    }

    if matched_starts.len() != 1 {
        return None;
    }

    let start_idx = matched_starts[0];
    let mut result_lines: Vec<String> = file_lines[..start_idx]
        .iter()
        .map(|s| s.to_string())
        .collect();
    for nl in norm_new.lines() {
        result_lines.push(nl.to_string());
    }
    for after in &file_lines[start_idx + old_lines.len()..] {
        result_lines.push((*after).to_string());
    }
    let mut joined = result_lines.join("\n");
    if norm_content.ends_with('\n') {
        joined.push('\n');
    }
    let final_txt = if uses_crlf {
        joined.replace('\n', "\r\n")
    } else {
        joined
    };
    Some((final_txt, start_idx))
}

async fn fetch_clean_text(url: &str) -> String {
    let Ok(client) = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Loors/0.1")
        .timeout(std::time::Duration::from_secs(20))
        .build()
    else {
        return "Error inicializando cliente HTTP.".to_string();
    };

    match client.get(url).send().await {
        Ok(resp) => {
            let status = resp.status().as_u16();
            let raw = resp.text().await.unwrap_or_default();
            let meta = docs::extract_html_page_meta(&raw);
            let cleaned = docs::html_to_clean_markdown(&raw);
            let combined = format!("{meta}{cleaned}");
            let truncated = if combined.len() > 16_000 {
                let end = combined.floor_char_boundary(16_000);
                format!("{}... [truncado]", &combined[..end])
            } else {
                combined
            };
            format!("HTTP {status}\n{truncated}")
        }
        Err(e) => format!("Error consultando '{url}': {e}"),
    }
}

fn unwrap_bing_news_url(raw: &str) -> String {
    let decoded_amp = raw.replace("&amp;", "&");
    if let Some(idx) = decoded_amp.find("url=") {
        let rest = &decoded_amp[idx + 4..];
        let encoded = rest.split('&').next().unwrap_or(rest);
        let mut out = Vec::with_capacity(encoded.len());
        let bytes = encoded.as_bytes();
        let mut i = 0;
        while i < bytes.len() {
            if bytes[i] == b'%' && i + 2 < bytes.len() {
                if let (Ok(s), Ok(v)) = (
                    std::str::from_utf8(&bytes[i + 1..i + 3]),
                    u8::from_str_radix(
                        std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or(""),
                        16,
                    ),
                ) {
                    let _ = s;
                    out.push(v);
                    i += 3;
                    continue;
                }
            } else if bytes[i] == b'+' {
                out.push(b' ');
                i += 1;
                continue;
            }
            out.push(bytes[i]);
            i += 1;
        }
        let unescaped = String::from_utf8_lossy(&out).to_string();
        if unescaped.starts_with("http://") || unescaped.starts_with("https://") {
            return unescaped;
        }
    }
    decoded_amp
}

fn parse_rss_search_results(xml: &str, max_items: usize) -> Vec<String> {
    let re_item = regex::Regex::new(r"(?is)<item\b[^>]*>(.*?)</item>").unwrap();
    let re_title = regex::Regex::new(r"(?is)<title\b[^>]*>(.*?)</title>").unwrap();
    let re_link = regex::Regex::new(r"(?is)<link\b[^>]*>(.*?)</link>").unwrap();
    let re_pub = regex::Regex::new(r"(?is)<pubDate\b[^>]*>(.*?)</pubDate>").unwrap();
    let re_desc = regex::Regex::new(r"(?is)<description\b[^>]*>(.*?)</description>").unwrap();
    let re_tags = regex::Regex::new(r"<[^>]+>").unwrap();

    let clean_field = |raw: &str| -> String {
        let no_cdata = raw
            .trim()
            .trim_start_matches("<![CDATA[")
            .trim_end_matches("]]>");
        let stripped = re_tags.replace_all(no_cdata, " ");
        stripped
            .replace("&amp;", "&")
            .replace("&lt;", "<")
            .replace("&gt;", ">")
            .replace("&quot;", "\"")
            .replace("&#39;", "'")
            .replace("&apos;", "'")
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
    };

    let mut results = Vec::new();
    for cap in re_item.captures_iter(xml) {
        let block = &cap[1];
        let title = re_title
            .captures(block)
            .map(|c| clean_field(&c[1]))
            .unwrap_or_default();
        let raw_link = re_link
            .captures(block)
            .map(|c| clean_field(&c[1]))
            .unwrap_or_default();
        if title.is_empty() || raw_link.is_empty() {
            continue;
        }
        let link = unwrap_bing_news_url(&raw_link);
        let pub_date = re_pub
            .captures(block)
            .map(|c| clean_field(&c[1]))
            .unwrap_or_default();
        let desc: String = re_desc
            .captures(block)
            .map(|c| clean_field(&c[1]))
            .unwrap_or_default()
            .chars()
            .take(220)
            .collect();

        let date_part = if pub_date.is_empty() {
            String::new()
        } else {
            format!(" ({pub_date})")
        };
        let desc_part = if desc.is_empty() {
            String::new()
        } else {
            format!(" — {desc}")
        };
        results.push(format!("- [{title}]({link}){date_part}{desc_part}"));
        if results.len() >= max_items {
            break;
        }
    }
    results
}

async fn web_search_ddg(query: &str) -> String {
    let Ok(client) = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
        .timeout(std::time::Duration::from_secs(15))
        .build()
    else {
        return "Error inicializando cliente HTTP.".to_string();
    };

    // 1. Try DuckDuckGo Lite first
    if let Ok(resp) = client
        .get("https://lite.duckduckgo.com/lite/")
        .query(&[("q", query)])
        .send()
        .await
    {
        if resp.status().is_success() {
            let raw = resp.text().await.unwrap_or_default();
            let cleaned = docs::html_to_clean_markdown(&raw);
            let low = cleaned.to_lowercase();
            let looks_valid = cleaned.len() >= 150
                && cleaned.contains("http")
                && !low.contains("bots use duckduckgo")
                && !low.contains("anomaly.js");
            if looks_valid {
                return if cleaned.len() > 10_000 {
                    let end = cleaned.floor_char_boundary(10_000);
                    format!("{}... [truncado]", &cleaned[..end])
                } else {
                    cleaned
                };
            }
        }
    }

    // 2. Fallback: Bing News RSS + Bing Web RSS (clean XML with direct unwrapped URLs)
    let mut combined: Vec<String> = Vec::new();
    for (label, endpoint) in [
        ("Noticias (Bing News)", "https://www.bing.com/news/search"),
        ("Web (Bing)", "https://www.bing.com/search"),
    ] {
        if let Ok(resp) = client
            .get(endpoint)
            .query(&[("q", query), ("format", "rss")])
            .send()
            .await
        {
            if resp.status().is_success() {
                if let Ok(xml) = resp.text().await {
                    let items = parse_rss_search_results(&xml, 8);
                    if !items.is_empty() {
                        combined.push(format!("### {label}\n{}", items.join("\n")));
                    }
                }
            }
        }
    }

    if !combined.is_empty() {
        return combined.join("\n\n");
    }

    // 3. Last-resort fallback: Google News RSS
    if let Ok(resp) = client
        .get("https://news.google.com/rss/search")
        .query(&[("q", query), ("hl", "en-US"), ("gl", "US"), ("ceid", "US:en")])
        .send()
        .await
    {
        if resp.status().is_success() {
            if let Ok(xml) = resp.text().await {
                let items = parse_rss_search_results(&xml, 10);
                if !items.is_empty() {
                    return format!("### Noticias (Google News)\n{}", items.join("\n"));
                }
            }
        }
    }

    format!("Sin resultados web disponibles para '{query}'.")
}

fn shannon_entropy(data: &[u8]) -> f64 {
    if data.is_empty() {
        return 0.0;
    }
    let mut counts = [0usize; 256];
    for &b in data {
        counts[b as usize] += 1;
    }
    let len = data.len() as f64;
    let mut ent = 0.0;
    for &c in &counts {
        if c > 0 {
            let p = (c as f64) / len;
            ent -= p * p.log2();
        }
    }
    ent
}

fn extract_printable_strings(bytes: &[u8], min_len: usize, filter: Option<&str>, max_items: usize) -> Vec<String> {
    let mut out = Vec::new();
    let filter_low = filter.map(|f| f.to_lowercase());
    let mut cur = String::new();
    let mut cur_offset = 0usize;

    for (idx, &b) in bytes.iter().enumerate() {
        if (0x20..=0x7E).contains(&b) {
            if cur.is_empty() {
                cur_offset = idx;
            }
            cur.push(b as char);
        } else {
            if cur.len() >= min_len {
                let matches = filter_low
                    .as_ref()
                    .map(|fl| cur.to_lowercase().contains(fl))
                    .unwrap_or(true);
                if matches {
                    out.push(format!("0x{:08X}: {}", cur_offset, cur));
                    if out.len() >= max_items {
                        return out;
                    }
                }
            }
            cur.clear();
        }
    }
    if cur.len() >= min_len && out.len() < max_items {
        let matches = filter_low
            .as_ref()
            .map(|fl| cur.to_lowercase().contains(fl))
            .unwrap_or(true);
        if matches {
            out.push(format!("0x{:08X}: {}", cur_offset, cur));
        }
    }
    out
}

fn parse_binary_header_summary(bytes: &[u8]) -> String {
    let size = bytes.len();
    let overall_ent = shannon_entropy(bytes);
    let mut report = format!(
        "Tamaño: {} bytes ({:.2} KB) | Entropía global: {:.2}/8.00{}\n",
        size,
        size as f64 / 1024.0,
        overall_ent,
        if overall_ent > 7.2 {
            " [ALTA ENTROPÍA: posible empaquetado/cifrado UPX o secciones comprimidas]"
        } else {
            ""
        }
    );

    if bytes.starts_with(b"MZ") && bytes.len() >= 0x40 {
        let pe_off = u32::from_le_bytes([bytes[0x3C], bytes[0x3D], bytes[0x3E], bytes[0x3F]]) as usize;
        if pe_off + 24 <= bytes.len() && &bytes[pe_off..pe_off + 4] == b"PE\0\0" {
            let machine = u16::from_le_bytes([bytes[pe_off + 4], bytes[pe_off + 5]]);
            let num_sections = u16::from_le_bytes([bytes[pe_off + 6], bytes[pe_off + 7]]) as usize;
            let opt_hdr_size = u16::from_le_bytes([bytes[pe_off + 20], bytes[pe_off + 21]]) as usize;
            let characteristics = u16::from_le_bytes([bytes[pe_off + 22], bytes[pe_off + 23]]);
            let arch = match machine {
                0x8664 => "x86_64 (AMD64)",
                0x014c => "x86 (i386)",
                0xAA64 => "ARM64 (AArch64)",
                _ => "PE desconocido",
            };
            let is_dll = (characteristics & 0x2000) != 0;
            report.push_str(&format!(
                "Formato: Windows PE ({}) | Arquitectura: {} | Secciones: {}\n",
                if is_dll { "DLL" } else { "EXE" },
                arch,
                num_sections
            ));

            let opt_off = pe_off + 24;
            if opt_off + 28 <= bytes.len() {
                let magic = u16::from_le_bytes([bytes[opt_off], bytes[opt_off + 1]]);
                let entry_rva = u32::from_le_bytes([
                    bytes[opt_off + 16],
                    bytes[opt_off + 17],
                    bytes[opt_off + 18],
                    bytes[opt_off + 19],
                ]);
                let image_base = if magic == 0x20b && opt_off + 32 <= bytes.len() {
                    u64::from_le_bytes([
                        bytes[opt_off + 24],
                        bytes[opt_off + 25],
                        bytes[opt_off + 26],
                        bytes[opt_off + 27],
                        bytes[opt_off + 28],
                        bytes[opt_off + 29],
                        bytes[opt_off + 30],
                        bytes[opt_off + 31],
                    ])
                } else if opt_off + 32 <= bytes.len() {
                    u32::from_le_bytes([
                        bytes[opt_off + 28],
                        bytes[opt_off + 29],
                        bytes[opt_off + 30],
                        bytes[opt_off + 31],
                    ]) as u64
                } else {
                    0
                };
                report.push_str(&format!(
                    "ImageBase: 0x{:X} | EntryPoint RVA: 0x{:X}\n",
                    image_base, entry_rva
                ));
            }

            let sec_table = opt_off + opt_hdr_size;
            report.push_str("\nSECCIONES PE:\n");
            for i in 0..num_sections.min(32) {
                let off = sec_table + i * 40;
                if off + 40 > bytes.len() {
                    break;
                }
                let name_raw = &bytes[off..off + 8];
                let name = String::from_utf8_lossy(name_raw)
                    .trim_end_matches('\0')
                    .to_string();
                let vsize = u32::from_le_bytes([bytes[off + 8], bytes[off + 9], bytes[off + 10], bytes[off + 11]]);
                let vrva = u32::from_le_bytes([bytes[off + 12], bytes[off + 13], bytes[off + 14], bytes[off + 15]]);
                let raw_size = u32::from_le_bytes([bytes[off + 16], bytes[off + 17], bytes[off + 18], bytes[off + 19]]) as usize;
                let raw_ptr = u32::from_le_bytes([bytes[off + 20], bytes[off + 21], bytes[off + 22], bytes[off + 23]]) as usize;
                let flags = u32::from_le_bytes([bytes[off + 36], bytes[off + 37], bytes[off + 38], bytes[off + 39]]);
                let r = if (flags & 0x40000000) != 0 { "R" } else { "-" };
                let w = if (flags & 0x80000000) != 0 { "W" } else { "-" };
                let x = if (flags & 0x20000000) != 0 { "X" } else { "-" };
                let sec_ent = if raw_ptr < bytes.len() {
                    let end = (raw_ptr + raw_size).min(bytes.len());
                    shannon_entropy(&bytes[raw_ptr..end])
                } else {
                    0.0
                };
                report.push_str(&format!(
                    "  {:<8} | RVA 0x{:08X} | VSize 0x{:06X} | Raw 0x{:06X} | {}{}{} | Entropía {:.2}{}\n",
                    name,
                    vrva,
                    vsize,
                    raw_size,
                    r,
                    w,
                    x,
                    sec_ent,
                    if w == "W" && x == "X" { " [RWX!]" } else { "" }
                ));
            }
        }
    } else if bytes.starts_with(b"\x7FELF") && bytes.len() >= 64 {
        let class = match bytes[4] {
            1 => "ELF32",
            2 => "ELF64",
            _ => "ELF",
        };
        let endian = if bytes[5] == 1 { "Little-Endian" } else { "Big-Endian" };
        let machine = u16::from_le_bytes([bytes[18], bytes[19]]);
        let arch = match machine {
            0x3E => "x86_64",
            0x03 => "x86",
            0xB7 => "AArch64",
            0x28 => "ARM",
            0xF3 => "RISC-V",
            _ => "Otra",
        };
        let entry = if bytes[4] == 2 {
            u64::from_le_bytes([
                bytes[24], bytes[25], bytes[26], bytes[27], bytes[28], bytes[29], bytes[30],
                bytes[31],
            ])
        } else {
            u32::from_le_bytes([bytes[24], bytes[25], bytes[26], bytes[27]]) as u64
        };
        report.push_str(&format!(
            "Formato: {} ({}) | Arquitectura: {} | EntryPoint: 0x{:X}\n",
            class, endian, arch, entry
        ));
    } else if bytes.len() >= 4
        && matches!(
            u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]),
            0xFEEDFACE | 0xFEEDFACF | 0xCAFEBABE | 0xCEFAEDFE | 0xCFFAEDFE
        )
    {
        report.push_str("Formato: Apple Mach-O / Universal Binary\n");
    } else {
        report.push_str("Formato: Binario raw / desconocido\n");
    }

    let interesting = extract_printable_strings(bytes, 5, None, 2500);
    let mut dlls_or_libs = Vec::new();
    let mut apis_or_urls = Vec::new();
    for s in &interesting {
        let val = s.splitn(2, ": ").nth(1).unwrap_or("");
        let low = val.to_lowercase();
        if low.ends_with(".dll") || low.contains(".so") || low.ends_with(".dylib") {
            if dlls_or_libs.len() < 35 && !dlls_or_libs.contains(&val.to_string()) {
                dlls_or_libs.push(val.to_string());
            }
        } else if low.starts_with("http://")
            || low.starts_with("https://")
            || val.contains("VirtualAlloc")
            || val.contains("WriteProcessMemory")
            || val.contains("CreateRemoteThread")
            || val.contains("LoadLibrary")
            || val.contains("GetProcAddress")
            || val.contains("WinExec")
            || val.contains("ShellExecute")
            || val.contains("system")
            || val.contains("execve")
            || val.contains("mprotect")
            || val.contains("memcpy")
            || val.contains("strcpy")
            || val.contains("sprintf")
        {
            if apis_or_urls.len() < 40 && !apis_or_urls.contains(&val.to_string()) {
                apis_or_urls.push(val.to_string());
            }
        }
    }

    if !dlls_or_libs.is_empty() {
        report.push_str(&format!(
            "\nLIBRERÍAS / DLLS DETECTADAS ({}):\n  {}\n",
            dlls_or_libs.len(),
            dlls_or_libs.join(", ")
        ));
    }
    if !apis_or_urls.is_empty() {
        report.push_str(&format!(
            "\nSÍMBOLOS / APIS SENSIBLES / URLS ({}):\n  {}\n",
            apis_or_urls.len(),
            apis_or_urls.join("\n  ")
        ));
    }

    report
}

async fn run_binary_inspect(
    workspace: &str,
    path_str: &str,
    mode: &str,
    filter: Option<&str>,
    ghidra_script: Option<&str>,
) -> String {
    let target = {
        let p = Path::new(path_str.trim());
        if p.is_absolute() {
            p.to_path_buf()
        } else {
            match resolve_safe_path(workspace, path_str) {
                Ok(abs) => abs,
                Err(e) => return e,
            }
        }
    };
    if !target.exists() {
        return format!("Archivo binario no encontrado: '{}'", target.display());
    }

    let bytes = match fs::read(&target) {
        Ok(b) => b,
        Err(e) => return format!("Error leyendo binario '{}': {e}", target.display()),
    };

    let target_str = target.to_string_lossy().to_string();

    match mode {
        "strings" => {
            let list = extract_printable_strings(&bytes, 4, filter, 150);
            if list.is_empty() {
                "No se encontraron strings con ese criterio.".to_string()
            } else {
                format!(
                    "STRINGS EXTRAÍDAS ({} mostradas):\n{}",
                    list.len(),
                    list.join("\n")
                )
            }
        }
        "disasm" => {
            for (bin, args_vec) in [
                ("llvm-objdump", vec!["-d", "--demangle", &target_str]),
                ("objdump", vec!["-d", "-C", &target_str]),
                ("dumpbin", vec!["/DISASM", "/NOBYTES", &target_str]),
            ] {
                let mut cmd = Command::new(bin);
                cmd.args(&args_vec).kill_on_drop(true);
                if let Ok(out) = cmd.output().await {
                    if out.status.success() {
                        let text = String::from_utf8_lossy(&out.stdout).to_string();
                        if let Some(sym) = filter {
                            let sym_low = sym.to_lowercase();
                            let filtered: Vec<&str> = text
                                .lines()
                                .filter(|l| l.to_lowercase().contains(&sym_low))
                                .take(200)
                                .collect();
                            if !filtered.is_empty() {
                                return format!(
                                    "DESENSAMBLADO ({bin}, filtro '{sym}'):\n{}",
                                    filtered.join("\n")
                                );
                            }
                        }
                        let snippet: String = text.lines().take(220).collect::<Vec<_>>().join("\n");
                        return format!("DESENSAMBLADO ({bin}, primeras 220 líneas):\n{snippet}");
                    }
                }
            }
            format!(
                "No se encontró llvm-objdump, objdump ni dumpbin en PATH para desensamblar.\n\n{}",
                parse_binary_header_summary(&bytes)
            )
        }
        "ghidra_headless" => {
            let ghidra_headless = std::env::var("GHIDRA_INSTALL_DIR")
                .ok()
                .map(|d| {
                    let base = PathBuf::from(d).join("support");
                    if cfg!(target_os = "windows") {
                        base.join("analyzeHeadless.bat")
                    } else {
                        base.join("analyzeHeadless")
                    }
                })
                .filter(|p| p.exists())
                .unwrap_or_else(|| {
                    if cfg!(target_os = "windows") {
                        PathBuf::from("analyzeHeadless.bat")
                    } else {
                        PathBuf::from("analyzeHeadless")
                    }
                });

            let proj_dir = std::env::temp_dir().join("loors_ghidra_proj");
            let _ = fs::create_dir_all(&proj_dir);
            let mut cmd = Command::new(&ghidra_headless);
            cmd.arg(proj_dir.to_string_lossy().to_string())
                .arg("LoorsProject")
                .arg("-import")
                .arg(&target_str)
                .arg("-overwrite");
            if let Some(sc) = ghidra_script {
                if !sc.trim().is_empty() {
                    cmd.arg("-postScript").arg(sc.trim());
                }
            }
            cmd.kill_on_drop(true);
            match tokio::time::timeout(std::time::Duration::from_secs(180), cmd.output()).await {
                Ok(Ok(out)) => {
                    let stdout = String::from_utf8_lossy(&out.stdout);
                    let stderr = String::from_utf8_lossy(&out.stderr);
                    format!(
                        "Ghidra Headless finalizó (exit_code={:?}):\n{}\n{}",
                        out.status.code(),
                        stdout.chars().take(8000).collect::<String>(),
                        stderr.chars().take(4000).collect::<String>()
                    )
                }
                Ok(Err(e)) => format!(
                    "No se pudo lanzar Ghidra analyzeHeadless ({}): {e}. Define GHIDRA_INSTALL_DIR o conecta un nodo MCP Server con el preset 'Ghidra (GhidraMCP)'.\n\nResumen estático nativo:\n{}",
                    ghidra_headless.display(),
                    parse_binary_header_summary(&bytes)
                ),
                Err(_) => "Timeout (180s) ejecutando Ghidra analyzeHeadless.".to_string(),
            }
        }
        _ => parse_binary_header_summary(&bytes),
    }
}

#[cfg(test)]
mod tests {
    #[cfg(unix)]
    #[test]
    fn file_tools_reject_links_outside_workspace() {
        let workspace = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(outside.path(), workspace.path().join("external")).unwrap();
        let root = workspace.path().to_str().unwrap();
        assert!(super::resolve_safe_path(root, "external/new-file").is_err());
        assert!(super::resolve_safe_path(root, "local/new-file").is_ok());
    }
    use super::*;

    #[tokio::test]
    async fn document_tools_write_and_read_csv_with_quoted_fields() {
        let workspace = tempfile::tempdir().unwrap();
        let root = workspace.path().to_str().unwrap();
        let args = json!({
            "path": "datos.csv",
            "columns": ["nombre", "nota", "total"],
            "rows": [
                {"total": 42, "nombre": "Revisión, Q4", "nota": "Dijo \"sí\"\nDespués"},
                {"nombre": "Vacío", "total": null}
            ]
        });
        let result = execute_tool(root, "create_csv", &args).await;
        assert_eq!(serde_json::from_str::<Value>(&result).unwrap(), json!({"path": "datos.csv"}));
        let path = workspace.path().join("datos.csv");
        assert_eq!(
            docs::read_document_or_text(&path).await.unwrap(),
            "nombre,nota,total\r\n\"Revisión, Q4\",\"Dijo \"\"sí\"\"\nDespués\",42\r\nVacío,\"\",\"\"\r\n"
        );
        let read = execute_tool(root, "read_file", &json!({ "path": "datos.csv" })).await;
        assert!(read.contains("\"Revisión, Q4\""));
    }

    #[tokio::test]
    async fn document_tools_generate_and_read_excel_and_word() {
        let workspace = tempfile::tempdir().unwrap();
        let root = workspace.path().to_str().unwrap();
        let report = json!({
            "title": "Informe de producción",
            "sections": [{
                "heading": "Resultados",
                "paragraphs": ["Revisión & control."],
                "table": { "headers": ["Métrica", "Valor"], "rows": [["Total", "42"]] }
            }]
        });
        for (tool, args, expected) in [
            ("create_excel", json!({
                "path": "datos.xlsx",
                "rows": [
                    {"id": 42, "title": "Revisión & control.", "active": true},
                    {"id": 43, "title": "=1+1"}
                ],
                "columns": ["title", "id", "active"]
            }), "Revisión & control."),
            ("create_word", json!({ "path": "informe.docx", "content": report }), "Informe de producción"),
        ] {
            let path = args["path"].as_str().unwrap();
            let result = execute_tool(root, tool, &args).await;
            assert_eq!(serde_json::from_str::<Value>(&result).unwrap(), json!({"path": path}), "{result}");
            let read = execute_tool(root, "read_file", &json!({"path": path})).await;
            assert!(read.contains(expected), "{tool}: {read}");
            assert!(read.contains("42"), "{tool}: {read}");

            let duplicate = execute_tool(root, tool, &args).await;
            assert!(serde_json::from_str::<Value>(&duplicate).unwrap()["error"].is_string());
        }
        let file = fs::File::open(workspace.path().join("datos.xlsx")).unwrap();
        let mut zip = zip::ZipArchive::new(file).unwrap();
        let mut xml = String::new();
        std::io::Read::read_to_string(&mut zip.by_name("xl/worksheets/sheet1.xml").unwrap(), &mut xml).unwrap();
        assert!(xml.contains("<c><v>42</v></c>"));
        assert!(xml.contains("<c t=\"b\"><v>1</v></c>"));
        assert!(xml.contains(">=1+1</t>") && !xml.contains("<f>"));
    }

    #[tokio::test]
    #[ignore = "Requires permission to launch an installed Chromium-based browser"]
    async fn document_tools_generate_and_read_pdf() {
        let workspace = tempfile::tempdir().unwrap();
        let root = workspace.path().to_str().unwrap();
        let result = execute_tool(root, "create_pdf", &json!({
            "path": "informe.pdf",
            "content": {
                "title": "Informe de producción",
                "sections": [{
                    "heading": "Resultados",
                    "paragraphs": ["Revisión & control."],
                    "table": { "headers": ["Métrica", "Valor"], "rows": [["Total", "42"]] }
                }]
            }
        })).await;
        assert_eq!(serde_json::from_str::<Value>(&result).unwrap(), json!({"path": "informe.pdf"}), "{result}");
        let read = execute_tool(root, "read_file", &json!({"path": "informe.pdf"})).await;
        assert!(read.contains("Informe de producción"), "{read}");
        assert!(read.contains("Revisión & control."), "{read}");
        assert!(read.contains("42"), "{read}");
    }

    #[tokio::test]
    async fn edit_file_and_read_file_line_ranges_work() {
        let dir = std::env::temp_dir().join("loors_tools_test");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let ws = dir.to_string_lossy().to_string();

        let write_res = execute_tool(
            &ws,
            "write_file",
            &json!({ "path": "hello.txt", "content": "line1\nline2\nline3\n" }),
        )
        .await;
        assert!(write_res.contains("escrito"));

        let edit_res = execute_tool(
            &ws,
            "edit_file",
            &json!({ "path": "hello.txt", "old_text": "line2", "new_text": "line2_edited" }),
        )
        .await;
        assert!(edit_res.contains("editado"));
        assert!(edit_res.contains("2 | line2_edited"));

        let read_res = execute_tool(
            &ws,
            "read_file",
            &json!({ "path": "hello.txt", "start_line": 2, "end_line": 2 }),
        )
        .await;
        assert!(read_res.contains("2 | line2_edited"));

        // Regression test for bug found by Loors self-audit: start_line > end_line must not panic
        let inverted_res = execute_tool(
            &ws,
            "read_file",
            &json!({ "path": "hello.txt", "start_line": 3, "end_line": 1 }),
        )
        .await;
        assert!(inverted_res.contains("Mostrando") || inverted_res.is_empty());

        let grep_res = execute_tool(&ws, "grep_search", &json!({ "pattern": "edited" })).await;
        assert!(grep_res.contains("hello.txt:2:"));

        // Fuzzy CRLF edit + compact diff check
        fs::write(dir.join("win.txt"), "alpha\r\n  beta  \r\ngamma\r\n").unwrap();
        let crlf_edit = execute_tool(
            &ws,
            "edit_file",
            &json!({ "path": "win.txt", "old_text": "beta", "new_text": "  beta_fixed" }),
        )
        .await;
        assert!(crlf_edit.contains("editado"));
        let after = fs::read_to_string(dir.join("win.txt")).unwrap();
        assert!(after.contains("\r\n"));
        let (diff, add, rem) = compute_compact_diff(Some("a\nb\nc"), Some("a\nb2\nc"), "win.txt");
        assert_eq!(add, 1);
        assert_eq!(rem, 1);
        assert!(diff.contains("+ b2"));

        let diff_res = execute_tool(
            &ws,
            "differential_test",
            &json!({ "cmd_a": "echo alpha", "cmd_b": "echo beta" }),
        )
        .await;
        assert!(diff_res.contains("\"mismatch\":true"));

        // Minimal ELF64 header + strings check for binary_inspect
        let mut fake_elf = vec![0u8; 128];
        fake_elf[0..4].copy_from_slice(b"\x7FELF");
        fake_elf[4] = 2; // ELF64
        fake_elf[5] = 1; // Little-Endian
        fake_elf[18] = 0x3E; // x86_64
        fake_elf.extend_from_slice(b"\0libcrypto.so.3\0VirtualAlloc\0https://example.org/c2\0");
        fs::write(dir.join("sample.bin"), &fake_elf).unwrap();

        let bin_sum = execute_tool(
            &ws,
            "binary_inspect",
            &json!({ "path": "sample.bin", "mode": "summary" }),
        )
        .await;
        assert!(bin_sum.contains("ELF64"));
        assert!(bin_sum.contains("x86_64"));
        assert!(bin_sum.contains("libcrypto.so.3"));
        assert!(bin_sum.contains("VirtualAlloc"));

        let bin_str = execute_tool(
            &ws,
            "binary_inspect",
            &json!({ "path": "sample.bin", "mode": "strings", "filter": "example.org" }),
        )
        .await;
        assert!(bin_str.contains("https://example.org/c2"));

        let _ = fs::remove_dir_all(&dir);
    }
}
