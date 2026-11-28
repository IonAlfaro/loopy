use serde::Deserialize;
use serde_json::Value;
use std::fmt::Write as _;
use std::io::Write as _;
use std::path::Path;
use std::time::Duration;
use tempfile::NamedTempFile;
use zip::{write::SimpleFileOptions, ZipWriter};

#[derive(Deserialize)]
struct Report {
    title: String,
    sections: Vec<Section>,
}

#[derive(Deserialize)]
struct Section {
    #[serde(default)]
    heading: String,
    #[serde(default)]
    paragraphs: Vec<String>,
    #[serde(default)]
    table: Option<Table>,
}

#[derive(Deserialize)]
struct Table {
    headers: Vec<String>,
    rows: Vec<Vec<String>>,
}

pub(crate) async fn create_report(
    workspace: &str,
    path: &str,
    format: &str,
    content: Value,
) -> Result<String, String> {
    if !Path::new(path)
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case(format))
    {
        return Err(format!("La ruta de salida debe terminar en .{format}."));
    }
    let report: Report = serde_json::from_value(content)
        .map_err(|error| format!("Informe JSON inválido: {error}"))?;
    for table in report
        .sections
        .iter()
        .filter_map(|section| section.table.as_ref())
    {
        if table.headers.is_empty()
            || table
                .rows
                .iter()
                .any(|row| row.len() != table.headers.len())
        {
            return Err("Cada tabla necesita encabezados y filas del mismo ancho.".into());
        }
    }

    let target = super::resolve_safe_path(workspace, path)?;
    let parent = target
        .parent()
        .ok_or("La ruta necesita un directorio padre.")?;
    let mut staged = NamedTempFile::new_in(parent).map_err(|error| error.to_string())?;
    match format {
        "docx" => {
            staged = tokio::task::spawn_blocking(move || {
                write_word(staged.as_file_mut(), &report)?;
                Ok::<_, std::io::Error>(staged)
            })
            .await
            .map_err(|error| error.to_string())?
            .map_err(|error| format!("No se pudo generar Word: {error}"))?;
        }
        "pdf" => write_pdf(&mut staged, &report).await?,
        _ => return Err(format!("Formato de informe no admitido: {format}.")),
    }
    staged
        .persist_noclobber(&target)
        .map_err(|error| format!("No se pudo guardar el informe: {}", error.error))?;
    Ok(path.to_owned())
}

fn escape(text: &str) -> String {
    let mut escaped = String::new();
    for ch in text.chars() {
        match ch {
            '&' => escaped.push_str("&amp;"),
            '<' => escaped.push_str("&lt;"),
            '>' => escaped.push_str("&gt;"),
            '\0'..='\x08' | '\x0b' | '\x0c' | '\x0e'..='\x1f' | '\u{fffe}' | '\u{ffff}' => {
                escaped.push('\u{fffd}')
            }
            _ => escaped.push(ch),
        }
    }
    escaped
}

fn word_paragraph(xml: &mut String, text: &str, size: u32, bold: bool, outline: Option<u32>) {
    xml.push_str("<w:p>");
    if let Some(level) = outline {
        let _ = write!(
            xml,
            r#"<w:pPr><w:keepNext/><w:outlineLvl w:val="{level}"/></w:pPr>"#
        );
    }
    for (index, line) in text.split('\n').enumerate() {
        xml.push_str("<w:r><w:rPr>");
        if bold {
            xml.push_str("<w:b/>");
        }
        let _ = write!(xml, r#"<w:sz w:val="{size}"/></w:rPr>"#);
        if index > 0 {
            xml.push_str("<w:br/>");
        }
        for (tab_index, part) in line.trim_end_matches('\r').split('\t').enumerate() {
            if tab_index > 0 {
                xml.push_str("<w:tab/>");
            }
            let _ = write!(xml, r#"<w:t xml:space="preserve">{}</w:t>"#, escape(part));
        }
        xml.push_str("</w:r>");
    }
    xml.push_str("</w:p>");
}

fn word_row(xml: &mut String, cells: &[String], header: bool) {
    xml.push_str("<w:tr>");
    if header {
        xml.push_str("<w:trPr><w:tblHeader/></w:trPr>");
    }
    for text in cells {
        xml.push_str("<w:tc>");
        word_paragraph(xml, text, 22, header, None);
        xml.push_str("</w:tc>");
    }
    xml.push_str("</w:tr>");
}

fn write_word(file: &mut std::fs::File, report: &Report) -> std::io::Result<()> {
    let mut xml = String::from(
        r#"<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>"#,
    );
    word_paragraph(&mut xml, &report.title, 44, true, Some(0));
    for section in &report.sections {
        if !section.heading.is_empty() {
            word_paragraph(&mut xml, &section.heading, 28, true, Some(1));
        }
        for paragraph in &section.paragraphs {
            word_paragraph(&mut xml, paragraph, 22, false, None);
        }
        if let Some(table) = &section.table {
            xml.push_str(r#"<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/><w:tblBorders><w:top w:val="single" w:color="CBD5E1"/><w:left w:val="single" w:color="CBD5E1"/><w:bottom w:val="single" w:color="CBD5E1"/><w:right w:val="single" w:color="CBD5E1"/><w:insideH w:val="single" w:color="CBD5E1"/><w:insideV w:val="single" w:color="CBD5E1"/></w:tblBorders></w:tblPr><w:tblGrid>"#);
            for _ in &table.headers {
                xml.push_str("<w:gridCol/>");
            }
            xml.push_str("</w:tblGrid>");
            word_row(&mut xml, &table.headers, true);
            for row in &table.rows {
                word_row(&mut xml, row, false);
            }
            xml.push_str("</w:tbl>");
        }
    }
    xml.push_str(r#"<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="0" w:footer="0" w:gutter="0"/></w:sectPr></w:body></w:document>"#);
    let mut zip = ZipWriter::new(file);
    let options = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    for (name, data) in [
        (
            "[Content_Types].xml",
            r#"<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>"#,
        ),
        (
            "_rels/.rels",
            r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>"#,
        ),
        ("word/document.xml", &xml),
    ] {
        zip.start_file(name, options)?;
        zip.write_all(data.as_bytes())?;
    }
    zip.finish()?;
    Ok(())
}

fn report_html(report: &Report) -> String {
    let mut html = String::from(
        r#"<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>
@page { size: A4; margin: 20mm; }
body { font: 11pt/1.5 system-ui, sans-serif; color: #172333; overflow-wrap: anywhere; }
h1, h2 { break-after: avoid; line-height: 1.2; }
h1 { font-size: 23pt; } h2 { font-size: 15pt; margin-top: 1.4em; }
p, td, th { white-space: pre-wrap; }
table { width: 100%; table-layout: fixed; border-collapse: collapse; margin: 1em 0; }
th, td { border: 1px solid #b5c4d4; padding: 6px; text-align: left; vertical-align: top; }
thead { display: table-header-group; }
</style></head><body>"#,
    );
    let _ = write!(html, "<h1>{}</h1>", escape(&report.title));
    for section in &report.sections {
        if !section.heading.is_empty() {
            let _ = write!(html, "<h2>{}</h2>", escape(&section.heading));
        }
        for paragraph in &section.paragraphs {
            let _ = write!(html, "<p>{}</p>", escape(paragraph));
        }
        if let Some(table) = &section.table {
            html.push_str("<table><thead><tr>");
            for header in &table.headers {
                let _ = write!(html, "<th>{}</th>", escape(header));
            }
            html.push_str("</tr></thead><tbody>");
            for row in &table.rows {
                html.push_str("<tr>");
                for cell in row {
                    let _ = write!(html, "<td>{}</td>", escape(cell));
                }
                html.push_str("</tr>");
            }
            html.push_str("</tbody></table>");
        }
    }
    html.push_str("</body></html>");
    html
}

async fn write_pdf(staged: &mut NamedTempFile, report: &Report) -> Result<(), String> {
    let browser = super::browser::find_system_browser()
        .ok_or("Instala Chrome, Chromium o Edge para generar PDF.")?;
    let temp = tempfile::tempdir().map_err(|error| error.to_string())?;
    let html = temp.path().join("report.html");
    let pdf = temp.path().join("report.pdf");
    let profile = temp.path().join("profile");
    tokio::fs::write(&html, report_html(report))
        .await
        .map_err(|error| error.to_string())?;
    let html_url =
        reqwest::Url::from_file_path(&html).map_err(|_| "Ruta temporal HTML inválida.")?;

    let mut command = tokio::process::Command::new(browser);
    command
        .kill_on_drop(true)
        .args([
            "--headless",
            "--no-first-run",
            "--disable-background-networking",
            "--no-pdf-header-footer",
        ])
        .arg(format!("--user-data-dir={}", profile.display()))
        .arg(format!("--print-to-pdf={}", pdf.display()))
        .arg(html_url.as_str());
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let output = tokio::time::timeout(Duration::from_secs(45), command.output())
        .await
        .map_err(|_| "Se agotó el tiempo al generar el PDF.")?
        .map_err(|error| format!("No se pudo iniciar el navegador para exportar PDF: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "El navegador no pudo generar el PDF: {}",
            output.status
        ));
    }
    let bytes = tokio::fs::read(&pdf)
        .await
        .map_err(|error| format!("El navegador no produjo el PDF: {error}"))?;
    if !bytes.starts_with(b"%PDF-") {
        return Err("El navegador no produjo un PDF válido.".into());
    }
    staged.write_all(&bytes).map_err(|error| error.to_string())
}
