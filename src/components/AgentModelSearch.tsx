import { Eye, EyeOff, Search, X } from "lucide-react";
import { useRef } from "react";

export function AgentModelSearch({ query, onQuery, hiddenCount, showHidden, onToggleHidden, onClose, label, locale }: {
  query: string;
  onQuery: (query: string) => void;
  hiddenCount: number;
  showHidden: boolean;
  onToggleHidden: () => void;
  onClose: () => void;
  label: string;
  locale: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  const clear = locale === "es" ? "Limpiar búsqueda" : "Clear search";
  const toggle = showHidden ? (locale === "es" ? "Ocultar modelos escondidos" : "Hide hidden models") : (locale === "es" ? `Mostrar ${hiddenCount} ocultos` : `Show ${hiddenCount} hidden`);
  return <div className="model-pop-search">
    <Search size={13} aria-hidden="true" />
    <input ref={input} type="text" autoFocus aria-label={label} placeholder={label} value={query} onChange={e => onQuery(e.target.value)} onKeyDown={e => {
      if (e.key === "Escape" && !e.nativeEvent.isComposing) {
        e.stopPropagation();
        onClose();
      }
    }} />
    {query && <button type="button" className="icon-btn" title={clear} aria-label={clear} onClick={() => { onQuery(""); input.current?.focus(); }}><X size={11} /></button>}
    {hiddenCount > 0 && <button type="button" className={`model-pop-hidden-toggle ${showHidden ? "active" : ""}`} title={toggle} aria-label={toggle} aria-pressed={showHidden} onClick={onToggleHidden}>
      {showHidden ? <Eye size={11} /> : <EyeOff size={11} />}
      <span>{hiddenCount}</span>
    </button>}
  </div>;
}
