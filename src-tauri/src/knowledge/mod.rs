use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

const IGNORED_DIRS: &[&str] = &[
    ".git",
    ".loors",
    "node_modules",
    "target",
    "dist",
    "build",
    ".next",
    "__pycache__",
    ".venv",
    "venv",
    ".idea",
    ".vscode",
];

const DEFAULT_EXTENSIONS: &[&str] = &[
    "rs", "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "c", "cc", "cpp", "cxx", "h", "hpp", "hh",
    "go", "java", "kt", "cs", "swift", "rb", "php", "md", "txt", "rst", "json", "toml", "yaml",
    "yml", "sql", "sh", "ps1", "cmake", "html", "css", "scss",
];

const MAX_FILE_BYTES: u64 = 512 * 1024;
const MAX_INDEXED_FILES: usize = 2500;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RagChunk {
    pub start_line: usize,
    pub end_line: usize,
    pub text: String,
    pub tokens: HashMap<String, u32>,
    pub length: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IndexedFile {
    pub rel_path: String,
    pub mtime_secs: u64,
    pub size: u64,
    pub symbols: Vec<String>,
    pub chunks: Vec<RagChunk>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct KnowledgeIndex {
    pub version: u32,
    pub files: Vec<IndexedFile>,
}

#[derive(Debug, Clone)]
pub struct IndexStats {
    pub total_files: usize,
    pub reindexed_files: usize,
    pub total_chunks: usize,
}

/// Splits text into lowercase searchable tokens, breaking snake_case and camelCase
/// while also keeping the full identifier for exact matches.
pub fn tokenize(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut current = String::new();

    let flush = |word: &str, dst: &mut Vec<String>| {
        if word.len() < 2 {
            return;
        }
        let lower = word.to_lowercase();
        dst.push(lower.clone());

        // Split snake_case / camelCase parts if multi-part
        let mut parts: Vec<String> = Vec::new();
        for seg in word.split('_') {
            if seg.is_empty() {
                continue;
            }
            let mut cur = String::new();
            let chars: Vec<char> = seg.chars().collect();
            for (i, &c) in chars.iter().enumerate() {
                if i > 0
                    && c.is_uppercase()
                    && (chars[i - 1].is_lowercase()
                        || (i + 1 < chars.len() && chars[i + 1].is_lowercase()))
                {
                    if cur.len() >= 2 {
                        parts.push(cur.to_lowercase());
                    }
                    cur.clear();
                }
                cur.push(c);
            }
            if cur.len() >= 2 {
                parts.push(cur.to_lowercase());
            }
        }
        for p in parts {
            if p != lower {
                dst.push(p);
            }
        }
    };

    for ch in text.chars() {
        if ch.is_alphanumeric() || ch == '_' {
            current.push(ch);
        } else if !current.is_empty() {
            flush(&current, &mut out);
            current.clear();
        }
    }
    if !current.is_empty() {
        flush(&current, &mut out);
    }
    out
}

fn extract_symbols(content: &str, ext: &str) -> Vec<String> {
    let mut symbols = Vec::new();
    let re_code = Regex::new(
        r"^\s*(?:pub(?:\([^)]*\))?\s+)?(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:unsafe\s+)?(?:fn|struct|enum|trait|impl|class|interface|type|function|def|const|namespace)\s+([A-Za-z_][A-Za-z0-9_:<>]*)",
    )
    .ok();
    let re_cpp = Regex::new(
        r"^\s*(?:inline\s+|static\s+|virtual\s+|constexpr\s+)*(?:[A-Za-z_][A-Za-z0-9_:<>*&\s]+?)\s+([A-Za-z_][A-Za-z0-9_:~]*)\s*\([^;]*\)\s*(?:const\s*)?(?:override\s*)?\{?\s*$",
    )
    .ok();

    for line in content.lines().take(2000) {
        if symbols.len() >= 24 {
            break;
        }
        if matches!(ext, "md" | "rst") {
            let t = line.trim();
            if t.starts_with('#') {
                let heading = t.trim_start_matches('#').trim();
                if !heading.is_empty() {
                    let short: String = heading.chars().take(60).collect();
                    symbols.push(format!("# {short}"));
                }
            }
            continue;
        }
        if let Some(re) = &re_code {
            if let Some(caps) = re.captures(line) {
                if let Some(m) = caps.get(1) {
                    let s = m.as_str().to_string();
                    if !symbols.contains(&s) {
                        symbols.push(s);
                    }
                    continue;
                }
            }
        }
        if matches!(ext, "c" | "cc" | "cpp" | "cxx" | "h" | "hpp" | "hh") {
            if let Some(re) = &re_cpp {
                if let Some(caps) = re.captures(line) {
                    if let Some(m) = caps.get(1) {
                        let name = m.as_str();
                        if !matches!(name, "if" | "for" | "while" | "switch" | "catch" | "return")
                            && !symbols.iter().any(|s| s == name)
                        {
                            symbols.push(name.to_string());
                        }
                    }
                }
            }
        }
    }
    symbols
}

fn chunk_text(content: &str) -> Vec<RagChunk> {
    let lines: Vec<&str> = content.lines().collect();
    if lines.is_empty() {
        return Vec::new();
    }
    let chunk_lines = 45usize;
    let overlap = 6usize;
    let mut chunks = Vec::new();
    let mut start = 0usize;

    while start < lines.len() {
        let end = (start + chunk_lines).min(lines.len());
        let slice_text = lines[start..end].join("\n");
        let toks = tokenize(&slice_text);
        if !toks.is_empty() {
            let mut tf: HashMap<String, u32> = HashMap::new();
            for t in &toks {
                *tf.entry(t.clone()).or_insert(0) += 1;
            }
            chunks.push(RagChunk {
                start_line: start + 1,
                end_line: end,
                text: slice_text,
                tokens: tf,
                length: toks.len(),
            });
        }
        if end >= lines.len() {
            break;
        }
        start = end.saturating_sub(overlap);
    }
    chunks
}

fn collect_files(root: &Path, dir: &Path, out: &mut Vec<PathBuf>, depth: usize) {
    if depth > 14 || out.len() >= MAX_INDEXED_FILES {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let mut paths: Vec<PathBuf> = entries.flatten().map(|e| e.path()).collect();
    paths.sort();

    for p in paths {
        if out.len() >= MAX_INDEXED_FILES {
            break;
        }
        let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if p.is_dir() {
            if IGNORED_DIRS.iter().any(|d| d.eq_ignore_ascii_case(name)) {
                continue;
            }
            collect_files(root, &p, out, depth + 1);
        } else if p.is_file() {
            let ext = p
                .extension()
                .and_then(|e| e.to_str())
                .map(|e| e.to_lowercase())
                .unwrap_or_default();
            if !DEFAULT_EXTENSIONS.iter().any(|allowed| *allowed == ext) {
                continue;
            }
            if let Ok(meta) = fs::metadata(&p) {
                if meta.len() <= MAX_FILE_BYTES && meta.len() > 0 {
                    out.push(p);
                }
            }
        }
    }
}

fn resolve_base(workspace: &str) -> PathBuf {
    if workspace.trim().is_empty() || workspace == "." {
        std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
    } else {
        PathBuf::from(workspace)
    }
}

pub fn build_or_update_index(
    workspace: &str,
    subpath: &str,
) -> Result<(KnowledgeIndex, IndexStats), String> {
    let ws_root = resolve_base(workspace);
    let scan_root = if subpath.trim().is_empty() || subpath.trim() == "." {
        ws_root.clone()
    } else {
        ws_root.join(subpath.trim())
    };
    if !scan_root.exists() {
        return Err(format!(
            "Ruta de conocimiento no existe: '{}'",
            scan_root.display()
        ));
    }

    let cache_path = ws_root.join(".loors").join("rag-index.json");
    let cached: HashMap<String, IndexedFile> = fs::read_to_string(&cache_path)
        .ok()
        .and_then(|raw| serde_json::from_str::<KnowledgeIndex>(&raw).ok())
        .filter(|idx| idx.version == 1)
        .map(|idx| {
            idx.files
                .into_iter()
                .map(|f| (f.rel_path.clone(), f))
                .collect()
        })
        .unwrap_or_default();

    let mut disk_files = Vec::new();
    collect_files(&ws_root, &scan_root, &mut disk_files, 0);

    let mut files = Vec::with_capacity(disk_files.len());
    let mut reindexed_files = 0usize;
    let mut total_chunks = 0usize;

    for abs_path in disk_files {
        let rel = abs_path
            .strip_prefix(&ws_root)
            .unwrap_or(&abs_path)
            .to_string_lossy()
            .replace('\\', "/");
        let Ok(meta) = fs::metadata(&abs_path) else {
            continue;
        };
        let size = meta.len();
        let mtime_secs = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);

        if let Some(prev) = cached.get(&rel) {
            if prev.mtime_secs == mtime_secs && prev.size == size {
                total_chunks += prev.chunks.len();
                files.push(prev.clone());
                continue;
            }
        }

        let Ok(content) = fs::read_to_string(&abs_path) else {
            continue;
        };
        let ext = abs_path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_lowercase())
            .unwrap_or_default();
        let symbols = extract_symbols(&content, &ext);
        let chunks = chunk_text(&content);
        total_chunks += chunks.len();
        reindexed_files += 1;
        files.push(IndexedFile {
            rel_path: rel,
            mtime_secs,
            size,
            symbols,
            chunks,
        });
    }

    let index = KnowledgeIndex { version: 1, files };
    if reindexed_files > 0 || !cache_path.exists() {
        if let Some(parent) = cache_path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        if let Ok(serialized) = serde_json::to_string(&index) {
            let _ = fs::write(&cache_path, serialized);
        }
    }

    let stats = IndexStats {
        total_files: index.files.len(),
        reindexed_files,
        total_chunks,
    };
    Ok((index, stats))
}

pub fn search_bm25(
    index: &KnowledgeIndex,
    query: &str,
    top_k: usize,
    max_chars: usize,
) -> String {
    let query_tokens: Vec<String> = {
        let mut seen = HashSet::new();
        tokenize(query)
            .into_iter()
            .filter(|t| seen.insert(t.clone()))
            .collect()
    };

    if query_tokens.is_empty() {
        return "Sin términos de búsqueda válidos para RAG.".to_string();
    }

    // Flatten chunks and compute document frequency + avg length
    let mut all_chunks: Vec<(&IndexedFile, &RagChunk)> = Vec::new();
    let mut df: HashMap<&str, usize> = HashMap::new();
    let mut total_len = 0usize;

    for f in &index.files {
        for c in &f.chunks {
            total_len += c.length;
            for qt in &query_tokens {
                if c.tokens.contains_key(qt) {
                    *df.entry(qt.as_str()).or_insert(0) += 1;
                }
            }
            all_chunks.push((f, c));
        }
    }

    let n = all_chunks.len() as f64;
    if n == 0.0 {
        return "El índice de conocimiento está vacío.".to_string();
    }
    let avg_dl = (total_len as f64 / n).max(1.0);
    let k1 = 1.5_f64;
    let b = 0.75_f64;

    let mut scored: Vec<(f64, &IndexedFile, &RagChunk)> = Vec::new();
    for (f, c) in all_chunks {
        let dl = c.length as f64;
        let mut score = 0.0_f64;
        let path_lower = f.rel_path.to_lowercase();

        for qt in &query_tokens {
            if let Some(&tf_u32) = c.tokens.get(qt) {
                let tf = tf_u32 as f64;
                let doc_freq = *df.get(qt.as_str()).unwrap_or(&0) as f64;
                let idf = ((n - doc_freq + 0.5) / (doc_freq + 0.5) + 1.0).ln();
                score += idf * (tf * (k1 + 1.0)) / (tf + k1 * (1.0 - b + b * (dl / avg_dl)));
            }
            if path_lower.contains(qt) {
                score += 1.2;
            }
            if f.symbols.iter().any(|s| s.to_lowercase().contains(qt)) {
                score += 0.8;
            }
        }
        if score > 0.0 {
            scored.push((score, f, c));
        }
    }

    if scored.is_empty() {
        return format!("No se encontraron fragmentos relevantes para: '{}'.", query);
    }

    scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));

    let mut out = String::new();
    let limit_k = top_k.clamp(1, 20);
    for (score, f, c) in scored.into_iter().take(limit_k) {
        let block = format!(
            "### {}:{}-{} (relevancia={:.2})\n```\n{}\n```\n\n",
            f.rel_path, c.start_line, c.end_line, score, c.text
        );
        if out.len() + block.len() > max_chars && !out.is_empty() {
            break;
        }
        out.push_str(&block);
    }
    out.trim_end().to_string()
}

pub fn build_knowledge_tree(
    index: &KnowledgeIndex,
    subpath_filter: Option<&str>,
    max_chars: usize,
) -> String {
    let filter_norm = subpath_filter
        .map(|s| s.trim().replace('\\', "/").trim_start_matches("./").to_string())
        .filter(|s| !s.is_empty() && s != ".");

    let mut out = String::from("# Árbol de Conocimiento (Repo Map)\n");
    let mut included = 0usize;
    let mut omitted = 0usize;

    for f in &index.files {
        if let Some(prefix) = &filter_norm {
            if !f.rel_path.starts_with(prefix) && !f.rel_path.contains(prefix) {
                continue;
            }
        }
        let line = if f.symbols.is_empty() {
            format!("- {}\n", f.rel_path)
        } else {
            let preview = f
                .symbols
                .iter()
                .take(8)
                .cloned()
                .collect::<Vec<_>>()
                .join(", ");
            let extra = if f.symbols.len() > 8 {
                format!(" (+{})", f.symbols.len() - 8)
            } else {
                String::new()
            };
            format!("- {} :: {}{}\n", f.rel_path, preview, extra)
        };

        if out.len() + line.len() > max_chars {
            omitted += 1;
            continue;
        }
        out.push_str(&line);
        included += 1;
    }

    if omitted > 0 {
        out.push_str(&format!(
            "... (+{omitted} archivos adicionales omitidos por límite de {max_chars} chars; usa search_knowledge o filtra por subcarpeta)\n"
        ));
    }
    if included == 0 {
        return "No hay archivos indexados que coincidan con el filtro.".to_string();
    }
    out.trim_end().to_string()
}

pub fn query_knowledge(
    workspace: &str,
    subpath: &str,
    mode: &str,
    query: &str,
    top_k: usize,
    max_chars: usize,
) -> Result<(String, IndexStats), String> {
    let (index, stats) = build_or_update_index(workspace, subpath)?;
    let budget = max_chars.clamp(500, 32_000);

    let result = match mode {
        "tree" => build_knowledge_tree(&index, None, budget),
        "rag" => search_bm25(&index, query, top_k, budget),
        _ => {
            // hybrid: 40% tree + 60% top-k RAG chunks
            let tree_budget = (budget * 2) / 5;
            let rag_budget = budget.saturating_sub(tree_budget);
            let tree = build_knowledge_tree(&index, None, tree_budget);
            let rag = search_bm25(&index, query, top_k, rag_budget);
            format!("{tree}\n\n# Fragmentos RAG más relevantes\n{rag}")
        }
    };

    Ok((result, stats))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokenizes_camel_and_snake_case() {
        let toks = tokenize("parseWasmFunction bounds_check");
        assert!(toks.contains(&"parsewasmfunction".to_string()));
        assert!(toks.contains(&"parse".to_string()));
        assert!(toks.contains(&"wasm".to_string()));
        assert!(toks.contains(&"function".to_string()));
        assert!(toks.contains(&"bounds".to_string()));
        assert!(toks.contains(&"check".to_string()));
    }

    #[test]
    fn builds_tree_and_bm25_search_on_temp_repo() {
        let dir = std::env::temp_dir().join(format!(
            "loors-rag-test-{}",
            std::time::SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let _ = fs::create_dir_all(dir.join("src"));
        fs::write(
            dir.join("src").join("auth.rs"),
            "pub struct AuthManager {}\npub fn verifyJwtToken(token: &str) -> bool {\n    token.starts_with(\"eyJ\")\n}\n",
        )
        .unwrap();
        fs::write(
            dir.join("src").join("math.rs"),
            "pub fn addNumbers(a: i32, b: i32) -> i32 { a + b }\n",
        )
        .unwrap();

        let (tree_and_rag, stats) = query_knowledge(
            &dir.to_string_lossy(),
            "",
            "hybrid",
            "verify jwt token",
            3,
            4000,
        )
        .unwrap();

        assert_eq!(stats.total_files, 2);
        assert!(tree_and_rag.contains("AuthManager"));
        assert!(tree_and_rag.contains("verifyJwtToken"));
        assert!(tree_and_rag.contains("src/auth.rs"));

        let _ = fs::remove_dir_all(&dir);
    }
}
