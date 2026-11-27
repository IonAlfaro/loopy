import { memo, useMemo, useState, useRef, useLayoutEffect, type ComponentProps } from "react";
import { AgentUserMessage } from "./AgentUserMessage";
import { AgentAssistantMessage } from "./AgentAssistantMessage";
import type { AgentChatMessage } from "../types/graph";

type AssistantProps = ComponentProps<typeof AgentAssistantMessage>;
interface Props {
  messages: AgentChatMessage[];
  running: boolean;
  locale: string;
  modelPath: string;
  expandedThinking: Record<string, boolean>;
  copiedId: string | null;
  modelLoadProgress: AssistantProps["modelLoadProgress"];
  expandedTools: AssistantProps["expandedTools"];
  savedShots: AssistantProps["savedShots"];
  onRetry: (msg: AgentChatMessage) => void;
  onCopy: AssistantProps["onCopy"];
  onToggleThinking: AssistantProps["onToggleThinking"];
  onToggleTool: AssistantProps["onToggleTool"];
  onUndo: AssistantProps["onUndo"];
}

export const AgentHistory = memo(function AgentHistory(props: Props) {
  const { messages, running, locale, modelPath, expandedThinking, copiedId, modelLoadProgress, expandedTools, savedShots, onRetry, onCopy, onToggleThinking, onToggleTool, onUndo } = props;
  const lastUserIndex = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === "user") return i;
    return -1;
  }, [messages]);
  const [limit, setLimit] = useState(80);
  const anchor = useRef<HTMLDivElement>(null);
  const pendingAnchor = useRef<{ element: HTMLElement; top: number } | null>(null);
  const start = Math.max(0, messages.length - limit);
  useLayoutEffect(() => {
    const pending = pendingAnchor.current;
    if (pending) {
      pendingAnchor.current = null;
      const delta = pending.element.getBoundingClientRect().top - pending.top;
      let parent = pending.element.parentElement;
      while (parent && !/auto|scroll/.test(getComputedStyle(parent).overflowY)) parent = parent.parentElement;
      if (parent) parent.scrollTop += delta;
    }
  }, [limit]);
  return <>{start > 0 && <div style={{ textAlign: "center", padding: "12px" }}>
    <button type="button" className="btn-secondary" onClick={() => {
      const first = anchor.current?.nextElementSibling;
      if (first instanceof HTMLElement) pendingAnchor.current = { element: first, top: first.getBoundingClientRect().top };
      setLimit(n => n + 80);
    }}>{locale === "es" ? "Cargar mensajes anteriores" : "Load older messages"} ({start})</button>
  </div>}
  <div ref={anchor} style={{ height: 0 }} aria-hidden="true" />
  {messages.slice(start).map((msg, offset) => {
    const idx = start + offset;
    const deferred = idx < messages.length - 20;
    const last = idx === messages.length - 1;
    if (msg.role === "user") return <AgentUserMessage key={msg.id} msg={msg} locale={locale} canRetry={idx === lastUserIndex && !running} deferred={deferred} onRetry={onRetry} />;
    return <AgentAssistantMessage key={msg.id} msg={msg} active={running && last} continuation={idx > 0 && messages[idx - 1].role === "assistant"} deferred={deferred} locale={locale} modelPath={modelPath} thinkingOpen={expandedThinking[msg.id] ?? false} copied={copiedId === msg.id} modelLoadProgress={last ? modelLoadProgress : null} expandedTools={expandedTools} savedShots={savedShots} onCopy={onCopy} onToggleThinking={onToggleThinking} onToggleTool={onToggleTool} onUndo={onUndo} />;
  })}</>;
});
