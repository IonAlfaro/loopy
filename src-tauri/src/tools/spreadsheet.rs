use serde_json::{Map, Value};
use std::collections::BTreeSet;
use std::io::{self, Write};
use std::path::Path;
use zip::{write::SimpleFileOptions, CompressionMethod, ZipWriter};

const CONTENT_TYPES: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>"#;
const PACKAGE_RELS: &str = r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>"#;
const WORKBOOK: &str = r#"<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<bookViews><workbookView/></bookViews>
<sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets>
</workbook>"#;
const WORKBOOK_RELS: &str = r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>"#;

#[derive(Clone, Copy)]
pub(crate) enum TableFormat {
    Excel,
    Csv,
}

pub(crate) async fn create_table(
    workspace: &str,
    path: &str,
    rows: Value,
    columns: Option<Value>,
    format: TableFormat,
) -> Result<String, String> {
    let extension = match format {
        TableFormat::Excel => "xlsx",
        TableFormat::Csv => "csv",
    };
    if !Path::new(path)
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case(extension))
    {
        return Err(format!("La ruta de salida debe terminar en .{extension}."));
    }
    let target = super::resolve_safe_path(workspace, path)?;
    let destination = target.clone();
    let staged = tokio::task::spawn_blocking(move || stage_table(&target, rows, columns, format))
        .await
        .map_err(|error| error.to_string())??;
    staged.persist_noclobber(destination).map_err(|error| {
        format!(
            "No se pudo guardar el archivo .{extension}: {}",
            error.error
        )
    })?;
    Ok(path.to_owned())
}

fn stage_table(
    path: &Path,
    rows: Value,
    columns: Option<Value>,
    format: TableFormat,
) -> Result<tempfile::NamedTempFile, String> {
    let rows = rows
        .as_array()
        .ok_or("Se esperaba una lista JSON de objetos.")?;
    if matches!(format, TableFormat::Excel) && rows.len() > 1_048_575 {
        return Err("Excel admite hasta 1.048.575 filas de datos con encabezado.".into());
    }
    let rows = rows
        .iter()
        .enumerate()
        .map(|(index, row)| {
            row.as_object()
                .ok_or_else(|| format!("La fila {} debe ser un objeto JSON.", index + 1))
        })
        .collect::<Result<Vec<_>, _>>()?;
    let mut columns = columns
        .map(serde_json::from_value::<Vec<String>>)
        .transpose()
        .map_err(|error| format!("Columnas inválidas: {error}"))?
        .unwrap_or_default();
    if columns.is_empty() {
        columns = rows
            .iter()
            .flat_map(|row| row.keys().cloned())
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect();
    }
    if matches!(format, TableFormat::Excel) && columns.len() > 16_384 {
        return Err("Excel admite hasta 16.384 columnas.".into());
    }
    if columns.iter().collect::<BTreeSet<_>>().len() != columns.len() {
        return Err("Las columnas deben ser únicas.".into());
    }

    let parent = path
        .parent()
        .ok_or("La ruta necesita un directorio padre.")?;
    let mut staged = tempfile::NamedTempFile::new_in(parent)
        .map_err(|error| format!("No se pudo preparar el archivo: {error}"))?;
    match format {
        TableFormat::Excel => write_workbook(staged.as_file_mut(), &rows, &columns),
        TableFormat::Csv => write_csv(staged.as_file_mut(), &rows, &columns),
    }
    .map_err(|error| format!("No se pudo generar el archivo: {error}"))?;
    Ok(staged)
}

fn write_csv(
    file: &mut std::fs::File,
    rows: &[&Map<String, Value>],
    columns: &[String],
) -> io::Result<()> {
    let mut writer = io::BufWriter::new(file);
    if !columns.is_empty() {
        write_csv_row(&mut writer, columns.iter().map(String::as_str))?;
        for row in rows {
            let values = columns.iter().map(|key| match row.get(key) {
                None | Some(Value::Null) => std::borrow::Cow::Borrowed(""),
                Some(Value::String(text)) => std::borrow::Cow::Borrowed(text.as_str()),
                Some(value) => std::borrow::Cow::Owned(value.to_string()),
            });
            write_csv_row(&mut writer, values)?;
        }
    }
    writer.flush()
}

fn write_csv_row(
    writer: &mut impl Write,
    fields: impl IntoIterator<Item = impl AsRef<str>>,
) -> io::Result<()> {
    for (index, field) in fields.into_iter().enumerate() {
        if index > 0 {
            writer.write_all(b",")?;
        }
        let field = field.as_ref();
        if field.is_empty() || field.contains([',', '"', '\r', '\n']) {
            write!(writer, "\"{}\"", field.replace('"', "\"\""))?;
        } else {
            writer.write_all(field.as_bytes())?;
        }
    }
    writer.write_all(b"\r\n")
}

fn write_workbook(
    file: &mut std::fs::File,
    rows: &[&Map<String, Value>],
    columns: &[String],
) -> io::Result<()> {
    let mut zip = ZipWriter::new(file);
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    for (name, content) in [
        ("[Content_Types].xml", CONTENT_TYPES),
        ("_rels/.rels", PACKAGE_RELS),
        ("xl/workbook.xml", WORKBOOK),
        ("xl/_rels/workbook.xml.rels", WORKBOOK_RELS),
    ] {
        zip.start_file(name, options)?;
        zip.write_all(content.as_bytes())?;
    }
    zip.start_file("xl/worksheets/sheet1.xml", options)?;
    write!(
        zip,
        r#"<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
<sheetData>"#
    )?;
    if !columns.is_empty() {
        write!(zip, "<row r=\"1\">")?;
        for column in columns {
            write_text(&mut zip, column)?;
        }
        write!(zip, "</row>")?;
    }
    for (index, row) in rows.iter().enumerate() {
        write!(zip, "<row r=\"{}\">", index + 2)?;
        for column in columns {
            match row.get(column) {
                Some(Value::Number(number)) => {
                    let text = number.to_string();
                    if (number.is_i64() || number.is_u64())
                        && text.trim_start_matches('-').len() > 15
                    {
                        write_text(&mut zip, &text)?;
                    } else {
                        write!(zip, "<c><v>{text}</v></c>")?;
                    }
                }
                Some(Value::Bool(value)) => {
                    write!(zip, "<c t=\"b\"><v>{}</v></c>", u8::from(*value))?
                }
                Some(Value::String(value)) => write_text(&mut zip, value)?,
                Some(Value::Array(_) | Value::Object(_)) => {
                    write_text(&mut zip, &row[column].to_string())?
                }
                None | Some(Value::Null) => write!(zip, "<c></c>")?,
            }
        }
        write!(zip, "</row>")?;
    }
    write!(zip, "</sheetData></worksheet>")?;
    zip.finish()?;
    Ok(())
}

fn write_text(writer: &mut impl Write, value: &str) -> io::Result<()> {
    if value.encode_utf16().count() > 32_767 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Una celda supera los 32.767 caracteres.",
        ));
    }
    write!(writer, r#"<c t="inlineStr"><is><t xml:space="preserve">"#)?;
    for (index, ch) in value.char_indices() {
        match ch {
            '&' => writer.write_all(b"&amp;")?,
            '<' => writer.write_all(b"&lt;")?,
            '>' => writer.write_all(b"&gt;")?,
            '\r' => writer.write_all(b"&#13;")?,
            '_' if value.as_bytes().get(index..index + 7).is_some_and(|part| {
                part[1] == b'x' && part[2..6].iter().all(u8::is_ascii_hexdigit) && part[6] == b'_'
            }) =>
            {
                writer.write_all(b"_x005F_")?
            }
            '\0'..='\x08' | '\x0b' | '\x0c' | '\x0e'..='\x1f' | '\u{fffe}' | '\u{ffff}' => {
                write!(writer, "_x{:04X}_", ch as u32)?;
            }
            _ => write!(writer, "{ch}")?,
        }
    }
    write!(writer, "</t></is></c>")
}
