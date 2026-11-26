use regex::Regex;
use std::fs::{self, File};
use std::io::Read;
use std::path::Path;
use zip::ZipArchive;

/// Extracts readable text/Markdown from document formats (.pdf, .docx, .xlsx, .pptx, .odt, .epub)
/// or reads plain UTF-8 text files directly.
pub async fn read_document_or_text(path: &Path) -> Result<String, String> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_lowercase())
        .unwrap_or_default();

    match ext.as_str() {
        "docx" => extract_docx(path),
        "odt" => extract_odt(path),
        "xlsx" => extract_xlsx(path),
        "pptx" => extract_pptx(path),
        "epub" => extract_epub(path),
        "pdf" => extract_pdf(path).await,
        _ => fs::read_to_string(path).map_err(|e| format!("Error leyendo archivo: {e}")),
    }
}

fn decode_xml_entities(input: &str) -> String {
    input
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&#39;", "'")
        .replace("&#10;", "\n")
        .replace("&#13;", "")
        .replace("&nbsp;", " ")
}

fn extract_docx(path: &Path) -> Result<String, String> {
    let file = File::open(path).map_err(|e| format!("No se pudo abrir DOCX: {e}"))?;
    let mut archive = ZipArchive::new(file).map_err(|e| format!("DOCX ZIP inválido: {e}"))?;
    let mut doc = archive
        .by_name("word/document.xml")
        .map_err(|_| "El DOCX no contiene word/document.xml".to_string())?;
    let mut xml = String::new();
    doc.read_to_string(&mut xml)
        .map_err(|e| format!("Error leyendo XML del DOCX: {e}"))?;

    let xml = xml
        .replace("</w:p>", "\n")
        .replace("<w:br/>", "\n")
        .replace("<w:br />", "\n")
        .replace("</w:tc>", " | ")
        .replace("<w:tab/>", "\t");
    let re_tags = Regex::new(r"<[^>]+>").unwrap();
    let stripped = re_tags.replace_all(&xml, "");
    let decoded = decode_xml_entities(&stripped);
    let cleaned: Vec<&str> = decoded
        .lines()
        .map(|l| l.trim_end())
        .filter(|l| !l.trim().is_empty())
        .collect();
    Ok(cleaned.join("\n"))
}

fn extract_odt(path: &Path) -> Result<String, String> {
    let file = File::open(path).map_err(|e| format!("No se pudo abrir ODT: {e}"))?;
    let mut archive = ZipArchive::new(file).map_err(|e| format!("ODT ZIP inválido: {e}"))?;
    let mut doc = archive
        .by_name("content.xml")
        .map_err(|_| "El ODT no contiene content.xml".to_string())?;
    let mut xml = String::new();
    doc.read_to_string(&mut xml)
        .map_err(|e| format!("Error leyendo content.xml de ODT: {e}"))?;

    let xml = xml
        .replace("</text:p>", "\n")
        .replace("</text:h>", "\n")
        .replace("<text:line-break/>", "\n")
        .replace("</table:table-cell>", " | ");
    let re_tags = Regex::new(r"<[^>]+>").unwrap();
    let stripped = re_tags.replace_all(&xml, "");
    let decoded = decode_xml_entities(&stripped);
    Ok(decoded
        .lines()
        .map(|l| l.trim_end())
        .filter(|l| !l.trim().is_empty())
        .collect::<Vec<_>>()
        .join("\n"))
}

fn extract_xlsx(path: &Path) -> Result<String, String> {
    let file = File::open(path).map_err(|e| format!("No se pudo abrir XLSX: {e}"))?;
    let mut archive = ZipArchive::new(file).map_err(|e| format!("XLSX ZIP inválido: {e}"))?;

    // Load shared strings if present
    let mut shared: Vec<String> = Vec::new();
    if let Ok(mut ss_file) = archive.by_name("xl/sharedStrings.xml") {
        let mut ss_xml = String::new();
        if ss_file.read_to_string(&mut ss_xml).is_ok() {
            let re_si = Regex::new(r"(?s)<si[^>]*>(.*?)</si>").unwrap();
            let re_t = Regex::new(r"(?s)<t[^>]*>(.*?)</t>").unwrap();
            for cap in re_si.captures_iter(&ss_xml) {
                let mut val = String::new();
                for tcap in re_t.captures_iter(&cap[1]) {
                    val.push_str(&decode_xml_entities(&tcap[1]));
                }
                shared.push(val);
            }
        }
    }

    let mut sheet_names: Vec<String> = (0..archive.len())
        .filter_map(|i| archive.by_index(i).ok().map(|f| f.name().to_string()))
        .filter(|name| name.starts_with("xl/worksheets/sheet") && name.ends_with(".xml"))
        .collect();
    sheet_names.sort();

    if sheet_names.is_empty() {
        return Err("No se encontraron hojas xl/worksheets/sheet*.xml en el XLSX.".to_string());
    }

    let re_row = Regex::new(r"(?s)<row[^>]*>(.*?)</row>").unwrap();
    let re_cell = Regex::new(r#"(?s)<c\b([^>]*)>(.*?)</c>"#).unwrap();
    let re_v = Regex::new(r"(?s)<v>(.*?)</v>").unwrap();
    let re_is = Regex::new(r"(?s)<t[^>]*>(.*?)</t>").unwrap();
    let re_type_s = Regex::new(r#"t\s*=\s*["']s["']"#).unwrap();

    let mut out = String::new();
    for sname in sheet_names {
        let Ok(mut sf) = archive.by_name(&sname) else {
            continue;
        };
        let mut sxml = String::new();
        if sf.read_to_string(&mut sxml).is_err() {
            continue;
        }
        let label = sname.trim_start_matches("xl/worksheets/").trim_end_matches(".xml");
        out.push_str(&format!("## {label}\n"));
        for rcap in re_row.captures_iter(&sxml) {
            let mut cells = Vec::new();
            for ccap in re_cell.captures_iter(&rcap[1]) {
                let attrs = &ccap[1];
                let inner = &ccap[2];
                let cell_val = if re_type_s.is_match(attrs) {
                    re_v.captures(inner)
                        .and_then(|vc| vc[1].trim().parse::<usize>().ok())
                        .and_then(|idx| shared.get(idx))
                        .cloned()
                        .unwrap_or_default()
                } else if let Some(vc) = re_v.captures(inner) {
                    decode_xml_entities(vc[1].trim())
                } else {
                    re_is
                        .captures_iter(inner)
                        .map(|tc| decode_xml_entities(&tc[1]))
                        .collect::<String>()
                };
                cells.push(cell_val.replace('\n', " "));
            }
            if cells.iter().any(|c| !c.trim().is_empty()) {
                out.push_str(&format!("| {} |\n", cells.join(" | ")));
            }
        }
        out.push('\n');
    }
    Ok(out.trim().to_string())
}

fn extract_pptx(path: &Path) -> Result<String, String> {
    let file = File::open(path).map_err(|e| format!("No se pudo abrir PPTX: {e}"))?;
    let mut archive = ZipArchive::new(file).map_err(|e| format!("PPTX ZIP inválido: {e}"))?;
    let mut slide_names: Vec<String> = (0..archive.len())
        .filter_map(|i| archive.by_index(i).ok().map(|f| f.name().to_string()))
        .filter(|n| n.starts_with("ppt/slides/slide") && n.ends_with(".xml"))
        .collect();
    slide_names.sort_by_key(|n| {
        n.trim_start_matches("ppt/slides/slide")
            .trim_end_matches(".xml")
            .parse::<usize>()
            .unwrap_or(9999)
    });

    let re_t = Regex::new(r"(?s)<a:t[^>]*>(.*?)</a:t>").unwrap();
    let re_p = Regex::new(r"(?s)<a:p\b[^>]*>(.*?)</a:p>").unwrap();
    let mut out = String::new();

    for (idx, sname) in slide_names.iter().enumerate() {
        let Ok(mut sf) = archive.by_name(sname) else {
            continue;
        };
        let mut sxml = String::new();
        if sf.read_to_string(&mut sxml).is_err() {
            continue;
        }
        out.push_str(&format!("## Slide {}\n", idx + 1));
        for pcap in re_p.captures_iter(&sxml) {
            let line: String = re_t
                .captures_iter(&pcap[1])
                .map(|c| decode_xml_entities(&c[1]))
                .collect();
            if !line.trim().is_empty() {
                out.push_str(line.trim());
                out.push('\n');
            }
        }
        out.push('\n');
    }
    Ok(out.trim().to_string())
}

fn extract_epub(path: &Path) -> Result<String, String> {
    let file = File::open(path).map_err(|e| format!("No se pudo abrir EPUB: {e}"))?;
    let mut archive = ZipArchive::new(file).map_err(|e| format!("EPUB ZIP inválido: {e}"))?;
    let mut html_files: Vec<String> = (0..archive.len())
        .filter_map(|i| archive.by_index(i).ok().map(|f| f.name().to_string()))
        .filter(|n| n.ends_with(".xhtml") || n.ends_with(".html") || n.ends_with(".htm"))
        .collect();
    html_files.sort();

    let mut out = String::new();
    for hf in html_files {
        let Ok(mut entry) = archive.by_name(&hf) else {
            continue;
        };
        let mut raw = String::new();
        if entry.read_to_string(&mut raw).is_ok() {
            let md = html_to_clean_markdown(&raw);
            if !md.trim().is_empty() {
                out.push_str(&md);
                out.push_str("\n\n");
            }
        }
        if out.len() > 250_000 {
            break;
        }
    }
    Ok(out.trim().to_string())
}

async fn extract_pdf(path: &Path) -> Result<String, String> {
    let raw_bytes = fs::read(path).map_err(|e| format!("Error leyendo PDF: {e}"))?;
    let raw_lossy = String::from_utf8_lossy(&raw_bytes);
    let pure_rust_txt = extract_pdf_bt_et(&raw_lossy);

    if pure_rust_txt.trim().len() >= 80 {
        return Ok(pure_rust_txt);
    }

    // Fallback: Python extractor supporting pypdf / fitz / pdfplumber / stdlib zlib FlateDecode streams
    let py_script = r#"import sys, re, zlib
p = sys.argv[1]
try:
    import fitz
    doc = fitz.open(p)
    print("\n".join(page.get_text() for page in doc))
    sys.exit(0)
except Exception:
    pass
try:
    from pypdf import PdfReader
    r = PdfReader(p)
    print("\n".join((page.extract_text() or "") for page in r.pages))
    sys.exit(0)
except Exception:
    pass
data = open(p, "rb").read()
out = []
for m in re.finditer(rb"stream\r?\n(.*?)\r?\nendstream", data, re.S):
    chunk = m.group(1)
    try:
        chunk = zlib.decompress(chunk)
    except Exception:
        pass
    txt = chunk.decode("latin-1", errors="ignore")
    for bt in re.finditer(r"BT(.*?)ET", txt, re.S):
        parts = re.findall(r"\(([^()\\]*(?:\\.[^()\\]*)*)\)", bt.group(1))
        if parts:
            line = "".join(parts).replace("\\n", "\n").replace("\\r", "").replace("\\(", "(").replace("\\)", ")")
            out.append(line)
print("\n".join(out))"#;

    let mut cmd = tokio::process::Command::new("python");
    cmd.arg("-c")
        .arg(py_script)
        .arg(path)
        .kill_on_drop(true);
    if let Ok(out) = tokio::time::timeout(std::time::Duration::from_secs(15), cmd.output()).await {
        if let Ok(o) = out {
            let txt = String::from_utf8_lossy(&o.stdout).trim().to_string();
            if !txt.is_empty() {
                return Ok(txt);
            }
        }
    }

    if !pure_rust_txt.trim().is_empty() {
        Ok(pure_rust_txt)
    } else {
        Err("El PDF está comprimido o basado en imágenes escaneadas; no se pudo extraer texto plano sin pypdf/PyMuPDF.".to_string())
    }
}

fn extract_pdf_bt_et(raw: &str) -> String {
    let re_bt = Regex::new(r"(?s)BT(.*?)ET").unwrap();
    let re_str = Regex::new(r"\(([^()\\]*(?:\\.[^()\\]*)*)\)").unwrap();
    let mut lines = Vec::new();
    for bt in re_bt.captures_iter(raw) {
        let mut block = String::new();
        for s in re_str.captures_iter(&bt[1]) {
            let clean = s[1]
                .replace("\\n", "\n")
                .replace("\\r", "")
                .replace("\\(", "(")
                .replace("\\)", ")")
                .replace("\\\\", "\\");
            block.push_str(&clean);
        }
        if !block.trim().is_empty() {
            lines.push(block.trim().to_string());
        }
    }
    lines.join("\n")
}

/// Extracts key article metadata (`og:image`, `twitter:image`, published date, and up to 4
/// direct HTTPS image URLs) from raw HTML before it is stripped to Markdown.
pub fn extract_html_page_meta(html: &str) -> String {
    let mut lines: Vec<String> = Vec::new();
    let mut seen_imgs: Vec<String> = Vec::new();

    // 1. <meta property="og:image" content="..."> or <meta name="twitter:image" content="...">
    let re_meta = Regex::new(r#"(?is)<meta\b[^>]*>"#).unwrap();
    let re_prop = Regex::new(r#"(?is)\b(?:property|name)\s*=\s*(?:"([^"]*)"|'([^']*)')"#).unwrap();
    let re_content = Regex::new(r#"(?is)\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)')"#).unwrap();

    let mut published_date: Option<String> = None;

    for m in re_meta.find_iter(html) {
        let tag = m.as_str();
        let prop = re_prop
            .captures(tag)
            .and_then(|c| c.get(1).or_else(|| c.get(2)))
            .map(|x| x.as_str().trim().to_lowercase())
            .unwrap_or_default();
        let content = re_content
            .captures(tag)
            .and_then(|c| c.get(1).or_else(|| c.get(2)))
            .map(|x| decode_xml_entities(x.as_str().trim()))
            .unwrap_or_default();
        if content.is_empty() {
            continue;
        }
        if (prop == "og:image" || prop == "og:image:secure_url" || prop == "twitter:image" || prop == "twitter:image:src")
            && content.starts_with("http")
            && !content.to_lowercase().contains("/thumb/")
            && !seen_imgs.contains(&content)
        {
            seen_imgs.push(content.clone());
            lines.push(format!("- {prop}: {content}"));
        } else if published_date.is_none()
            && (prop == "article:published_time" || prop == "pubdate" || prop == "publishdate" || prop == "date")
        {
            published_date = Some(content);
        }
    }

    // 2. Fallback: JSON-LD "datePublished":"YYYY-MM-DD..."
    if published_date.is_none() {
        let re_ld_date = Regex::new(r#""datePublished"\s*:\s*"([^"]{8,40})""#).unwrap();
        if let Some(cap) = re_ld_date.captures(html) {
            published_date = Some(cap[1].to_string());
        }
    }
    if let Some(dt) = published_date {
        lines.insert(0, format!("- published: {dt}"));
    }

    // 3. Direct HTTPS <img src="..."> URLs with image extensions (skip icons/logos/thumbs)
    let re_img = Regex::new(
        r#"(?is)<img\b[^>]*\b(?:src|data-src)\s*=\s*(?:"(https?://[^"]+)"|'(https?://[^']+)')"#,
    )
    .unwrap();
    let mut extra_imgs = Vec::new();
    for cap in re_img.captures_iter(html) {
        let raw_u = cap
            .get(1)
            .or_else(|| cap.get(2))
            .map(|m| decode_xml_entities(m.as_str().trim()))
            .unwrap_or_default();
        let low = raw_u.to_lowercase();
        let path_part = low.split('?').next().unwrap_or(&low);
        let has_img_ext = path_part.ends_with(".jpg")
            || path_part.ends_with(".jpeg")
            || path_part.ends_with(".png")
            || path_part.ends_with(".webp")
            || path_part.ends_with(".avif");
        if !has_img_ext
            || low.contains("/thumb/")
            || low.contains("favicon")
            || low.contains("logo")
            || low.contains("avatar")
            || low.contains("icon")
            || low.contains("1x1")
            || seen_imgs.contains(&raw_u)
        {
            continue;
        }
        seen_imgs.push(raw_u.clone());
        extra_imgs.push(raw_u);
        if extra_imgs.len() >= 4 {
            break;
        }
    }
    for u in extra_imgs {
        lines.push(format!("- img: {u}"));
    }

    if lines.is_empty() {
        String::new()
    } else {
        format!("[Metadatos e imágenes de la página]\n{}\n\n", lines.join("\n"))
    }
}

/// Converts HTML to clean Markdown preserving `<a href="...">text</a>` links
/// (decoding DuckDuckGo `uddg=` redirect links) and basic paragraph structure.
pub fn html_to_clean_markdown(html: &str) -> String {
    // Drop script, style, svg, noscript blocks cleanly
    let re_noise =
        Regex::new(r"(?is)<(script|style|svg|noscript)\b[^>]*>.*?</(script|style|svg|noscript)>")
            .unwrap();
    let no_noise = re_noise.replace_all(html, " ");

    // Convert <a href="URL">TEXT</a> -> [TEXT](URL)
    let re_link = Regex::new(r#"(?is)<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>(.*?)</a>"#)
        .unwrap();
    let re_tags = Regex::new(r"<[^>]+>").unwrap();

    let with_links = re_link.replace_all(&no_noise, |caps: &regex::Captures| {
        let raw_href = caps
            .get(1)
            .or_else(|| caps.get(2))
            .map(|m| m.as_str())
            .unwrap_or("")
            .trim();
        let inner_raw = re_tags.replace_all(&caps[3], " ");
        let inner = decode_xml_entities(inner_raw.trim())
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        let clean_url = normalize_search_href(raw_href);
        if clean_url.is_empty() || clean_url.starts_with('#') || clean_url.starts_with("javascript:") {
            inner
        } else if inner.is_empty() {
            clean_url
        } else {
            format!("[{inner}]({clean_url})")
        }
    });

    // Preserve newlines at block boundaries
    let re_blocks =
        Regex::new(r"(?i)</?(p|div|li|tr|h[1-6]|br|section|article|blockquote)\b[^>]*>").unwrap();
    let blocked = re_blocks.replace_all(&with_links, "\n");
    let stripped = re_tags.replace_all(&blocked, " ");
    let decoded = decode_xml_entities(&stripped);

    let mut out_lines = Vec::new();
    for line in decoded.lines() {
        let compact = line.split_whitespace().collect::<Vec<_>>().join(" ");
        if !compact.is_empty() {
            out_lines.push(compact);
        }
    }
    out_lines.join("\n")
}

fn normalize_search_href(href: &str) -> String {
    let h = decode_xml_entities(href.trim());
    let full = if h.starts_with("//") {
        format!("https:{h}")
    } else {
        h
    };
    if let Some(idx) = full.find("uddg=") {
        let after = &full[idx + 5..];
        let encoded = after.split('&').next().unwrap_or(after);
        return percent_decode(encoded);
    }
    full
}

fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(hex_str) = std::str::from_utf8(&bytes[i + 1..i + 3]) {
                if let Ok(val) = u8::from_str_radix(hex_str, 16) {
                    out.push(val);
                    i += 3;
                    continue;
                }
            }
        } else if bytes[i] == b'+' {
            out.push(b' ');
            i += 1;
            continue;
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn html_to_markdown_keeps_links_and_decodes_ddg_uddg() {
        let html = r#"<div><a class="result-link" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Ftienda.es%2Fcafetera&amp;rut=1">Cafetera Express 89 EUR</a></div>"#;
        let md = html_to_clean_markdown(html);
        assert!(md.contains("[Cafetera Express 89 EUR](https://tienda.es/cafetera)"));
    }

    #[test]
    fn extracts_og_image_and_published_date_from_html() {
        let html = r#"<html><head>
            <meta property="article:published_time" content="2026-11-25T08:00:00Z" />
            <meta property="og:image" content="https://cdn.example.com/news/tiangong.jpg" />
        </head><body><img src="https://cdn.example.com/photo/crew.webp" /></body></html>"#;
        let meta = extract_html_page_meta(html);
        assert!(meta.contains("2026-11-25T08:00:00Z"));
        assert!(meta.contains("https://cdn.example.com/news/tiangong.jpg"));
        assert!(meta.contains("https://cdn.example.com/photo/crew.webp"));
    }

    #[tokio::test]
    async fn extracts_docx_xml_paragraphs() {
        let p = std::env::temp_dir().join(format!(
            "loors-docx-test-{}.docx",
            SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()
        ));
        {
            let f = File::create(&p).unwrap();
            let mut zw = zip::ZipWriter::new(f);
            let opts = zip::write::SimpleFileOptions::default();
            zw.start_file("word/document.xml", opts).unwrap();
            zw.write_all(
                br#"<w:document><w:body><w:p><w:r><w:t>Contrato Alfa</w:t></w:r></w:p><w:p><w:r><w:t>Importe: 500 &amp; IVA</w:t></w:r></w:p></w:body></w:document>"#,
            )
            .unwrap();
            zw.finish().unwrap();
        }
        let text = read_document_or_text(&p).await.unwrap();
        assert!(text.contains("Contrato Alfa"));
        assert!(text.contains("Importe: 500 & IVA"));
        let _ = fs::remove_file(&p);
    }
}
