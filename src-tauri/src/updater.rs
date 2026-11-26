use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::time::Duration;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheckResult {
    pub current_version: String,
    pub latest_version: String,
    pub update_available: bool,
    pub repo: String,
    pub release_url: String,
    pub release_notes: String,
    pub asset_name: Option<String>,
    pub asset_url: Option<String>,
    pub asset_size: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateProgressEvent {
    pub stage: String,
    pub downloaded_bytes: u64,
    pub total_bytes: Option<u64>,
    pub percent: Option<u8>,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct UpdaterConfig {
    repo: String,
}

fn updater_config_path() -> PathBuf {
    dirs::data_local_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join("loors")
        .join("updater.json")
}

fn load_saved_repo() -> Option<String> {
    let raw = fs::read_to_string(updater_config_path()).ok()?;
    let cfg: UpdaterConfig = serde_json::from_str(&raw).ok()?;
    let trimmed = cfg.repo.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

pub fn save_update_repo(repo: &str) -> Result<(), String> {
    let path = updater_config_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("No se pudo crear carpeta de configuración: {e}"))?;
    }
    let json = serde_json::to_string_pretty(&UpdaterConfig {
        repo: repo.trim().to_string(),
    })
    .map_err(|e| e.to_string())?;
    fs::write(path, json).map_err(|e| format!("No se pudo guardar updater.json: {e}"))
}

pub fn configured_update_repo() -> Option<String> {
    if let Some(saved) = load_saved_repo() {
        return Some(saved);
    }
    if let Ok(v) = std::env::var("LOORS_UPDATE_REPO") {
        if !v.trim().is_empty() {
            return Some(v.trim().to_string());
        }
    }
    if let Some(v) = option_env!("LOORS_UPDATE_REPO") {
        if !v.trim().is_empty() {
            return Some(v.trim().to_string());
        }
    }
    if let Some(v) = option_env!("GITHUB_REPOSITORY") {
        if !v.trim().is_empty() {
            return Some(v.trim().to_string());
        }
    }
    Some("IonAlfaro/loors".to_string())
}

pub fn current_app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

pub fn parse_semver(raw: &str) -> (u64, u64, u64) {
    let cleaned = raw
        .trim()
        .trim_start_matches('v')
        .trim_start_matches('V')
        .split('-')
        .next()
        .unwrap_or("0.0.0");
    let mut parts = cleaned.split('.');
    let major = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
    let minor = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
    let patch = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
    (major, minor, patch)
}

pub fn is_newer_version(current: &str, latest: &str) -> bool {
    parse_semver(latest) > parse_semver(current)
}

fn select_platform_asset(assets: &[Value]) -> Option<(String, String, Option<u64>)> {
    let items: Vec<(String, String, Option<u64>)> = assets
        .iter()
        .filter_map(|a| {
            let name = a.get("name")?.as_str()?.to_string();
            let url = a.get("browser_download_url")?.as_str()?.to_string();
            let size = a.get("size").and_then(|s| s.as_u64());
            Some((name, url, size))
        })
        .collect();

    if cfg!(target_os = "windows") {
        items
            .iter()
            .find(|(n, _, _)| n.to_ascii_lowercase().ends_with("-setup.exe"))
            .or_else(|| {
                items
                    .iter()
                    .find(|(n, _, _)| n.to_ascii_lowercase().ends_with(".exe"))
            })
            .or_else(|| {
                items
                    .iter()
                    .find(|(n, _, _)| n.to_ascii_lowercase().ends_with(".msi"))
            })
            .cloned()
    } else if cfg!(target_os = "macos") {
        let want_arm = cfg!(target_arch = "aarch64");
        items
            .iter()
            .find(|(n, _, _)| {
                let l = n.to_ascii_lowercase();
                l.ends_with(".dmg")
                    && if want_arm {
                        l.contains("aarch64") || l.contains("arm64")
                    } else {
                        l.contains("x64") || l.contains("x86_64")
                    }
            })
            .or_else(|| {
                items
                    .iter()
                    .find(|(n, _, _)| n.to_ascii_lowercase().ends_with(".dmg"))
            })
            .cloned()
    } else {
        items
            .iter()
            .find(|(n, _, _)| n.to_ascii_lowercase().ends_with(".appimage"))
            .or_else(|| {
                items
                    .iter()
                    .find(|(n, _, _)| n.to_ascii_lowercase().ends_with(".deb"))
            })
            .cloned()
    }
}

pub async fn check_for_updates(repo_override: Option<String>) -> Result<UpdateCheckResult, String> {
    let repo = repo_override
        .map(|r| r.trim().to_string())
        .filter(|r| !r.is_empty())
        .or_else(configured_update_repo)
        .ok_or_else(|| {
            "Repositorio de actualizaciones no configurado todavía (ej. tu-usuario/loors)."
                .to_string()
        })?;

    if !repo.contains('/') || repo.contains(' ') {
        return Err(
            "Formato de repositorio inválido. Usa 'usuario/repositorio' (ej. tu-usuario/loors)."
                .to_string(),
        );
    }

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .user_agent(format!("Loors-Desktop/{}", current_app_version()))
        .build()
        .map_err(|e| format!("Error creando cliente HTTP: {e}"))?;

    let api_url = format!("https://api.github.com/repos/{repo}/releases/latest");
    let resp = client
        .get(&api_url)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| format!("No se pudo consultar GitHub Releases: {e}"))?;

    if resp.status().as_u16() == 404 {
        return Err(format!(
            "No hay ninguna release publicada todavía en github.com/{repo}."
        ));
    }
    if !resp.status().is_success() {
        return Err(format!(
            "Error HTTP {} consultando actualizaciones en {repo}.",
            resp.status()
        ));
    }

    let payload: Value = resp
        .json()
        .await
        .map_err(|e| format!("Respuesta JSON inválida de GitHub: {e}"))?;

    let tag = payload
        .get("tag_name")
        .and_then(|v| v.as_str())
        .unwrap_or("0.0.0")
        .to_string();
    let release_url = payload
        .get("html_url")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| format!("https://github.com/{repo}/releases"));
    let release_notes = payload
        .get("body")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    let assets = payload
        .get("assets")
        .and_then(|v| v.as_array())
        .map(|a| a.as_slice())
        .unwrap_or(&[]);
    let selected = select_platform_asset(assets);

    let current = current_app_version();
    let latest_clean = tag.trim_start_matches('v').trim_start_matches('V').to_string();
    let update_available = is_newer_version(&current, &latest_clean);

    Ok(UpdateCheckResult {
        current_version: current,
        latest_version: latest_clean,
        update_available,
        repo,
        release_url,
        release_notes,
        asset_name: selected.as_ref().map(|(n, _, _)| n.clone()),
        asset_url: selected.as_ref().map(|(_, u, _)| u.clone()),
        asset_size: selected.and_then(|(_, _, s)| s),
    })
}

pub async fn download_update_installer<F>(
    asset_url: &str,
    asset_name: &str,
    mut on_progress: F,
) -> Result<PathBuf, String>
where
    F: FnMut(UpdateProgressEvent),
{
    if !asset_url.starts_with("https://") {
        return Err("La URL de descarga debe usar HTTPS.".to_string());
    }

    let safe_name: String = asset_name
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '.' || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    if safe_name.is_empty() {
        return Err("Nombre de instalador inválido.".to_string());
    }

    let updates_dir = std::env::temp_dir().join("loors-updates");
    fs::create_dir_all(&updates_dir)
        .map_err(|e| format!("No se pudo crear carpeta temporal: {e}"))?;
    let dest = updates_dir.join(&safe_name);

    on_progress(UpdateProgressEvent {
        stage: "connecting".to_string(),
        downloaded_bytes: 0,
        total_bytes: None,
        percent: Some(0),
        message: format!("Descargando {safe_name}…"),
    });

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(600))
        .user_agent(format!("Loors-Desktop/{}", current_app_version()))
        .build()
        .map_err(|e| format!("Error creando cliente HTTP: {e}"))?;

    let resp = client
        .get(asset_url)
        .send()
        .await
        .map_err(|e| format!("Error descargando actualización: {e}"))?
        .error_for_status()
        .map_err(|e| format!("Error HTTP descargando actualización: {e}"))?;

    let total_bytes = resp.content_length();
    let mut file = fs::File::create(&dest)
        .map_err(|e| format!("No se pudo crear {}: {e}", dest.display()))?;

    let mut stream = resp.bytes_stream();
    let mut downloaded: u64 = 0;
    let mut last_pct: u8 = 0;

    while let Some(chunk_res) = stream.next().await {
        let chunk = chunk_res.map_err(|e| format!("Error leyendo descarga: {e}"))?;
        file.write_all(&chunk)
            .map_err(|e| format!("Error escribiendo instalador: {e}"))?;
        downloaded += chunk.len() as u64;
        let pct = total_bytes
            .filter(|&t| t > 0)
            .map(|t| ((downloaded.saturating_mul(100)) / t).min(100) as u8);
        if pct.unwrap_or(0) != last_pct || total_bytes.is_none() {
            last_pct = pct.unwrap_or(0);
            on_progress(UpdateProgressEvent {
                stage: "downloading".to_string(),
                downloaded_bytes: downloaded,
                total_bytes,
                percent: pct,
                message: match pct {
                    Some(p) => format!("Descargando {safe_name} ({p}%)…"),
                    None => format!(
                        "Descargando {safe_name} ({:.1} MB)…",
                        downloaded as f64 / (1024.0 * 1024.0)
                    ),
                },
            });
        }
    }

    on_progress(UpdateProgressEvent {
        stage: "installing".to_string(),
        downloaded_bytes: downloaded,
        total_bytes,
        percent: Some(100),
        message: "Iniciando instalador…".to_string(),
    });

    Ok(dest)
}

pub fn launch_installer(installer_path: &PathBuf) -> Result<bool, String> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;

        let lower = installer_path
            .to_string_lossy()
            .to_ascii_lowercase();
        let inst_escaped = installer_path
            .to_string_lossy()
            .replace('\'', "''");
        let exe_escaped = std::env::current_exe()
            .ok()
            .map(|p| p.to_string_lossy().replace('\'', "''"))
            .unwrap_or_default();

        // Run a hidden detached PowerShell helper that waits briefly for Loors to exit,
        // runs the NSIS (/S) or MSI (/qn) installer 100% silently with zero wizard UI,
        // and automatically relaunches the updated Loors executable.
        let ps_script = if lower.ends_with(".msi") {
            format!(
                "Start-Sleep -Milliseconds 700; \
                 $p = Start-Process 'msiexec.exe' -ArgumentList '/i','\"{inst_escaped}\"','/qn','/norestart' -PassThru -Wait; \
                 if ('{exe_escaped}' -ne '' -and (Test-Path '{exe_escaped}')) {{ Start-Process '{exe_escaped}' }}"
            )
        } else {
            format!(
                "Start-Sleep -Milliseconds 700; \
                 $p = Start-Process '{inst_escaped}' -ArgumentList '/S' -PassThru -Wait; \
                 if ('{exe_escaped}' -ne '' -and (Test-Path '{exe_escaped}')) {{ Start-Process '{exe_escaped}' }}"
            )
        };

        std::process::Command::new("powershell.exe")
            .args(["-NoProfile", "-WindowStyle", "Hidden", "-Command", &ps_script])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|e| format!("No se pudo lanzar el actualizador silencioso: {e}"))?;
        Ok(true)
    }

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(installer_path)
            .spawn()
            .map_err(|e| format!("No se pudo abrir el DMG: {e}"))?;
        Ok(false)
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(installer_path, fs::Permissions::from_mode(0o755));
        if let Ok(current_appimage) = std::env::var("APPIMAGE") {
            let current_path = PathBuf::from(&current_appimage);
            if installer_path
                .to_string_lossy()
                .to_ascii_lowercase()
                .ends_with(".appimage")
            {
                let backup = current_path.with_extension("AppImage.old");
                let _ = fs::rename(&current_path, &backup);
                if fs::copy(installer_path, &current_path).is_ok() {
                    let _ = fs::set_permissions(&current_path, fs::Permissions::from_mode(0o755));
                    let _ = std::process::Command::new(&current_path).spawn();
                    return Ok(true);
                }
            }
        }
        if let Some(parent) = installer_path.parent() {
            let _ = std::process::Command::new("xdg-open").arg(parent).spawn();
        }
        Ok(false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compares_semver_versions_correctly() {
        assert!(is_newer_version("0.1.0", "0.2.0"));
        assert!(is_newer_version("0.1.0", "v0.1.1"));
        assert!(is_newer_version("0.9.9", "1.0.0"));
        assert!(!is_newer_version("0.2.0", "0.2.0"));
        assert!(!is_newer_version("0.2.1", "0.2.0"));
        assert!(!is_newer_version("1.0.0", "v0.9.5"));
    }
}
