import { AgentDiff } from "./AgentDiff";
import { memo, useEffect, useRef, useState, type ReactNode } from "react";
import { detectModelReasoningCaps } from "../types/graph";
import { useI18n } from "../i18n";
import {
  AlertCircle,
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Clock,
  Copy,
  FileCode2,
  FileText,
  Folder,
  FolderOpen,
  FolderSearch,
  Globe,
  Pin,
  RefreshCw,
  Search,
  Terminal,
  Undo2,
  Wrench,
  X,
} from "lucide-react";

export interface ActivityToolItem {
  id: string;
  name: string;
  argsJson: string;
  status: string;
  outputPreview?: string;
  durationMs?: number;
  filePath?: string | null;
  diffPreview?: string | null;
  addedLines?: number;
  removedLines?: number;
  screenshotPath?: string | null;
  cursorX?: number | null;
  cursorY?: number | null;
  undone?: boolean;
}

export interface QueuedMessageItem {
  id: string;
  text: string;
  attachments?: string[];
}

export function summarizeToolArgs(argsJson: string): string {
  try {
    const obj = JSON.parse(argsJson) as Record<string, unknown>;
    if (typeof obj.action === "string" && obj.action.trim()) {
      const act = obj.action.trim();
      const target =
        (typeof obj.url === "string" && obj.url.trim()) ||
        (typeof obj.selector === "string" && obj.selector.trim()) ||
        (typeof obj.text === "string" && obj.text.trim()) ||
        "";
      return target ? `${act} · ${target}` : act;
    }
    if (typeof obj.path === "string" && obj.path.trim()) return obj.path;
    if (typeof obj.command === "string" && obj.command.trim()) return obj.command;
    if (typeof obj.url === "string" && obj.url.trim()) return obj.url;
    if (typeof obj.query === "string" && obj.query.trim()) return obj.query;
    if (typeof obj.pattern === "string" && obj.pattern.trim()) return obj.pattern;
    if (typeof obj.symbol === "string" && obj.symbol.trim()) return obj.symbol;
    if (typeof obj.action === "string") {
      return `${obj.action}${typeof obj.selector === "string" ? ` (${obj.selector})` : ""}`;
    }
    const compact = argsJson.trim();
    return compact === "{}" ? "" : compact.slice(0, 80);
  } catch {
    return argsJson.slice(0, 80);
  }
}

function getToolPresentation(
  name: string,
  isRunning: boolean
): { verb: string; icon: ReactNode } {
  const s = 12;
  switch (name) {
    case "read_file":
    case "read_skill":
      return {
        verb: isRunning ? "Leyendo" : "Leído",
        icon: <FileText size={s} />,
      };
    case "edit_file":
    case "write_file":
      return {
        verb: isRunning ? "Editando" : "Editado",
        icon: <FileCode2 size={s} />,
      };
    case "delete_file":
      return {
        verb: isRunning ? "Eliminando" : "Eliminado",
        icon: <FileText size={s} />,
      };
    case "list_files":
    case "find_files":
      return {
        verb: isRunning ? "Explorando" : "Explorado",
        icon: <FolderSearch size={s} />,
      };
    case "grep_search":
    case "code_symbols":
      return {
        verb: isRunning ? "Buscando" : "Buscado",
        icon: <Search size={s} />,
      };
    case "run_cmd":
    case "docker_exec":
    case "differential_test":
      return {
        verb: isRunning ? "Ejecutando" : "Ejecutado",
        icon: <Terminal size={s} />,
      };
    case "web_search":
    case "fetch_url":
    case "browser_action":
      return {
        verb: isRunning ? "Navegando" : "Navegador",
        icon: <Globe size={s} />,
      };
    case "list_loors_capabilities":
      return {
        verb: isRunning ? "Revisando capacidades" : "Capacidades revisadas",
        icon: <Wrench size={s} />,
      };
    case "binary_inspect":
    case "debug_crash":
      return {
        verb: isRunning ? "Analizando" : "Analizado",
        icon: <Wrench size={s} />,
      };
    default:
      return {
        verb: name,
        icon: <Wrench size={s} />,
      };
  }
}

type ToolCategory = "read" | "write" | "search" | "exec" | "web" | "analyze" | "other";

function toolCategory(name: string): ToolCategory {
  switch (name) {
    case "read_file":
    case "read_skill":
    case "list_files":
    case "find_files":
    case "workspace_tree":
    case "knowledge_tree":
      return "read";
    case "edit_file":
    case "write_file":
    case "delete_file":
    case "apply_patch":
      return "write";
    case "grep_search":
    case "code_symbols":
    case "search_knowledge":
      return "search";
    case "run_cmd":
    case "run_bg_cmd":
    case "docker_exec":
    case "differential_test":
    case "debug_crash":
      return "exec";
    case "web_search":
    case "fetch_url":
    case "browser_action":
      return "web";
    case "binary_inspect":
    case "sql_query":
      return "analyze";
    default:
      return "other";
  }
}

const CATEGORY_LABELS_ES: Record<ToolCategory, { one: string; many: string }> = {
  read: { one: "lectura", many: "lecturas" },
  write: { one: "edición", many: "ediciones" },
  search: { one: "búsqueda", many: "búsquedas" },
  exec: { one: "comando", many: "comandos" },
  web: { one: "consulta web", many: "consultas web" },
  analyze: { one: "análisis", many: "análisis" },
  other: { one: "acción", many: "acciones" },
};

const CATEGORY_LABELS_EN: Record<ToolCategory, { one: string; many: string }> = {
  read: { one: "read", many: "reads" },
  write: { one: "edit", many: "edits" },
  search: { one: "search", many: "searches" },
  exec: { one: "command", many: "commands" },
  web: { one: "web lookup", many: "web lookups" },
  analyze: { one: "analysis", many: "analyses" },
  other: { one: "action", many: "actions" },
};

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  const mins = Math.floor(ms / 60_000);
  const secs = Math.round((ms % 60_000) / 1000);
  return `${mins}m ${String(secs).padStart(2, "0")}s`;
}

function summarizeToolGroup(
  calls: ActivityToolItem[],
  labels: Record<ToolCategory, { one: string; many: string }>
): string {
  const order: ToolCategory[] = ["read", "search", "write", "exec", "web", "analyze", "other"];
  const counts = new Map<ToolCategory, number>();
  for (const call of calls) {
    const cat = toolCategory(call.name);
    counts.set(cat, (counts.get(cat) ?? 0) + 1);
  }
  const parts: string[] = [];
  for (const cat of order) {
    const n = counts.get(cat);
    if (!n) continue;
    const label = n === 1 ? labels[cat].one : labels[cat].many;
    parts.push(`${n} ${label}`);
  }
  return parts.slice(0, 4).join(" · ");
}

/** Number of tool rows kept visible when a group is collapsed. */
const GROUP_VISIBLE_TAIL = 3;

export function ToolCallGroup({
  calls,
  expandedTools,
  onToggleTool,
  extras,
}: {
  calls: ActivityToolItem[];
  expandedTools: Record<string, boolean>;
  onToggleTool: (id: string, next: boolean) => void;
  extras?: (call: ActivityToolItem) => { shotB64?: string; onUndo?: () => void };
}) {
  const { locale } = useI18n();
  const [groupOpen, setGroupOpen] = useState(false);

  if (calls.length === 0) return null;

  const isEs = locale === "es";
  const labels = isEs ? CATEGORY_LABELS_ES : CATEGORY_LABELS_EN;
  const running = calls.filter((c) => c.status === "running").length;
  const failed = calls.filter((c) => c.status === "error" || c.status === "rejected").length;
  const totalMs = calls.reduce((acc, c) => acc + (c.durationMs ?? 0), 0);
  const hasOverflow = calls.length > GROUP_VISIBLE_TAIL;
  const hiddenCount = hasOverflow ? calls.length - GROUP_VISIBLE_TAIL : 0;
  const visible = groupOpen || !hasOverflow ? calls : calls.slice(-GROUP_VISIBLE_TAIL);

  const renderRow = (call: ActivityToolItem) => {
    const isOpen = expandedTools[call.id] ?? Boolean(call.diffPreview);
    const extra = extras?.(call);
    return (
      <ToolActivityRow
        key={call.id}
        call={call}
        open={isOpen}
        shotB64={extra?.shotB64}
        onUndo={extra?.onUndo}
        onToggle={() => onToggleTool(call.id, !isOpen)}
      />
    );
  };

  if (!hasOverflow) {
    return <div className="codex-tool-list">{calls.map(renderRow)}</div>;
  }

  return (
    <div className={`codex-tool-group ${groupOpen ? "is-open" : ""}`}>
      <button
        type="button"
        className="codex-tool-group-head"
        onClick={() => setGroupOpen((v) => !v)}
        title={
          groupOpen
            ? isEs
              ? "Contraer actividad"
              : "Collapse activity"
            : isEs
              ? "Expandir toda la actividad"
              : "Expand all activity"
        }
      >
        <span className="codex-tool-group-chev">
          {groupOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </span>
        {running > 0 ? (
          <RefreshCw size={11} className="spin" />
        ) : failed > 0 ? (
          <AlertCircle size={11} />
        ) : (
          <Check size={11} />
        )}
        <span className="codex-tool-group-title">
          {running > 0 ? (isEs ? "Trabajando" : "Working") : isEs ? "Actividad" : "Activity"}
        </span>
        <span className="codex-tool-group-summary truncate-text">
          {summarizeToolGroup(calls, labels)}
        </span>
        <span className="codex-tool-group-meta">
          {failed > 0 && (
            <em className="codex-tool-group-fail">
              {failed} {failed === 1 ? (isEs ? "fallo" : "failure") : isEs ? "fallos" : "failures"}
            </em>
          )}
          {totalMs > 0 && <span className="tabular-nums">{formatDuration(totalMs)}</span>}
          <em className="codex-tool-group-count">{calls.length}</em>
        </span>
      </button>

      {!groupOpen && hiddenCount > 0 && (
        <button
          type="button"
          className="codex-tool-group-more"
          onClick={() => setGroupOpen(true)}
        >
          +{hiddenCount}{" "}
          {hiddenCount === 1
            ? isEs
              ? "acción anterior"
              : "earlier action"
            : isEs
              ? "acciones anteriores"
              : "earlier actions"}
        </button>
      )}

      <div className="codex-tool-list codex-tool-list--grouped">{visible.map(renderRow)}</div>

      {groupOpen && hiddenCount > 0 && (
        <button
          type="button"
          className="codex-tool-group-more is-collapse"
          onClick={() => setGroupOpen(false)}
        >
          <ChevronUp size={11} />
          <span>
            {isEs
              ? `Contraer a las ${GROUP_VISIBLE_TAIL} últimas`
              : `Collapse to last ${GROUP_VISIBLE_TAIL}`}
          </span>
        </button>
      )}
    </div>
  );
}

export function ThinkingDisclosure({
  text,
  isStreaming,
  open,
  onToggle,
}: {
  text: string;
  isStreaming: boolean;
  open: boolean;
  onToggle: () => void;
}) {
  const preRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);

  useEffect(() => {
    const el = preRef.current;
    if (open && isStreaming && el && stickRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [text, open, isStreaming]);

  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  const tailPreview = lines.length > 0 ? lines[lines.length - 1].trim() : "";

  return (
    <div className={`codex-think ${isStreaming ? "is-live" : ""}`}>
      <button type="button" className="codex-think-head" onClick={onToggle}>
        <span className="codex-think-chevron">
          {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </span>
        {isStreaming && <span className="codex-think-dot" />}
        <span className="codex-think-label">
          {isStreaming ? "Pensando…" : "Pensado"}
        </span>
        {!open && isStreaming && tailPreview && (
          <span className="codex-think-preview truncate-text">{tailPreview}</span>
        )}
        {!isStreaming && (
          <span className="codex-think-meta">
            {Math.max(1, lines.length)} {lines.length === 1 ? "línea" : "líneas"}
          </span>
        )}
      </button>
      {open && (
        <div
          className="codex-think-body"
          ref={preRef}
          onScroll={() => {
            const el = preRef.current;
            if (!el) return;
            stickRef.current =
              el.scrollHeight - el.scrollTop - el.clientHeight < 36;
          }}
        >
          {text}
        </div>
      )}
    </div>
  );
}

export function ToolActivityRow({
  call,
  open,
  onToggle,
  shotB64,
  onUndo,
}: {
  call: ActivityToolItem;
  open: boolean;
  onToggle: () => void;
  shotB64?: string;
  onUndo?: () => void;
}) {
  const { locale } = useI18n();
  const isRunning = call.status === "running";
  const isError = call.status === "error" || call.status === "rejected";
  const pres = getToolPresentation(call.name, isRunning);
  const target = summarizeToolArgs(call.argsJson);
  const hasBody = Boolean(call.diffPreview || shotB64 || call.outputPreview);

  return (
    <div className={`codex-tool-row status-${call.status}`}>
      <div
        className={`codex-tool-head ${hasBody ? "is-clickable" : ""}`}
        onClick={() => hasBody && onToggle()}
      >
        <span className="codex-tool-status">
          {isRunning ? (
            <RefreshCw size={11} className="spin" />
          ) : isError ? (
            <AlertCircle size={12} />
          ) : (
            <Check size={12} />
          )}
        </span>
        <span className="codex-tool-icon">{pres.icon}</span>
        <span className="codex-tool-verb">{pres.verb}</span>
        {target && (
          <span className="codex-tool-target truncate-text" title={target}>
            {target}
          </span>
        )}

        <div className="codex-tool-right">
          {((call.addedLines ?? 0) > 0 || (call.removedLines ?? 0) > 0) && (
            <span className="diff-count-badge">
              <em className="plus">+{call.addedLines ?? 0}</em>{" "}
              <em className="minus">-{call.removedLines ?? 0}</em>
            </span>
          )}
          {onUndo && call.filePath && call.status === "success" && !call.undone && (
            <button
              type="button"
              className="undo-btn"
              onClick={(e) => {
                e.stopPropagation();
                onUndo();
              }}
            >
              <Undo2 size={11} />
              <span>Deshacer</span>
            </button>
          )}
          {call.undone && <span className="undone-pill">Deshecho</span>}
          {typeof call.durationMs === "number" && !isRunning && (
            <span className="codex-tool-ms tabular-nums">
              {call.durationMs >= 1000
                ? `${(call.durationMs / 1000).toFixed(1)}s`
                : `${call.durationMs}ms`}
            </span>
          )}
          {hasBody && (
            <span className="codex-tool-chev">
              {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            </span>
          )}
        </div>
      </div>

      {open && hasBody && (
        <div className="codex-tool-body">
          {call.diffPreview && <AgentDiff diff={call.diffPreview} locale={locale} preview />}
          {shotB64 && (
            <div className="shot-preview-box">
              <img
                src={`data:image/png;base64,${shotB64}`}
                alt="Captura navegador"
              />
              {call.cursorX != null && call.cursorY != null && (
                <div className="shot-cursor-meta">
                  Puntero en ({call.cursorX}, {call.cursorY})
                </div>
              )}
            </div>
          )}
          {call.outputPreview && (() => {
            if (call.name === "browser_action") {
              try {
                const parsed = JSON.parse(call.outputPreview) as Record<string, unknown>;
                const url = typeof parsed.url === "string" ? parsed.url : "";
                const note = typeof parsed.action_note === "string" ? parsed.action_note : "";
                const err = typeof parsed.error === "string" ? parsed.error : "";
                const interactiveCount = Array.isArray(parsed.interactive) ? parsed.interactive.length : 0;
                const jsErrs = Array.isArray(parsed.console_errors) ? parsed.console_errors.length : 0;
                const netErrs = Array.isArray(parsed.network_errors) ? parsed.network_errors.length : 0;
                return (
                  <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: 4,
                      padding: "8px 10px",
                      borderRadius: 8,
                      background: "var(--bg-surface-2)",
                      fontSize: 11.5,
                      color: "var(--text-secondary)",
                    }}
                  >
                    {err && <div style={{ color: "#f87171" }}>{err}</div>}
                    {url && (
                      <div className="truncate-text">
                        <strong style={{ color: "var(--text-primary)" }}>URL:</strong> {url}
                      </div>
                    )}
                    {note && <div>{note}</div>}
                    <div style={{ fontSize: 10.5, color: "var(--text-muted)" }}>
                      {interactiveCount} elementos interactivos · JS: {jsErrs} err · Red: {netErrs} err
                    </div>
                  </div>
                );
              } catch {
                // fallback to plain preview
              }
            }
            return <pre className="tool-output-pre">{call.outputPreview}</pre>;
          })()}
        </div>
      )}
    </div>
  );
}

export function MessageQueueTray({
  items,
  onRemove,
  onRunNext,
  isBusy,
}: {
  items: QueuedMessageItem[];
  onRemove: (id: string) => void;
  onRunNext?: () => void;
  isBusy: boolean;
}) {
  const { locale } = useI18n();
  if (items.length === 0) return null;
  return (
    <div className="composer-queue-tray">
      <div className="composer-queue-head">
        <span className="composer-queue-title">
          <Clock size={11} />
          <span>
            {locale === "es"
              ? `En cola (${items.length})`
              : `Queued (${items.length})`}
          </span>
        </span>
        {!isBusy && onRunNext && (
          <button
            type="button"
            className="composer-queue-resume"
            onClick={onRunNext}
          >
            <span>{locale === "es" ? "Enviar ahora" : "Send now"}</span>
          </button>
        )}
      </div>
      <div className="composer-queue-list">
        {items.map((item, idx) => (
          <div key={item.id} className="composer-queue-item">
            <span className="composer-queue-idx">{idx + 1}</span>
            <span className="composer-queue-text truncate-text" title={item.text}>
              {item.text ||
                (locale === "es"
                  ? `${item.attachments?.length ?? 0} archivo(s) adjunto(s)`
                  : `${item.attachments?.length ?? 0} attached file(s)`)}
            </span>
            <button
              type="button"
              className="composer-queue-del"
              title={locale === "es" ? "Quitar de la cola" : "Remove from queue"}
              onClick={() => onRemove(item.id)}
            >
              <X size={11} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}


function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="md-code-wrap">
      <div className="md-code-head">
        <span className="md-code-lang">{lang || "code"}</span>
        <button
          type="button"
          className="md-code-copy"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(code);
              setCopied(true);
              setTimeout(() => setCopied(false), 1400);
            } catch { setCopied(false); }
          }}
        >
          {copied ? <Check size={11} /> : <Copy size={11} />}
          <span>{copied ? "Copiado" : "Copiar"}</span>
        </button>
      </div>
      <pre className="md-code-pre">
        <code>{code}</code>
      </pre>
    </div>
  );
}

function renderInlineMarkdown(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  // Matches: `code`, **bold**, *italic*, [label](url)
  const regex = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\*[^*\n]+\*|\[[^\]\n]+\]\([^)\n]+\))/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let k = 0;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      out.push(text.slice(lastIndex, match.index));
    }
    const token = match[0];
    if (token.startsWith("`") && token.endsWith("`")) {
      out.push(
        <code key={`i-${k++}`} className="md-inline-code">
          {token.slice(1, -1)}
        </code>
      );
    } else if (token.startsWith("**") && token.endsWith("**")) {
      out.push(<strong key={`i-${k++}`}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith("*") && token.endsWith("*")) {
      out.push(<em key={`i-${k++}`}>{token.slice(1, -1)}</em>);
    } else if (token.startsWith("[")) {
      const m = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      if (m) {
        const href = m[2];
        const safeHref = /^(https?:|mailto:)/i.test(href) ? href : undefined;
        out.push(
          safeHref ? (
            <a
              key={`i-${k++}`}
              className="md-link"
              href={safeHref}
              target="_blank"
              rel="noreferrer"
            >
              {m[1]}
            </a>
          ) : (
            <span key={`i-${k++}`} className="md-inline-code">
              {m[1]}
            </span>
          )
        );
      } else {
        out.push(token);
      }
    }
    lastIndex = match.index + token.length;
  }

  if (lastIndex < text.length) {
    out.push(text.slice(lastIndex));
  }
  return out;
}

export const MarkdownContent = memo(function MarkdownContent({ text }: { text: string }) {
  if (!text) return null;

  const blocks: ReactNode[] = [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let i = 0;
  let keyIdx = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block ```lang
    const fenceMatch = line.match(/^\s*```([a-zA-Z0-9_+-]*)\s*$/);
    if (fenceMatch) {
      const lang = fenceMatch[1] || "";
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
        codeLines.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++; // skip closing fence
      blocks.push(
        <CodeBlock key={`b-${keyIdx++}`} lang={lang} code={codeLines.join("\n")} />
      );
      continue;
    }

    // Blank line
    if (!line.trim()) {
      i++;
      continue;
    }

    // Horizontal rule
    if (/^\s*(?:---|\*\*\*|___)\s*$/.test(line)) {
      blocks.push(<hr key={`b-${keyIdx++}`} className="md-hr" />);
      i++;
      continue;
    }

    // Headings # to ####
    const headMatch = line.match(/^(#{1,4})\s+(.+)$/);
    if (headMatch) {
      const level = headMatch[1].length;
      const content = renderInlineMarkdown(headMatch[2].trim());
      blocks.push(
        <div key={`b-${keyIdx++}`} className={`md-h md-h${level}`}>
          {content}
        </div>
      );
      i++;
      continue;
    }

    // Blockquote
    if (/^\s*>\s?/.test(line)) {
      const qLines: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        qLines.push(lines[i].replace(/^\s*>\s?/, ""));
        i++;
      }
      blocks.push(
        <blockquote key={`b-${keyIdx++}`} className="md-quote">
          {qLines.map((ql, idx) => (
            <div key={idx}>{renderInlineMarkdown(ql)}</div>
          ))}
        </blockquote>
      );
      continue;
    }

    // GFM Table
    if (
      line.includes("|") &&
      i + 1 < lines.length &&
      /^\s*\|?[\s:-]+\|[\s|:-]*$/.test(lines[i + 1])
    ) {
      const splitRow = (row: string) =>
        row
          .trim()
          .replace(/^\|/, "")
          .replace(/\|$/, "")
          .split("|")
          .map((c) => c.trim());
      const headers = splitRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
        rows.push(splitRow(lines[i]));
        i++;
      }
      blocks.push(
        <div key={`b-${keyIdx++}`} className="md-table-wrap">
          <table className="md-table">
            <thead>
              <tr>
                {headers.map((h, hi) => (
                  <th key={hi}>{renderInlineMarkdown(h)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri}>
                  {r.map((cell, ci) => (
                    <td key={ci}>{renderInlineMarkdown(cell)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
      continue;
    }

    // Unordered list
    if (/^\s*[-*•]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*•]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*•]\s+/, ""));
        i++;
      }
      blocks.push(
        <ul key={`b-${keyIdx++}`} className="md-list">
          {items.map((it, idx) => (
            <li key={idx}>{renderInlineMarkdown(it)}</li>
          ))}
        </ul>
      );
      continue;
    }

    // Ordered list
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+[.)]\s+/, ""));
        i++;
      }
      blocks.push(
        <ol key={`b-${keyIdx++}`} className="md-list md-olist">
          {items.map((it, idx) => (
            <li key={idx}>{renderInlineMarkdown(it)}</li>
          ))}
        </ol>
      );
      continue;
    }

    // Paragraph (consume consecutive plain lines)
    const pLines: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !/^\s*```/.test(lines[i]) &&
      !/^#{1,4}\s+/.test(lines[i]) &&
      !/^\s*>\s?/.test(lines[i]) &&
      !/^\s*[-*•]\s+/.test(lines[i]) &&
      !/^\s*\d+[.)]\s+/.test(lines[i]) &&
      !/^\s*(?:---|\*\*\*|___)\s*$/.test(lines[i])
    ) {
      pLines.push(lines[i]);
      i++;
    }
    // Unrecognized or incomplete fence during streaming: always advance.
    if (pLines.length === 0) pLines.push(lines[i++]);
    blocks.push(
      <p key={`b-${keyIdx++}`} className="md-p">
        {pLines.map((pl, idx) => (
          <span key={idx}>
            {idx > 0 && <br />}
            {renderInlineMarkdown(pl)}
          </span>
        ))}
      </p>
    );
  }

  return <div className="md-root">{blocks}</div>;
});


export function ModelLoadInlineBar({
  progress,
}: {
  progress: {
    stage: string;
    model_name: string;
    percent: number | null;
    message: string;
  };
}) {
  const pct = Math.max(0, Math.min(100, progress.percent ?? 12));
  const isUnloading = progress.stage === "unloading";
  return (
    <div className={`model-load-inline ${isUnloading ? "is-unloading" : ""}`}>
      <div className="model-load-inline-head">
        <RefreshCw size={12} className="spin" />
        <span className="model-load-inline-msg truncate-text">
          {progress.message}
        </span>
        {progress.percent != null && (
          <span className="model-load-inline-pct tabular-nums">{pct}%</span>
        )}
      </div>
      <div className="model-load-bar-track">
        <div
          className="model-load-bar-fill"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}


const EFFORT_OPTIONS: {
  id: "off" | "low" | "medium" | "high";
  label: string;
  short: string;
  desc: string;
}[] = [
  { id: "off", label: "Sin thinking", short: "Off", desc: "Respuesta directa y rápida" },
  { id: "low", label: "Bajo", short: "Bajo", desc: "Razonamiento breve" },
  { id: "medium", label: "Medio", short: "Medio", desc: "Equilibrado (recomendado)" },
  { id: "high", label: "Alto", short: "Alto", desc: "Razonamiento profundo" },
];

export function ReasoningEffortSelect({
  value,
  onChange,
  modelPath = "",
  disabled = false,
}: {
  value: "off" | "low" | "medium" | "high";
  onChange: (next: "off" | "low" | "medium" | "high") => void;
  modelPath?: string;
  disabled?: boolean;
}) {
  const { locale } = useI18n();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const effortOptions =
    locale === "es"
      ? EFFORT_OPTIONS
      : [
          { id: "off" as const, label: "No thinking", short: "Off", desc: "Direct, fast reply" },
          { id: "low" as const, label: "Low", short: "Low", desc: "Brief reasoning" },
          { id: "medium" as const, label: "Medium", short: "Medium", desc: "Balanced (recommended)" },
          { id: "high" as const, label: "High", short: "High", desc: "Deep reasoning" },
        ];

  const caps = modelPath
    ? detectModelReasoningCaps(modelPath)
    : { supported: true, allowOff: true, hint: "Thinking + effort" };

  // Always expose Thinking/Effort selector so new GGUF/cloud models (e.g. Inkling, Qwen, etc.)
  // can toggle thinking on/off and set effort even if not in the static heuristic list.
  const allowOff = caps.supported ? caps.allowOff : true;
  const visibleOptions = allowOff
    ? effortOptions
    : effortOptions.filter((o) => o.id !== "off");
  const effectiveValue = !allowOff && value === "off" ? "low" : value;
  const current =
    visibleOptions.find((o) => o.id === effectiveValue) ?? visibleOptions[0];

  return (
    <div className="effort-pop-wrap" ref={wrapRef}>
      <button
        type="button"
        disabled={disabled}
        className={`effort-pill-btn ${effectiveValue === "off" ? "is-off" : ""} ${open ? "is-open" : ""}`}
        title={`Thinking / Effort: ${current.label} (${caps.hint})`}
        onClick={() => setOpen((v) => !v)}
      >
        <Brain size={12} />
        <span>{current.short}</span>
        <ChevronUp size={11} className="effort-pill-chev" />
      </button>

      {open && (
        <div className="effort-popover" role="menu">
          <div className="effort-popover-title">Thinking y esfuerzo</div>
          {visibleOptions.map((opt) => {
            const active = opt.id === effectiveValue;
            return (
              <button
                key={opt.id}
                type="button"
                role="menuitem"
                className={`effort-pop-item ${active ? "active" : ""}`}
                onClick={() => {
                  onChange(opt.id);
                  setOpen(false);
                }}
              >
                <div className="effort-pop-item-text">
                  <span className="effort-pop-item-label">{opt.label}</span>
                  <span className="effort-pop-item-desc">{opt.desc}</span>
                </div>
                {active && <Check size={12} style={{ color: "#c084fc", flexShrink: 0 }} />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}


interface TreeNode {
  name: string;
  path: string;
  isDir: boolean;
  children: TreeNode[];
}

function buildFileTree(paths: string[]): TreeNode[] {
  const root: TreeNode[] = [];
  const dirMap = new Map<string, TreeNode>();

  for (const raw of paths) {
    const clean = raw.replace(/\\/g, "/").replace(/^\/+/, "");
    if (!clean) continue;
    const parts = clean.split("/").filter(Boolean);
    let currentChildren = root;
    let accum = "";

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      accum = accum ? `${accum}/${part}` : part;
      const isDir = i < parts.length - 1;

      if (isDir) {
        let dirNode = dirMap.get(accum);
        if (!dirNode) {
          dirNode = { name: part, path: accum, isDir: true, children: [] };
          dirMap.set(accum, dirNode);
          currentChildren.push(dirNode);
        }
        currentChildren = dirNode.children;
      } else {
        currentChildren.push({
          name: part,
          path: raw,
          isDir: false,
          children: [],
        });
      }
    }
  }

  const sortNodes = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    });
    for (const n of nodes) {
      if (n.isDir) sortNodes(n.children);
    }
  };
  sortNodes(root);
  return root;
}

export function WorkspaceFileTree({
  files,
  pinnedFiles,
  filterActive,
  onOpenFile,
  onTogglePin,
}: {
  files: string[];
  pinnedFiles: string[];
  filterActive: boolean;
  onOpenFile: (relPath: string) => void;
  onTogglePin: (relPath: string) => void;
}) {
  const [expandedDirs, setExpandedDirs] = useState<Record<string, boolean>>({});
  const tree = buildFileTree(files);

  const toggleDir = (dirPath: string) => {
    setExpandedDirs((prev) => ({ ...prev, [dirPath]: !prev[dirPath] }));
  };

  const renderNode = (node: TreeNode, depth: number): ReactNode => {
    if (node.isDir) {
      const isOpen = filterActive ? true : Boolean(expandedDirs[node.path]);
      return (
        <div key={`d:${node.path}`}>
          <div
            className="vsc-tree-row is-dir"
            style={{ paddingLeft: 8 + depth * 14 }}
            onClick={() => toggleDir(node.path)}
            title={node.path}
          >
            <span className="vsc-tree-chev">
              {isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            </span>
            <span className="vsc-tree-folder-icon">
              {isOpen ? <FolderOpen size={13} /> : <Folder size={13} />}
            </span>
            <span className="vsc-tree-name truncate-text">{node.name}</span>
          </div>
          {isOpen && (
            <div className="vsc-tree-children">
              {node.children.map((child) => renderNode(child, depth + 1))}
            </div>
          )}
        </div>
      );
    }

    const isPinned = pinnedFiles.includes(node.path);
    const isCode = /\.(ts|tsx|js|jsx|rs|py|go|cpp|c|h|cs|java|css|html|json|toml|yaml|yml|sh|ps1)$/i.test(
      node.name
    );
    return (
      <div
        key={`f:${node.path}`}
        className={`vsc-tree-row is-file ${isPinned ? "is-pinned" : ""}`}
        style={{ paddingLeft: 22 + depth * 14 }}
        onClick={() => onOpenFile(node.path)}
        title={node.path}
      >
        <span className="vsc-tree-file-icon">
          {isCode ? <FileCode2 size={12} /> : <FileText size={12} />}
        </span>
        <span className="vsc-tree-name truncate-text">{node.name}</span>
        <button
          type="button"
          className={`vsc-tree-pin icon-btn ${isPinned ? "active" : ""}`}
          title={isPinned ? "Desfijar del chat" : "Fijar al contexto del chat"}
          onClick={(e) => {
            e.stopPropagation();
            onTogglePin(node.path);
          }}
        >
          <Pin size={11} />
        </button>
      </div>
    );
  };

  return <div className="vsc-tree-root">{tree.map((n) => renderNode(n, 0))}</div>;
}
