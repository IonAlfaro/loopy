use serde::{Deserialize, Serialize};
use std::process::Command;
use std::sync::OnceLock;
use sysinfo::System;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

static CACHED_HARDWARE: OnceLock<HardwareProfile> = OnceLock::new();

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeBackendKind {
    Auto,
    Cuda,
    Vulkan,
    Metal,
    Cpu,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GpuInfo {
    pub name: String,
    pub vendor: String,
    pub vram_mb: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HardwareProfile {
    pub os: String,
    pub arch: String,
    pub cpu_brand: String,
    pub cpu_cores: usize,
    pub total_ram_mb: u64,
    pub gpus: Vec<GpuInfo>,
    pub recommended_backend: RuntimeBackendKind,
    pub available_backends: Vec<RuntimeBackendKind>,
}

pub fn detect_hardware_profile() -> HardwareProfile {
    CACHED_HARDWARE
        .get_or_init(detect_hardware_profile_uncached)
        .clone()
}

fn detect_hardware_profile_uncached() -> HardwareProfile {
    let mut sys = System::new_all();
    sys.refresh_cpu_all();
    sys.refresh_memory();

    let cpu_brand = sys
        .cpus()
        .first()
        .map(|c| c.brand().trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "Unknown CPU".to_string());

    let cpu_cores = sys.cpus().len();
    let total_ram_mb = sys.total_memory() / (1024 * 1024);

    let gpus = detect_gpus();

    let has_nvidia = gpus
        .iter()
        .any(|g| g.vendor.eq_ignore_ascii_case("nvidia") || g.name.to_lowercase().contains("nvidia"));
    let has_any_gpu = !gpus.is_empty();

    let mut available_backends = vec![RuntimeBackendKind::Auto];
    if cfg!(target_os = "macos") {
        available_backends.push(RuntimeBackendKind::Metal);
    } else {
        if has_nvidia {
            available_backends.push(RuntimeBackendKind::Cuda);
        }
        available_backends.push(RuntimeBackendKind::Vulkan);
    }
    available_backends.push(RuntimeBackendKind::Cpu);

    let recommended_backend = if cfg!(target_os = "macos") {
        RuntimeBackendKind::Metal
    } else if has_nvidia {
        RuntimeBackendKind::Cuda
    } else if has_any_gpu {
        RuntimeBackendKind::Vulkan
    } else {
        RuntimeBackendKind::Cpu
    };

    HardwareProfile {
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        cpu_brand,
        cpu_cores,
        total_ram_mb,
        gpus,
        recommended_backend,
        available_backends,
    }
}

fn detect_gpus() -> Vec<GpuInfo> {
    let mut gpus = Vec::new();

    // 1. Try nvidia-smi for exact NVIDIA GPU name and VRAM
    let mut nv_cmd = Command::new("nvidia-smi");
    nv_cmd.args([
        "--query-gpu=name,memory.total",
        "--format=csv,noheader,nounits",
    ]);
    #[cfg(target_os = "windows")]
    nv_cmd.creation_flags(CREATE_NO_WINDOW);

    if let Ok(output) = nv_cmd.output() {
        if output.status.success() {
            let stdout = String::from_utf8_lossy(&output.stdout);
            for line in stdout.lines() {
                let parts: Vec<&str> = line.split(',').map(|s| s.trim()).collect();
                if let Some(name) = parts.first() {
                    if !name.is_empty() {
                        let vram_mb = parts.get(1).and_then(|v| v.parse::<u64>().ok());
                        gpus.push(GpuInfo {
                            name: (*name).to_string(),
                            vendor: "NVIDIA".to_string(),
                            vram_mb,
                        });
                    }
                }
            }
        }
    }

    // 2. On Windows, also inspect Win32_VideoController for AMD/Intel GPUs if none found yet
    #[cfg(target_os = "windows")]
    if gpus.is_empty() {
        let mut ps_cmd = Command::new("powershell");
        ps_cmd
            .args([
                "-NoProfile",
                "-Command",
                "Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name",
            ])
            .creation_flags(CREATE_NO_WINDOW);
        if let Ok(output) = ps_cmd.output() {
            if output.status.success() {
                let stdout = String::from_utf8_lossy(&output.stdout);
                for line in stdout.lines() {
                    let name = line.trim();
                    if name.is_empty() {
                        continue;
                    }
                    let lower = name.to_lowercase();
                    let vendor = if lower.contains("nvidia") {
                        "NVIDIA"
                    } else if lower.contains("amd") || lower.contains("radeon") {
                        "AMD"
                    } else if lower.contains("intel") {
                        "Intel"
                    } else {
                        "Other"
                    };
                    gpus.push(GpuInfo {
                        name: name.to_string(),
                        vendor: vendor.to_string(),
                        vram_mb: None,
                    });
                }
            }
        }
    }

    gpus
}
