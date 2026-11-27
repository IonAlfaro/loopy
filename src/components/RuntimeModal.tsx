import { ModalBackdrop } from "./ModalBackdrop";
import { useEffect, useState } from "react";
import { CheckCircle2, Cpu, Download, FolderOpen, Gauge, MemoryStick, Trash2, X } from "lucide-react";
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

  const L = (en: string, es: string) => locale === "es" ? es : en;
  const backendLabel = (backend: RuntimeBackendKind) => backend === "auto"
    ? L("Automatic", "Automático")
    : BACKEND_LABELS[backend];
  const installed = status?.installed ?? [];
  const innerBody = (
    <div className={`modal-body runtime-settings ${embedded ? "is-embedded" : ""}`}>
      <section className="runtime-preference">
        <div className="runtime-preference-title">
          <span className="runtime-section-icon"><Gauge size={17} /></span>
          <div>
            <label className="runtime-section-title" htmlFor="runtime-backend">
              {L("Inference engine", "Motor de inferencia")}
            </label>
            {hardware && (
              <p>{L("Recommended for this device", "Recomendado para este equipo")} · <strong>{backendLabel(hardware.recommended_backend)}</strong></p>
            )}
          </div>
        </div>
        <select id="runtime-backend" className="cloud-field-input" value={selectedBackend} disabled={downloading}
          onChange={(event) => setSelectedBackend(event.target.value as RuntimeBackendKind)}>
          {backends.map((backend) => (
            <option key={backend} value={backend}>{backendLabel(backend)}</option>
          ))}
        </select>
      </section>

      <section className="runtime-installed">
        <div className="runtime-section-head">
          <h3 className="runtime-section-title">{L("Installed runtimes", "Runtimes instalados")}</h3>
          <button type="button" className="btn-primary" disabled={downloading || !hardware} onClick={handleInstall}>
            <Download size={14} />
            {downloading ? L("Downloading…", "Descargando…") : installed.length
              ? L("Download or update", "Descargar o actualizar") : L("Download llama.cpp", "Descargar llama.cpp")}
          </button>
        </div>
        {installed.length > 0 ? (
          <div className="runtime-installed-list">
            {installed.map((runtime) => (
              <div key={runtime.backend} className="runtime-installed-row">
                <CheckCircle2 size={16} className="installed-ok" aria-hidden="true" />
                <div className="runtime-installed-meta">
                  <strong>{BACKEND_LABELS[runtime.backend]}</strong>
                  <span className="runtime-installed-path truncate-text" title={runtime.binary_path}>{runtime.binary_path}</span>
                </div>
                <span className="runtime-version">{runtime.version}</span>
                <button type="button" className="icon-btn danger" disabled={downloading}
                  title={L("Uninstall runtime", "Desinstalar runtime")}
                  aria-label={`${L("Uninstall", "Desinstalar")} ${BACKEND_LABELS[runtime.backend]}`}
                  onClick={() => void handleUninstall(runtime.backend)}>
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>
        ) : status && (
          <p className="runtime-empty">{L("No Loors-managed runtimes installed.", "No hay runtimes gestionados por Loors instalados.")}</p>
        )}
        {progress && (
          <div className="download-box" role="status">
            <div className="download-msg">{progress.message}</div>
            {progress.percent !== null && (
              <div className="progress-track">
                <div className="progress-fill" style={{ width: `${Math.min(100, Math.max(0, progress.percent))}%` }} />
              </div>
            )}
          </div>
        )}
      </section>

      {hardware ? (
        <section className="runtime-device">
          <h3 className="runtime-section-title">{L("This device", "Este equipo")}</h3>
          <dl className="runtime-hardware-grid">
            <div>
              <dt><Cpu size={14} /> CPU</dt>
              <dd>{hardware.cpu_brand}</dd>
              <dd className="runtime-hardware-detail">{hardware.cpu_cores} {L("threads", "hilos")}</dd>
            </div>
            <div>
              <dt><MemoryStick size={14} /> RAM</dt>
              <dd>{(hardware.total_ram_mb / 1024).toFixed(1)} GB</dd>
            </div>
            <div>
              <dt><Gauge size={14} /> GPU</dt>
              {hardware.gpus.length ? hardware.gpus.map((gpu, index) => (
                <dd key={index}>{gpu.name}{gpu.vram_mb ? ` · ${(gpu.vram_mb / 1024).toFixed(1)} GB VRAM` : ""}</dd>
              )) : <dd>{L("None detected", "No detectada")}</dd>}
            </div>
          </dl>
        </section>
      ) : !error && <p className="runtime-empty" role="status">{L("Detecting hardware…", "Detectando hardware…")}</p>}

      <details className="runtime-advanced">
        <summary>
          <span>{L("Custom binary", "Binario personalizado")}</span>
          {status?.custom_binary_path && <span className="runtime-version">{L("In use", "En uso")}</span>}
        </summary>
        <div className="runtime-custom-body">
          <p>{L("Use a compatible llama-server binary instead of the Loors-managed runtime.", "Usa un binario llama-server compatible en lugar del runtime gestionado por Loors.")}</p>
          <label className="cloud-field-label">
            <span>{L("Binary path", "Ruta del binario")}</span>
            <input type="text" className="cloud-field-input" value={customPath}
              onChange={(event) => setCustomPath(event.target.value)}
              placeholder={L("/path/to/llama-server", "Ruta a llama-server")} />
          </label>
          <div className="runtime-custom-actions">
            <button type="button" className="btn-secondary" disabled={savingCustom} onClick={() => void handleBrowseCustomRuntime()}>
              <FolderOpen size={14} /> {L("Browse…", "Examinar…")}
            </button>
            <button type="button" className="btn-primary" disabled={savingCustom} onClick={() => void handleSaveCustomRuntime()}>
              {L("Apply", "Aplicar")}
            </button>
            {status?.custom_binary_path && (
              <button type="button" className="btn-secondary" disabled={savingCustom} onClick={() => void handleSaveCustomRuntime("")}>
                {L("Use Loors runtime", "Usar runtime de Loors")}
              </button>
            )}
          </div>
          {customNotice && <p role="status">{customNotice}</p>}
        </div>
      </details>

      {error && <div className="hw-error" role="alert">{error}</div>}
      {!embedded && (
        <div className="modal-footer">
          <button type="button" className="btn-secondary" onClick={onClose}>{t("runtime.done")}</button>
        </div>
      )}
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
