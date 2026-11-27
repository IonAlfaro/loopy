import {
  AlertCircle,
  Check,
  ChevronDown,
  ChevronUp,
  Download,
  RefreshCw,
  Trash2,
  X,
} from "lucide-react";
import { useGraphStore } from "../store/useGraphStore";
import { useI18n } from "../i18n";
import { parseGgufMetadata, type ModelDownloadItem } from "../types/graph";

interface DownloadsDockProps {
  onNotice?: (msg: string) => void;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function formatSpeed(bps: number | null | undefined): string | null {
  if (!bps || bps <= 0) return null;
  if (bps >= 1024 * 1024) {
    return `${(bps / (1024 * 1024)).toFixed(1)} MB/s`;
  }
  return `${Math.round(bps / 1024)} KB/s`;
}

function formatEta(item: ModelDownloadItem): string | null {
  if (
    !item.speed_bps ||
    item.speed_bps <= 0 ||
    !item.total_bytes ||
    item.total_bytes <= item.downloaded_bytes
  ) {
    return null;
  }
  const secs = Math.ceil((item.total_bytes - item.downloaded_bytes) / item.speed_bps);
  if (secs < 60) return `~${secs}s`;
  const mins = Math.floor(secs / 60);
  const remSecs = secs % 60;
  if (mins < 60) return `~${mins}m ${remSecs.toString().padStart(2, "0")}s`;
  const hrs = Math.floor(mins / 60);
  return `~${hrs}h ${mins % 60}m`;
}

export function DownloadsDock({ onNotice }: DownloadsDockProps) {
  const { locale } = useI18n();
  const modelDownloads = useGraphStore((s) => s.modelDownloads);
  const downloadsDockOpen = useGraphStore((s) => s.downloadsDockOpen);
  const setDownloadsDockOpen = useGraphStore((s) => s.setDownloadsDockOpen);
  const startModelDownload = useGraphStore((s) => s.startModelDownload);
  const cancelModelDownload = useGraphStore((s) => s.cancelModelDownload);
  const dismissModelDownload = useGraphStore((s) => s.dismissModelDownload);
  const clearFinishedDownloads = useGraphStore((s) => s.clearFinishedDownloads);
  const activeModelPath = useGraphStore((s) => s.activeModelPath);
  const setActiveModelPath = useGraphStore((s) => s.setActiveModelPath);

  const items = Object.values(modelDownloads).sort((a, b) => {
    const aActive = a.stage === "starting" || a.stage === "downloading" ? 0 : 1;
    const bActive = b.stage === "starting" || b.stage === "downloading" ? 0 : 1;
    if (aActive !== bActive) return aActive - bActive;
    return b.updatedAt - a.updatedAt;
  });

  if (items.length === 0) return null;

  const activeItems = items.filter(
    (d) => d.stage === "starting" || d.stage === "downloading"
  );
  const finishedCount = items.length - activeItems.length;

  const aggregatePct = (() => {
    if (activeItems.length === 0) return 100;
    let sumDone = 0;
    let sumTotal = 0;
    for (const d of activeItems) {
      if (d.total_bytes && d.total_bytes > 0) {
        sumDone += d.downloaded_bytes;
        sumTotal += d.total_bytes;
      }
    }
    if (sumTotal > 0) {
      return Math.min(100, Math.round((sumDone / sumTotal) * 100));
    }
    const pcts = activeItems.map((d) => d.percent ?? 0);
    return Math.round(pcts.reduce((a, b) => a + b, 0) / pcts.length);
  })();

  const totalSpeedBps = activeItems.reduce((acc, d) => acc + (d.speed_bps ?? 0), 0);
  const totalSpeedLabel = formatSpeed(totalSpeedBps);

  return (
    <div className={`downloads-dock ${downloadsDockOpen ? "is-open" : ""}`}>
      {downloadsDockOpen && (
        <div className="downloads-drawer" role="region" aria-label="Model downloads">
          <div className="downloads-drawer-head">
            <div className="downloads-drawer-title">
              <Download size={14} style={{ color: "#38bdf8" }} />
              <span>
                {locale === "es" ? "Descargas de modelos" : "Model Downloads"}
              </span>
              {activeItems.length > 0 && (
                <span className="downloads-count-pill">
                  {activeItems.length}{" "}
                  {locale === "es"
                    ? activeItems.length === 1
                      ? "activa"
                      : "activas"
                    : "active"}
                </span>
              )}
            </div>
            <div className="downloads-drawer-actions">
              {finishedCount > 0 && (
                <button
                  type="button"
                  className="downloads-head-btn"
                  title={locale === "es" ? "Limpiar completadas" : "Clear finished"}
                  onClick={clearFinishedDownloads}
                >
                  <Trash2 size={12} />
                  <span>{locale === "es" ? "Limpiar" : "Clear"}</span>
                </button>
              )}
              <button
                type="button"
                className="icon-btn"
                title={locale === "es" ? "Minimizar" : "Minimize"}
                onClick={() => setDownloadsDockOpen(false)}
              >
                <ChevronDown size={14} />
              </button>
            </div>
          </div>

          <div className="downloads-list">
            {items.map((item) => {
              const meta = parseGgufMetadata(item.filename, item.total_bytes ?? 0);
              const isRunning =
                item.stage === "starting" || item.stage === "downloading";
              const isDone = item.stage === "done";
              const isErr = item.stage === "error" || item.stage === "cancelled";
              const pct = Math.min(100, Math.max(0, item.percent ?? (isDone ? 100 : 0)));
              const speed = formatSpeed(item.speed_bps);
              const eta = formatEta(item);
              const isActiveModel =
                Boolean(item.saved_path) && activeModelPath === item.saved_path;

              return (
                <div
                  key={item.key}
                  className={`dl-item ${isDone ? "is-done" : isErr ? "is-error" : "is-running"}`}
                >
                  <div className="dl-item-top">
                    <div className="dl-item-info">
                      <div className="dl-item-title-row">
                        <span className={`quant-pill ${meta.quantColor}`}>
                          {meta.quant}
                        </span>
                        <span className="dl-item-name truncate-text" title={item.filename}>
                          {meta.baseName || item.filename}
                        </span>
                      </div>
                      <div className="dl-item-repo truncate-text" title={item.repo_id}>
                        {item.repo_id}
                      </div>
                    </div>

                    <div className="dl-item-controls">
                      {isRunning && (
                        <button
                          type="button"
                          className="icon-btn danger"
                          title={locale === "es" ? "Cancelar descarga" : "Cancel download"}
                          onClick={() =>
                            void cancelModelDownload(item.repo_id, item.filename)
                          }
                        >
                          <X size={13} />
                        </button>
                      )}
                      {isDone && item.saved_path && (
                        <button
                          type="button"
                          className={
                            isActiveModel ? "btn-mini active-select" : "btn-mini"
                          }
                          onClick={() => {
                            setActiveModelPath(item.saved_path!);
                            onNotice?.(
                              locale === "es"
                                ? `Modelo activo: ${meta.baseName || item.filename}`
                                : `Active model: ${meta.baseName || item.filename}`
                            );
                          }}
                        >
                          <Check size={12} />
                          <span>
                            {isActiveModel
                              ? locale === "es"
                                ? "Activo"
                                : "Active"
                              : locale === "es"
                                ? "Usar"
                                : "Use"}
                          </span>
                        </button>
                      )}
                      {isErr && (
                        <button
                          type="button"
                          className="icon-btn"
                          title={locale === "es" ? "Reintentar descarga" : "Retry download"}
                          onClick={() =>
                            void startModelDownload(
                              item.repo_id,
                              item.filename,
                              item.total_bytes
                            )
                          }
                        >
                          <RefreshCw size={12} />
                        </button>
                      )}
                      {!isRunning && (
                        <button
                          type="button"
                          className="icon-btn"
                          title={locale === "es" ? "Ocultar" : "Dismiss"}
                          onClick={() => dismissModelDownload(item.key)}
                        >
                          <X size={12} />
                        </button>
                      )}
                    </div>
                  </div>

                  {isRunning && (
                    <>
                      <div className="dl-progress-track">
                        <div
                          className="dl-progress-fill"
                          style={{ width: `${Math.max(2, pct)}%` }}
                        />
                      </div>
                      <div className="dl-item-metrics tabular-nums">
                        <span>
                          {formatBytes(item.downloaded_bytes)}
                          {item.total_bytes ? ` / ${formatBytes(item.total_bytes)}` : ""}
                        </span>
                        <span>
                          {[
                            `${pct.toFixed(1)}%`,
                            speed,
                            eta,
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        </span>
                      </div>
                    </>
                  )}

                  {isDone && (
                    <div className="dl-item-status-ok">
                      <Check size={12} />
                      <span>
                        {locale === "es" ? "Descargado" : "Downloaded"}
                        {item.total_bytes ? ` · ${formatBytes(item.total_bytes)}` : ""}
                      </span>
                    </div>
                  )}

                  {isErr && (
                    <div className="dl-item-status-err">
                      <AlertCircle size={12} />
                      <span className="truncate-text" title={item.message}>
                        {item.stage === "cancelled"
                          ? locale === "es"
                            ? "Descarga cancelada"
                            : "Download cancelled"
                          : item.message}
                      </span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      <button
        type="button"
        className={`downloads-pill ${activeItems.length > 0 ? "is-active" : "is-idle"}`}
        onClick={() => setDownloadsDockOpen(!downloadsDockOpen)}
        title={
          locale === "es"
            ? "Ver descargas de modelos en segundo plano"
            : "View background model downloads"
        }
      >
        <span className="downloads-pill-icon">
          {activeItems.length > 0 ? (
            <Download size={13} className="dl-pulse-icon" />
          ) : (
            <Check size={13} style={{ color: "#4ade80" }} />
          )}
        </span>
        <span className="downloads-pill-text tabular-nums">
          {activeItems.length > 0
            ? locale === "es"
              ? `Descargando ${activeItems.length} ${activeItems.length === 1 ? "modelo" : "modelos"} · ${aggregatePct}%${totalSpeedLabel ? ` · ${totalSpeedLabel}` : ""}`
              : `Downloading ${activeItems.length} ${activeItems.length === 1 ? "model" : "models"} · ${aggregatePct}%${totalSpeedLabel ? ` · ${totalSpeedLabel}` : ""}`
            : locale === "es"
              ? `${items.length} ${items.length === 1 ? "descarga lista" : "descargas listas"}`
              : `${items.length} ${items.length === 1 ? "download ready" : "downloads ready"}`}
        </span>
        {activeItems.length > 0 && (
          <span className="downloads-pill-bar">
            <span style={{ width: `${Math.max(4, aggregatePct)}%` }} />
          </span>
        )}
        {downloadsDockOpen ? <ChevronDown size={13} /> : <ChevronUp size={13} />}
      </button>
    </div>
  );
}
