use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use std::fs::{self, File};
use std::io::Write;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HfModelRepo {
    pub id: String,
    pub downloads: u64,
    pub likes: u64,
    pub last_modified: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HfGgufFile {
    pub filename: String,
    pub size_bytes: u64,
    pub download_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelDownloadEvent {
    pub repo_id: String,
    pub filename: String,
    pub downloaded_bytes: u64,
    pub total_bytes: Option<u64>,
    pub percent: Option<f32>,
    pub stage: String,
    pub message: String,
}

#[derive(Debug, Deserialize)]
struct HfApiModel {
    id: String,
    #[serde(default)]
    downloads: u64,
    #[serde(default)]
    likes: u64,
    #[serde(default, rename = "lastModified")]
    last_modified: Option<String>,
}

#[derive(Debug, Deserialize)]
struct HfTreeEntry {
    #[serde(rename = "type")]
    entry_type: String,
    path: String,
    #[serde(default)]
    size: u64,
    lfs: Option<HfLfsInfo>,
}

#[derive(Debug, Deserialize)]
struct HfLfsInfo {
    size: u64,
}

pub fn models_dir() -> PathBuf {
    dirs::data_local_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("loopy")
        .join("models")
}

pub async fn search_hf_models(query: &str, sort: Option<&str>) -> Result<Vec<HfModelRepo>, String> {
    let client = reqwest::Client::builder()
        .user_agent("loopy-studio/0.1")
        .build()
        .map_err(|e| format!("Error creating HTTP client: {e}"))?;

    let sort_key = match sort.unwrap_or("trendingScore") {
        "downloads" => "downloads",
        "likes" => "likes",
        "lastModified" => "lastModified",
        _ => "trendingScore",
    };

    let mut req = client
        .get("https://huggingface.co/api/models")
        .query(&[
            ("filter", "gguf"),
            ("sort", sort_key),
            ("direction", "-1"),
            ("limit", "24"),
        ]);

    let trimmed = query.trim();
    if !trimmed.is_empty() {
        req = req.query(&[("search", trimmed)]);
    }

    let repos: Vec<HfApiModel> = req
        .send()
        .await
        .map_err(|e| format!("Error querying Hugging Face: {e}"))?
        .error_for_status()
        .map_err(|e| format!("Hugging Face returned HTTP error: {e}"))?
        .json()
        .await
        .map_err(|e| format!("Error reading Hugging Face response: {e}"))?;

    Ok(repos
        .into_iter()
        .map(|r| HfModelRepo {
            id: r.id,
            downloads: r.downloads,
            likes: r.likes,
            last_modified: r.last_modified,
        })
        .collect())
}

pub async fn list_hf_gguf_files(repo_id: &str) -> Result<Vec<HfGgufFile>, String> {
    let client = reqwest::Client::builder()
        .user_agent("loopy-studio/0.1")
        .build()
        .map_err(|e| format!("Error creando cliente HTTP: {e}"))?;

    let url = format!("https://huggingface.co/api/models/{repo_id}/tree/main");
    let entries: Vec<HfTreeEntry> = client
        .get(&url)
        .query(&[("recursive", "true")])
        .send()
        .await
        .map_err(|e| format!("Error listando archivos de '{repo_id}': {e}"))?
        .error_for_status()
        .map_err(|e| format!("Error HTTP listando '{repo_id}': {e}"))?
        .json()
        .await
        .map_err(|e| format!("Error parseando árbol de archivos: {e}"))?;

    let mut files: Vec<HfGgufFile> = entries
        .into_iter()
        .filter(|e| {
            e.entry_type == "file" && e.path.to_lowercase().ends_with(".gguf")
        })
        .map(|e| {
            let size_bytes = e.lfs.map(|l| l.size).unwrap_or(e.size);
            let download_url = format!(
                "https://huggingface.co/{repo_id}/resolve/main/{}",
                e.path
            );
            HfGgufFile {
                filename: e.path,
                size_bytes,
                download_url,
            }
        })
        .collect();

    files.sort_by_key(|f| f.size_bytes);
    Ok(files)
}

pub async fn download_hf_model<F>(
    repo_id: &str,
    filename: &str,
    on_progress: F,
) -> Result<String, String>
where
    F: Fn(ModelDownloadEvent) + Send + Sync,
{
    let dest_dir = models_dir();
    fs::create_dir_all(&dest_dir)
        .map_err(|e| format!("No se pudo crear carpeta de modelos: {e}"))?;

    let safe_file = filename.replace('/', "_").replace('\\', "_");
    let final_path = dest_dir.join(&safe_file);
    let part_path = dest_dir.join(format!("{safe_file}.part"));

    let url = format!("https://huggingface.co/{repo_id}/resolve/main/{filename}");
    on_progress(ModelDownloadEvent {
        repo_id: repo_id.to_string(),
        filename: filename.to_string(),
        downloaded_bytes: 0,
        total_bytes: None,
        percent: Some(0.0),
        stage: "starting".into(),
        message: format!("Conectando con Hugging Face para descargar {filename}..."),
    });

    let client = reqwest::Client::builder()
        .user_agent("loopy-studio/0.1")
        .build()
        .map_err(|e| format!("Error creando cliente HTTP: {e}"))?;

    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Error descargando modelo: {e}"))?
        .error_for_status()
        .map_err(|e| format!("Hugging Face devolvió error HTTP: {e}"))?;

    let total = resp.content_length();
    let mut file = File::create(&part_path)
        .map_err(|e| format!("No se pudo crear archivo temporal: {e}"))?;
    let mut stream = resp.bytes_stream();
    let mut downloaded: u64 = 0;
    let mut last_reported: u64 = 0;

    while let Some(chunk) = stream.next().await {
        let bytes = chunk.map_err(|e| format!("Error leyendo descarga del modelo: {e}"))?;
        file.write_all(&bytes)
            .map_err(|e| format!("Error escribiendo modelo en disco: {e}"))?;
        downloaded += bytes.len() as u64;

        if downloaded - last_reported >= 2 * 1024 * 1024 || total == Some(downloaded) {
            last_reported = downloaded;
            let pct = total.map(|t| {
                if t > 0 {
                    (downloaded as f32 / t as f32) * 100.0
                } else {
                    0.0
                }
            });
            on_progress(ModelDownloadEvent {
                repo_id: repo_id.to_string(),
                filename: filename.to_string(),
                downloaded_bytes: downloaded,
                total_bytes: total,
                percent: pct,
                stage: "downloading".into(),
                message: format!(
                    "Descargando {filename}: {:.1} MB{}",
                    downloaded as f64 / (1024.0 * 1024.0),
                    total
                        .map(|t| format!(" / {:.1} MB", t as f64 / (1024.0 * 1024.0)))
                        .unwrap_or_default()
                ),
            });
        }
    }

    drop(file);
    fs::rename(&part_path, &final_path)
        .map_err(|e| format!("Error finalizando archivo GGUF: {e}"))?;

    let final_str = final_path.to_string_lossy().to_string();
    on_progress(ModelDownloadEvent {
        repo_id: repo_id.to_string(),
        filename: filename.to_string(),
        downloaded_bytes: downloaded,
        total_bytes: total,
        percent: Some(100.0),
        stage: "done".into(),
        message: format!("Modelo descargado en {final_str}"),
    });

    Ok(final_str)
}
