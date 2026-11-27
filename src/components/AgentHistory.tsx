import { memo, useMemo, type ComponentProps } from "react";
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
  return <>{messages.map((msg, idx) => {
    const deferred = idx < messages.length - 20;
    const last = idx === messages.length - 1;
    if (msg.role === "user") return <AgentUserMessage key={msg.id} msg={msg} locale={locale} canRetry={idx === lastUserIndex && !running} deferred={deferred} onRetry={onRetry} />;
    return <AgentAssistantMessage key={msg.id} msg={msg} active={running && last} continuation={idx > 0 && messages[idx - 1].role === "assistant"} deferred={deferred} locale={locale} modelPath={modelPath} thinkingOpen={expandedThinking[msg.id] ?? false} copied={copiedId === msg.id} modelLoadProgress={last ? modelLoadProgress : null} expandedTools={expandedTools} savedShots={savedShots} onCopy={onCopy} onToggleThinking={onToggleThinking} onToggleTool={onToggleTool} onUndo={onUndo} />;
  })}</>;
});
