import { useCallback, useEffect, useState } from "react";
import {
  ArrowDownToLine,
  ArrowRight,
  CheckCircle2,
  ExternalLink,
  RefreshCw,
  Sparkles,
  X,
} from "lucide-react";
import { invoke, listen } from "../lib/bridge";
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
    setStatusMsg(null);
    setProgress({
      stage: "starting",
      downloadedBytes: 0,
      totalBytes: result.assetSize,
      percent: 0,
      message: L("Connecting to release server…", "Conectando con el servidor…"),
    });
    try {
      await invoke<string>("install_app_update", {
        assetUrl: result.assetUrl,
        assetName: result.assetName,
      });
      setStatusMsg(
        L(
          "Installer launched silently — Loors will restart shortly.",
          "Instalador silencioso iniciado — Loors se reiniciará en unos segundos."
        )
      );
    } catch (err) {
      setError(typeof err === "string" ? err : String(err));
      setInstalling(false);
    }
  };

  const pct = progress?.percent != null ? Math.min(100, Math.max(0, progress.percent)) : null;
  const stageLabel =
    progress?.stage === "installing" || pct === 100
      ? L("Installing & relaunching…", "Instalando y reiniciando…")
      : progress?.stage === "starting"
        ? L("Connecting…", "Conectando…")
        : L("Downloading update…", "Descargando actualización…");

  const innerBody = (
    <div
      className="modal-body update-panel"
      style={{ padding: embedded ? 0 : undefined }}
    >
      <div className="update-version-row">
        <div className="update-version-meta">
          <span className="update-eyebrow">{t("updates.installed")}</span>
          <div className="update-version-pills tabular-nums">
            <span className="update-ver-badge">v{appVersion}</span>
            {result?.updateAvailable && (
              <>
                <ArrowRight size={13} style={{ color: "var(--text-muted)" }} />
                <span className="update-ver-badge is-next">
                  v{result.latestVersion}
                </span>
              </>
            )}
          </div>
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
          className={`update-release-card ${
            result.updateAvailable ? "is-available" : "is-current"
          }`}
        >
          <div className="update-release-head">
            <div className="update-release-title">
              {result.updateAvailable ? (
                <Sparkles size={15} style={{ color: "#a78bfa", flexShrink: 0 }} />
              ) : (
                <CheckCircle2 size={15} style={{ color: "#34d399", flexShrink: 0 }} />
              )}
              <span>
                {result.updateAvailable
                  ? L(
                      `Loors v${result.latestVersion} is ready`,
                      `Loors v${result.latestVersion} disponible`
                    )
                  : L(
                      `You're on the latest version (v${result.currentVersion})`,
                      `Ya tienes la última versión (v${result.currentVersion})`
                    )}
              </span>
            </div>

            {result.releaseUrl && (
              <a
                href={result.releaseUrl}
                target="_blank"
                rel="noreferrer"
                className="update-release-link"
              >
                <span>{L("Release notes", "Notas")}</span>
                <ExternalLink size={11} />
              </a>
            )}
          </div>

          {result.releaseNotes.trim() && (
            <pre className="update-notes-pre">{result.releaseNotes.trim()}</pre>
          )}

          {result.updateAvailable && result.assetUrl && result.assetName && (
            installing && progress ? (
              <div className="update-progress-inline">
                <div className="update-progress-top">
                  <span className="update-progress-stage">
                    <span className="update-progress-dot" />
                    <span>{stageLabel}</span>
                  </span>
                  <span className="update-progress-nums tabular-nums">
                    {progress.downloadedBytes > 0 && (
                      <>
                        {formatSize(progress.downloadedBytes)}
                        {progress.totalBytes
                          ? ` / ${formatSize(progress.totalBytes)}`
                          : ""}
                        {pct !== null ? " · " : ""}
                      </>
                    )}
                    {pct !== null ? `${Math.round(pct)}%` : ""}
                  </span>
                </div>
                <div className="update-hairline-track">
                  <div
                    className={`update-hairline-fill ${
                      pct === null ? "is-indeterminate" : ""
                    }`}
                    style={{ width: pct !== null ? `${Math.max(3, pct)}%` : "35%" }}
                  />
                </div>
              </div>
            ) : (
              <div className="update-action-row">
                <button
                  type="button"
                  className="btn-primary update-install-btn"
                  disabled={installing}
                  onClick={() => void handleInstall()}
                >
                  <ArrowDownToLine size={14} />
                  <span>
                    {L(
                      `Update to v${result.latestVersion}`,
                      `Actualizar a v${result.latestVersion}`
                    )}
                  </span>
                  {result.assetSize && (
                    <span className="update-size-chip tabular-nums">
                      {formatSize(result.assetSize)}
                    </span>
                  )}
                </button>
              </div>
            )
          )}
        </div>
      )}

      {statusMsg && (
        <div className="update-status-ok">
          <CheckCircle2 size={14} />
          <span>{statusMsg}</span>
        </div>
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
          <button
            type="button"
            className="icon-btn"
            aria-label={t("models.close")}
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </div>
        {innerBody}
      </div>
    </div>
  );
}
