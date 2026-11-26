import { useCallback, useEffect, useState } from "react";
import {
  ArrowDownToLine,
  CheckCircle2,
  ExternalLink,
  RefreshCw,
  X,
} from "lucide-react";
import { invoke } from "../lib/bridge";
import { listen } from "../lib/bridge";
import { useI18n } from "../i18n";

export interface UpdateCheckResult {
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  repo: string;
  releaseUrl: string;
  releaseNotes: string;
  assetName: string | null;
  assetUrl: string | null;
  assetSize: number | null;
}

interface UpdateProgressEvent {
  stage: string;
  downloadedBytes: number;
  totalBytes: number | null;
  percent: number | null;
  message: string;
}

interface UpdateModalProps {
  open: boolean;
  embedded?: boolean;
  initialResult: UpdateCheckResult | null;
  onClose: () => void;
  onUpdateChecked: (res: UpdateCheckResult | null) => void;
}

function formatSize(bytes: number | null): string {
  if (!bytes) return "";
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function UpdateModal({
  open,
  embedded = false,
  initialResult,
  onClose,
  onUpdateChecked,
}: UpdateModalProps) {
  const { locale, t } = useI18n();
  const L = (en: string, es: string) => (locale === "es" ? es : en);
  const [appVersion, setAppVersion] = useState("0.1.0");
  const [result, setResult] = useState<UpdateCheckResult | null>(initialResult);
  const [checking, setChecking] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [progress, setProgress] = useState<UpdateProgressEvent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  useEffect(() => {
    setResult(initialResult);
  }, [initialResult]);

  const runCheck = useCallback(async () => {
    setChecking(true);
    setError(null);
    setStatusMsg(null);
    try {
      const res = await invoke<UpdateCheckResult>("check_app_update", {
        repo: null,
      });
      setResult(res);
      onUpdateChecked(res);
    } catch (err) {
      setError(typeof err === "string" ? err : String(err));
    } finally {
      setChecking(false);
    }
  }, [onUpdateChecked]);

  useEffect(() => {
    if (!open) return;
    invoke<string>("get_app_version")
      .then(setAppVersion)
      .catch(() => {});
    if (!initialResult) {
      void runCheck();
    }

    let cancelled = false;
    let unlisten: (() => void) | undefined;
    listen<UpdateProgressEvent>("loors://update-progress", (ev) => {
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
  }, [open, initialResult, runCheck]);

  if (!open) return null;

  const handleInstall = async () => {
    if (!result?.assetUrl || !result.assetName) return;
    setInstalling(true);
    setError(null);
    setProgress(null);
    try {
      const saved = await invoke<string>("install_app_update", {
        assetUrl: result.assetUrl,
        assetName: result.assetName,
      });
      setStatusMsg(L(`Installer started: ${saved}`, `Instalador iniciado: ${saved}`));
    } catch (err) {
      setError(typeof err === "string" ? err : String(err));
      setInstalling(false);
    }
  };

  const innerBody = (
    <div className="modal-body" style={{ display: "flex", flexDirection: "column", gap: 12, padding: embedded ? 0 : undefined }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "10px 12px",
              borderRadius: 10,
              background: "rgba(255,255,255,0.03)",
              border: "1px solid rgba(255,255,255,0.08)",
            }}
          >
            <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              <span style={{ fontSize: 12, color: "#94a3b8" }}>{t("updates.installed")}</span>
              <strong style={{ fontSize: 14, color: "#f1f5f9" }}>v{appVersion}</strong>
            </div>
            <button
              type="button"
              className="btn-secondary"
              disabled={checking || installing}
              onClick={() => void runCheck()}
            >
              <RefreshCw size={13} className={checking ? "spin" : ""} />
              <span>{checking ? t("updates.checking") : t("updates.check")}</span>
            </button>
          </div>

          {result && (
            <div
              style={{
                padding: "12px",
                borderRadius: 10,
                background: result.updateAvailable
                  ? "rgba(139,92,246,0.08)"
                  : "rgba(16,185,129,0.07)",
                border: result.updateAvailable
                  ? "1px solid rgba(167,139,250,0.35)"
                  : "1px solid rgba(16,185,129,0.28)",
                display: "flex",
                flexDirection: "column",
                gap: 8,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  {result.updateAvailable ? (
                    <ArrowDownToLine size={16} style={{ color: "#a78bfa" }} />
                  ) : (
                    <CheckCircle2 size={16} style={{ color: "#10b981" }} />
                  )}
                  <strong style={{ fontSize: 13.5, color: "#f8fafc" }}>
                    {result.updateAvailable
                      ? L(`New version available: v${result.latestVersion}`, `Nueva versión disponible: v${result.latestVersion}`)
                      : L(`Loors is up to date (v${result.currentVersion})`, `Loors está actualizado (v${result.currentVersion})`)}
                  </strong>
                </div>
                {result.releaseUrl && (
                  <a
                    href={result.releaseUrl}
                    target="_blank"
                    rel="noreferrer"
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 4,
                      fontSize: 11.5,
                      color: "#a78bfa",
                      textDecoration: "none",
                    }}
                  >
                    <span>{L("View release", "Ver release")}</span>
                    <ExternalLink size={11} />
                  </a>
                )}
              </div>

              {result.releaseNotes.trim() && (
                <pre
                  style={{
                    margin: 0,
                    maxHeight: 140,
                    overflowY: "auto",
                    whiteSpace: "pre-wrap",
                    fontSize: 12,
                    color: "#cbd5e1",
                    background: "rgba(15,23,42,0.55)",
                    padding: "8px 10px",
                    borderRadius: 6,
                    fontFamily: "inherit",
                  }}
                >
                  {result.releaseNotes.trim()}
                </pre>
              )}

              {result.updateAvailable && result.assetUrl && result.assetName && (
                <button
                  type="button"
                  className="btn-primary"
                  disabled={installing}
                  onClick={() => void handleInstall()}
                >
                  <ArrowDownToLine size={14} />
                  <span>
                    {installing
                      ? "Descargando actualización…"
                      : `Descargar e instalar ${result.assetName}${
                          result.assetSize ? ` (${formatSize(result.assetSize)})` : ""
                        }`}
                  </span>
                </button>
              )}
            </div>
          )}

          {progress && (
            <div className="download-box">
              <div className="download-msg">{progress.message}</div>
              {progress.percent !== null && (
                <div className="progress-track">
                  <div
                    className="progress-fill"
                    style={{
                      width: `${Math.min(100, Math.max(0, progress.percent))}%`,
                    }}
                  />
                </div>
              )}
            </div>
          )}

          {statusMsg && (
            <div style={{ fontSize: 12, color: "#34d399" }}>{statusMsg}</div>
          )}
          {error && <div className="hw-error">{error}</div>}
        </div>
  );

  if (embedded) return innerBody;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal-card"
        style={{ maxWidth: 520 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <div className="modal-title">
            <ArrowDownToLine size={17} style={{ color: "#38bdf8" }} />
            <span>{t("updates.title")}</span>
          </div>
          <button type="button" className="icon-btn" aria-label={t("models.close")} onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        {innerBody}
      </div>
    </div>
  );
}
