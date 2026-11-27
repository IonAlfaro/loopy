import { memo } from "react";

export const AgentContextMeter = memo(function AgentContextMeter({ tokens, capacity, locale }: {
  tokens?: number | null;
  capacity?: number | null;
  locale: string;
}) {
  if (tokens == null || !Number.isFinite(tokens) || tokens < 0) return null;
  const label = locale === "es" ? "Tokens del prompt" : "Prompt tokens";
  const format = (n: number) => n.toLocaleString(locale === "es" ? "es-ES" : "en-US");
  if (capacity == null || !Number.isFinite(capacity) || capacity <= 0) {
    return <span className="agent-model-tag" title={label}>{format(tokens)} ctx tokens</span>;
  }
  const percent = tokens / capacity * 100;
  const description = `${label}: ${format(tokens)} / ${format(capacity)} (${percent.toFixed(1)}%)`;
  return <span className="agent-model-tag" title={description} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
    <span>{format(tokens)} / {format(capacity)} ({percent.toFixed(1)}%)</span>
    <span role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={capacity} aria-valuenow={Math.min(tokens, capacity)} aria-valuetext={description} style={{ width: 48, height: 5, borderRadius: 4, background: "rgba(128,128,128,.25)", overflow: "hidden" }}>
      <span style={{ display: "block", height: "100%", width: `${Math.min(100, percent)}%`, background: percent >= 90 ? "#ef4444" : percent >= 75 ? "#d97706" : "#3b82f6" }} />
    </span>
  </span>;
});
