import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDownToLine,
  ChevronDown,
  ChevronUp,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { invoke } from "../lib/bridge";
import { useGraphStore } from "../store/useGraphStore";
import { useI18n } from "../i18n";
import type { WorkspaceMemoryFileInfo } from "../types/graph";

const STATUS_LABELS: Record<string, { en: string; es: string }> = {
  idle: { en: "Ready", es: "Listo" },
  running: { en: "Running", es: "Ejecutando" },
  completed: { en: "Done", es: "Completado" },
  exhausted: { en: "Limit reached", es: "Límite alcanzado" },
  failed: { en: "Failed", es: "Error" },
  cancelled: { en: "Stopped", es: "Detenido" },
};

export function ConsolePanel() {
  const { locale } = useI18n();
  const L = (en: string, es: string) => (locale === "es" ? es : en);
  const nodes = useGraphStore((s) => s.nodes);
  const runStatus = useGraphStore((s) => s.runStatus);
  const currentIteration = useGraphStore((s) => s.currentIteration);
  const maxIterations = useGraphStore((s) => s.maxIterations);
  const runSummary = useGraphStore((s) => s.runSummary);
  const activeActivity = useGraphStore((s) => s.activeActivity);
  const logs = useGraphStore((s) => s.logs);
  const consoleOpen = useGraphStore((s) => s.consoleOpen);
  const setConsoleOpen = useGraphStore((s) => s.setConsoleOpen);
  const clearLogs = useGraphStore((s) => s.clearLogs);

  const [tab, setTab] = useState<"logs" | "diff" | "reports">("logs");
  const [iterFilter, setIterFilter] = useState<number | "all">("all");
  const [autoScroll, setAutoScroll] = useState(true);
  const [panelHeight, setPanelHeight] = useState(230);
  const [diffText, setDiffText] = useState<string>("");
  const [loadingDiff, setLoadingDiff] = useState(false);
  const [reportFiles, setReportFiles] = useState<WorkspaceMemoryFileInfo[]>([]);
  const [selectedReportPath, setSelectedReportPath] = useState<string>("");
  const [loadingReports, setLoadingReports] = useState(false);
  const prevRunStatusRef = useRef(runStatus);

  const bodyRef = useRef<HTMLDivElement>(null);
  const lastScrollTopRef = useRef<number>(0);
  const programmaticScrollRef = useRef<boolean>(false);

  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = panelHeight;
    const onMove = (ev: MouseEvent) => {
      const next = Math.min(520, Math.max(120, startH + (startY - ev.clientY)));
      setPanelHeight(next);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const iterations = useMemo(() => {
    const set = new Set<number>();
    for (const l of logs) set.add(l.iteration);
    return Array.from(set).sort((a, b) => a - b);
  }, [logs]);

  const filteredLogs = useMemo(() => {
    if (iterFilter === "all") return logs;
    return logs.filter((l) => l.iteration === iterFilter);
  }, [logs, iterFilter]);

  const lastLogLen = filteredLogs.length > 0 ? filteredLogs[filteredLogs.length - 1].text.length : 0;

  const scrollToBottom = useCallback(() => {
    const el = bodyRef.current;
    if (!el) return;
    programmaticScrollRef.current = true;
    el.scrollTop = el.scrollHeight;
    lastScrollTopRef.current = el.scrollTop;
    window.requestAnimationFrame(() => {
      programmaticScrollRef.current = false;
    });
  }, []);

  useEffect(() => {
    if (!consoleOpen || tab !== "logs" || !autoScroll) return;
    scrollToBottom();
  }, [filteredLogs.length, lastLogLen, consoleOpen, tab, autoScroll, scrollToBottom]);

  const handleScroll = () => {
    const el = bodyRef.current;
    if (!el || el.scrollHeight <= el.clientHeight + 8) return;
    const prevTop = lastScrollTopRef.current;
    const curTop = el.scrollTop;
    lastScrollTopRef.current = curTop;

    if (programmaticScrollRef.current) return;

    const distFromBottom = el.scrollHeight - curTop - el.clientHeight;
    // Only pause auto-scroll when the user genuinely scrolls UP (never when new log lines grow scrollHeight)
    if (curTop < prevTop - 4 && distFromBottom > 24 && autoScroll) {
      setAutoScroll(false);
    } else if (distFromBottom < 12 && !autoScroll) {
      // Re-engage auto-scroll automatically when the user scrolls back to the bottom
      setAutoScroll(true);
    }
  };

  const getActiveWorkspace = useCallback(() => {
    const inputNode = nodes.find((n) => n.data.kind === "task_input");
    return String(inputNode?.data.config.workspace ?? ".");
  }, [nodes]);

  const refreshDiff = useCallback(async () => {
    const workspace = getActiveWorkspace();
    setLoadingDiff(true);
    try {
      const diff = await invoke<string>("get_workspace_diff", { workspace });
      setDiffText(diff);
    } catch {
      setDiffText("Disponible en modo escritorio (Tauri).");
    } finally {
      setLoadingDiff(false);
    }
  }, [getActiveWorkspace]);

  const refreshReports = useCallback(async () => {
    const workspace = getActiveWorkspace();
    setLoadingReports(true);
    try {
      const list = await invoke<WorkspaceMemoryFileInfo[]>(
        "read_workspace_memory_files",
        { workspace }
      );
      setReportFiles(list);
      if (list.length > 0) {
        setSelectedReportPath((prev) =>
          list.some((f) => f.relPath === prev) ? prev : list[0].relPath
        );
      } else {
        setSelectedReportPath("");
      }
    } catch {
      setReportFiles([]);
    } finally {
      setLoadingReports(false);
    }
  }, [getActiveWorkspace]);

  const handleClearReport = async (relPath: string) => {
    const workspace = getActiveWorkspace();
    try {
      await invoke("clear_workspace_memory_file", { workspace, relPath });
      await refreshReports();
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    const prev = prevRunStatusRef.current;
    prevRunStatusRef.current = runStatus;
    if (prev === "running" && runStatus !== "running" && tab === "reports") {
      void refreshReports();
    }
  }, [runStatus, tab, refreshReports]);

  useEffect(() => {
    const onOpenReports = () => {
      setTab("reports");
      setConsoleOpen(true);
      void refreshReports();
    };
    window.addEventListener("loors:open-reports", onOpenReports);
    return () => window.removeEventListener("loors:open-reports", onOpenReports);
  }, [setConsoleOpen, refreshReports]);

  const openDiffTab = () => {
    setTab("diff");
    setConsoleOpen(true);
    void refreshDiff();
  };

  const openReportsTab = () => {
    setTab("reports");
    setConsoleOpen(true);
    void refreshReports();
  };

  const activeReport =
    reportFiles.find((f) => f.relPath === selectedReportPath) ?? reportFiles[0] ?? null;

  return (
    <section
      className={`console-panel ${consoleOpen ? "open" : "collapsed"}`}
      style={consoleOpen ? { height: panelHeight } : undefined}
    >
      {consoleOpen && (
        <div
          className="console-resizer"
          title="Arrastra para cambiar altura de la consola"
          onMouseDown={startResize}
        />
      )}
      <div className="console-bar">
        <div className="console-left">
          <div className="console-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={tab === "logs"}
              className={`console-tab ${tab === "logs" ? "active" : ""}`}
              onClick={() => {
                setTab("logs");
                setConsoleOpen(true);
              }}
            >
              <span>Logs</span>
              {logs.length > 0 && <span className="console-tab-count">{logs.length}</span>}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === "diff"}
              className={`console-tab ${tab === "diff" ? "active" : ""}`}
              onClick={openDiffTab}
            >
              <span>Diff</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === "reports"}
              className={`console-tab ${tab === "reports" ? "active" : ""}`}
              onClick={openReportsTab}
            >
              <span>{L("Reports", "Informes")}</span>
              {reportFiles.length > 0 && (
                <span className="console-tab-count">{reportFiles.length}</span>
              )}
            </button>
          </div>

          <span className="console-sep" aria-hidden="true" />

          <div className={`console-status console-status-${runStatus}`}>
            <span className="console-status-dot" />
            <span className="console-status-text">
              {runStatus === "running" && activeActivity
                ? activeActivity
                : (STATUS_LABELS[runStatus]?.[locale === "es" ? "es" : "en"] ?? runStatus)}
            </span>
            {currentIteration > 0 && (
              <span className="console-status-meta">
                · #{currentIteration}
                {maxIterations ? `/${maxIterations}` : ""}
              </span>
            )}
            {runStatus !== "running" && runSummary && (
              <span className="console-status-summary">· {runSummary}</span>
            )}
          </div>
        </div>

        <div className="console-right">
          {tab === "logs" && iterations.length > 1 && (
            <select
              className="console-iter-select"
              aria-label={L("Filter by iteration", "Filtrar por iteración")}
              value={iterFilter === "all" ? "all" : String(iterFilter)}
              onChange={(e) =>
                setIterFilter(e.target.value === "all" ? "all" : Number(e.target.value))
              }
            >
              <option value="all">{L("All iterations", "Todas")}</option>
              {iterations.map((it) => (
                <option key={it} value={String(it)}>
                  Iter #{it}
                </option>
              ))}
            </select>
          )}

          {tab === "logs" && (
            <button
              type="button"
              className={`console-icon-btn ${autoScroll ? "active" : ""}`}
              title={
                autoScroll
                  ? L("Auto-scroll on (click to pause)", "Auto-scroll activo (clic para pausar)")
                  : L("Auto-scroll paused (click to follow)", "Auto-scroll pausado (clic para seguir)")
              }
              onClick={() => {
                const next = !autoScroll;
                setAutoScroll(next);
                if (next) {
                  scrollToBottom();
                }
              }}
            >
              <ArrowDownToLine size={13} />
            </button>
          )}

          {tab === "diff" ? (
            <button
              type="button"
              className="console-icon-btn"
              title={L("Refresh Diff", "Actualizar Diff")}
              onClick={() => void refreshDiff()}
            >
              <RefreshCw size={13} className={loadingDiff ? "spin" : ""} />
            </button>
          ) : tab === "reports" ? (
            <>
              {activeReport && (
                <button
                  type="button"
                  className="console-icon-btn"
                  title={L("Clear selected file", "Vaciar archivo seleccionado")}
                  onClick={() => void handleClearReport(activeReport.relPath)}
                >
                  <Trash2 size={13} />
                </button>
              )}
              <button
                type="button"
                className="console-icon-btn"
                title={L("Reload reports", "Recargar informes")}
                onClick={() => void refreshReports()}
              >
                <RefreshCw size={13} className={loadingReports ? "spin" : ""} />
              </button>
            </>
          ) : (
            <button
              type="button"
              className="console-icon-btn"
              title={L("Clear logs", "Limpiar logs")}
              onClick={clearLogs}
            >
              <Trash2 size={13} />
            </button>
          )}

          <button
            type="button"
            className="console-icon-btn"
            title={consoleOpen ? L("Collapse console", "Contraer consola") : L("Expand console", "Expandir consola")}
            onClick={() => setConsoleOpen(!consoleOpen)}
          >
            {consoleOpen ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
          </button>
        </div>
      </div>

      {consoleOpen && (
        <div className="console-body" ref={bodyRef} onScroll={handleScroll}>
          {tab === "diff" ? (
            <pre className="diff-inline">
              {loadingDiff
                ? locale === "es"
                  ? "Leyendo git diff…"
                  : "Reading git diff…"
                : diffText.trim() ||
                  (locale === "es"
                    ? "(Sin cambios en el workspace actual)"
                    : "(No changes in current workspace)")}
            </pre>
          ) : tab === "reports" ? (
            loadingReports ? (
              <div className="console-empty">
                {locale === "es"
                  ? "Leyendo reportes en `.loors/`…"
                  : "Reading reports in `.loors/`…"}
              </div>
            ) : reportFiles.length === 0 ? (
              <div className="console-empty">
                {locale === "es"
                  ? "No se encontraron archivos Markdown en `.loors/` del workspace actual."
                  : "No Markdown files found in `.loors/` for the current workspace."}
              </div>
            ) : (
              <div className="reports-viewer">
                <div className="reports-file-bar">
                  {reportFiles.map((rf) => (
                    <button
                      key={rf.relPath}
                      type="button"
                      className={`iter-tab ${
                        activeReport?.relPath === rf.relPath ? "active" : ""
                      }`}
                      onClick={() => setSelectedReportPath(rf.relPath)}
                    >
                      {rf.relPath} ({Math.max(1, Math.round(rf.sizeBytes / 1024))} KB)
                    </button>
                  ))}
                </div>
                {activeReport && (
                  <pre className="diff-inline reports-pre">
                    {activeReport.content.trim() ||
                      (locale === "es" ? "(Archivo vacío)" : "(Empty file)")}
                  </pre>
                )}
              </div>
            )
          ) : filteredLogs.length === 0 ? (
            <div className="console-empty">
              {locale === "es" ? (
                <>
                  Pulsa <strong>Ejecutar</strong> para ver el pensamiento,
                  streaming de tokens, tools y stdout/stderr en vivo.
                </>
              ) : (
                <>
                  Click <strong>Run</strong> to stream live thinking, tokens,
                  tool calls, and stdout/stderr.
                </>
              )}
            </div>
          ) : (
            filteredLogs.map((entry) => (
              <div key={entry.id} className={`log-line stream-${entry.stream}`}>
                <span className="log-time">{entry.timestamp}</span>
                <span className="log-iter">#{entry.iteration}</span>
                <span className="log-node">{entry.nodeTitle}</span>
                <span className="log-text">{entry.text}</span>
              </div>
            ))
          )}
        </div>
      )}
    </section>
  );
}
