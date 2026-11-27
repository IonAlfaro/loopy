import { memo, type CSSProperties } from "react";
import { RotateCcw } from "lucide-react";
import type { AgentChatMessage } from "../types/graph";

export function getAttachmentBadge(pathOrName: string): { tag: string; cls: string } {
  const lower = pathOrName.toLowerCase();
  if (lower.endsWith(".pdf")) return { tag: "PDF", cls: "att-pdf" };
  if (lower.endsWith(".docx") || lower.endsWith(".odt")) return { tag: "DOC", cls: "att-doc" };
  if (lower.endsWith(".xlsx") || lower.endsWith(".csv")) return { tag: "XLS", cls: "att-xls" };
  if (lower.endsWith(".pptx")) return { tag: "PPT", cls: "att-doc" };
  if (lower.endsWith(".epub")) return { tag: "EPUB", cls: "att-doc" };
  if (/\.(png|jpe?g|webp|gif|bmp)$/i.test(lower)) return { tag: "IMG", cls: "att-img" };
  const ext = lower.split(".").pop();
  return {
    tag: ext && ext.length <= 5 ? ext.toUpperCase() : "FILE",
    cls: "att-file",
  };
}

export const AgentUserMessage = memo(function AgentUserMessage({ msg, locale, canRetry, deferred, onRetry }: {
  msg: AgentChatMessage;
  locale: string;
  canRetry: boolean;
  deferred: boolean;
  onRetry: (msg: AgentChatMessage) => void;
}) {
  const historyStyle: CSSProperties | undefined = deferred ? { contentVisibility: "auto", containIntrinsicSize: "auto 160px" } : undefined;
  return (
    <div className="agent-user-row" style={historyStyle}>
                      <div className="agent-user-bubble">
                        {msg.attachments && msg.attachments.length > 0 && (
                          <div className="user-msg-attachments">
                            {msg.attachments.map((att) => {
                              const badge = getAttachmentBadge(att);
                              const name = att.split(/[\\/]/).pop() ?? att;
                              return (
                                <span key={att} className="attachment-chip sent" title={att}>
                                  <span className={`attachment-ext-badge ${badge.cls}`}>
                                    {badge.tag}
                                  </span>
                                  <span className="truncate-text">{name}</span>
                                </span>
                              );
                            })}
                          </div>
                        )}
                        {msg.content && (
                          <div className="agent-msg-text">{msg.content}</div>
                        )}
                        {canRetry && (
                          <button
                            type="button"
                            className="micro-action-btn"
                            title={locale === "es" ? "Reintentar este mensaje" : "Retry this message"}
                            onClick={() => onRetry(msg)}
                          >
                            <RotateCcw size={11} />
                            <span>{locale === "es" ? "Reintentar" : "Retry"}</span>
                          </button>
                        )}
                      </div>
                    </div>
  );
});
