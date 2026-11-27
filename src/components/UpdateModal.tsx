import { ModalBackdrop } from "./ModalBackdrop";
import { useCallback, useEffect, useRef, useState } from "react";
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
  const [appVersion, setAppVersion] = useState<string | null>(null);
  const [result, setResult] = useState<UpdateCheckResult | null>(initialResult);
  const [checking, setChecking] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [progress, setProgress] = useState<UpdateProgressEvent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const checkedOnOpen = useRef(false);

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
    if (!open) {
      checkedOnOpen.current = false;
      return;
    }
    invoke<string>("get_app_version")
      .then(setAppVersion)
      .catch(() => {});
  }, [open]);

  useEffect(() => {
    if (!open || checkedOnOpen.current) return;
    checkedOnOpen.current = true;
    if (!initialResult) {
      void runCheck();
    }
  }, [open, initialResult, runCheck]);

  if (!open) return null;

  const handleInstall = async () => {
    if (checking || installing || !result?.updateAvailable || !result.assetUrl || !result.assetName) return;
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
    let unlisten: (() => void) | undefined;
    let restarting = false;
    try {
      unlisten = await listen<UpdateProgressEvent>("loors://update-progress", (ev) => {
        setProgress(ev.payload);
      });
      restarting = await invoke<boolean>("install_app_update", {
        expectedVersion: result.latestVersion,
      });
      const assetName = result.assetName.toLowerCase();
      if (restarting) {
        setStatusMsg(L("Loors will restart to apply the update.", "Loors se reiniciará para aplicar la actualización."));
      } else if (assetName.endsWith(".dmg")) {
        setStatusMsg(L(
          "The disk image is open. Close Loors, then drag the new Loors app into Applications.",
          "La imagen de disco está abierta. Cierra Loors y arrastra la nueva aplicación a Aplicaciones.",
        ));
      } else if (assetName.endsWith(".appimage")) {
        setStatusMsg(L(
          "Close Loors and replace your current AppImage with the downloaded one.",
          "Cierra Loors y sustituye tu AppImage actual por el que acabas de descargar.",
        ));
      } else {
        setStatusMsg(L("Complete the update using the downloaded package.", "Completa la actualización con el paquete descargado."));
      }
    } catch (err) {
      setError(typeof err === "string" ? err : String(err));
    } finally {
      unlisten?.();
      if (!restarting) setInstalling(false);
    }
  };

  const pct = progress?.percent != null ? Math.min(100, Math.max(0, progress.percent)) : null;
  const stageLabel =
    progress?.stage === "installing"
      ? L("Preparing installer…", "Preparando el instalador…")
      : progress?.stage === "starting" || progress?.stage === "connecting"
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
            <span className="update-ver-badge">{result ? `v${result.currentVersion}` : appVersion ? `v${appVersion}` : "—"}</span>
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
                  disabled={checking || installing}
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
          {result.updateAvailable && (!result.assetUrl || !result.assetName) && (
            <p>{L("This release has no installer for your platform. Check the release notes for details.", "Esta versión no incluye un instalador para tu plataforma. Consulta las notas de la versión.")}</p>
          )}
        </div>
      )}

      {statusMsg && (
        <div className="update-status-ok" role="status">
          <CheckCircle2 size={14} />
          <span>{statusMsg}</span>
        </div>
      )}
      {error && <div className="hw-error" role="alert">{error}</div>}
    </div>
  );

  if (embedded) return innerBody;

  return (
    <ModalBackdrop label={t("updates.title")} onClose={onClose}>
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
    </ModalBackdrop>
  );
}
