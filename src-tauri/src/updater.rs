use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
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

fn parse_semver(raw: &str) -> Result<semver::Version, String> {
    semver::Version::parse(raw.trim().trim_start_matches(['v', 'V']))
        .map_err(|_| format!("Versión de actualización inválida: {raw}"))
}

fn is_newer_version(current: &str, latest: &str) -> Result<bool, String> {
    Ok(parse_semver(latest)?
        .cmp_precedence(&parse_semver(current)?)
        .is_gt())
}

fn select_platform_asset(assets: &[Value]) -> Option<(String, String, Option<u64>)> {
    select_asset(
        assets,
        std::env::consts::OS,
        std::env::consts::ARCH,
        std::env::var_os("APPIMAGE").is_some_and(|path| !path.is_empty()),
    )
}

fn select_asset(
    assets: &[Value],
    os: &str,
    arch: &str,
    running_appimage: bool,
) -> Option<(String, String, Option<u64>)> {
    let items: Vec<(String, String, Option<u64>)> = assets
        .iter()
        .filter_map(|a| {
            let name = a.get("name")?.as_str()?.to_string();
            let url = a.get("browser_download_url")?.as_str()?.to_string();
            let size = a.get("size").and_then(|s| s.as_u64());
            Some((name, url, size))
        })
        .collect();

    if os == "windows" {
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
    } else {
        let extension = match (os, running_appimage) {
            ("macos", _) => ".dmg",
            ("linux", true) => ".appimage",
            ("linux", false) => ".deb",
            _ => return None,
        };
        let arch_aliases: &[&str] = match arch {
            "x86_64" => &["x64", "amd64"],
            "aarch64" => &["aarch64", "arm64"],
            "x86" => &["x86", "i386", "i686"],
            "arm" => &["arm", "armhf", "armv7"],
            _ => &[],
        };
        items.into_iter().find(|(name, _, _)| {
            let name = name.to_ascii_lowercase().replace("x86_64", "x64");
            name.strip_suffix(extension).is_some_and(|stem| {
                stem.split(|c: char| !c.is_ascii_alphanumeric())
                    .any(|label| {
                        label == arch
                            || arch_aliases.contains(&label)
                            || (os == "macos" && matches!(label, "universal" | "universal2"))
                    })
            })
        })
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

    let valid_segment = |segment: &str| {
        !segment.is_empty()
            && !matches!(segment, "." | "..")
            && segment
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'-' | b'_'))
    };
    if !repo
        .split_once('/')
        .is_some_and(|(owner, name)| valid_segment(owner) && valid_segment(name))
    {
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
        .ok_or_else(|| "GitHub no devolvió la versión de la publicación.".to_string())?;
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
    let latest_clean = parse_semver(tag)?.to_string();
    let update_available = is_newer_version(&current, &latest_clean)?;

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

pub struct DownloadedInstaller {
    pub directory: tempfile::TempDir,
    pub path: PathBuf,
}

pub async fn download_update_installer<F>(
    release: &UpdateCheckResult,
    mut on_progress: F,
) -> Result<DownloadedInstaller, String>
where
    F: FnMut(UpdateProgressEvent),
{
    let (asset_url, asset_name) = release
        .asset_url
        .as_deref()
        .zip(release.asset_name.as_deref())
        .ok_or_else(|| "No hay un instalador disponible para este sistema.".to_string())?;
    if !asset_url.starts_with("https://github.com/") {
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
    if safe_name.is_empty() || matches!(safe_name.as_str(), "." | "..") {
        return Err("Nombre de instalador inválido.".to_string());
    }

    let directory = tempfile::Builder::new()
        .prefix("loors-update-")
        .tempdir()
        .map_err(|e| format!("No se pudo crear carpeta temporal: {e}"))?;
    let dest = directory.path().join(&safe_name);

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

    let total_bytes = release.asset_size.or_else(|| resp.content_length());
    let mut file = fs::File::create_new(&dest)
        .map_err(|e| format!("No se pudo crear {}: {e}", dest.display()))?;

    let mut stream = resp.bytes_stream();
    let mut downloaded: u64 = 0;
    let mut last_reported_bytes = 0;
    let mut last_pct = Some(0);

    while let Some(chunk_res) = stream.next().await {
        let chunk = chunk_res.map_err(|e| format!("Error leyendo descarga: {e}"))?;
        file.write_all(&chunk)
            .map_err(|e| format!("Error escribiendo instalador: {e}"))?;
        downloaded += chunk.len() as u64;
        let pct = total_bytes
            .filter(|&t| t > 0)
            .map(|t| ((downloaded.saturating_mul(100)) / t).min(100) as u8);
        if pct != last_pct || (pct.is_none() && downloaded - last_reported_bytes >= 1024 * 1024) {
            last_pct = pct;
            last_reported_bytes = downloaded;
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

    if downloaded == 0 || total_bytes.is_some_and(|size| size != downloaded) {
        return Err("El tamaño del instalador descargado no coincide con el esperado.".into());
    }
    file.sync_all()
        .map_err(|e| format!("Error guardando el instalador: {e}"))?;
    drop(file);

    on_progress(UpdateProgressEvent {
        stage: "installing".to_string(),
        downloaded_bytes: downloaded,
        total_bytes,
        percent: Some(100),
        message: "Iniciando instalador…".to_string(),
    });

    Ok(DownloadedInstaller {
        directory,
        path: dest,
    })
}

pub fn launch_installer(installer_path: &Path) -> Result<bool, String> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;

        let executable = std::env::current_exe()
            .map_err(|e| format!("No se pudo localizar Loors para reiniciarlo: {e}"))?;
        let ps_script = r#"
            $ErrorActionPreference = 'Stop'
            $installer = $env:LOORS_UPDATE_INSTALLER
            try {
                $appProcess = Get-Process -Id ([int]$env:LOORS_UPDATE_PID) -ErrorAction SilentlyContinue
                if ($appProcess) { $appProcess | Wait-Process -Timeout 60 }
                if ([IO.Path]::GetExtension($installer) -ieq '.msi') {
                    $quotedInstaller = '"' + $installer + '"'
                    $process = Start-Process 'msiexec.exe' -ArgumentList '/i',$quotedInstaller,'/qn','/norestart' -PassThru -Wait -WindowStyle Hidden
                } else {
                    $process = Start-Process -FilePath $installer -ArgumentList '/S' -PassThru -Wait -WindowStyle Hidden
                }
                if ($process.ExitCode -ne 0) { throw "Installer exit code: $($process.ExitCode)" }
            } catch {
                Add-Type -AssemblyName PresentationFramework
                [void][System.Windows.MessageBox]::Show($_.Exception.Message, 'Loors Update')
            } finally {
                Remove-Item -LiteralPath $installer -ErrorAction SilentlyContinue
                Remove-Item -LiteralPath ([IO.Path]::GetDirectoryName($installer)) -ErrorAction SilentlyContinue
                if (-not (Get-Process -Id ([int]$env:LOORS_UPDATE_PID) -ErrorAction SilentlyContinue) -and
                    (Test-Path -LiteralPath $env:LOORS_UPDATE_EXECUTABLE)) {
                    Start-Process -FilePath $env:LOORS_UPDATE_EXECUTABLE
                }
            }
        "#;

        std::process::Command::new("powershell.exe")
            .args([
                "-NoProfile",
                "-WindowStyle",
                "Hidden",
                "-Command",
                ps_script,
            ])
            .env("LOORS_UPDATE_PID", std::process::id().to_string())
            .env("LOORS_UPDATE_INSTALLER", installer_path)
            .env("LOORS_UPDATE_EXECUTABLE", executable)
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|e| format!("No se pudo lanzar el actualizador silencioso: {e}"))?;
        Ok(true)
    }

    #[cfg(target_os = "macos")]
    {
        let status = std::process::Command::new("open")
            .arg(installer_path)
            .status()
            .map_err(|e| format!("No se pudo abrir el DMG: {e}"))?;
        if !status.success() {
            return Err(format!("No se pudo abrir el DMG: {status}"));
        }
        Ok(false)
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        use std::os::unix::fs::PermissionsExt;
        let is_appimage = installer_path
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("appimage"));
        if is_appimage {
            fs::set_permissions(installer_path, fs::Permissions::from_mode(0o755))
                .map_err(|e| format!("No se pudo preparar el AppImage: {e}"))?;
        }
        if let Some(current_appimage) = std::env::var_os("APPIMAGE").filter(|path| !path.is_empty())
        {
            let current_path = PathBuf::from(&current_appimage);
            if let Some(parent) = current_path.parent().filter(|_| is_appimage) {
                let replace = || -> std::io::Result<()> {
                    let staged = tempfile::NamedTempFile::new_in(parent)?;
                    fs::copy(installer_path, staged.path())?;
                    staged.as_file().sync_all()?;
                    staged.persist(&current_path)?;
                    Ok(())
                };
                if replace().is_ok()
                    && std::process::Command::new(&current_path)
                        .env_remove("APPIMAGE")
                        .env_remove("APPDIR")
                        .env_remove("ARGV0")
                        .env_remove("OWD")
                        .spawn()
                        .is_ok()
                {
                    return Ok(true);
                }
            }
        }
        if let Some(parent) = installer_path.parent() {
            std::process::Command::new("xdg-open")
                .arg(parent)
                .spawn()
                .map_err(|e| format!("No se pudo abrir la carpeta del instalador: {e}"))?;
        }
        Ok(false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn selects_unix_installers_by_format_and_architecture() {
        let assets = [
            "Loors_1.2.3_aarch64.dmg",
            "Loors_1.2.3_x64.dmg",
            "Loors_1.2.3_aarch64.AppImage",
            "Loors_1.2.3_amd64.AppImage",
            "Loors_1.2.3_amd64.deb",
            "Loors_1.2.3_universal.dmg",
        ].map(|name| serde_json::json!({
            "name": name,
            "browser_download_url": format!("https://github.com/owner/repo/releases/download/v1.2.3/{name}"),
        }));
        let selected = |assets: &[Value], os, arch, appimage| {
            select_asset(assets, os, arch, appimage).map(|(name, _, _)| name)
        };

        assert_eq!(
            selected(&assets, "macos", "x86_64", false).as_deref(),
            Some("Loors_1.2.3_x64.dmg")
        );
        assert_eq!(
            selected(&assets[5..], "macos", "x86_64", false).as_deref(),
            Some("Loors_1.2.3_universal.dmg")
        );
        assert!(selected(&assets[..1], "macos", "x86_64", false).is_none());
        assert_eq!(
            selected(&assets, "linux", "x86_64", true).as_deref(),
            Some("Loors_1.2.3_amd64.AppImage")
        );
        assert_eq!(
            selected(&assets, "linux", "x86_64", false).as_deref(),
            Some("Loors_1.2.3_amd64.deb")
        );
        assert!(selected(&assets, "linux", "aarch64", false).is_none());
        assert!(selected(&assets[4..], "linux", "x86_64", true).is_none());
    }

    #[test]
    fn compares_semver_versions_correctly() {
        assert_eq!(is_newer_version("0.1.0", "0.2.0"), Ok(true));
        assert_eq!(is_newer_version("0.1.0", "v0.1.1"), Ok(true));
        assert_eq!(is_newer_version("0.9.9", "1.0.0"), Ok(true));
        assert_eq!(is_newer_version("0.2.0", "0.2.0"), Ok(false));
        assert_eq!(is_newer_version("0.2.1", "0.2.0"), Ok(false));
        assert_eq!(is_newer_version("1.0.0", "v0.9.5"), Ok(false));
        assert_eq!(is_newer_version("1.0.0-rc.1", "1.0.0"), Ok(true));
        assert_eq!(is_newer_version("1.0.0", "1.0.0-rc.2"), Ok(false));
        assert_eq!(is_newer_version("1.0.0", "1.0.0+build"), Ok(false));
        assert!(is_newer_version("1.0.0", "invalid").is_err());
    }
}
