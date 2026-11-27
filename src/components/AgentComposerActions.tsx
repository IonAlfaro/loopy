import { ArrowUp, Square } from "lucide-react";

export function AgentComposerActions({ running, hasContent, hasModel, locale, onStop, onSend }: {
  running: boolean;
  hasContent: boolean;
  hasModel: boolean;
  locale: string;
  onStop: () => void;
  onSend: () => void;
}) {
  const stop = locale === "es" ? "Detener respuesta" : "Stop response";
  const send = running ? (locale === "es" ? "Encolar mensaje" : "Queue message") : (locale === "es" ? "Enviar" : "Send");
  return <div className="composer-action-group">
    {running && <button type="button" className="composer-send-btn is-stop" title={stop} aria-label={stop} onClick={onStop}>
      <Square size={12} fill="currentColor" />
    </button>}
    {(!running || hasContent) && <button type="button" className="composer-send-btn" title={send} aria-label={send} disabled={!hasContent || !hasModel} onClick={onSend}>
      <ArrowUp size={16} strokeWidth={2.3} />
    </button>}
  </div>;
}
