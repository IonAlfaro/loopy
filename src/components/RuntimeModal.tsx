import { ModalBackdrop } from "./ModalBackdrop";
import { useEffect, useState } from "react";
import { CheckCircle2, Cpu, Download, Trash2, X } from "lucide-react";
import { invoke } from "../lib/bridge";
import { listen } from "../lib/bridge";
import { useGraphStore } from "../store/useGraphStore";
import { useI18n } from "../i18n";
import type {
  HardwareProfile,
  RuntimeBackendKind,
  RuntimeDownloadEvent,
  RuntimeStatusSnapshot,
} from "../types/graph";

interface RuntimeModalProps {
  open: boolean;
  embedded?: boolean;
  onClose: () => void;
}

const BACKEND_LABELS: Record<RuntimeBackendKind, string> = {
  auto: "Auto (recommended)",
  cuda: "NVIDIA CUDA (llama.cpp)",
  vulkan: "Vulkan GPU (AMD / Intel / NVIDIA)",
  metal: "Apple Metal",
  cpu: "CPU (AVX2 / fallback)",
};

export function RuntimeModal({ open, embedded = false, onClose }: RuntimeModalProps) {
  const { locale, t } = useI18n();
  const selectedBackend = useGraphStore((s) => s.selectedBackend);
  const setSelectedBackend = useGraphStore((s) => s.setSelectedBackend);

  const [hardware, setHardware] = useState<HardwareProfile | null>(null);
  const [status, setStatus] = useState<RuntimeStatusSnapshot | null>(null);
  const [customPath, setCustomPath] = useState("");
  const [savingCustom, setSavingCustom] = useState(false);
  const [customNotice, setCustomNotice] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [progress, setProgress] = useState<RuntimeDownloadEvent | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refreshStatus = () => {
    invoke<RuntimeStatusSnapshot>("get_runtime_status")
      .then((snap) => {
        setStatus(snap);
        setCustomPath(snap.custom_binary_path ?? "");
      })
      .catch(() => {});
  };

  const handleSaveCustomRuntime = async (pathOverride?: string) => {
    const nextPath = (pathOverride ?? customPath).trim();
    setSavingCustom(true);
    setError(null);
    setCustomNotice(null);
    try {
      await invoke("set_custom_runtime_binary", { path: nextPath });
      setCustomPath(nextPath);
      refreshStatus();
      setCustomNotice(
        nextPath
          ? locale === "es"
            ? "Runtime personalizado guardado"
            : "Custom runtime saved"
          : locale === "es"
            ? "Restaurado al runtime gestionado por Loors"
            : "Reset to Loors-managed runtime"
      );
    } catch (err) {
      setError(typeof err === "string" ? err : String(err));
    } finally {
      setSavingCustom(false);
    }
  };

  const handleBrowseCustomRuntime = async () => {
    try {
      const files = await invoke<string[]>("pick_files", { initialDir: null });
      if (files && files[0]) {
        setCustomPath(files[0]);
        await handleSaveCustomRuntime(files[0]);
      }
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setError(null);

    invoke<HardwareProfile>("detect_hardware")
      .then((profile) => {
        if (!cancelled) setHardware(profile);
      })
      .catch(() => {
        if (!cancelled) {
          setError(
            locale === "es"
              ? "Modo navegador: ejecuta Loors con Tauri para detectar hardware real y descargar llama.cpp."
              : "Browser preview mode: run the Loors desktop app (Tauri) to detect hardware and download llama.cpp."
          );
        }
      });

    refreshStatus();

    let unlisten: (() => void) | undefined;
    listen<RuntimeDownloadEvent>("loors://runtime-download", (ev) => {
      if (!cancelled) setProgress(ev.payload);
    })
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => {});

    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, [open]);

  if (!open) return null;

  const backends: RuntimeBackendKind[] = hardware?.available_backends ?? [
    "auto",
    "cuda",
    "vulkan",
    "cpu",
  ];

  const handleInstall = async () => {
    setDownloading(true);
    setError(null);
    setProgress(null);
    try {
      await invoke("install_runtime", { backend: selectedBackend });
      refreshStatus();
    } catch (err) {
      setError(typeof err === "string" ? err : "Error instalando llama.cpp");
    } finally {
      setDownloading(false);
    }
  };

  const handleUninstall = async (backend: RuntimeBackendKind) => {
    try {
      await invoke("uninstall_runtime", { backend });
      refreshStatus();
    } catch (err) {
      setError(typeof err === "string" ? err : "Error eliminando runtime");
    }
  };

  const innerBody = (
    <div className="modal-body" style={embedded ? { padding: 0 } : undefined}>
          {hardware ? (
            <div className="hw-box">
              <div>
                <strong>CPU:</strong> {hardware.cpu_brand} ({hardware.cpu_cores}{" "}
                {locale === "es" ? "hilos" : "threads"})
              </div>
              <div>
                <strong>RAM:</strong>{" "}
                {(hardware.total_ram_mb / 1024).toFixed(1)} GB
              </div>
              <div>
                <strong>GPU:</strong>{" "}
                {hardware.gpus.length > 0
                  ? hardware.gpus
                      .map(
                        (g) =>
                          `${g.name}${g.vram_mb ? ` (${(g.vram_mb / 1024).toFixed(1)} GB VRAM)` : ""}`
                      )
                      .join(", ")
                  : locale === "es"
                    ? "No detectada (se usará CPU)"
                    : "Not detected (CPU will be used)"}
              </div>
              <div>
                <strong>{locale === "es" ? "Recomendado:" : "Recommended:"}</strong>{" "}
                <span className="pill">
                  {BACKEND_LABELS[hardware.recommended_backend]}
                </span>
              </div>
            </div>
          ) : error ? (
            <div className="hw-note">{error}</div>
          ) : (
            <div className="hw-note">
              {locale === "es" ? "Detectando hardware…" : "Detecting hardware…"}
            </div>
          )}

          <label className="field">
            <span>{locale === "es" ? "Backend de inferencia" : "Inference backend"}</span>
            <select
              value={selectedBackend}
              disabled={downloading}
              onChange={(e) =>
                setSelectedBackend(e.target.value as RuntimeBackendKind)
              }
            >
              {backends.map((b) => (
                <option key={b} value={b}>
                  {BACKEND_LABELS[b]}
                </option>
              ))}
            </select>
          </label>

          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 6,
              padding: "10px 12px",
              borderRadius: 10,
              border: "1px solid rgba(255,255,255,0.08)",
              background: "rgba(255,255,255,0.03)",
            }}
          >
            <span style={{ fontSize: 12, fontWeight: 600, color: "#e2e8f0" }}>
              {locale === "es"
                ? "Binario llama-server personalizado (opcional)"
                : "Custom llama-server binary (optional)"}
            </span>
            <span style={{ fontSize: 11.5, color: "#94a3b8" }}>
              {locale === "es"
                ? "Usa tu propia compilación de llama.cpp, ik_llama.cpp u otro binario compatible."
                : "Point to your own llama.cpp, ik_llama.cpp, or any compatible llama-server binary."}
            </span>
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <input
                type="text"
                className="cloud-field-input"
                style={{ flex: 1 }}
                value={customPath}
                onChange={(e) => setCustomPath(e.target.value)}
                placeholder={
                  locale === "es"
                    ? "C:\\ruta\\a\\llama-server.exe (vacío = gestionado por Loors)"
                    : "/path/to/llama-server (empty = Loors-managed)"
                }
              />
              <button
                type="button"
                className="btn-secondary"
                disabled={savingCustom}
                onClick={() => void handleBrowseCustomRuntime()}
              >
                {locale === "es" ? "Examinar…" : "Browse…"}
              </button>
              <button
                type="button"
                className="btn-secondary"
                disabled={savingCustom}
                onClick={() => void handleSaveCustomRuntime()}
              >
                {locale === "es" ? "Usar" : "Apply"}
              </button>
              {status?.custom_binary_path && (
                <button
                  type="button"
                  className="icon-btn"
                  title={locale === "es" ? "Restaurar runtime gestionado" : "Reset to managed runtime"}
                  onClick={() => void handleSaveCustomRuntime("")}
                >
                  <X size={13} />
                </button>
              )}
            </div>
            {customNotice && (
              <span style={{ fontSize: 11.5, color: "#34d399" }}>{customNotice}</span>
            )}
          </div>

          {status && status.installed.length > 0 && (
            <div className="installed-list">
              <div className="panel-title">
                {locale === "es" ? "Runtimes instalados" : "Installed runtimes"}
              </div>
              {status.installed.map((rt) => (
                <div key={rt.backend} className="installed-item">
                  <CheckCircle2 size={15} className="installed-ok" />
                  <div className="installed-meta">
                    <div className="installed-name">
                      {BACKEND_LABELS[rt.backend]} ·{" "}
                      <span>{rt.version}</span>
                    </div>
                    <div className="installed-path">{rt.binary_path}</div>
                  </div>
                  <button
                    type="button"
                    className="icon-btn danger"
                    title={locale === "es" ? "Desinstalar runtime" : "Uninstall runtime"}
                    disabled={downloading}
                    onClick={() => handleUninstall(rt.backend)}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
            </div>
          )}

          {progress && (
            <div className="download-box">
              <div className="download-msg">{progress.message}</div>
              {progress.percent !== null && (
                <div className="progress-track">
                  <div
                    className="progress-fill"
                    style={{ width: `${Math.min(100, Math.max(0, progress.percent))}%` }}
                  />
                </div>
              )}
            </div>
          )}

          {error && hardware && <div className="hw-error">{error}</div>}

          <div className="modal-footer" style={embedded ? { justifyContent: "flex-start" } : undefined}>
            <button
              type="button"
              className="btn-primary"
              disabled={downloading || !hardware}
              onClick={handleInstall}
            >
              <Download size={14} />
              <span>
                {downloading ? "Downloading llama.cpp…" : t("runtime.install")}
              </span>
            </button>
            {!embedded && (
              <button type="button" className="btn-secondary" onClick={onClose}>
                {t("runtime.done")}
              </button>
            )}
          </div>
        </div>
  );

  if (embedded) return innerBody;

  return (
    <ModalBackdrop label={t("runtime.title")} onClose={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div className="modal-title">
            <Cpu size={18} />
            <span>{t("runtime.title")}</span>
          </div>
          <button type="button" className="icon-btn" aria-label={t("models.close")} onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        {innerBody}
      </div>
    </ModalBackdrop>
  );
}
