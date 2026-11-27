import { useMemo, useRef } from "react";
import { ChevronRight, FileCode2, GitCompareArrows } from "lucide-react";
import "./AgentDiff.css";

type DiffRow = {
  kind: "add" | "remove" | "context" | "hunk" | "note";
  text: string;
  oldLine?: number;
  newLine?: number;
};

function parseDiff(diff: string) {
  const git = diff.startsWith("diff --git ");
  const chunks = git ? diff.split(/\r?\n(?=diff --git )/) : [diff];

  return chunks.map((chunk) => {
    const lines = chunk.replace(/\r?\n$/, "").split(/\r?\n/);
    const compact = !git && lines[0].startsWith("--- ") && lines[1]?.startsWith("+++ ");
    const rows: DiffRow[] = [];
    let path = "";
    let oldPath = "";
    let added = 0;
    let removed = 0;
    let oldLine: number | undefined;
    let newLine: number | undefined;

    for (const [index, line] of lines.entries()) {
      const hunk = git && line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
      if (hunk) {
        oldLine = Number(hunk[1]);
        newLine = Number(hunk[2]);
        rows.push({ kind: "hunk", text: line });
      } else if (compact ? index < 2 : git && oldLine === undefined) {
        if (line.startsWith("--- ")) oldPath = line.slice(4).replace(/\t$/, "");
        else if (line.startsWith("+++ ")) path = line.slice(4).replace(/\t$/, "");
        else if (line.startsWith("rename to ")) path = line.slice("rename to ".length);
        else if (line.startsWith("copy to ")) path = line.slice("copy to ".length);
        else if (index > 0 && !line.startsWith("index ")) rows.push({ kind: "note", text: line });
      } else if ((git || compact) && /^[+\- ]/.test(line)) {
        const kind = line[0] === "+" ? "add" : line[0] === "-" ? "remove" : "context";
        if (kind === "add") added++;
        if (kind === "remove") removed++;
        rows.push({
          kind,
          text: line.slice(compact ? 2 : 1),
          oldLine: kind === "add" ? undefined : oldLine,
          newLine: kind === "remove" ? undefined : newLine,
        });
        if (kind !== "add" && oldLine !== undefined) oldLine++;
        if (kind !== "remove" && newLine !== undefined) newLine++;
      } else {
        rows.push({ kind: "note", text: line });
      }
    }

    const fallback = git ? lines[0].match(/ b\/(.*)$/)?.[1] || lines[0].slice(11) : "";
    const filePath = (path === "/dev/null" ? oldPath : path).replace(/^(")?[ab]\//, "$1") || fallback;
    return { path: filePath, rows, added, removed, numbered: git && oldLine !== undefined };
  });
}

export function AgentDiff({ diff, locale, preview = false }: { diff: string; locale: string; preview?: boolean }) {
  const files = useMemo(() => parseDiff(diff), [diff]);
  const viewerRef = useRef<HTMLDivElement>(null);
  const spanish = locale === "es";
  const fileCount = files.filter((file) => file.path).length;

  function setAllFilesOpen(open: boolean) {
    viewerRef.current?.querySelectorAll<HTMLDetailsElement>("details").forEach((file) => {
      file.open = open;
    });
  }

  return (
    <div ref={viewerRef} className={`agent-diff${preview ? " agent-diff--preview" : ""}`}>
      {!preview && fileCount > 0 && (
        <div className="agent-diff-overview">
          <GitCompareArrows size={14} aria-hidden="true" />
          <span>
            {fileCount} {spanish ? (fileCount === 1 ? "archivo modificado" : "archivos modificados") : (fileCount === 1 ? "changed file" : "changed files")}
          </span>
          {fileCount > 1 && (
            <div className="agent-diff-actions">
              <button type="button" className="btn-mini" onClick={() => setAllFilesOpen(false)}>
                {spanish ? "Plegar todo" : "Collapse all"}
              </button>
              <button type="button" className="btn-mini" onClick={() => setAllFilesOpen(true)}>
                {spanish ? "Expandir todo" : "Expand all"}
              </button>
            </div>
          )}
        </div>
      )}
      {files.map((file, index) => {
        const separator = file.path.lastIndexOf("/");
        const content = (
          <div
            className={`agent-diff-code${file.numbered ? " agent-diff-code--numbered" : ""}`}
            role="region"
            aria-label={file.path || (spanish ? "Salida de Git" : "Git output")}
            tabIndex={0}
          >
            <div className="agent-diff-lines">
              {file.rows.map((row, rowIndex) => (
                <div key={rowIndex} className={`agent-diff-row agent-diff-row--${row.kind}`}>
                  {(row.kind === "hunk" || row.kind === "note") ? (
                    <code className="agent-diff-message">{row.text}</code>
                  ) : (
                    <>
                      {file.numbered && (
                        <>
                          <span className="agent-diff-number" aria-hidden="true">{row.oldLine}</span>
                          <span className="agent-diff-number" aria-hidden="true">{row.newLine}</span>
                        </>
                      )}
                      <span className="agent-diff-marker">{row.kind === "add" ? "+" : row.kind === "remove" ? "−" : ""}</span>
                      <code>{row.text}</code>
                    </>
                  )}
                </div>
              ))}
            </div>
          </div>
        );

        if (!file.path) return <div className="agent-diff-file" key={index}>{content}</div>;

        return (
          <details className="agent-diff-file" key={`${file.path}:${index}`} open>
            <summary className="agent-diff-file-head" title={file.path}>
              <ChevronRight className="agent-diff-chevron" size={13} aria-hidden="true" />
              <FileCode2 size={15} aria-hidden="true" />
              <span className="agent-diff-path">
                {separator >= 0 && <span>{file.path.slice(0, separator + 1)}</span>}
                <strong>{file.path.slice(separator + 1)}</strong>
              </span>
              {!preview && (file.added > 0 || file.removed > 0) && (
                <span className="agent-diff-stats">
                  <span aria-label={spanish ? `${file.added} líneas añadidas` : `${file.added} lines added`}>+{file.added}</span>
                  <span aria-label={spanish ? `${file.removed} líneas eliminadas` : `${file.removed} lines removed`}>−{file.removed}</span>
                </span>
              )}
            </summary>
            {file.rows.length > 0 && content}
          </details>
        );
      })}
    </div>
  );
}
