use crate::hardware::{detect_hardware_profile, RuntimeBackendKind};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use std::fs::{self, File};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

const GITHUB_RELEASES_URL: &str =
    "https://api.github.com/repos/ggml-org/llama.cpp/releases?per_page=10";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RuntimeInstallInfo {
    pub backend: RuntimeBackendKind,
    pub version: String,
    pub binary_path: String,
    pub asset_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RuntimeStatusSnapshot {
    pub install_dir: String,
    pub installed: Vec<RuntimeInstallInfo>,
    #[serde(default)]
    pub custom_binary_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct CustomRuntimeConfig {
    binary_path: String,
}

fn custom_runtime_config_path() -> PathBuf {
    dirs::data_local_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("loors")
        .join("runtime_custom.json")
}

pub fn load_custom_runtime_path() -> Option<String> {
    let raw = fs::read_to_string(custom_runtime_config_path()).ok()?;
    let cfg: CustomRuntimeConfig = serde_json::from_str(&raw).ok()?;
    let trimmed = cfg.binary_path.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

pub fn save_custom_runtime_path(path: &str) -> Result<(), String> {
    let trimmed = path.trim();
    if !trimmed.is_empty() && !Path::new(trimmed).exists() {
        return Err(format!("El binario especificado no existe: {trimmed}"));
    }
    let cfg_path = custom_runtime_config_path();
    if let Some(parent) = cfg_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("No se pudo crear carpeta de configuración: {e}"))?;
    }
    let json = serde_json::to_string_pretty(&CustomRuntimeConfig {
        binary_path: trimmed.to_string(),
    })
    .map_err(|e| e.to_string())?;
    fs::write(cfg_path, json).map_err(|e| format!("No se pudo guardar runtime personalizado: {e}"))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RuntimeDownloadEvent {
    pub backend: RuntimeBackendKind,
    pub stage: String,
    pub downloaded_bytes: u64,
    pub total_bytes: Option<u64>,
    pub percent: Option<f32>,
    pub message: String,
}

#[derive(Debug, Deserialize)]
struct GithubRelease {
    tag_name: String,
    #[serde(default)]
    draft: bool,
    assets: Vec<GithubAsset>,
}

#[derive(Debug, Clone, Deserialize)]
struct GithubAsset {
    name: String,
    browser_download_url: String,
    size: u64,
}

pub fn runtimes_base_dir() -> PathBuf {
    dirs::data_local_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("loors")
        .join("runtimes")
}

pub fn backend_key(backend: &RuntimeBackendKind) -> &'static str {
    match backend {
        RuntimeBackendKind::Auto => "auto",
        RuntimeBackendKind::Cuda => "cuda",
        RuntimeBackendKind::Vulkan => "vulkan",
        RuntimeBackendKind::Metal => "metal",
        RuntimeBackendKind::Cpu => "cpu",
    }
}

pub fn resolve_backend(requested: RuntimeBackendKind) -> RuntimeBackendKind {
    if requested == RuntimeBackendKind::Auto {
        detect_hardware_profile().recommended_backend
    } else {
        requested
    }
}

pub fn get_runtime_status() -> RuntimeStatusSnapshot {
    let base = runtimes_base_dir();
    let mut installed = Vec::new();

    for kind in [
        RuntimeBackendKind::Cuda,
        RuntimeBackendKind::Vulkan,
        RuntimeBackendKind::Metal,
        RuntimeBackendKind::Cpu,
    ] {
        let manifest_path = base.join(backend_key(&kind)).join("manifest.json");
        if let Ok(raw) = fs::read_to_string(&manifest_path) {
            if let Ok(info) = serde_json::from_str::<RuntimeInstallInfo>(&raw) {
                if Path::new(&info.binary_path).exists() {
                    installed.push(info);
                }
            }
        }
    }

    RuntimeStatusSnapshot {
        install_dir: base.to_string_lossy().to_string(),
        installed,
        custom_binary_path: load_custom_runtime_path(),
    }
}

pub fn find_installed_binary(requested: RuntimeBackendKind) -> Option<RuntimeInstallInfo> {
    if let Some(custom_path) = load_custom_runtime_path() {
        if Path::new(&custom_path).exists() {
            let asset_name = Path::new(&custom_path)
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("custom-runtime")
                .to_string();
            return Some(RuntimeInstallInfo {
                backend: resolve_backend(requested),
                version: "custom".to_string(),
                binary_path: custom_path,
                asset_name,
            });
        }
    }
    let resolved = resolve_backend(requested);
    let status = get_runtime_status();
    status
        .installed
        .iter()
        .find(|i| i.backend == resolved)
        .cloned()
        .or_else(|| status.installed.into_iter().next())
}

pub fn uninstall_runtime(backend: RuntimeBackendKind) -> Result<(), String> {
    let resolved = resolve_backend(backend);
    let dir = runtimes_base_dir().join(backend_key(&resolved));
    if dir.exists() {
        fs::remove_dir_all(&dir).map_err(|e| format!("No se pudo eliminar el runtime: {e}"))?;
    }
    Ok(())
}

pub async fn install_runtime<F>(
    requested: RuntimeBackendKind,
    on_progress: F,
) -> Result<RuntimeInstallInfo, String>
where
    F: Fn(RuntimeDownloadEvent) + Send + Sync,
{
    let backend = resolve_backend(requested);
    on_progress(RuntimeDownloadEvent {
        backend: backend.clone(),
        stage: "fetching_release".into(),
        downloaded_bytes: 0,
        total_bytes: None,
        percent: None,
        message: format!(
            "Consultando última release oficial de llama.cpp para {}...",
            backend_key(&backend)
        ),
    });

    let client = reqwest::Client::builder()
        .user_agent("loors-studio/0.1")
        .build()
        .map_err(|e| format!("Error creando cliente HTTP: {e}"))?;

    let releases: Vec<GithubRelease> = client
        .get(GITHUB_RELEASES_URL)
        .send()
        .await
        .map_err(|e| format!("Error consultando GitHub Releases: {e}"))?
        .error_for_status()
        .map_err(|e| format!("GitHub devolvió un error HTTP: {e}"))?
        .json()
        .await
        .map_err(|e| format!("No se pudo parsear la lista de releases de llama.cpp: {e}"))?;

    let (release, assets_to_download) = releases
        .into_iter()
        .filter(|r| !r.draft && !r.assets.is_empty())
        .find_map(|r| {
            select_release_assets(&r.assets, &backend).map(|assets| (r, assets))
        })
        .ok_or_else(|| {
            format!(
                "No se encontró un paquete compatible en las últimas 10 releases de llama.cpp para {} ({}-{}).",
                backend_key(&backend),
                std::env::consts::OS,
                std::env::consts::ARCH
            )
        })?;

    let target_dir = runtimes_base_dir().join(backend_key(&backend));
    if target_dir.exists() {
        let _ = fs::remove_dir_all(&target_dir);
    }
    fs::create_dir_all(&target_dir)
        .map_err(|e| format!("No se pudo crear el directorio de runtime: {e}"))?;

    let primary_name = assets_to_download[0].name.clone();

    for asset in &assets_to_download {
        let zip_path = target_dir.join(&asset.name);
        download_asset(&client, asset, &zip_path, &backend, &on_progress).await?;

        on_progress(RuntimeDownloadEvent {
            backend: backend.clone(),
            stage: "extracting".into(),
            downloaded_bytes: asset.size,
            total_bytes: Some(asset.size),
            percent: Some(100.0),
            message: format!("Extrayendo {}...", asset.name),
        });

        extract_zip(&zip_path, &target_dir)?;
        let _ = fs::remove_file(&zip_path);
    }

    let binary_name = if cfg!(target_os = "windows") {
        "llama-server.exe"
    } else {
        "llama-server"
    };

    let binary_path = find_file_recursive(&target_dir, binary_name).ok_or_else(|| {
        format!("Se extrajo el paquete pero no se encontró '{binary_name}' dentro de {target_dir:?}.")
    })?;

    let info = RuntimeInstallInfo {
        backend: backend.clone(),
        version: release.tag_name.clone(),
        binary_path: binary_path.to_string_lossy().to_string(),
        asset_name: primary_name,
    };

    let manifest_raw =
        serde_json::to_string_pretty(&info).map_err(|e| format!("Error serializando manifest: {e}"))?;
    fs::write(target_dir.join("manifest.json"), manifest_raw)
        .map_err(|e| format!("Error guardando manifest.json: {e}"))?;

    on_progress(RuntimeDownloadEvent {
        backend,
        stage: "done".into(),
        downloaded_bytes: 0,
        total_bytes: None,
        percent: Some(100.0),
        message: format!("llama.cpp {} instalado correctamente.", info.version),
    });

    Ok(info)
}

fn select_release_assets(
    assets: &[GithubAsset],
    backend: &RuntimeBackendKind,
) -> Option<Vec<GithubAsset>> {
    let find_archive = |predicates: &[&str], excludes: &[&str]| -> Option<GithubAsset> {
        assets
            .iter()
            .find(|a| {
                let n = a.name.to_lowercase();
                n.ends_with(".zip")
                    && predicates.iter().all(|p| n.contains(p))
                    && excludes.iter().all(|ex| !n.contains(ex))
            })
            .cloned()
    };

    if cfg!(target_os = "windows") {
        match backend {
            RuntimeBackendKind::Cuda => {
                // Match llama-bXXXX-bin-win-cuda-12.4-x64.zip, cuda-13.x, or cuda-cu12.x
                let main = find_archive(&["win", "cuda", "12", "x64"], &["cudart"])
                    .or_else(|| find_archive(&["win", "cuda", "13", "x64"], &["cudart"]))
                    .or_else(|| find_archive(&["win", "cuda", "x64"], &["cudart"]))?;

                let mut list = vec![main.clone()];
                let main_lower = main.name.to_lowercase();
                let cudart = if main_lower.contains("13") {
                    find_archive(&["cudart", "win", "cuda", "13", "x64"], &[])
                        .or_else(|| find_archive(&["cudart", "win", "cuda", "x64"], &[]))
                } else {
                    find_archive(&["cudart", "win", "cuda", "12", "x64"], &[])
                        .or_else(|| find_archive(&["cudart", "win", "cuda", "x64"], &[]))
                };
                if let Some(c) = cudart {
                    if c.name != main.name {
                        list.push(c);
                    }
                }
                Some(list)
            }
            RuntimeBackendKind::Vulkan => {
                find_archive(&["win", "vulkan", "x64"], &[]).map(|a| vec![a])
            }
            RuntimeBackendKind::Cpu | RuntimeBackendKind::Auto | RuntimeBackendKind::Metal => {
                find_archive(&["win", "cpu", "x64"], &[])
                    .or_else(|| find_archive(&["win", "avx2", "x64"], &[]))
                    .or_else(|| find_archive(&["win", "noavx", "x64"], &[]))
                    .map(|a| vec![a])
            }
        }
    } else if cfg!(target_os = "macos") {
        let arch_hint = if cfg!(target_arch = "aarch64") {
            "arm64"
        } else {
            "x64"
        };
        find_archive(&["macos", arch_hint], &[]).map(|a| vec![a])
    } else {
        match backend {
            RuntimeBackendKind::Vulkan => {
                find_archive(&["ubuntu", "vulkan", "x64"], &[]).map(|a| vec![a])
            }
            _ => find_archive(&["ubuntu", "x64"], &["vulkan", "cuda"]).map(|a| vec![a]),
        }
    }
}

async fn download_asset<F>(
    client: &reqwest::Client,
    asset: &GithubAsset,
    dest: &Path,
    backend: &RuntimeBackendKind,
    on_progress: &F,
) -> Result<(), String>
where
    F: Fn(RuntimeDownloadEvent),
{
    let resp = client
        .get(&asset.browser_download_url)
        .send()
        .await
        .map_err(|e| format!("Error descargando {}: {e}", asset.name))?
        .error_for_status()
        .map_err(|e| format!("Error HTTP descargando {}: {e}", asset.name))?;

    let total = resp.content_length().or(Some(asset.size));
    let mut file =
        File::create(dest).map_err(|e| format!("No se pudo crear {}: {e}", dest.display()))?;
    let mut stream = resp.bytes_stream();
    let mut downloaded: u64 = 0;
    let mut last_reported: u64 = 0;

    while let Some(chunk) = stream.next().await {
        let bytes = chunk.map_err(|e| format!("Error leyendo descarga: {e}"))?;
        file.write_all(&bytes)
            .map_err(|e| format!("Error escribiendo archivo: {e}"))?;
        downloaded += bytes.len() as u64;

        if downloaded - last_reported >= 512 * 1024 || total == Some(downloaded) {
            last_reported = downloaded;
            let pct = total.map(|t| if t > 0 { (downloaded as f32 / t as f32) * 100.0 } else { 0.0 });
            on_progress(RuntimeDownloadEvent {
                backend: backend.clone(),
                stage: "downloading".into(),
                downloaded_bytes: downloaded,
                total_bytes: total,
                percent: pct,
                message: format!("Descargando {}...", asset.name),
            });
        }
    }

    Ok(())
}

fn extract_zip(zip_path: &Path, dest_dir: &Path) -> Result<(), String> {
    let file = File::open(zip_path).map_err(|e| format!("Error abriendo zip: {e}"))?;
    let mut archive =
        zip::ZipArchive::new(file).map_err(|e| format!("Archivo zip inválido: {e}"))?;

    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| format!("Error leyendo entrada zip: {e}"))?;
        let Some(enclosed) = entry.enclosed_name() else {
            continue;
        };
        let out_path = dest_dir.join(enclosed);
        if entry.is_dir() {
            fs::create_dir_all(&out_path).map_err(|e| format!("Error creando carpeta: {e}"))?;
        } else {
            if let Some(parent) = out_path.parent() {
                fs::create_dir_all(parent).map_err(|e| format!("Error creando carpeta: {e}"))?;
            }
            let mut outfile =
                File::create(&out_path).map_err(|e| format!("Error creando archivo: {e}"))?;
            io::copy(&mut entry, &mut outfile)
                .map_err(|e| format!("Error extrayendo archivo: {e}"))?;
        }
    }
    Ok(())
}

fn find_file_recursive(dir: &Path, target_name: &str) -> Option<PathBuf> {
    let entries = fs::read_dir(dir).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_file() {
            if path
                .file_name()
                .and_then(|n| n.to_str())
                .map(|n| n.eq_ignore_ascii_case(target_name))
                .unwrap_or(false)
            {
                return Some(path);
            }
        } else if path.is_dir() {
            if let Some(found) = find_file_recursive(&path, target_name) {
                return Some(found);
            }
        }
    }
    None
}
