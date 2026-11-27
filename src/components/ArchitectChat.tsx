import { useEffect, useRef, useState } from "react";
import {
  ArrowUp,
  Bot,
  Check,
  ChevronUp,
  Cloud,
  FolderPlus,
  Paperclip,
  RefreshCw,
  Sparkles,
  Square,
  Trash2,
  Undo2,
  Wand2,
  X,
} from "lucide-react";
import { invoke } from "../lib/bridge";
import { listen } from "../lib/bridge";
import { useGraphStore } from "../store/useGraphStore";
import { useI18n } from "../i18n";
import {
  applyGraphPatch,
  parseGraphPatch,
  parseWorkflowJson,
  summarizeGraphPatch,
  type CloudProviderConfig,
  type LocalModelFile,
  type LoorsGraphPatch,
  type LoorsWorkflowFile,
} from "../types/graph";
import {
  MarkdownContent,
  MessageQueueTray,
  ModelLoadInlineBar,
  ReasoningEffortSelect,
  ThinkingDisclosure,
  ToolActivityRow,
  type ActivityToolItem,
  type QueuedMessageItem,
} from "./ChatActivity";

interface ChatMsg {
  id: string;
  role: "user" | "assistant";
  content: string;
  attachments?: string[];
  thinking?: string;
  toolCalls?: ActivityToolItem[];
  workflow?: LoorsWorkflowFile | null;
  patch?: LoorsGraphPatch | null;
  rawActionJson?: string | null;
  applied?: boolean;
  previousWorkflow?: LoorsWorkflowFile | null;
}

type ArchitectStreamEvent =
  | { type: "token"; is_thinking: boolean; token: string }
  | { type: "tool_started"; id: string; name: string; args_json: string }
  | {
      type: "tool_finished";
      id: string;
      name: string;
      output_preview: string;
      duration_ms: number;
      status: string;
    };

interface ArchitectSkillInfo {
  name: string;
  path: string;
  source: string;
}

interface ArchitectChatProps {
  open: boolean;
  onApplyGraph: (
    wf: LoorsWorkflowFile,
    opts?: { isPatch?: boolean; summary?: string }
  ) => void;
}

function getAttachTag(pathOrName: string): { tag: string; cls: string } {
  const lower = pathOrName.toLowerCase();
  if (lower.endsWith(".pdf")) return { tag: "PDF", cls: "att-pdf" };
  if (lower.endsWith(".docx") || lower.endsWith(".odt")) return { tag: "DOC", cls: "att-doc" };
  if (lower.endsWith(".xlsx") || lower.endsWith(".csv")) return { tag: "XLS", cls: "att-xls" };
  if (/\.(png|jpe?g|webp|gif|bmp)$/i.test(lower)) return { tag: "IMG", cls: "att-img" };
  const base = pathOrName.split(/[\\/]/).pop() ?? pathOrName;
  if (!base.includes(".")) return { tag: "DIR", cls: "att-doc" };
  const ext = base.split(".").pop();
  return {
    tag: ext && ext.length <= 5 ? ext.toUpperCase() : "FILE",
    cls: "att-file",
  };
}

function extractGraphActionFromReply(text: string): {
  workflow: LoorsWorkflowFile | null;
  patch: LoorsGraphPatch | null;
  rawActionJson: string | null;
  displayText: string;
} {
  const regex = /```(?:json)?\s*([\s\S]*?)```/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    const raw = match[1].trim();
    const patch = parseGraphPatch(raw);
    if (patch) {
      const displayText = (
        text.slice(0, match.index) + text.slice(match.index + match[0].length)
      ).trim();
      return { workflow: null, patch, rawActionJson: raw, displayText };
    }
    try {
      const workflow = parseWorkflowJson(raw);
      const displayText = (
        text.slice(0, match.index) + text.slice(match.index + match[0].length)
      ).trim();
      return { workflow, patch: null, rawActionJson: raw, displayText };
    } catch {
      // try next block
    }
  }
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    const raw = text.slice(firstBrace, lastBrace + 1);
    const patch = parseGraphPatch(raw);
    if (patch) {
      const displayText = (text.slice(0, firstBrace) + text.slice(lastBrace + 1)).trim();
      return { workflow: null, patch, rawActionJson: raw, displayText };
    }
    try {
      const workflow = parseWorkflowJson(raw);
      const displayText = (text.slice(0, firstBrace) + text.slice(lastBrace + 1)).trim();
      return { workflow, patch: null, rawActionJson: raw, displayText };
    } catch {
      return { workflow: null, patch: null, rawActionJson: null, displayText: text };
    }
  }
  return { workflow: null, patch: null, rawActionJson: null, displayText: text };
}

export function ArchitectChat({ open, onApplyGraph }: ArchitectChatProps) {
  const { locale, t } = useI18n();
  const nodes = useGraphStore((s) => s.nodes);
  const selectedBackend = useGraphStore((s) => s.selectedBackend);
  const exportWorkflow = useGraphStore((s) => s.exportWorkflow);
  const architectSeedPrompt = useGraphStore((s) => s.architectSeedPrompt);
  const setArchitectSeedPrompt = useGraphStore((s) => s.setArchitectSeedPrompt);
  const modelLoadProgress = useGraphStore((s) => s.modelLoadProgress);
  const globalActiveModelPath = useGraphStore((s) => s.activeModelPath);
  const setGlobalActiveModelPath = useGraphStore((s) => s.setActiveModelPath);

  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [streamThinking, setStreamThinking] = useState("");
  const [streamContent, setStreamContent] = useState("");
  const [streamTools, setStreamTools] = useState<ActivityToolItem[]>([]);
  const [queue, setQueue] = useState<QueuedMessageItem[]>([]);
  const [pendingAttachments, setPendingAttachments] = useState<string[]>([]);
  const [stagingFiles, setStagingFiles] = useState(false);
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const [expandedThinking, setExpandedThinking] = useState<Record<string, boolean>>({});
  const [expandedTools, setExpandedTools] = useState<Record<string, boolean>>({});
  const [localModels, setLocalModels] = useState<LocalModelFile[]>([]);
  const [cloudProviders, setCloudProviders] = useState<CloudProviderConfig[]>([]);
  const [overrideModel, setOverrideModel] = useState("");
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const modelMenuRef = useRef<HTMLDivElement>(null);
  const [reasoningEffort, setReasoningEffort] = useState<"off" | "low" | "medium" | "high">(() => {
    try {
      const saved = localStorage.getItem("loors_architect_effort");
      if (saved === "off" || saved === "low" || saved === "medium" || saved === "high") {
        return saved;
      }
    } catch {
      // ignore
    }
    return "medium";
  });
  const [skillInfo, setSkillInfo] = useState<ArchitectSkillInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  const listRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const messagesRef = useRef<ChatMsg[]>(messages);
  messagesRef.current = messages;
  const streamThinkingRef = useRef("");
  const streamToolsRef = useRef<ActivityToolItem[]>([]);
  const manualStopRef = useRef(false);

  const graphModelNode = nodes.find((n) => n.data.kind === "local_model");
  const graphTaskNode = nodes.find((n) => n.data.kind === "task_input");
  const graphWorkspace = String(graphTaskNode?.data.config.workspace ?? ".");
  const rawGraphModelPath = String(graphModelNode?.data.config.modelPath ?? "").trim();
  const graphModelPath =
    rawGraphModelPath === "models/qwen2.5-coder-7b-instruct-q4_k_m.gguf"
      ? ""
      : rawGraphModelPath;
  const graphContextSize = Number(graphModelNode?.data.config.contextSize ?? 0);
  const firstCloudModel = (() => {
    const p = cloudProviders.find((cp) => cp.enabled && cp.models.length > 0);
    return p ? `cloud::${p.id}::${p.models[0]}` : "";
  })();
  const activeModelPath =
    overrideModel ||
    globalActiveModelPath ||
    graphModelPath ||
    localModels[0]?.path ||
    firstCloudModel ||
    "";

  useEffect(() => {
    if (!modelMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (modelMenuRef.current && !modelMenuRef.current.contains(e.target as Node)) {
        setModelMenuOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setModelMenuOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [modelMenuOpen]);

  useEffect(() => {
    if (!open || !architectSeedPrompt) return;
    setInput(architectSeedPrompt);
    setArchitectSeedPrompt(null);
    setTimeout(() => inputRef.current?.focus(), 40);
  }, [open, architectSeedPrompt, setArchitectSeedPrompt]);

  useEffect(() => {
    if (!open) return;
    const refresh = () => {
      invoke<LocalModelFile[]>("scan_local_models")
        .then(setLocalModels)
        .catch(() => {});
      invoke<CloudProviderConfig[]>("get_cloud_providers")
        .then(setCloudProviders)
        .catch(() => setCloudProviders([]));
    };
    refresh();
    invoke<ArchitectSkillInfo>("get_architect_skill_info", {
      workspace: graphWorkspace,
    })
      .then(setSkillInfo)
      .catch(() => {});
    window.addEventListener("loors:models-changed", refresh);
    window.addEventListener("loors:providers-changed", refresh);
    return () => {
      window.removeEventListener("loors:models-changed", refresh);
      window.removeEventListener("loors:providers-changed", refresh);
    };
  }, [open, graphWorkspace]);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    listen<ArchitectStreamEvent>("loors://architect-event", (ev) => {
      if (cancelled) return;
      const p = ev.payload;
      if (p.type === "token") {
        if (p.is_thinking) {
          streamThinkingRef.current += p.token;
          setStreamThinking(streamThinkingRef.current);
        } else {
          setStreamContent((prev) => prev + p.token);
        }
      } else if (p.type === "tool_started") {
        const nextTool: ActivityToolItem = {
          id: p.id,
          name: p.name,
          argsJson: p.args_json,
          status: "running",
        };
        streamToolsRef.current = [...streamToolsRef.current, nextTool];
        setStreamTools(streamToolsRef.current);
      } else if (p.type === "tool_finished") {
        streamToolsRef.current = streamToolsRef.current.map((t) =>
          t.id === p.id
            ? {
                ...t,
                status: p.status,
                outputPreview: p.output_preview,
                durationMs: p.duration_ms,
              }
            : t
        );
        setStreamTools(streamToolsRef.current);
      }
    })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch(() => {});

    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, []);

  useEffect(() => {
    const el = listRef.current;
    if (el && stickToBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages.length, streamContent, streamThinking, streamTools.length]);

  const stageExternalFiles = async (fileList: FileList | File[]) => {
    const files = Array.from(fileList);
    if (files.length === 0) return;
    setStagingFiles(true);
    try {
      const stagedPaths: string[] = [];
      for (const file of files) {
        const buf = await file.arrayBuffer();
        const bytes = new Uint8Array(buf);
        let binary = "";
        const chunk = 0x8000;
        for (let i = 0; i < bytes.length; i += chunk) {
          binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
        }
        const b64 = btoa(binary);
        const savedPath = await invoke<string>("stage_uploaded_file", {
          filename: file.name || `capture-${Date.now()}.png`,
          base64Data: b64,
        });
        stagedPaths.push(savedPath);
      }
      if (stagedPaths.length > 0) {
        setPendingAttachments((prev) => Array.from(new Set([...prev, ...stagedPaths])));
      }
    } catch (err) {
      setError(`Error adjuntando archivo: ${String(err)}`);
    } finally {
      setStagingFiles(false);
    }
  };

  const handlePickFiles = async () => {
    try {
      const picked = await invoke<string[]>("pick_files", {
        initialDir: graphWorkspace && graphWorkspace !== "." ? graphWorkspace : null,
      });
      if (picked && picked.length > 0) {
        setPendingAttachments((prev) => Array.from(new Set([...prev, ...picked])));
      }
    } catch (err) {
      setError(String(err));
    }
  };

  const handlePickFolder = async () => {
    try {
      const picked = await invoke<string | null>("pick_folder", {
        initialDir: graphWorkspace && graphWorkspace !== "." ? graphWorkspace : null,
      });
      if (picked) {
        setPendingAttachments((prev) => Array.from(new Set([...prev, picked])));
      }
    } catch (err) {
      setError(String(err));
    }
  };

  const sendPrompt = async (promptText: string, explicitAttachments?: string[]) => {
    const trimmed = promptText.trim();
    const attachmentsToSend = explicitAttachments ?? pendingAttachments;
    if (!trimmed && attachmentsToSend.length === 0) return;

    if (sending) {
      setQueue((prev) => [
        ...prev,
        {
          id: `q-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
          text: trimmed,
          attachments: attachmentsToSend.length > 0 ? [...attachmentsToSend] : undefined,
        },
      ]);
      setInput("");
      if (!explicitAttachments) setPendingAttachments([]);
      return;
    }

    manualStopRef.current = false;
    setError(null);
    const userMsg: ChatMsg = {
      id: `u-${Date.now()}`,
      role: "user",
      content: trimmed,
      attachments: attachmentsToSend.length > 0 ? [...attachmentsToSend] : undefined,
    };
    const nextHistory = [...messagesRef.current, userMsg];
    setMessages(nextHistory);
    stickToBottomRef.current = true;
    setInput("");
    if (!explicitAttachments) setPendingAttachments([]);
    setSending(true);
    streamThinkingRef.current = "";
    streamToolsRef.current = [];
    setStreamThinking("");
    setStreamContent("");
    setStreamTools([]);

    try {
      const currentGraphJson = JSON.stringify(exportWorkflow(), null, 2);
      const reply = await invoke<string>("architect_chat", {
        backend: selectedBackend,
        modelPath: activeModelPath,
        contextSize: graphContextSize,
        reasoningEffort,
        messages: nextHistory.map((m) => ({
          role: m.role,
          content: m.content,
          attachments: m.attachments ?? [],
        })),
        currentGraphJson,
      });

      const {
        workflow: parsedWf,
        patch: parsedPatch,
        rawActionJson,
        displayText,
      } = extractGraphActionFromReply(reply);
      setMessages((prev) => [
        ...prev,
        {
          id: `a-${Date.now()}`,
          role: "assistant",
          content: parsedWf || parsedPatch ? displayText : reply,
          thinking: streamThinkingRef.current || undefined,
          toolCalls: streamToolsRef.current.length > 0 ? [...streamToolsRef.current] : undefined,
          workflow: parsedWf,
          patch: parsedPatch,
          rawActionJson,
        },
      ]);
    } catch (err) {
      const msg = typeof err === "string" ? err : String(err);
      if (manualStopRef.current || msg.includes("detenida")) {
        if (streamThinkingRef.current || streamToolsRef.current.length > 0) {
          setMessages((prev) => [
            ...prev,
            {
              id: `a-${Date.now()}`,
              role: "assistant",
              content: "Generación detenida por el usuario.",
              thinking: streamThinkingRef.current || undefined,
              toolCalls:
                streamToolsRef.current.length > 0 ? [...streamToolsRef.current] : undefined,
            },
          ]);
        }
      } else {
        setError(msg);
      }
    } finally {
      setSending(false);
      streamThinkingRef.current = "";
      streamToolsRef.current = [];
      setStreamThinking("");
      setStreamContent("");
      setStreamTools([]);
    }
  };

  useEffect(() => {
    if (!sending && !manualStopRef.current && queue.length > 0) {
      const [next, ...rest] = queue;
      setQueue(rest);
      void sendPrompt(next.text, next.attachments ?? []);
    }
  }, [sending, queue]);

  const handleStop = async () => {
    manualStopRef.current = true;
    try {
      await invoke("stop_architect_chat");
    } catch {
      // ignore
    }
  };

  if (!open) return null;

  const streamThinkOpen = expandedThinking["__stream__"] ?? false;

  return (
    <div
      className={`architect-drawer ${isDraggingOver ? "is-drop-active" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        setIsDraggingOver(true);
      }}
      onDragLeave={() => setIsDraggingOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setIsDraggingOver(false);
        if (e.dataTransfer?.files && e.dataTransfer.files.length > 0) {
          void stageExternalFiles(e.dataTransfer.files);
        }
      }}
    >
      <div className="architect-subhead">
        <div className="architect-subhead-title">
          <Sparkles size={14} style={{ color: "#a855f7" }} />
          <span>{t("architect.subtitle")}</span>
        </div>
        {messages.length > 0 && (
          <button
            type="button"
            className="icon-btn"
            title={locale === "es" ? "Limpiar conversación" : "Clear conversation"}
            onClick={() => setMessages([])}
          >
            <Trash2 size={13} />
          </button>
        )}
      </div>

      {skillInfo && (
        <div
          className="architect-model-bar"
          style={{
            padding: "6px 12px",
            fontSize: 11,
            color: "#94a3b8",
            display: "flex",
            justifyContent: "space-between",
            gap: 8,
          }}
          title={`Skill cargada: ${skillInfo.path}\nHerramientas activas: list_files, find_files, grep_search, read_file, list_loors_capabilities, read_skill`}
        >
          <span>
            Skill: <strong style={{ color: "#c084fc" }}>{skillInfo.name}</strong> ({skillInfo.source})
          </span>
          <span>{locale === "es" ? "6 tools lectura" : "6 read-only tools"}</span>
        </div>
      )}

      <div
        className="architect-messages"
        ref={listRef}
        onScroll={() => {
          const el = listRef.current;
          if (!el) return;
          stickToBottomRef.current =
            el.scrollHeight - el.scrollTop - el.clientHeight < 48;
        }}
      >
        {messages.length === 0 && !sending && (
          <div className="architect-welcome">
            <Bot size={22} style={{ color: "#818cf8" }} />
            <p>{t("architect.emptyIntro")}</p>
            <div className="architect-quick">
              {[t("architect.p1"), t("architect.p2"), t("architect.p3"), t("architect.p4")].map((qp) => (
                <button
                  key={qp}
                  type="button"
                  className="architect-quick-btn"
                  onClick={() => void sendPrompt(qp)}
                >
                  {qp}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((m) => {
          const thinkOpen = expandedThinking[m.id] ?? false;
          return (
            <div key={m.id} className={`chat-bubble role-${m.role}`}>
              <div className="chat-role">
                {m.role === "user"
                  ? locale === "es"
                    ? "Tú"
                    : "You"
                  : locale === "es"
                    ? "Arquitecto Loors"
                    : "Loors Architect"}
              </div>
              {m.attachments && m.attachments.length > 0 && (
                <div className="user-msg-attachments" style={{ marginBottom: 6 }}>
                  {m.attachments.map((att) => {
                    const badge = getAttachTag(att);
                    const name = att.split(/[\\/]/).pop() ?? att;
                    return (
                      <span key={att} className="attachment-chip sent" title={att}>
                        <span className={`attachment-ext-badge ${badge.cls}`}>
                          {badge.tag}
                        </span>
                        <span className="truncate-text" style={{ maxWidth: 150 }}>
                          {name}
                        </span>
                      </span>
                    );
                  })}
                </div>
              )}
              {m.thinking && (
                <ThinkingDisclosure
                  text={m.thinking}
                  isStreaming={false}
                  open={thinkOpen}
                  onToggle={() =>
                    setExpandedThinking((p) => ({ ...p, [m.id]: !thinkOpen }))
                  }
                />
              )}
              {m.toolCalls && m.toolCalls.length > 0 && (
                <div className="codex-tool-list">
                  {m.toolCalls.map((call) => {
                    const isOpen = expandedTools[call.id] ?? false;
                    return (
                      <ToolActivityRow
                        key={call.id}
                        call={call}
                        open={isOpen}
                        onToggle={() =>
                          setExpandedTools((p) => ({ ...p, [call.id]: !isOpen }))
                        }
                      />
                    );
                  })}
                </div>
              )}
              {m.content && (
                <div className="chat-content">
                  {m.role === "assistant" ? (
                    <MarkdownContent text={m.content} />
                  ) : (
                    m.content
                  )}
                </div>
              )}
              {m.patch && (
                <div className="architect-patch-card">
                  {m.patch.summary && (
                    <div className="architect-patch-summary">{m.patch.summary}</div>
                  )}
                  <ul className="architect-patch-list">
                    {m.patch.updateNodes?.map((u) => {
                      const existing = nodes.find((n) => n.id === u.id);
                      const cfgKeys = Object.keys({
                        ...(u.data?.config ?? {}),
                        ...(u.config ?? {}),
                      });
                      const label = existing?.data.title || u.id;
                      return (
                        <li key={`upd-${u.id}`}>
                          <span className="patch-tag patch-upd">~</span>
                          <strong>{label}</strong>
                          <span className="patch-meta">
                            ({u.id})
                            {cfgKeys.length > 0 ? ` · ${cfgKeys.join(", ")}` : ""}
                          </span>
                        </li>
                      );
                    })}
                    {m.patch.addNodes?.map((n) => (
                      <li key={`add-${n.id}`}>
                        <span className="patch-tag patch-add">+</span>
                        <strong>{n.data?.title || n.id}</strong>
                        <span className="patch-meta">
                          ({n.data?.kind})
                        </span>
                      </li>
                    ))}
                    {m.patch.removeNodes?.map((id) => {
                      const existing = nodes.find((n) => n.id === id);
                      return (
                        <li key={`rem-${id}`}>
                          <span className="patch-tag patch-rem">-</span>
                          <strong>{existing?.data.title || id}</strong>
                          <span className="patch-meta">({id})</span>
                        </li>
                      );
                    })}
                    {((m.patch.addEdges?.length ?? 0) > 0 ||
                      (m.patch.removeEdges?.length ?? 0) > 0) && (
                      <li>
                        <span className="patch-tag patch-edge">⇄</span>
                        <span>
                          {locale === "es" ? "Conexiones" : "Edges"}:{" "}
                          {(m.patch.addEdges?.length ?? 0) > 0
                            ? `+${m.patch.addEdges!.length}`
                            : ""}
                          {(m.patch.addEdges?.length ?? 0) > 0 &&
                          (m.patch.removeEdges?.length ?? 0) > 0
                            ? " / "
                            : ""}
                          {(m.patch.removeEdges?.length ?? 0) > 0
                            ? `-${m.patch.removeEdges!.length}`
                            : ""}
                        </span>
                      </li>
                    )}
                  </ul>

                  <div className="architect-patch-actions">
                    <button
                      type="button"
                      className="btn-primary apply-graph-btn"
                      onClick={() => {
                        const currentWf = exportWorkflow();
                        const patched = applyGraphPatch(currentWf, m.patch!);
                        const summary =
                          m.patch!.summary ||
                          summarizeGraphPatch(m.patch!, locale === "es" ? "es" : "en");
                        onApplyGraph(patched, { isPatch: true, summary });
                        setMessages((prev) =>
                          prev.map((item) =>
                            item.id === m.id
                              ? {
                                  ...item,
                                  applied: true,
                                  previousWorkflow: item.previousWorkflow ?? currentWf,
                                }
                              : item
                          )
                        );
                      }}
                    >
                      {m.applied ? <Check size={14} /> : <Wand2 size={14} />}
                      <span>
                        {m.applied
                          ? locale === "es"
                            ? `Aplicado (${summarizeGraphPatch(m.patch, "es")})`
                            : `Applied (${summarizeGraphPatch(m.patch, "en")})`
                          : locale === "es"
                            ? `Aplicar cambios (${summarizeGraphPatch(m.patch, "es")})`
                            : `Apply patch (${summarizeGraphPatch(m.patch, "en")})`}
                      </span>
                    </button>
                    {m.applied && m.previousWorkflow && (
                      <button
                        type="button"
                        className="btn-secondary architect-undo-btn"
                        title={locale === "es" ? "Deshacer este parche" : "Undo this patch"}
                        onClick={() => {
                          onApplyGraph(m.previousWorkflow!, {
                            isPatch: true,
                            summary:
                              locale === "es"
                                ? "Parche deshecho"
                                : "Patch reverted",
                          });
                          setMessages((prev) =>
                            prev.map((item) =>
                              item.id === m.id
                                ? { ...item, applied: false, previousWorkflow: null }
                                : item
                            )
                          );
                        }}
                      >
                        <Undo2 size={13} />
                        <span>{locale === "es" ? "Deshacer" : "Undo"}</span>
                      </button>
                    )}
                  </div>

                  {m.rawActionJson && (
                    <details className="architect-json-details">
                      <summary>
                        {locale === "es" ? "Ver JSON del parche" : "View patch JSON"}
                      </summary>
                      <pre>{m.rawActionJson}</pre>
                    </details>
                  )}
                </div>
              )}
              {m.workflow && (
                <div className="architect-patch-card">
                  <div className="architect-patch-actions">
                    <button
                      type="button"
                      className="btn-primary apply-graph-btn"
                      onClick={() => {
                        const currentWf = exportWorkflow();
                        onApplyGraph(m.workflow!, { isPatch: false });
                        setMessages((prev) =>
                          prev.map((item) =>
                            item.id === m.id
                              ? {
                                  ...item,
                                  applied: true,
                                  previousWorkflow: item.previousWorkflow ?? currentWf,
                                }
                              : item
                          )
                        );
                      }}
                    >
                      {m.applied ? <Check size={14} /> : <Wand2 size={14} />}
                      <span>
                        {locale === "es"
                          ? `Aplicar "${m.workflow.name}" al Canvas (${m.workflow.nodes.length} nodos)`
                          : `Apply "${m.workflow.name}" to Canvas (${m.workflow.nodes.length} nodes)`}
                      </span>
                    </button>
                    {m.applied && m.previousWorkflow && (
                      <button
                        type="button"
                        className="btn-secondary architect-undo-btn"
                        title={locale === "es" ? "Restaurar arnés anterior" : "Restore previous harness"}
                        onClick={() => {
                          onApplyGraph(m.previousWorkflow!, {
                            isPatch: true,
                            summary:
                              locale === "es"
                                ? "Arnés anterior restaurado"
                                : "Previous harness restored",
                          });
                          setMessages((prev) =>
                            prev.map((item) =>
                              item.id === m.id
                                ? { ...item, applied: false, previousWorkflow: null }
                                : item
                            )
                          );
                        }}
                      >
                        <Undo2 size={13} />
                        <span>{locale === "es" ? "Deshacer" : "Undo"}</span>
                      </button>
                    )}
                  </div>
                  {m.rawActionJson && (
                    <details className="architect-json-details">
                      <summary>
                        {locale === "es" ? "Ver JSON completo" : "View full JSON"}
                      </summary>
                      <pre>{m.rawActionJson}</pre>
                    </details>
                  )}
                </div>
              )}
            </div>
          );
        })}

        {sending && (
          <div className="chat-bubble role-assistant">
            <div className="chat-role">
              {locale === "es" ? "Arquitecto Loors" : "Loors Architect"}
            </div>
            {streamThinking && (
              <ThinkingDisclosure
                text={streamThinking}
                isStreaming={!streamContent}
                open={streamThinkOpen}
                onToggle={() =>
                  setExpandedThinking((p) => ({
                    ...p,
                    __stream__: !streamThinkOpen,
                  }))
                }
              />
            )}
            {streamTools.length > 0 && (
              <div className="codex-tool-list">
                {streamTools.map((call) => {
                  const isOpen = expandedTools[call.id] ?? false;
                  return (
                    <ToolActivityRow
                      key={call.id}
                      call={call}
                      open={isOpen}
                      onToggle={() =>
                        setExpandedTools((p) => ({ ...p, [call.id]: !isOpen }))
                      }
                    />
                  );
                })}
              </div>
            )}
            {streamContent ? (
              <div className="chat-content">
                <MarkdownContent text={streamContent} />
              </div>
            ) : (
              !streamThinking &&
              streamTools.length === 0 && (
                modelLoadProgress &&
                (modelLoadProgress.stage === "unloading" ||
                  modelLoadProgress.stage === "starting" ||
                  modelLoadProgress.stage === "loading") ? (
                  <ModelLoadInlineBar progress={modelLoadProgress} />
                ) : (
                  <div className="agent-typing-hint">
                    <RefreshCw size={12} className="spin" />
                    <span>Preparando respuesta…</span>
                  </div>
                )
              )
            )}
          </div>
        )}

        {error && <div className="hw-error">{error}</div>}
      </div>

      <MessageQueueTray
        items={queue}
        isBusy={sending}
        onRemove={(id) => setQueue((prev) => prev.filter((q) => q.id !== id))}
        onRunNext={() => {
          if (queue.length === 0) return;
          const [next, ...rest] = queue;
          setQueue(rest);
          void sendPrompt(next.text, next.attachments ?? []);
        }}
      />

      {(pendingAttachments.length > 0 || stagingFiles) && (
        <div className="composer-attachments-tray architect-att-tray">
          {pendingAttachments.map((att) => {
            const badge = getAttachTag(att);
            const name = att.split(/[\\/]/).pop() ?? att;
            return (
              <span key={att} className="attachment-chip" title={att}>
                <span className={`attachment-ext-badge ${badge.cls}`}>
                  {badge.tag}
                </span>
                <span className="truncate-text" style={{ maxWidth: 140 }}>
                  {name}
                </span>
                <button
                  type="button"
                  title="Quitar adjunto"
                  onClick={() =>
                    setPendingAttachments((prev) => prev.filter((x) => x !== att))
                  }
                >
                  <X size={11} />
                </button>
              </span>
            );
          })}
          {stagingFiles && (
            <span className="attachment-chip">
              <RefreshCw size={11} className="spin" />
              <span>Procesando…</span>
            </span>
          )}
        </div>
      )}

      <div className="architect-composer-box">
        <textarea
          ref={inputRef}
          rows={2}
          placeholder={
            sending
              ? t("architect.queuePlaceholder")
              : t("architect.placeholder")
          }
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onPaste={(e) => {
            if (e.clipboardData?.files && e.clipboardData.files.length > 0) {
              e.preventDefault();
              void stageExternalFiles(e.clipboardData.files);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void sendPrompt(input);
            }
          }}
        />
        <div className="architect-composer-bar">
          <div className="architect-attach-actions" style={{ minWidth: 0, flex: 1 }}>
            <button
              type="button"
              className="composer-icon-pill"
              title="Adjuntar archivos o imágenes"
              onClick={() => void handlePickFiles()}
            >
              <Paperclip size={13} />
            </button>
            <button
              type="button"
              className="composer-icon-pill"
              title="Adjuntar carpeta de proyecto"
              onClick={() => void handlePickFolder()}
            >
              <FolderPlus size={13} />
            </button>

            <div className="composer-model-wrap" ref={modelMenuRef} style={{ minWidth: 0 }}>
              <button
                type="button"
                className="effort-pill-btn"
                title={activeModelPath || "Elegir modelo"}
                onClick={() => setModelMenuOpen((v) => !v)}
                style={{ maxWidth: 175 }}
              >
                {activeModelPath.startsWith("cloud::") && (
                  <Cloud size={11} style={{ color: "#38bdf8", flexShrink: 0 }} />
                )}
                <span className="truncate-text">
                  {activeModelPath
                    ? activeModelPath.startsWith("cloud::")
                      ? activeModelPath.split("::").slice(2).join("::")
                      : (activeModelPath.split(/[\\/]/).pop() ?? activeModelPath).replace(/\.gguf$/i, "")
                    : t("agent.chooseModel")}
                </span>
                <ChevronUp size={11} style={{ color: "#64748b", flexShrink: 0 }} />
              </button>

              {modelMenuOpen && (
                <div
                  className="effort-popover"
                  role="menu"
                  style={{ minWidth: 250, maxHeight: 280, overflowY: "auto" }}
                >
                  {cloudProviders
                    .filter((p) => p.enabled && p.models.length > 0)
                    .map((p) => (
                      <div key={p.id}>
                        <div className="effort-popover-title">{p.name}</div>
                        {p.models.map((mid) => {
                          const uri = `cloud::${p.id}::${mid}`;
                          const active = activeModelPath === uri;
                          return (
                            <button
                              key={uri}
                              type="button"
                              role="menuitem"
                              className={`effort-pop-item ${active ? "active" : ""}`}
                              onClick={() => {
                                setOverrideModel(uri);
                                setGlobalActiveModelPath(uri);
                                setModelMenuOpen(false);
                              }}
                            >
                              <div className="effort-pop-item-text">
                                <span className="effort-pop-item-label truncate-text">{mid}</span>
                              </div>
                              {active && <Check size={12} style={{ color: "#c084fc", flexShrink: 0 }} />}
                            </button>
                          );
                        })}
                      </div>
                    ))}

                  {localModels.length > 0 && (
                    <div>
                      <div className="effort-popover-title">Modelos locales (GGUF)</div>
                      {localModels.map((m) => {
                        const active = activeModelPath === m.path;
                        return (
                          <button
                            key={m.path}
                            type="button"
                            role="menuitem"
                            className={`effort-pop-item ${active ? "active" : ""}`}
                            onClick={() => {
                              setOverrideModel(m.path);
                              setGlobalActiveModelPath(m.path);
                              setModelMenuOpen(false);
                            }}
                          >
                            <div className="effort-pop-item-text">
                              <span className="effort-pop-item-label truncate-text">
                                {m.name.replace(/\.gguf$/i, "")}
                              </span>
                              <span className="effort-pop-item-desc">
                                {(m.size_mb / 1024).toFixed(1)} GB
                              </span>
                            </div>
                            {active && <Check size={12} style={{ color: "#c084fc", flexShrink: 0 }} />}
                          </button>
                        );
                      })}
                    </div>
                  )}

                  {localModels.length === 0 &&
                    !cloudProviders.some((p) => p.enabled && p.models.length > 0) && (
                      <div style={{ padding: "8px 10px", fontSize: 11.5, color: "#94a3b8" }}>
                        No hay modelos locales ni APIs conectadas.
                      </div>
                    )}

                  <button
                    type="button"
                    role="menuitem"
                    className="effort-pop-item"
                    onClick={() => {
                      setModelMenuOpen(false);
                      window.dispatchEvent(
                        new CustomEvent("loors:open-models-modal", {
                          detail: { tab: "cloud" },
                        })
                      );
                    }}
                  >
                    <div className="effort-pop-item-text">
                      <span className="effort-pop-item-label" style={{ color: "#38bdf8" }}>
                        Configurar modelos o APIs…
                      </span>
                    </div>
                  </button>
                </div>
              )}
            </div>

            <ReasoningEffortSelect
              value={reasoningEffort}
              modelPath={activeModelPath}
              onChange={(next) => {
                setReasoningEffort(next);
                try {
                  localStorage.setItem("loors_architect_effort", next);
                } catch {
                  // ignore
                }
              }}
            />
          </div>
          <div className="composer-action-group">
            {sending && (
              <button
                type="button"
                className="composer-send-btn is-stop"
                title="Detener generación"
                onClick={() => void handleStop()}
              >
                <Square size={12} fill="currentColor" />
              </button>
            )}
            {(!sending || input.trim().length > 0 || pendingAttachments.length > 0) && (
              <button
                type="button"
                className="composer-send-btn"
                title={sending ? "Encolar mensaje" : "Enviar"}
                disabled={!input.trim() && pendingAttachments.length === 0}
                onClick={() => void sendPrompt(input)}
              >
                <ArrowUp size={15} strokeWidth={2.3} />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
