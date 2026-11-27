import { Pin, RefreshCw, X } from "lucide-react";
import { getAttachmentBadge } from "./AgentUserMessage";

export function AgentComposerAttachments({ pendingAttachments, pinnedFiles, stagingFiles, locale, onRemove, onUnpin }: {
  pendingAttachments: string[];
  pinnedFiles: string[];
  stagingFiles: boolean;
  locale: string;
  onRemove: (path: string) => void;
  onUnpin: (path: string) => void;
}) {
  return <>{(pendingAttachments.length > 0 || pinnedFiles.length > 0 || stagingFiles) && (
                <div className="composer-attachments-tray">
                  {pendingAttachments.map((att) => {
                    const badge = getAttachmentBadge(att);
                    const name = att.split(/[\\/]/).pop() ?? att;
                    return (
                      <span key={att} className="attachment-chip" title={att}>
                        <span className={`attachment-ext-badge ${badge.cls}`}>
                          {badge.tag}
                        </span>
                        <span className="truncate-text" style={{ maxWidth: 160 }}>
                          {name}
                        </span>
                        <button
                          type="button"
                          title={locale === "es" ? "Quitar adjunto" : "Remove attachment"}
                          onClick={() =>
                            onRemove(att)
                          }
                        >
                          <X size={11} />
                        </button>
                      </span>
                    );
                  })}
                  {pinnedFiles.map((rel) => (
                    <span key={`pin-${rel}`} className="pinned-chip" title={`${locale === "es" ? "Fijado del proyecto" : "Pinned project file"}: ${rel}`}>
                      <Pin size={10} />
                      <span className="truncate-text" style={{ maxWidth: 150 }}>
                        {rel.split("/").pop()}
                      </span>
                      <button
                        type="button"
                        title={locale === "es" ? "Desfijar archivo del proyecto" : "Unpin project file"}
                        onClick={() => onUnpin(rel)}
                      >
                        <X size={10} />
                      </button>
                    </span>
                  ))}
                  {stagingFiles && (
                    <span className="attachment-chip">
                      <RefreshCw size={11} className="spin" />
                      <span>{locale === "es" ? "Procesando archivo…" : "Processing file…"}</span>
                    </span>
                  )}
                </div>
              )}</>;
}
