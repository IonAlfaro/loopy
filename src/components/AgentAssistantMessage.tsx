import { AgentContextMeter } from "./AgentContextMeter";
import { memo, type CSSProperties, type ComponentProps } from "react";
import { Bot, Check, Copy, RefreshCw } from "lucide-react";
import { MarkdownContent, ModelLoadInlineBar, ThinkingDisclosure, ToolCallGroup } from "./ChatActivity";
import type { AgentChatMessage } from "../types/graph";

interface Props {
  msg: AgentChatMessage;
  active: boolean;
  continuation: boolean;
  deferred: boolean;
  locale: string;
  modelPath: string;
  thinkingOpen: boolean;
  copied: boolean;
  modelLoadProgress?: ComponentProps<typeof ModelLoadInlineBar>["progress"] | null;
  expandedTools: Record<string, boolean>;
  savedShots: Record<string, string>;
  onCopy: (id: string, content: string) => void;
  onToggleThinking: (id: string, next: boolean) => void;
  onToggleTool: (id: string, next: boolean) => void;
  onUndo: (messageId: string, callId: string) => void;
}

export const AgentAssistantMessage = memo(function AgentAssistantMessage({ msg, active, continuation, deferred, locale, modelPath, thinkingOpen, copied, modelLoadProgress, expandedTools, savedShots, onCopy, onToggleThinking, onToggleTool, onUndo }: Props) {
  const historyStyle: CSSProperties | undefined = deferred ? { contentVisibility: "auto", containIntrinsicSize: "auto 160px" } : undefined;
                const isLastMsg = active;
                const hasRunningTools = msg.toolCalls.some((t) => t.status === "running");
                const isThinkingLive =
                  active &&
                  isLastMsg &&
                  !msg.content &&
                  !msg.toolCalls.length;
                const thinkOpen = thinkingOpen;

                return (
                  <div style={historyStyle} className={`agent-assistant-row${continuation ? " agent-assistant-continuation" : ""}`}>
                    <div className="agent-assistant-head">
                      <span className="agent-model-tag">
                        {!continuation && <Bot size={13} style={{ color: "#a855f7" }} />}
                        <span>
                          {continuation ? (locale === "es" ? "Continuación" : "Continuation") : (modelPath.split(/[\\/]/).pop() || "Agente Loors")}
                        </span>
                      </span>
                      {msg.tokensPerSecond != null && <span className="agent-model-tag">{msg.tokensPerSecond.toFixed(1)} tok/s</span>}
                      <AgentContextMeter tokens={msg.promptTokens} capacity={msg.contextCapacity} locale={locale} />
                      {msg.prefillMs != null && <span className="agent-model-tag">Prefill {(msg.prefillMs / 1000).toFixed(2)} s</span>}
                      {msg.generationMs != null && <span className="agent-model-tag">Gen {(msg.generationMs / 1000).toFixed(2)} s</span>}
                      {msg.inferenceMs != null && <span className="agent-model-tag" title={locale === "es" ? "Duración de inferencia / primer fragmento" : "Inference duration / first chunk"}>{(msg.inferenceMs / 1000).toFixed(2)} s{msg.firstTokenMs != null ? ` · TTFT ${(msg.firstTokenMs / 1000).toFixed(2)} s` : ""}</span>}
                      {msg.content && (
                        <button
                          type="button"
                          className="micro-action-btn"
                          onClick={() => onCopy(msg.id, msg.content)}
                        >
                          {copied ? <Check size={11} /> : <Copy size={11} />}
                          <span>{copied ? (locale === "es" ? "Copiado" : "Copied") : (locale === "es" ? "Copiar" : "Copy")}</span>
                        </button>
                      )}
                    </div>

                    {msg.thinking && (
                      <ThinkingDisclosure
                        text={msg.thinking}
                        isStreaming={isThinkingLive}
                        open={thinkOpen}
                        onToggle={() =>
                          onToggleThinking(msg.id, !thinkOpen)
                        }
                      />
                    )}

                    {msg.content ? (
                      <div className="agent-assistant-body">
                        <MarkdownContent text={msg.content} streaming={active && isLastMsg && !msg.toolCalls.length} />
                      </div>
                    ) : (
                      active &&
                      active && !msg.toolCalls.length && (
                        modelLoadProgress &&
                        (modelLoadProgress.stage === "unloading" ||
                          modelLoadProgress.stage === "starting" ||
                          modelLoadProgress.stage === "loading") ? (
                          <ModelLoadInlineBar progress={modelLoadProgress} />
                        ) : (
                          <div className="agent-typing-hint">
                            <RefreshCw size={12} className="spin" />
                            <span>{locale === "es" ? "Generando respuesta…" : "Generating response…"}</span>
                          </div>
                        )
                      )
                    )}
                    {active && isLastMsg && hasRunningTools && <div className="agent-typing-hint"><RefreshCw size={12} className="spin" /><span>{locale === "es" ? "Ejecutando herramientas…" : "Running tools…"}</span></div>}
                    {msg.toolCalls.length > 0 && (
                      <ToolCallGroup
                        collapseSuccessful
                        calls={msg.toolCalls}
                        expandedTools={expandedTools}
                        onToggleTool={(id, next) =>
                          onToggleTool(id, next)
                        }
                        extras={(call) => ({
                          shotB64: call.screenshotPath
                            ? savedShots[call.screenshotPath]
                            : undefined,
                          onUndo: () => void onUndo(msg.id, call.id),
                        })}
                      />
                    )}

                  </div>
                );
}, (previous, next) => {
  // Shared maps change when any tool expands or screenshot arrives.
  // Only invalidate rows whose own tool entries changed.
  const { expandedTools: oldTools, savedShots: oldShots, ...oldProps } = previous;
  const { expandedTools: newTools, savedShots: newShots, ...newProps } = next;
  for (const key of Object.keys(oldProps) as (keyof typeof oldProps)[]) {
    if (!Object.is(oldProps[key], newProps[key])) return false;
  }
  for (const call of next.msg.toolCalls) {
    if (oldTools[call.id] !== newTools[call.id]) return false;
    if (call.screenshotPath && oldShots[call.screenshotPath] !== newShots[call.screenshotPath]) return false;
  }
  return true;
});
