import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUp,
  Bot,
  Boxes,
  Check,
  ChevronUp,
  Cloud,
  Copy,
  Download,
  Eye,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  GitBranch,
  Globe,
  Lock,
  MessageSquare,
  MoreHorizontal,
  Paperclip,
  Pencil,
  Pin,
  PinOff,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Settings,
  Shield,
  Square,
  Trash2,
  X,
  Zap,
} from "lucide-react";
import { invoke } from "../lib/bridge";
import { listen } from "../lib/bridge";
import { useGraphStore } from "../store/useGraphStore";
import { useI18n } from "../i18n";
import { InteractiveBrowserPane } from "./InteractiveBrowserPane";
import {
  MarkdownContent,
  MessageQueueTray,
  ModelLoadInlineBar,
  ReasoningEffortSelect,
  ThinkingDisclosure,
  ToolActivityRow,
  WorkspaceFileTree,
  type QueuedMessageItem,
} from "./ChatActivity";
import {
  isCloudModelPath,
  parseCloudModelPath,
  parseGgufMetadata,
  type AgentArtifactPreview,
  type AgentChatEvent,
  type AgentChatMessage,
  type AgentSession,
  type AgentSessionSummary,
  type AgentTodoItem,
  type AgentToolCallRecord,
  type PendingAgentQuestion,
  type BrowserFrameEvent,
  type CloudProviderConfig,
  type HardwareProfile,
  type LocalModelFile,
  type ModelTuningProfile,
  type PermissionMode,
  type RuntimeBackendKind,
  type RuntimeDownloadEvent,
  type RuntimeStatusSnapshot,
  type SkillSummary,
} from "../types/graph";

function makeSessionId(): string {
  return `sess-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function normWs(p: string): string {
  return p.trim().replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function displaySessionTitle(title: string, locale: string): string {
  const t = title.trim();
  if (t === "Nuevo chat" || t === "New chat") {
    return locale === "es" ? "Nuevo chat" : "New chat";
  }
  if (t === "Nueva sesión" || t === "New session" || !t) {
    return locale === "es" ? "Nueva sesión" : "New session";
  }
  return title;
}

function formatRelativeAge(epochSecs: number, locale: string): string {
  if (!epochSecs) return "";
  const diff = Math.max(0, Math.floor(Date.now() / 1000) - epochSecs);
  if (diff < 60) return locale === "es" ? "ahora" : "now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  return `${Math.floor(diff / 86400)}d`;
}

function loadStoredProjects(): string[] {
  try {
    const raw = localStorage.getItem("loors_agent_projects");
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((x): x is string => typeof x === "string" && x.trim() !== "" && x.trim() !== ".")
      : [];
  } catch {
    return [];
  }
}

function saveStoredProjects(list: string[]) {
  try {
    localStorage.setItem("loors_agent_projects", JSON.stringify(list));
  } catch {
    // ignore
  }
}

function getAttachmentBadge(pathOrName: string): { tag: string; cls: string } {
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

function DiffLines({ diff }: { diff: string }) {
  return (
    <pre className="diff-code-box">
      {diff.split("\n").map((line, i) => {
        const cls = line.startsWith("+ ")
          ? "diff-add"
          : line.startsWith("- ")
            ? "diff-del"
            : line.startsWith("---") || line.startsWith("+++")
              ? "diff-hdr"
              : "diff-ctx";
        return (
          <div key={i} className={cls}>
            {line}
          </div>
        );
      })}
    </pre>
  );
}

export function AgentWorkspaceView() {
  const { locale, t } = useI18n();
  const nodes = useGraphStore((s) => s.nodes);
  const selectedBackend = useGraphStore((s) => s.selectedBackend);
  const setSelectedBackend = useGraphStore((s) => s.setSelectedBackend);
  const openTuningModal = useGraphStore((s) => s.openTuningModal);
  const activeModelPath = useGraphStore((s) => s.activeModelPath);
  const setActiveModelPath = useGraphStore((s) => s.setActiveModelPath);
  const loadedContextSize = useGraphStore((s) => s.loadedContextSize);
  const modelLoadProgress = useGraphStore((s) => s.modelLoadProgress);
  const setAgentStatus = useGraphStore((s) => s.setAgentStatus);

  const defaultHarnessWorkspace = String(
    nodes.find((n) => n.data.kind === "task_input")?.data.config.workspace ?? "."
  );
  const rawHarnessModel = String(
    nodes.find((n) => n.data.kind === "local_model")?.data.config.modelPath ?? ""
  ).trim();
  const defaultHarnessModel =
    rawHarnessModel === "models/qwen2.5-coder-7b-instruct-q4_k_m.gguf"
      ? ""
      : rawHarnessModel;

  const sidebarOpen = useGraphStore((s) => s.leftPanelOpen);
  const rightPanelOpen = useGraphStore((s) => s.rightPanelOpen);
  const setRightPanelOpen = useGraphStore((s) => s.setRightPanelOpen);
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    const saved = Number(localStorage.getItem("loors_agent_left_w"));
    return Number.isFinite(saved) && saved >= 190 && saved <= 420 ? saved : 252;
  });
  const [rightPanelWidth, setRightPanelWidth] = useState<number>(() => {
    const saved = Number(localStorage.getItem("loors_agent_right_w"));
    return Number.isFinite(saved) && saved >= 260 && saved <= 680 ? saved : 390;
  });

  const startAgentResize = (side: "left" | "right", startX: number) => {
    const initial = side === "left" ? sidebarWidth : rightPanelWidth;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    const onMove = (ev: MouseEvent) => {
      const dx = ev.clientX - startX;
      if (side === "left") {
        const next = Math.min(420, Math.max(190, initial + dx));
        setSidebarWidth(next);
        localStorage.setItem("loors_agent_left_w", String(next));
      } else {
        const next = Math.min(680, Math.max(260, initial - dx));
        setRightPanelWidth(next);
        localStorage.setItem("loors_agent_right_w", String(next));
      }
    };
    const onUp = () => {
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };
  const [projects, setProjects] = useState<string[]>(() => loadStoredProjects());
  const [collapsedProjects, setCollapsedProjects] = useState<Record<string, boolean>>({});
  const [sessions, setSessions] = useState<AgentSessionSummary[]>([]);
  const [localModels, setLocalModels] = useState<LocalModelFile[]>([]);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [modelPickerQuery, setModelPickerQuery] = useState("");
  const [pendingAttachments, setPendingAttachments] = useState<string[]>([]);
  const [attachMenuOpen, setAttachMenuOpen] = useState(false);
  const [compactPopoverOpen, setCompactPopoverOpen] = useState(false);
  const [wsMenuOpen, setWsMenuOpen] = useState(false);
  const [permMenuOpen, setPermMenuOpen] = useState(false);
  const [todoItems, setTodoItems] = useState<AgentTodoItem[]>([]);
  const [todoCollapsed, setTodoCollapsed] = useState(false);
  const [pendingQuestion, setPendingQuestion] = useState<PendingAgentQuestion | null>(null);
  const [selectedQuestionOpts, setSelectedQuestionOpts] = useState<string[]>([]);
  const [customQuestionAnswer, setCustomQuestionAnswer] = useState("");
  const [activeArtifact, setActiveArtifact] = useState<AgentArtifactPreview | null>(null);
  const [artifactExpanded, setArtifactExpanded] = useState(true);
  const [confirmRemoveProj, setConfirmRemoveProj] = useState<string | null>(null);
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const [stagingFiles, setStagingFiles] = useState(false);
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [session, setSession] = useState<AgentSession>(() => ({
    id: makeSessionId(),
    title: locale === "es" ? "Nueva sesión" : "New session",
    workspace:
      defaultHarnessWorkspace && defaultHarnessWorkspace !== "."
        ? defaultHarnessWorkspace
        : loadStoredProjects()[0] ?? ".",
    modelPath: activeModelPath || defaultHarnessModel,
    permissionMode: "ask",
    useRag: true,
    compactAtTokens: 0,
    reasoningEffort: "medium",
    enabledSkills: [],
    pinnedFiles: [],
    allowedSessionTools: [],
    messages: [],
    updatedAt: Math.floor(Date.now() / 1000),
  }));

  const [input, setInput] = useState("");
  const [running, setRunning] = useState(false);
  const [messageQueue, setMessageQueue] = useState<QueuedMessageItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [gpuBusyPrompt, setGpuBusyPrompt] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [expandedThinking, setExpandedThinking] = useState<Record<string, boolean>>({});
  const [expandedTools, setExpandedTools] = useState<Record<string, boolean>>({});
  const [pinQuery, setPinQuery] = useState("");
  const [pinResults, setPinResults] = useState<string[]>([]);
  const [rightPanelTab, setRightPanelTab] = useState<"files" | "diff" | "browser">("files");
  const [workspaceFiles, setWorkspaceFiles] = useState<string[]>([]);
  const [fileFilter, setFileFilter] = useState("");
  const [selectedPreviewFile, setSelectedPreviewFile] = useState<string | null>(null);
  const [selectedPreviewContent, setSelectedPreviewContent] = useState<string>("");
  const [gitDiffText, setGitDiffText] = useState("");
  const [contextUsage, setContextUsage] = useState<{ usedChars: number; maxTokens: number }>({
    usedChars: 0,
    maxTokens: 32768,
  });
  const [modelDefaultCompact, setModelDefaultCompact] = useState<number>(0);
  const [liveBrowserFrame, setLiveBrowserFrame] = useState<BrowserFrameEvent | null>(null);
  const [browserExpanded, setBrowserExpanded] = useState(false);
  const [chatMenuId, setChatMenuId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renamingDraft, setRenamingDraft] = useState("");
  const [savedShots, setSavedShots] = useState<Record<string, string>>({});
  const [permissionReq, setPermissionReq] = useState<{
    callId: string;
    toolName: string;
    summary: string;
    preview: string;
  } | null>(null);

  const feedRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const modelPickerRef = useRef<HTMLDivElement>(null);
  const attachMenuRef = useRef<HTMLDivElement>(null);
  const compactPopoverRef = useRef<HTMLDivElement>(null);
  const wsMenuRef = useRef<HTMLDivElement>(null);
  const permMenuRef = useRef<HTMLDivElement>(null);
  const activeSessionIdRef = useRef(session.id);
  activeSessionIdRef.current = session.id;
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const manualStopRef = useRef(false);

  const registerProject = useCallback((wsPath: string) => {
    const trimmed = wsPath.trim();
    if (!trimmed || trimmed === ".") return;
    const key = normWs(trimmed);
    setProjects((prev) => {
      if (prev.some((p) => normWs(p) === key)) return prev;
      const next = [...prev, trimmed];
      saveStoredProjects(next);
      return next;
    });
  }, []);

  const refreshSessions = useCallback(() => {
    invoke<AgentSessionSummary[]>("list_agent_sessions")
      .then((list) => {
        setSessions(list);
        for (const s of list) {
          if (s.workspace && s.workspace.trim() !== "" && s.workspace.trim() !== ".") {
            registerProject(s.workspace);
          }
        }
      })
      .catch(() => {});
  }, [registerProject]);

  const [cloudProviders, setCloudProviders] = useState<CloudProviderConfig[]>([]);
  const [autoInstallingRt, setAutoInstallingRt] = useState(false);
  const [rtInstallProgress, setRtInstallProgress] = useState<RuntimeDownloadEvent | null>(null);

  const refreshCloudProviders = useCallback(() => {
    invoke<CloudProviderConfig[]>("get_cloud_providers")
      .then((list) => setCloudProviders(list))
      .catch(() => setCloudProviders([]));
  }, []);

  const refreshLocalModels = useCallback(() => {
    invoke<LocalModelFile[]>("scan_local_models")
      .then((list) => {
        const mainModels = list.filter(
          (m) => !m.name.toLowerCase().includes("mmproj")
        );
        setLocalModels(mainModels);
        setSession((prev) => {
          if (activeModelPath && isCloudModelPath(activeModelPath)) {
            return { ...prev, modelPath: activeModelPath };
          }
          if (prev.modelPath && isCloudModelPath(prev.modelPath)) {
            return prev;
          }
          if (
            activeModelPath &&
            mainModels.some((m) => m.path === activeModelPath)
          ) {
            return { ...prev, modelPath: activeModelPath };
          }
          if (prev.modelPath && mainModels.some((m) => m.path === prev.modelPath)) {
            return prev;
          }
          const preferred =
            mainModels.find((m) => m.path === defaultHarnessModel)?.path ??
            mainModels[0]?.path ??
            prev.modelPath;
          return { ...prev, modelPath: preferred };
        });
      })
      .catch(() => {});
  }, [activeModelPath, defaultHarnessModel]);

  useEffect(() => {
    refreshSessions();
    refreshLocalModels();
    refreshCloudProviders();
    const onModelsChanged = () => refreshLocalModels();
    const onProvidersChanged = () => refreshCloudProviders();
    window.addEventListener("loors:models-changed", onModelsChanged);
    window.addEventListener("loors:providers-changed", onProvidersChanged);
    return () => {
      window.removeEventListener("loors:models-changed", onModelsChanged);
      window.removeEventListener("loors:providers-changed", onProvidersChanged);
    };
  }, [refreshSessions, refreshLocalModels, refreshCloudProviders]);

  const handleAutoInstallRuntime = useCallback(async () => {
    if (autoInstallingRt) return;
    setAutoInstallingRt(true);
    setRtInstallProgress(null);
    let unlisten: (() => void) | undefined;
    try {
      unlisten = await listen<RuntimeDownloadEvent>("loors://runtime-download", (ev) => {
        setRtInstallProgress(ev.payload);
      });
      const hw = await invoke<HardwareProfile>("detect_hardware");
      const targetBackend = hw.recommended_backend || "cpu";
      await invoke("install_runtime", { backend: targetBackend });
      const snap = await invoke<RuntimeStatusSnapshot>("get_runtime_status");
      setInstalledBackends((snap.installed ?? []).map((r) => r.backend));
      setSelectedBackend(targetBackend);
    } catch (err) {
      setError(
        typeof err === "string"
          ? err
          : "No se pudo instalar llama.cpp automáticamente."
      );
    } finally {
      if (unlisten) unlisten();
      setAutoInstallingRt(false);
    }
  }, [autoInstallingRt, setSelectedBackend]);

  const [installedBackends, setInstalledBackends] = useState<RuntimeBackendKind[]>([]);
  const [setupChecked, setSetupChecked] = useState(false);
  useEffect(() => {
    invoke<RuntimeStatusSnapshot>("get_runtime_status")
      .then((snap) => {
        const inst = snap.installed ?? [];
        setInstalledBackends(inst.map((r) => r.backend));
        setSetupChecked(true);
      })
      .catch(() => {
        setSetupChecked(true);
      });
  }, [selectedBackend, modelPickerOpen]);

  useEffect(() => {
    if (defaultHarnessWorkspace && defaultHarnessWorkspace !== ".") {
      registerProject(defaultHarnessWorkspace);
    }
  }, [defaultHarnessWorkspace, registerProject]);

  useEffect(() => {
    if (!activeModelPath) return;
    setSession((prev) =>
      prev.modelPath === activeModelPath
        ? prev
        : { ...prev, modelPath: activeModelPath }
    );
  }, [activeModelPath]);

  useEffect(() => {
    const syncFromProfile = (prof: ModelTuningProfile) => {
      setModelDefaultCompact(prof.compactAtTokens ?? 0);
      const resolvedCtx =
        prof.contextSize > 0
          ? prof.contextSize
          : loadedContextSize && loadedContextSize > 0
            ? loadedContextSize
            : prof.effectiveContextSize && prof.effectiveContextSize > 0
              ? prof.effectiveContextSize
              : 32768;
      setContextUsage((prev) => ({
        ...prev,
        maxTokens: resolvedCtx,
      }));
    };

    if (session.modelPath) {
      invoke<ModelTuningProfile>("get_model_profile", {
        modelPath: session.modelPath,
      })
        .then(syncFromProfile)
        .catch(() => {});
    } else if (loadedContextSize && loadedContextSize > 0) {
      setContextUsage((prev) => ({ ...prev, maxTokens: loadedContextSize }));
    }

    const onProfileUpdated = (ev: Event) => {
      const detail = (
        ev as CustomEvent<{ modelPath?: string; profile?: ModelTuningProfile }>
      ).detail;
      if (!detail?.profile) return;
      if (!session.modelPath || detail.modelPath === session.modelPath) {
        syncFromProfile(detail.profile);
      }
    };
    window.addEventListener("loors:model-profile-updated", onProfileUpdated);
    return () =>
      window.removeEventListener("loors:model-profile-updated", onProfileUpdated);
  }, [session.modelPath, loadedContextSize]);

  useEffect(() => {
    if (!modelPickerOpen) return;
    refreshLocalModels();
    const onMouseDown = (e: MouseEvent) => {
      if (
        modelPickerRef.current &&
        !modelPickerRef.current.contains(e.target as Node)
      ) {
        setModelPickerOpen(false);
      }
    };
    window.addEventListener("mousedown", onMouseDown);
    return () => window.removeEventListener("mousedown", onMouseDown);
  }, [modelPickerOpen, refreshLocalModels]);

  useEffect(() => {
    if (!attachMenuOpen) return;
    void handleSearchPin(pinQuery);
    const onMouseDown = (e: MouseEvent) => {
      if (
        attachMenuRef.current &&
        !attachMenuRef.current.contains(e.target as Node)
      ) {
        setAttachMenuOpen(false);
      }
    };
    window.addEventListener("mousedown", onMouseDown);
    return () => window.removeEventListener("mousedown", onMouseDown);
  }, [attachMenuOpen]);

  useEffect(() => {
    if (!compactPopoverOpen) return;
    const onMouseDown = (e: MouseEvent) => {
      if (
        compactPopoverRef.current &&
        !compactPopoverRef.current.contains(e.target as Node)
      ) {
        setCompactPopoverOpen(false);
      }
    };
    window.addEventListener("mousedown", onMouseDown);
    return () => window.removeEventListener("mousedown", onMouseDown);
  }, [compactPopoverOpen]);

  const activeLocalFile = useMemo(
    () => localModels.find((m) => m.path === session.modelPath) ?? null,
    [localModels, session.modelPath]
  );

  const activeModelMeta = useMemo(
    () =>
      session.modelPath
        ? parseGgufMetadata(
            session.modelPath,
            activeLocalFile ? activeLocalFile.size_mb * 1024 * 1024 : undefined
          )
        : null,
    [session.modelPath, activeLocalFile]
  );

  const groupedPickerModels = useMemo(() => {
    const q = modelPickerQuery.trim().toLowerCase();
    const groups = new Map<
      string,
      {
        baseName: string;
        family: string;
        params: string | null;
        items: { file: LocalModelFile; meta: ReturnType<typeof parseGgufMetadata> }[];
      }
    >();
    for (const file of localModels) {
      const meta = parseGgufMetadata(file.path, file.size_mb * 1024 * 1024);
      if (
        q &&
        !file.name.toLowerCase().includes(q) &&
        !meta.baseName.toLowerCase().includes(q) &&
        !meta.quant.toLowerCase().includes(q) &&
        !meta.family.toLowerCase().includes(q)
      ) {
        continue;
      }
      const key = `${meta.family}::${meta.baseName}`;
      const existing = groups.get(key);
      if (existing) existing.items.push({ file, meta });
      else {
        groups.set(key, {
          baseName: meta.baseName,
          family: meta.family,
          params: meta.params,
          items: [{ file, meta }],
        });
      }
    }
    return Array.from(groups.values());
  }, [localModels, modelPickerQuery]);

  useEffect(() => {
    invoke<SkillSummary[]>("list_skills", { workspace: session.workspace || "." })
      .then((s) => setSkills(s.filter((item) => item.name !== "architect-loors")))
      .catch(() => setSkills([]));
    if (session.workspace && session.workspace !== ".") {
      invoke<string[]>("find_workspace_files", {
        workspace: session.workspace,
        query: "",
      })
        .then(setWorkspaceFiles)
        .catch(() => setWorkspaceFiles([]));
    } else {
      setWorkspaceFiles([]);
    }
    setSelectedPreviewFile(null);
    setSelectedPreviewContent("");
  }, [session.workspace]);

  // Listen to live Agent Chat events & Browser CDP frames
  useEffect(() => {
    let cancelled = false;
    let unlistenAgent: (() => void) | undefined;
    let unlistenBrowser: (() => void) | undefined;

    listen<AgentChatEvent>("loors://agent-chat-event", (ev) => {
      if (cancelled) return;
      const p = ev.payload;
      if (p.session_id !== activeSessionIdRef.current) return;

      if (p.type === "todo_updated") {
        setTodoItems(p.items);
      } else if (p.type === "question_requested") {
        setPendingQuestion({
          callId: p.call_id,
          question: p.question,
          options: p.options,
          allowMultiple: p.allow_multiple,
        });
        setSelectedQuestionOpts([]);
        setCustomQuestionAnswer("");
      } else if (p.type === "artifact_updated") {
        setActiveArtifact({
          title: p.title,
          path: p.path,
          kind: p.kind,
          content: p.content,
        });
        setArtifactExpanded(true);
      } else if (p.type === "token") {
        setSession((prev) => {
          const msgs = [...prev.messages];
          let idx = msgs.findIndex((m) => m.id === p.message_id);
          if (idx === -1) {
            msgs.push({
              id: p.message_id,
              role: "assistant",
              content: "",
              thinking: "",
              toolCalls: [],
              timestamp: Math.floor(Date.now() / 1000),
            });
            idx = msgs.length - 1;
          }
          const target = { ...msgs[idx] };
          if (p.is_thinking) target.thinking += p.token;
          else target.content += p.token;
          msgs[idx] = target;
          return { ...prev, messages: msgs };
        });
      } else if (p.type === "tool_started") {
        setSession((prev) => {
          const msgs = [...prev.messages];
          const idx = msgs.findIndex((m) => m.id === p.message_id);
          if (idx === -1) return prev;
          const target = { ...msgs[idx] };
          target.toolCalls = [...target.toolCalls, p.call];
          msgs[idx] = target;
          return { ...prev, messages: msgs };
        });
      } else if (p.type === "tool_finished") {
        setPermissionReq(null);
        setSession((prev) => {
          const msgs = [...prev.messages];
          const idx = msgs.findIndex((m) => m.id === p.message_id);
          if (idx === -1) return prev;
          const target = { ...msgs[idx] };
          const cIdx = target.toolCalls.findIndex((c) => c.id === p.call.id);
          if (cIdx >= 0) {
            const nextCalls = [...target.toolCalls];
            nextCalls[cIdx] = p.call;
            target.toolCalls = nextCalls;
          } else {
            target.toolCalls = [...target.toolCalls, p.call];
          }
          msgs[idx] = target;
          return { ...prev, messages: msgs };
        });
        if (p.call.screenshotPath) {
          const shotPath = p.call.screenshotPath;
          invoke<string>("read_screenshot_base64", { path: shotPath })
            .then((b64) =>
              setSavedShots((prev) => ({ ...prev, [shotPath]: b64 }))
            )
            .catch(() => {});
        }
        if (p.call.diffPreview || p.call.addedLines > 0 || p.call.removedLines > 0) {
          setRightPanelOpen(true);
          setRightPanelTab("diff");
          invoke<string>("get_workspace_diff", {
            workspace: session.workspace || ".",
          })
            .then(setGitDiffText)
            .catch(() => {});
        }
        if (p.call.name === "browser_action") {
          setRightPanelOpen(true);
          setRightPanelTab("browser");
        }
      } else if (p.type === "permission_requested") {
        setPermissionReq({
          callId: p.call_id,
          toolName: p.tool_name,
          summary: p.summary,
          preview: p.preview,
        });
      } else if (p.type === "turn_finished") {
        setPermissionReq(null);
        setContextUsage({
          usedChars: p.context_used_chars,
          maxTokens: p.context_max_tokens,
        });
      }
    })
      .then((fn) => {
        if (cancelled) fn();
        else unlistenAgent = fn;
      })
      .catch(() => {});

    listen<BrowserFrameEvent>("loors://browser-frame", (ev) => {
      if (!cancelled) {
        setLiveBrowserFrame(ev.payload);
        setRightPanelOpen(true);
        setRightPanelTab("browser");
      }
    })
      .then((fn) => {
        if (cancelled) fn();
        else unlistenBrowser = fn;
      })
      .catch(() => {});

    return () => {
      cancelled = true;
      if (unlistenAgent) unlistenAgent();
      if (unlistenBrowser) unlistenBrowser();
    };
  }, []);

  useEffect(() => {
    const el = feedRef.current;
    if (el && stickToBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [session.messages, permissionReq, liveBrowserFrame]);

  const persistSession = useCallback(
    async (next: AgentSession) => {
      setSession(next);
      try {
        await invoke("save_agent_session", { session: next });
        refreshSessions();
      } catch {
        // ignore save error on transient state
      }
    },
    [refreshSessions]
  );

  const handleNewSession = (targetWorkspace?: string) => {
    if (running) return;
    const ws = targetWorkspace ?? (session.workspace || defaultHarnessWorkspace);
    if (ws && ws !== ".") registerProject(ws);
    setError(null);
    setLiveBrowserFrame(null);
    setPermissionReq(null);
    setSession({
      id: makeSessionId(),
      title: ws
        ? locale === "es"
          ? "Nueva sesión"
          : "New session"
        : locale === "es"
          ? "Nuevo chat"
          : "New chat",
      workspace: ws,
      modelPath: session.modelPath || localModels[0]?.path || "",
      permissionMode: session.permissionMode,
      useRag: session.useRag,
      compactAtTokens: session.compactAtTokens ?? 0,
      reasoningEffort: session.reasoningEffort ?? "medium",
      enabledSkills: session.enabledSkills,
      pinnedFiles: [],
      allowedSessionTools: [],
      messages: [],
      updatedAt: Math.floor(Date.now() / 1000),
    });
  };

  const handleSelectSession = async (id: string) => {
    if (running) return;
    try {
      const loaded = await invoke<AgentSession>("load_agent_session", { id });
      setSession(loaded);
      if (loaded.workspace && loaded.workspace !== ".") {
        registerProject(loaded.workspace);
      }
      setError(null);
      setPermissionReq(null);
    } catch (err) {
      setError(String(err));
    }
  };

  const handleDeleteSession = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    try {
      await invoke("delete_agent_session", { id });
      refreshSessions();
      if (session.id === id) {
        handleNewSession(session.workspace);
      }
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    if (!chatMenuId) return;
    const onDocClick = () => setChatMenuId(null);
    window.addEventListener("click", onDocClick);
    return () => window.removeEventListener("click", onDocClick);
  }, [chatMenuId]);

  const handleTogglePinSession = async (id: string) => {
    setChatMenuId(null);
    try {
      const target: AgentSession =
        id === session.id
          ? session
          : await invoke<AgentSession>("load_agent_session", { id });
      const updated: AgentSession = { ...target, pinned: !target.pinned };
      await invoke("save_agent_session", { session: updated });
      if (id === session.id) {
        setSession(updated);
      }
      refreshSessions();
    } catch {
      // ignore if unsaved draft
    }
  };

  const handleStartRenameSession = (s: AgentSessionSummary) => {
    setChatMenuId(null);
    setRenamingId(s.id);
    setRenamingDraft(displaySessionTitle(s.title, locale));
  };

  const handleCommitRenameSession = async (id: string) => {
    const trimmed = renamingDraft.trim();
    setRenamingId(null);
    if (!trimmed) return;
    try {
      const target: AgentSession =
        id === session.id
          ? session
          : await invoke<AgentSession>("load_agent_session", { id });
      const updated: AgentSession = { ...target, title: trimmed };
      await invoke("save_agent_session", { session: updated });
      if (id === session.id) {
        setSession(updated);
      }
      refreshSessions();
    } catch {
      if (id === session.id) {
        setSession((prev) => ({ ...prev, title: trimmed }));
      }
    }
  };

  const handleAddProject = async () => {
    try {
      const picked = await invoke<string | null>("pick_folder", {
        initialDir: session.workspace && session.workspace !== "." ? session.workspace : null,
      });
      if (picked) {
        registerProject(picked);
        handleNewSession(picked);
      }
    } catch (err) {
      setError(String(err));
    }
  };

  const handleRemoveProject = (e: React.MouseEvent, projPath: string) => {
    e.stopPropagation();
    const key = normWs(projPath);
    setConfirmRemoveProj(null);
    setProjects((prev) => {
      const next = prev.filter((p) => normWs(p) !== key);
      saveStoredProjects(next);
      return next;
    });
  };

  const handlePickWorkspace = async () => {
    try {
      const picked = await invoke<string | null>("pick_folder", {
        initialDir: session.workspace && session.workspace !== "." ? session.workspace : null,
      });
      if (picked) {
        registerProject(picked);
        await persistSession({ ...session, workspace: picked, pinnedFiles: [] });
      }
    } catch (err) {
      setError(String(err));
    }
  };

  const handlePickAttachFiles = async () => {
    try {
      const picked = await invoke<string[]>("pick_files", {
        initialDir: session.workspace && session.workspace !== "." ? session.workspace : null,
      });
      if (picked && picked.length > 0) {
        setPendingAttachments((prev) => {
          const next = [...prev];
          for (const p of picked) {
            if (!next.includes(p)) next.push(p);
          }
          return next;
        });
      }
    } catch (err) {
      setError(String(err));
    }
  };

  const stageExternalFiles = async (fileList: FileList | File[]) => {
    const files = Array.from(fileList);
    if (files.length === 0) return;
    setStagingFiles(true);
    try {
      const added: string[] = [];
      for (const f of files) {
        const nativePath = (f as File & { path?: string }).path;
        if (nativePath && nativePath.trim()) {
          added.push(nativePath);
        } else {
          const buf = await f.arrayBuffer();
          const stagedPath = await invoke<string>("stage_uploaded_file", {
            name: f.name || "adjunto.png",
            bytes: Array.from(new Uint8Array(buf)),
          });
          added.push(stagedPath);
        }
      }
      if (added.length > 0) {
        setPendingAttachments((prev) => {
          const next = [...prev];
          for (const p of added) {
            if (!next.includes(p)) next.push(p);
          }
          return next;
        });
      }
    } catch (err) {
      setError(`Error adjuntando archivo: ${String(err)}`);
    } finally {
      setStagingFiles(false);
    }
  };

  const handleSearchPin = async (q: string) => {
    setPinQuery(q);
    try {
      const matches = await invoke<string[]>("find_workspace_files", {
        workspace: session.workspace || ".",
        query: q,
      });
      setPinResults(matches.slice(0, 12));
    } catch {
      setPinResults([]);
    }
  };

  const togglePinFile = (rel: string) => {
    const exists = session.pinnedFiles.includes(rel);
    const nextPinned = exists
      ? session.pinnedFiles.filter((p) => p !== rel)
      : [...session.pinnedFiles, rel];
    void persistSession({ ...session, pinnedFiles: nextPinned });
    setPinQuery("");
    setPinResults([]);
  };

  const sendTurn = async (
    promptText: string,
    forceStopHarness = false,
    explicitAttachments?: string[]
  ) => {
    const trimmed = promptText.trim();
    const attachmentsToSend = explicitAttachments ?? pendingAttachments;
    if (!trimmed && attachmentsToSend.length === 0) return;

    if (running) {
      setMessageQueue((prev) => [
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
    setGpuBusyPrompt(null);

    const curSession = sessionRef.current;
    const activeWs =
      curSession.workspace && curSession.workspace.trim() !== "."
        ? curSession.workspace.trim()
        : "";
    if (activeWs) {
      registerProject(activeWs);
    }

    if (forceStopHarness) {
      try {
        await invoke("stop_workflow");
        await new Promise((r) => setTimeout(r, 250));
      } catch {
        // ignore
      }
    }

    const titleFallback =
      attachmentsToSend[0]?.split(/[\\/]/).pop() ?? "Archivo adjunto";
    const userMsg: AgentChatMessage = {
      id: `u-${Date.now()}`,
      role: "user",
      content: trimmed,
      thinking: "",
      attachments: attachmentsToSend,
      toolCalls: [],
      timestamp: Math.floor(Date.now() / 1000),
    };
    const nextSession: AgentSession = {
      ...curSession,
      workspace: activeWs,
      title:
        curSession.messages.length === 0 &&
        (curSession.title === "Nueva sesión" ||
          curSession.title === "Nuevo chat" ||
          curSession.title === "New session" ||
          curSession.title === "New chat")
          ? (trimmed || titleFallback).slice(0, 46)
          : curSession.title,
      messages: [...curSession.messages, userMsg],
      updatedAt: Math.floor(Date.now() / 1000),
    };

    setSession(nextSession);
    stickToBottomRef.current = true;
    setInput("");
    if (!explicitAttachments) setPendingAttachments([]);
    setRunning(true);
    setAgentStatus(true, nextSession.title);

    try {
      const updated = await invoke<AgentSession>("run_agent_turn", {
        backend: selectedBackend,
        session: { ...curSession, workspace: activeWs, title: nextSession.title },
        userPrompt: trimmed,
        overrideCtx: null,
        attachments: attachmentsToSend,
      });
      setSession(updated);
      refreshSessions();
    } catch (err) {
      const msg = typeof err === "string" ? err : String(err);
      if (msg.includes("__GPU_BUSY_HARNESS__")) {
        setSession(curSession);
        setInput(trimmed);
        if (!explicitAttachments) setPendingAttachments(attachmentsToSend);
        setGpuBusyPrompt(trimmed);
      } else {
        setError(msg);
      }
    } finally {
      setRunning(false);
      setAgentStatus(false, null);
      setPermissionReq(null);
    }
  };

  useEffect(() => {
    if (!running && !manualStopRef.current && messageQueue.length > 0) {
      const [next, ...rest] = messageQueue;
      setMessageQueue(rest);
      void sendTurn(next.text, false, next.attachments ?? []);
    }
  }, [running, messageQueue]);

  const handleStop = async () => {
    manualStopRef.current = true;
    try {
      await invoke("stop_agent_turn");
    } catch {
      // ignore
    }
  };

  const handlePermission = async (approved: boolean, alwaysAllowTool = false) => {
    try {
      await invoke("resolve_agent_permission", {
        decision: { approved, alwaysAllowTool },
      });
      if (approved && alwaysAllowTool && permissionReq) {
        setSession((prev) => ({
          ...prev,
          allowedSessionTools: prev.allowedSessionTools.includes(permissionReq.toolName)
            ? prev.allowedSessionTools
            : [...prev.allowedSessionTools, permissionReq.toolName],
        }));
      }
      setPermissionReq(null);
    } catch (err) {
      setError(String(err));
    }
  };

  const handleUndoToolCall = async (messageId: string, callId: string) => {
    try {
      const updated = await invoke<AgentSession>("undo_agent_tool_call", {
        sessionId: session.id,
        messageId,
        callId,
      });
      setSession(updated);
    } catch (err) {
      setError(String(err));
    }
  };

  const handleOpenRightTab = async (tab: "files" | "diff" | "browser") => {
    if (rightPanelOpen && rightPanelTab === tab) {
      setRightPanelOpen(false);
      return;
    }
    setRightPanelOpen(true);
    setRightPanelTab(tab);
    if (tab === "diff") {
      try {
        const diff = await invoke<string>("get_workspace_diff", {
          workspace: session.workspace || ".",
        });
        setGitDiffText(diff);
      } catch (err) {
        setGitDiffText(`Error: ${String(err)}`);
      }
    } else if (tab === "files" && session.workspace && session.workspace !== ".") {
      invoke<string[]>("find_workspace_files", {
        workspace: session.workspace,
        query: fileFilter,
      })
        .then(setWorkspaceFiles)
        .catch(() => {});
    }
  };

  const handlePreviewWorkspaceFile = async (relPath: string) => {
    setSelectedPreviewFile(relPath);
    try {
      const content = await invoke<string>("read_workspace_file_preview", {
        workspace: session.workspace || ".",
        relPath,
      });
      setSelectedPreviewContent(content);
    } catch (err) {
      setSelectedPreviewContent(`Error leyendo archivo: ${String(err)}`);
    }
  };

  const copyText = (id: string, text: string) => {
    navigator.clipboard.writeText(text).catch(() => {});
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 1500);
  };

  const liveSessionChars = useMemo(() => {
    if (session.messages.length === 0) return 0;
    let total = 2400; // base system prompt + tool schemas overhead
    for (const m of session.messages) {
      total += (m.content?.length ?? 0) + (m.thinking?.length ?? 0);
      for (const tc of m.toolCalls ?? []) {
        total += (tc.argsJson?.length ?? 0) + (tc.outputPreview?.length ?? 0);
      }
    }
    return total;
  }, [session.messages]);

  const effectiveUsedChars = Math.max(contextUsage.usedChars, liveSessionChars);
  const estTokensUsed = Math.round(effectiveUsedChars / 3.2);
  const effectiveMaxTokens = Math.max(4096, contextUsage.maxTokens || 32768);
  const activeCompactSetting =
    (session.compactAtTokens ?? 0) > 0
      ? Math.min(effectiveMaxTokens, session.compactAtTokens ?? 0)
      : modelDefaultCompact > 0
        ? Math.min(effectiveMaxTokens, modelDefaultCompact)
        : 0;
  const effectiveCompactTokens =
    activeCompactSetting > 0
      ? activeCompactSetting
      : Math.round(effectiveMaxTokens * 0.75);
  const compactPct = Math.min(
    100,
    Math.round((effectiveCompactTokens / effectiveMaxTokens) * 100)
  );
  const maxCtxLabel = `${Math.round(effectiveMaxTokens / 1024)}K`;
  useEffect(() => {
    if (!wsMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (wsMenuRef.current && !wsMenuRef.current.contains(e.target as Node)) {
        setWsMenuOpen(false);
      }
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [wsMenuOpen]);

  useEffect(() => {
    if (!permMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (permMenuRef.current && !permMenuRef.current.contains(e.target as Node)) {
        setPermMenuOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPermMenuOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [permMenuOpen]);

  const activeWsShort =
    !session.workspace || session.workspace === "."
      ? t("agent.noProject")
      : session.workspace.split(/[\\/]/).filter(Boolean).pop() ?? session.workspace;

  const orphanSessions = useMemo(() => {
    const knownKeys = new Set(projects.map((p) => normWs(p)));
    return sessions.filter(
      (s) => !s.workspace || s.workspace === "." || !knownKeys.has(normWs(s.workspace))
    );
  }, [projects, sessions]);

  const lastUserMsgIndex = useMemo(() => {
    for (let i = session.messages.length - 1; i >= 0; i--) {
      if (session.messages[i].role === "user") return i;
    }
    return -1;
  }, [session.messages]);

  return (
    <div className="agent-workspace-root">
      {sidebarOpen && (
        <>
          <aside
            className="agent-sidebar"
            style={{ width: sidebarWidth, minWidth: sidebarWidth }}
          >
          <div className="sidebar-top-action">
            <button
              type="button"
              className="sidebar-new-conv-btn"
              disabled={running}
              onClick={() => handleNewSession("")}
            >
              <Plus size={14} />
              <span>{t("agent.newConversation")}</span>
            </button>
          </div>

          <div className="projects-tree-scroll">
            {orphanSessions.length > 0 && (
              <div className="standalone-chats-block">
                {orphanSessions.map((s) => {
                  const isCurrent = s.id === session.id;
                  const isLive = isCurrent && running;
                  const isRenaming = renamingId === s.id;
                  const isMenuOpen = chatMenuId === s.id;
                  return (
                    <div
                      key={s.id}
                      className={`project-chat-pill ${isCurrent ? "active" : ""} ${isMenuOpen ? "menu-open" : ""}`}
                      onClick={() => {
                        if (!isRenaming) void handleSelectSession(s.id);
                      }}
                    >
                      {s.pinned ? (
                        <Pin size={11} style={{ color: "#a78bfa", flexShrink: 0 }} />
                      ) : (
                        <MessageSquare size={12} style={{ color: "#64748b", flexShrink: 0 }} />
                      )}
                      {isRenaming ? (
                        <input
                          type="text"
                          autoFocus
                          className="chat-rename-input"
                          value={renamingDraft}
                          onClick={(e) => e.stopPropagation()}
                          onChange={(e) => setRenamingDraft(e.target.value)}
                          onBlur={() => void handleCommitRenameSession(s.id)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              e.currentTarget.blur();
                            } else if (e.key === "Escape") {
                              setRenamingId(null);
                            }
                          }}
                        />
                      ) : (
                        <span className="project-chat-title truncate-text">
                          {displaySessionTitle(s.title, locale)}
                        </span>
                      )}
                      <span className="project-chat-right">
                        {isLive ? (
                          <span className="chat-active-dot" />
                        ) : (
                          <span className="project-chat-age tabular-nums">
                            {formatRelativeAge(s.updatedAt, locale)}
                          </span>
                        )}
                        <button
                          type="button"
                          className="chat-more-btn icon-btn"
                          title={locale === "es" ? "Opciones" : "Options"}
                          onClick={(e) => {
                            e.stopPropagation();
                            setChatMenuId(isMenuOpen ? null : s.id);
                          }}
                        >
                          <MoreHorizontal size={13} />
                        </button>
                      </span>
                      {isMenuOpen && (
                        <div
                          className="chat-row-menu"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <button
                            type="button"
                            className="chat-row-menu-item"
                            onClick={() => void handleTogglePinSession(s.id)}
                          >
                            {s.pinned ? <PinOff size={12} /> : <Pin size={12} />}
                            <span>
                              {s.pinned
                                ? locale === "es" ? "Desfijar" : "Unpin"
                                : locale === "es" ? "Fijar" : "Pin"}
                            </span>
                          </button>
                          <button
                            type="button"
                            className="chat-row-menu-item"
                            onClick={() => handleStartRenameSession(s)}
                          >
                            <Pencil size={12} />
                            <span>{locale === "es" ? "Renombrar" : "Rename"}</span>
                          </button>
                          <button
                            type="button"
                            className="chat-row-menu-item danger"
                            onClick={(e) => {
                              setChatMenuId(null);
                              void handleDeleteSession(e, s.id);
                            }}
                          >
                            <Trash2 size={12} />
                            <span>{locale === "es" ? "Eliminar" : "Delete"}</span>
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            <div className="projects-section-bar">
              <span className="projects-title">
                {locale === "es" ? "Proyectos" : "Projects"}
              </span>
              <button
                type="button"
                className="icon-btn"
                title="Añadir carpeta de proyecto"
                disabled={running}
                onClick={() => void handleAddProject()}
              >
                <FolderPlus size={14} />
              </button>
            </div>
            {projects.length === 0 ? (
              <div className="projects-empty-cta">
                <button
                  type="button"
                  className={`ws-selector-card ${!session.workspace || session.workspace === "." ? "unset" : ""}`}
                  onClick={() => void handleAddProject()}
                >
                  <FolderPlus size={14} />
                  <span>{t("agent.addFirstProject")}</span>
                </button>
              </div>
            ) : (
              projects.map((projPath) => {
                const key = normWs(projPath);
                const projName =
                  projPath.split(/[\\/]/).filter(Boolean).pop() || projPath;
                const isActiveProj = normWs(session.workspace) === key;
                const isProjCollapsed = Boolean(collapsedProjects[key]);

                const savedChats = sessions.filter(
                  (s) => normWs(s.workspace) === key
                );
                const hasCurrentInSaved = savedChats.some(
                  (s) => s.id === session.id
                );
                const chatList: AgentSessionSummary[] =
                  isActiveProj && !hasCurrentInSaved
                    ? [
                        {
                          id: session.id,
                          title:
                            session.title ||
                            (locale === "es" ? "Nueva sesión" : "New session"),
                          workspace: projPath,
                          updatedAt: session.updatedAt,
                          messageCount: session.messages.length,
                          permissionMode: session.permissionMode,
                        },
                        ...savedChats,
                      ]
                    : savedChats;

                return (
                  <div key={key} className="project-group">
                    <div
                      className={`project-group-header ${isActiveProj ? "is-active" : ""}`}
                      title={projPath}
                      onClick={() =>
                        setCollapsedProjects((prev) => ({
                          ...prev,
                          [key]: !prev[key],
                        }))
                      }
                    >
                      <span className="project-folder-icon">
                        {isActiveProj ? <FolderOpen size={14} /> : <Folder size={14} />}
                      </span>
                      <span className="project-group-name truncate-text">
                        {projName}
                      </span>
                      <div className="project-group-actions">
                        <button
                          type="button"
                          className="icon-btn"
                          title={`Nueva conversación en ${projName}`}
                          disabled={running}
                          onClick={(e) => {
                            e.stopPropagation();
                            handleNewSession(projPath);
                          }}
                        >
                          <Plus size={13} />
                        </button>
                        {confirmRemoveProj === projPath ? (
                          <>
                            <button
                              type="button"
                              className="icon-btn danger-hover"
                              style={{ color: "#f87171" }}
                              title={
                                locale === "es"
                                  ? "Confirmar: quitar proyecto de la lista (no borra archivos en disco)"
                                  : "Confirm: remove project from sidebar (disk files are kept)"
                              }
                              onClick={(e) => handleRemoveProject(e, projPath)}
                            >
                              <Check size={12} />
                            </button>
                            <button
                              type="button"
                              className="icon-btn"
                              title={locale === "es" ? "Cancelar" : "Cancel"}
                              onClick={(e) => {
                                e.stopPropagation();
                                setConfirmRemoveProj(null);
                              }}
                            >
                              <X size={12} />
                            </button>
                          </>
                        ) : (
                          <button
                            type="button"
                            className="icon-btn danger-hover"
                            title={
                              locale === "es"
                                ? "Quitar proyecto de la lista"
                                : "Remove project from list"
                            }
                            onClick={(e) => {
                              e.stopPropagation();
                              setConfirmRemoveProj(projPath);
                            }}
                          >
                            <Trash2 size={12} />
                          </button>
                        )}
                      </div>
                    </div>

                    {!isProjCollapsed && (
                      <div className="project-chats-list">
                        {chatList.length === 0 ? (
                          <button
                            type="button"
                            className="project-empty-chats"
                            disabled={running}
                            onClick={() => handleNewSession(projPath)}
                          >
                            {locale === "es"
                              ? "Sin conversaciones aún"
                              : "No conversations yet"}
                          </button>
                        ) : (
                          chatList.map((s) => {
                            const isCurrent = s.id === session.id;
                            const isLive = isCurrent && running;
                            const isRenaming = renamingId === s.id;
                            const isMenuOpen = chatMenuId === s.id;
                            const isSaved = savedChats.some((saved) => saved.id === s.id);
                            return (
                              <div
                                key={s.id}
                                className={`project-chat-pill ${isCurrent ? "active" : ""} ${isMenuOpen ? "menu-open" : ""}`}
                                onClick={() => {
                                  if (!isRenaming && (hasCurrentInSaved || !isCurrent)) {
                                    void handleSelectSession(s.id);
                                  }
                                }}
                              >
                                {s.pinned && (
                                  <Pin size={10} style={{ color: "#a78bfa", flexShrink: 0 }} />
                                )}
                                {isRenaming ? (
                                  <input
                                    type="text"
                                    autoFocus
                                    className="chat-rename-input"
                                    value={renamingDraft}
                                    onClick={(e) => e.stopPropagation()}
                                    onChange={(e) => setRenamingDraft(e.target.value)}
                                    onBlur={() => void handleCommitRenameSession(s.id)}
                                    onKeyDown={(e) => {
                                      if (e.key === "Enter") {
                                        e.currentTarget.blur();
                                      } else if (e.key === "Escape") {
                                        setRenamingId(null);
                                      }
                                    }}
                                  />
                                ) : (
                                  <span className="project-chat-title truncate-text">
                                    {displaySessionTitle(s.title, locale)}
                                  </span>
                                )}
                                <span className="project-chat-right">
                                  {isLive ? (
                                    <span className="chat-active-dot" />
                                  ) : (
                                    <span className="project-chat-age tabular-nums">
                                      {formatRelativeAge(s.updatedAt, locale)}
                                    </span>
                                  )}
                                  <button
                                    type="button"
                                    className="chat-more-btn icon-btn"
                                    title={locale === "es" ? "Opciones" : "Options"}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setChatMenuId(isMenuOpen ? null : s.id);
                                    }}
                                  >
                                    <MoreHorizontal size={13} />
                                  </button>
                                </span>
                                {isMenuOpen && (
                                  <div
                                    className="chat-row-menu"
                                    onClick={(e) => e.stopPropagation()}
                                  >
                                    <button
                                      type="button"
                                      className="chat-row-menu-item"
                                      onClick={() => void handleTogglePinSession(s.id)}
                                    >
                                      {s.pinned ? <PinOff size={12} /> : <Pin size={12} />}
                                      <span>
                                        {s.pinned
                                          ? locale === "es" ? "Desfijar" : "Unpin"
                                          : locale === "es" ? "Fijar" : "Pin"}
                                      </span>
                                    </button>
                                    <button
                                      type="button"
                                      className="chat-row-menu-item"
                                      onClick={() => handleStartRenameSession(s)}
                                    >
                                      <Pencil size={12} />
                                      <span>{locale === "es" ? "Renombrar" : "Rename"}</span>
                                    </button>
                                    {isSaved && (
                                      <button
                                        type="button"
                                        className="chat-row-menu-item danger"
                                        onClick={(e) => {
                                          setChatMenuId(null);
                                          void handleDeleteSession(e, s.id);
                                        }}
                                      >
                                        <Trash2 size={12} />
                                        <span>{locale === "es" ? "Eliminar" : "Delete"}</span>
                                      </button>
                                    )}
                                  </div>
                                )}
                              </div>
                            );
                          })
                        )}
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
          </aside>
          <div
            className="panel-resizer"
            role="separator"
            aria-orientation="vertical"
            title="Drag to resize (double-click to reset)"
            onMouseDown={(e) => {
              e.preventDefault();
              startAgentResize("left", e.clientX);
            }}
            onDoubleClick={() => {
              setSidebarWidth(252);
              localStorage.setItem("loors_agent_left_w", "252");
            }}
          />
        </>
      )}

      <div
        className={`agent-main-col ${isDraggingOver ? "drop-overlay-active" : ""}`}
        onDragOver={(e) => {
          if (e.dataTransfer?.types?.includes("Files")) {
            e.preventDefault();
            setIsDraggingOver(true);
          }
        }}
        onDragLeave={(e) => {
          if (e.currentTarget === e.target) {
            setIsDraggingOver(false);
          }
        }}
        onDrop={(e) => {
          e.preventDefault();
          setIsDraggingOver(false);
          if (e.dataTransfer?.files && e.dataTransfer.files.length > 0) {
            void stageExternalFiles(e.dataTransfer.files);
          }
        }}
      >
        <div className="agent-session-header">
          <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
            <button
              type="button"
              className="header-crumb-btn truncate-text"
              title={`Proyecto activo: ${session.workspace}\nClic para cambiar carpeta`}
              onClick={() => void handlePickWorkspace()}
            >
              {activeWsShort}
            </button>
            <span className="header-crumb-sep">/</span>
            <input
              className="session-title-input"
              value={displaySessionTitle(session.title, locale)}
              onChange={(e) => setSession({ ...session, title: e.target.value })}
              onBlur={() => void persistSession(session)}
            />
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <div className="workbench-tab-group">
              <button
                type="button"
                className={`workbench-tab-btn ${rightPanelOpen && rightPanelTab === "files" ? "active" : ""}`}
                onClick={() => void handleOpenRightTab("files")}
                title="Árbol de archivos del proyecto"
              >
                <Folder size={13} />
                <span>{t("agent.files")}</span>
              </button>
              <button
                type="button"
                className={`workbench-tab-btn ${rightPanelOpen && rightPanelTab === "diff" ? "active" : ""}`}
                onClick={() => void handleOpenRightTab("diff")}
              >
                <GitBranch size={13} />
                <span>{t("agent.diff")}</span>
              </button>
              <button
                type="button"
                className={`workbench-tab-btn ${rightPanelOpen && rightPanelTab === "browser" ? "active" : ""}`}
                onClick={() => void handleOpenRightTab("browser")}
              >
                <Globe size={13} />
                <span>{t("agent.browser")}</span>
                {liveBrowserFrame && <span className="mode-live-dot" />}
              </button>
            </div>
          </div>
        </div>

        <div className="agent-body-split">
          <div className="agent-chat-column">
          <div
            className="agent-feed-scroll"
            ref={feedRef}
            onScroll={() => {
              const el = feedRef.current;
              if (!el) return;
              stickToBottomRef.current =
                el.scrollHeight - el.scrollTop - el.clientHeight < 48;
            }}
          >
            <div className="agent-feed-inner">
              {session.messages.length === 0 && (
                <div className="agent-zero-minimal">
                  <span className="zero-ws-kicker">{activeWsShort}</span>
                  <h2>{t("agent.heroTitle")}</h2>

                  {setupChecked &&
                  !(
                    (installedBackends.length > 0 && localModels.length > 0) ||
                    cloudProviders.some((p) => p.enabled && p.models.length > 0)
                  ) ? (
                    <div className="onboarding-card">
                      <div className="onboarding-title">{t("onboarding.title")}</div>

                      <div style={{ fontSize: 11, fontWeight: 600, color: "#94a3b8", textTransform: "uppercase", letterSpacing: "0.04em", marginTop: 2 }}>
                        {t("onboarding.optA")}
                      </div>

                      <button
                        type="button"
                        className={`onboarding-step ${installedBackends.length > 0 ? "is-done" : ""}`}
                        disabled={autoInstallingRt}
                        onClick={() => {
                          if (installedBackends.length > 0) {
                            window.dispatchEvent(new CustomEvent("loors:open-runtime-modal"));
                          } else {
                            void handleAutoInstallRuntime();
                          }
                        }}
                      >
                        <span className="onboarding-step-num">
                          {installedBackends.length > 0 ? <Check size={12} /> : <Download size={12} />}
                        </span>
                        <div className="onboarding-step-text">
                          <strong>
                            {installedBackends.length > 0
                              ? t("onboarding.rtReady")
                              : autoInstallingRt
                                ? t("onboarding.rtInstalling")
                                : t("onboarding.rtInstallCta")}
                          </strong>
                          <span>
                            {installedBackends.length > 0
                              ? `${t("onboarding.rtInstalledPrefix")} (${installedBackends.join(", ")})`
                              : rtInstallProgress?.message
                                ? rtInstallProgress.message
                                : t("onboarding.rtInstallDesc")}
                          </span>
                        </div>
                      </button>

                      {autoInstallingRt && rtInstallProgress?.percent !== null && rtInstallProgress?.percent !== undefined && (
                        <div className="progress-track" style={{ marginTop: -2 }}>
                          <div
                            className="progress-fill"
                            style={{
                              width: `${Math.min(100, Math.max(0, rtInstallProgress.percent))}%`,
                            }}
                          />
                        </div>
                      )}

                      <button
                        type="button"
                        className={`onboarding-step ${localModels.length > 0 ? "is-done" : ""}`}
                        onClick={() =>
                          window.dispatchEvent(new CustomEvent("loors:open-models-modal"))
                        }
                      >
                        <span className="onboarding-step-num">
                          {localModels.length > 0 ? <Check size={12} /> : <Boxes size={12} />}
                        </span>
                        <div className="onboarding-step-text">
                          <strong>{t("onboarding.ggufCta")}</strong>
                          <span>
                            {localModels.length > 0
                              ? `${localModels.length} ${t("onboarding.ggufDetected")}`
                              : t("onboarding.ggufDesc")}
                          </span>
                        </div>
                      </button>

                      <div style={{ fontSize: 11, fontWeight: 600, color: "#94a3b8", textTransform: "uppercase", letterSpacing: "0.04em", marginTop: 6 }}>
                        {t("onboarding.optB")}
                      </div>

                      <button
                        type="button"
                        className="onboarding-step"
                        onClick={() =>
                          window.dispatchEvent(
                            new CustomEvent("loors:open-models-modal", {
                              detail: { tab: "cloud" },
                            })
                          )
                        }
                      >
                        <span className="onboarding-step-num">
                          <Cloud size={12} />
                        </span>
                        <div className="onboarding-step-text">
                          <strong>{t("onboarding.cloudCta")}</strong>
                          <span>{t("onboarding.cloudDesc")}</span>
                        </div>
                      </button>
                    </div>
                  ) : (
                    <div className="zero-suggestions">
                      {(session.workspace && session.workspace !== "."
                        ? [t("suggest.ws1"), t("suggest.ws2"), t("suggest.ws3")]
                        : [t("suggest.free1"), t("suggest.free2"), t("suggest.free3")]
                      ).map((prompt) => (
                        <button
                          key={prompt}
                          type="button"
                          className="zero-suggestion-btn"
                          onClick={() => {
                            if (session.modelPath) {
                              void sendTurn(prompt);
                            } else {
                              setInput(prompt);
                            }
                          }}
                        >
                          <span>{prompt}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {session.messages.map((msg, idx) => {
                if (msg.role === "user") {
                  return (
                    <div key={msg.id} className="agent-user-row">
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
                        {idx === lastUserMsgIndex && !running && (
                          <button
                            type="button"
                            className="micro-action-btn"
                            title="Reintentar este mensaje"
                            onClick={() => void sendTurn(msg.content, false, msg.attachments)}
                          >
                            <RotateCcw size={11} />
                            <span>Reintentar</span>
                          </button>
                        )}
                      </div>
                    </div>
                  );
                }

                const isLastMsg = idx === session.messages.length - 1;
                const isThinkingLive =
                  running &&
                  isLastMsg &&
                  !msg.content &&
                  !msg.toolCalls.some((t) => t.status === "running");
                const thinkOpen = expandedThinking[msg.id] ?? false;

                return (
                  <div key={msg.id} className="agent-assistant-row">
                    <div className="agent-assistant-head">
                      <span className="agent-model-tag">
                        <Bot size={13} style={{ color: "#a855f7" }} />
                        <span>
                          {session.modelPath.split(/[\\/]/).pop() || "Agente Loors"}
                        </span>
                      </span>
                      {msg.content && (
                        <button
                          type="button"
                          className="micro-action-btn"
                          onClick={() => copyText(msg.id, msg.content)}
                        >
                          {copiedId === msg.id ? <Check size={11} /> : <Copy size={11} />}
                          <span>{copiedId === msg.id ? "Copiado" : "Copiar"}</span>
                        </button>
                      )}
                    </div>

                    {msg.thinking && (
                      <ThinkingDisclosure
                        text={msg.thinking}
                        isStreaming={isThinkingLive}
                        open={thinkOpen}
                        onToggle={() =>
                          setExpandedThinking((p) => ({ ...p, [msg.id]: !thinkOpen }))
                        }
                      />
                    )}

                    {msg.toolCalls.length > 0 && (
                      <div className="codex-tool-list">
                        {msg.toolCalls.map((call: AgentToolCallRecord) => {
                          const isOpen =
                            expandedTools[call.id] ?? Boolean(call.diffPreview);
                          const shotB64 = call.screenshotPath
                            ? savedShots[call.screenshotPath]
                            : undefined;

                          return (
                            <ToolActivityRow
                              key={call.id}
                              call={call}
                              open={isOpen}
                              shotB64={shotB64}
                              onToggle={() =>
                                setExpandedTools((p) => ({ ...p, [call.id]: !isOpen }))
                              }
                              onUndo={() => void handleUndoToolCall(msg.id, call.id)}
                            />
                          );
                        })}
                      </div>
                    )}

                    {msg.content ? (
                      <div className="agent-assistant-body">
                        <MarkdownContent text={msg.content} />
                      </div>
                    ) : (
                      running &&
                      idx === session.messages.length - 1 && (
                        modelLoadProgress &&
                        (modelLoadProgress.stage === "unloading" ||
                          modelLoadProgress.stage === "starting" ||
                          modelLoadProgress.stage === "loading") ? (
                          <ModelLoadInlineBar progress={modelLoadProgress} />
                        ) : (
                          <div className="agent-typing-hint">
                            <RefreshCw size={12} className="spin" />
                            <span>Generando respuesta…</span>
                          </div>
                        )
                      )
                    )}
                  </div>
                );
              })}

              {/* Interactive Permission Approval Card */}
              {permissionReq && (
                <div className="permission-card">
                  <div className="permission-head">
                    <Shield size={16} style={{ color: "#f59e0b" }} />
                    <span>
                      Permiso requerido: <strong>{permissionReq.toolName}</strong>
                    </span>
                  </div>
                  <pre className="permission-preview">{permissionReq.preview}</pre>
                  <div className="permission-actions">
                    <button
                      type="button"
                      className="btn-primary"
                      onClick={() => void handlePermission(true, false)}
                    >
                      Aprobar 1 vez
                    </button>
                    <button
                      type="button"
                      className="btn-secondary"
                      onClick={() => void handlePermission(true, true)}
                    >
                      Permitir siempre {permissionReq.toolName} en esta sesión
                    </button>
                    <button
                      type="button"
                      className="btn-danger"
                      onClick={() => void handlePermission(false, false)}
                    >
                      Rechazar
                    </button>
                  </div>
                </div>
              )}

              {gpuBusyPrompt && (
                <div className="permission-card" style={{ borderColor: "rgba(99,102,241,0.5)" }}>
                  <div className="permission-head">
                    <Zap size={15} style={{ color: "#818cf8" }} />
                    <span>El Arnés está usando llama-server (GPU) ahora mismo</span>
                  </div>
                  <div className="permission-actions">
                    <button
                      type="button"
                      className="btn-primary"
                      onClick={() => void sendTurn(gpuBusyPrompt, true)}
                    >
                      Detener arnés y enviar ahora
                    </button>
                    <button
                      type="button"
                      className="btn-secondary"
                      onClick={() => setGpuBusyPrompt(null)}
                    >
                      Esperar
                    </button>
                  </div>
                </div>
              )}

              {error && <div className="hw-error">{error}</div>}
            </div>
          </div>

          <div className="composer-wrap">
            {pendingQuestion && (
              <div
                style={{
                  marginBottom: 8,
                  padding: "12px 14px",
                  borderRadius: 10,
                  background: "var(--bg-surface-1)",
                  border: "1px solid var(--accent)",
                  display: "flex",
                  flexDirection: "column",
                  gap: 8,
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                  <strong style={{ fontSize: 13 }}>{pendingQuestion.question}</strong>
                  <button
                    type="button"
                    className="icon-btn"
                    title="Dismiss"
                    onClick={() => {
                      setPendingQuestion(null);
                      void invoke("resolve_agent_question", { decision: { answers: [] } });
                    }}
                  >
                    <X size={13} />
                  </button>
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                  {pendingQuestion.options.map((opt) => {
                    const selected = selectedQuestionOpts.includes(opt);
                    return (
                      <button
                        key={opt}
                        type="button"
                        className={selected ? "btn-primary btn-xs" : "btn-secondary btn-xs"}
                        onClick={() => {
                          if (!pendingQuestion.allowMultiple) {
                            setPendingQuestion(null);
                            void invoke("resolve_agent_question", { decision: { answers: [opt] } });
                          } else {
                            setSelectedQuestionOpts((prev) =>
                              prev.includes(opt) ? prev.filter((x) => x !== opt) : [...prev, opt]
                            );
                          }
                        }}
                      >
                        {opt}
                      </button>
                    );
                  })}
                </div>
                <div style={{ display: "flex", gap: 6 }}>
                  <input
                    type="text"
                    placeholder="Or type a custom answer..."
                    value={customQuestionAnswer}
                    onChange={(e) => setCustomQuestionAnswer(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && (customQuestionAnswer.trim() || selectedQuestionOpts.length > 0)) {
                        const answers = [
                          ...selectedQuestionOpts,
                          ...(customQuestionAnswer.trim() ? [customQuestionAnswer.trim()] : []),
                        ];
                        setPendingQuestion(null);
                        void invoke("resolve_agent_question", { decision: { answers } });
                      }
                    }}
                    style={{ flex: 1, fontSize: 12, padding: "5px 8px", borderRadius: 6, background: "var(--bg-surface-2)", border: "1px solid var(--border-subtle)", color: "var(--text-primary)" }}
                  />
                  <button
                    type="button"
                    className="btn-primary btn-xs"
                    disabled={selectedQuestionOpts.length === 0 && !customQuestionAnswer.trim()}
                    onClick={() => {
                      const answers = [
                        ...selectedQuestionOpts,
                        ...(customQuestionAnswer.trim() ? [customQuestionAnswer.trim()] : []),
                      ];
                      setPendingQuestion(null);
                      void invoke("resolve_agent_question", { decision: { answers } });
                    }}
                  >
                    Send
                  </button>
                </div>
              </div>
            )}
            {activeArtifact && (
              <div
                style={{
                  marginBottom: 8,
                  padding: "10px 12px",
                  borderRadius: 10,
                  background: "var(--bg-surface-1)",
                  border: "1px solid var(--border-subtle)",
                  display: "flex",
                  flexDirection: "column",
                  gap: 8,
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                  <div
                    style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", minWidth: 0 }}
                    onClick={() => setArtifactExpanded((v) => !v)}
                  >
                    <FileText size={13} style={{ color: "var(--accent-soft)", flexShrink: 0 }} />
                    <strong style={{ fontSize: 12 }} className="truncate-text">
                      {activeArtifact.title}
                    </strong>
                    <span style={{ fontSize: 10, color: "var(--text-muted)", textTransform: "uppercase" }}>
                      {activeArtifact.kind}
                    </span>
                  </div>
                  <div style={{ display: "flex", gap: 4 }}>
                    <button
                      type="button"
                      className="btn-secondary btn-xs"
                      onClick={() => navigator.clipboard?.writeText(activeArtifact.content)}
                    >
                      <Copy size={11} />
                    </button>
                    <button
                      type="button"
                      className="icon-btn"
                      style={{ width: 22, height: 22 }}
                      onClick={() => setActiveArtifact(null)}
                    >
                      <X size={12} />
                    </button>
                  </div>
                </div>
                {artifactExpanded && (
                  activeArtifact.kind === "html" ? (
                    <iframe
                      title={activeArtifact.title}
                      sandbox="allow-scripts"
                      srcDoc={activeArtifact.content}
                      style={{
                        width: "100%",
                        height: 240,
                        border: "1px solid var(--border-subtle)",
                        borderRadius: 8,
                        background: "#ffffff",
                      }}
                    />
                  ) : (
                    <div
                      style={{
                        maxHeight: 220,
                        overflowY: "auto",
                        padding: "8px 10px",
                        borderRadius: 8,
                        background: "var(--bg-surface-2)",
                        fontSize: 12,
                      }}
                    >
                      <MarkdownContent text={activeArtifact.content} />
                    </div>
                  )
                )}
              </div>
            )}
            {todoItems.length > 0 && (
              <div
                style={{
                  marginBottom: 8,
                  padding: "8px 12px",
                  borderRadius: 10,
                  background: "var(--bg-surface-1)",
                  border: "1px solid var(--border-subtle)",
                  fontSize: 12,
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 8,
                    cursor: "pointer",
                  }}
                  onClick={() => setTodoCollapsed((v) => !v)}
                >
                  <strong style={{ fontSize: 11.5, color: "var(--text-primary)" }}>
                    Tasks ({todoItems.filter((i) => i.status === "done").length}/{todoItems.length})
                  </strong>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <button
                      type="button"
                      className="icon-btn"
                      style={{ width: 20, height: 20 }}
                      title="Clear checklist"
                      onClick={(e) => {
                        e.stopPropagation();
                        setTodoItems([]);
                      }}
                    >
                      <X size={12} />
                    </button>
                  </div>
                </div>
                {!todoCollapsed && (
                  <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 6 }}>
                    {todoItems.map((item, idx) => {
                      const done = item.status === "done";
                      const active = item.status === "in_progress";
                      const failed = item.status === "failed";
                      return (
                        <div
                          key={`${idx}-${item.title}`}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 7,
                            color: done
                              ? "var(--text-muted)"
                              : failed
                                ? "#f87171"
                                : active
                                  ? "var(--text-primary)"
                                  : "var(--text-secondary)",
                            textDecoration: done ? "line-through" : "none",
                          }}
                        >
                          <span
                            style={{
                              width: 14,
                              display: "inline-flex",
                              justifyContent: "center",
                              color: done
                                ? "#4ade80"
                                : active
                                  ? "#a78bfa"
                                  : failed
                                    ? "#f87171"
                                    : "var(--text-muted)",
                              fontWeight: 700,
                            }}
                          >
                            {done ? "✓" : active ? "●" : failed ? "✕" : "○"}
                          </span>
                          <span>{item.title}</span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
            <div className="floating-composer">
              <MessageQueueTray
                items={messageQueue}
                isBusy={running}
                onRemove={(id) =>
                  setMessageQueue((prev) => prev.filter((q) => q.id !== id))
                }
                onRunNext={() => {
                  if (messageQueue.length === 0) return;
                  const [next, ...rest] = messageQueue;
                  setMessageQueue(rest);
                  void sendTurn(next.text, false, next.attachments ?? []);
                }}
              />
              {(pendingAttachments.length > 0 || session.pinnedFiles.length > 0 || stagingFiles) && (
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
                  {session.pinnedFiles.map((rel) => (
                    <span key={`pin-${rel}`} className="pinned-chip" title={`Fijado del proyecto: ${rel}`}>
                      <Pin size={10} />
                      <span className="truncate-text" style={{ maxWidth: 150 }}>
                        {rel.split("/").pop()}
                      </span>
                      <button
                        type="button"
                        title="Desfijar archivo del proyecto"
                        onClick={() => togglePinFile(rel)}
                      >
                        <X size={10} />
                      </button>
                    </span>
                  ))}
                  {stagingFiles && (
                    <span className="attachment-chip">
                      <RefreshCw size={11} className="spin" />
                      <span>Procesando archivo…</span>
                    </span>
                  )}
                </div>
              )}

              <textarea
                rows={2}
                placeholder={
                  running
                    ? t("agent.composerQueuePlaceholder")
                    : t("agent.composerPlaceholder")
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
                    void sendTurn(input);
                  }
                }}
              />

              <div className="composer-bar">
                <div className="composer-left">
                <div className="composer-model-wrap" ref={attachMenuRef}>
                  <button
                    type="button"
                    className={`composer-plus-btn ${attachMenuOpen ? "active" : ""}`}
                    title="Adjuntar archivos, imágenes o fijar archivo del proyecto"
                    onClick={() => setAttachMenuOpen((v) => !v)}
                  >
                    <Plus size={14} />
                  </button>

                  {attachMenuOpen && (
                    <div className="composer-pin-popover">
                      <button
                        type="button"
                        className="attach-menu-action"
                        onClick={() => {
                          setAttachMenuOpen(false);
                          void handlePickAttachFiles();
                        }}
                      >
                        <Paperclip size={13} />
                        <span>
                          {locale === "es"
                            ? "Adjuntar archivos, PDFs o imágenes…"
                            : "Attach files, PDFs, or images…"}
                        </span>
                      </button>
                      <div className="model-pop-search">
                        <Search size={13} />
                        <input
                          type="text"
                          autoFocus
                          placeholder={
                            locale === "es"
                              ? "Fijar archivo del proyecto…"
                              : "Pin a project file…"
                          }
                          value={pinQuery}
                          onChange={(e) => void handleSearchPin(e.target.value)}
                        />
                      </div>
                      <div className="composer-pin-results">
                        {pinResults.length === 0 ? (
                          <div className="muted-empty" style={{ padding: 10 }}>
                            {locale === "es"
                              ? "Sin archivos que coincidan en el proyecto."
                              : "No matching files in this project."}
                          </div>
                        ) : (
                          pinResults.map((rel) => {
                            const pinned = session.pinnedFiles.includes(rel);
                            return (
                              <button
                                key={rel}
                                type="button"
                                className={`pin-result-item ${pinned ? "is-pinned" : ""}`}
                                onClick={() => togglePinFile(rel)}
                              >
                                <FileText size={12} />
                                <span className="truncate-text" style={{ flex: 1 }}>
                                  {rel}
                                </span>
                                {pinned && <Check size={12} />}
                              </button>
                            );
                          })
                        )}
                      </div>
                    </div>
                  )}
                </div>

                  <span className="composer-sep" aria-hidden="true" />
                  <div className="composer-model-wrap" ref={modelPickerRef}>
                    <button
                      type="button"
                      className="composer-model-btn"
                      title={session.modelPath || "Elegir modelo GGUF"}
                      onClick={() => setModelPickerOpen((prev) => !prev)}
                    >
                      {isCloudModelPath(session.modelPath) ? (
                        (() => {
                          const parsed = parseCloudModelPath(session.modelPath);
                          const prov = cloudProviders.find(
                            (p) => p.id === parsed?.providerId
                          );
                          return (
                            <>
                              <Cloud size={12} style={{ color: "#a78bfa", flexShrink: 0 }} />
                              <span className="composer-model-title truncate-text">
                                {parsed?.modelId ?? session.modelPath}
                              </span>
                              <span className="composer-model-quant">
                                {prov?.name.split(" ")[0] ?? parsed?.providerId ?? "API"}
                              </span>
                            </>
                          );
                        })()
                      ) : activeModelMeta ? (
                        <>
                          <span className="composer-model-title truncate-text">
                            {activeModelMeta.baseName}
                          </span>
                          <span className="composer-model-quant">
                            {activeModelMeta.quant}
                          </span>
                        </>
                      ) : (
                        <span className="composer-model-title">{t("agent.chooseModel")}</span>
                      )}
                      <ChevronUp size={12} style={{ color: "var(--muted)", flexShrink: 0 }} />
                    </button>

                    {modelPickerOpen && (
                      <div className="model-popover">
                        <div className="model-pop-search">
                          <Search size={13} />
                          <input
                            type="text"
                            autoFocus
                            placeholder={t("agent.searchModel")}
                            value={modelPickerQuery}
                            onChange={(e) => setModelPickerQuery(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Escape") {
                                e.stopPropagation();
                                setModelPickerOpen(false);
                              }
                            }}
                          />
                          {modelPickerQuery && (
                            <button
                              type="button"
                              className="icon-btn"
                              onClick={() => setModelPickerQuery("")}
                            >
                              <X size={11} />
                            </button>
                          )}
                        </div>

                        <div className="model-pop-list">
                          {cloudProviders
                            .filter((p) => p.enabled && p.models.length > 0)
                            .map((prov) => {
                              const q = modelPickerQuery.trim().toLowerCase();
                              const matchingModels = prov.models.filter(
                                (m) =>
                                  !q ||
                                  m.toLowerCase().includes(q) ||
                                  prov.name.toLowerCase().includes(q)
                              );
                              if (matchingModels.length === 0) return null;
                              return (
                                <div key={prov.id} className="model-pop-group">
                                  <div className="model-pop-group-head">
                                    <span className="truncate-text" style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                                      <Cloud size={11} style={{ color: "#a78bfa" }} />
                                      {prov.name}
                                    </span>
                                    <span className="composer-model-quant">API</span>
                                  </div>
                                  {matchingModels.map((mid) => {
                                    const uri = `cloud::${prov.id}::${mid}`;
                                    const isActive = session.modelPath === uri;
                                    return (
                                      <div
                                        key={uri}
                                        className={`model-pop-row ${isActive ? "active" : ""}`}
                                        onClick={() => {
                                          setActiveModelPath(uri);
                                          void persistSession({
                                            ...session,
                                            modelPath: uri,
                                          });
                                          setModelPickerOpen(false);
                                        }}
                                      >
                                        <span className="model-pop-quality truncate-text" style={{ flex: 1, color: "#e2e8f0" }}>
                                          {mid}
                                        </span>
                                        {isActive && (
                                          <Check size={13} style={{ flexShrink: 0 }} />
                                        )}
                                      </div>
                                    );
                                  })}
                                </div>
                              );
                            })}

                          {groupedPickerModels.length === 0 ? (
                            cloudProviders.some((p) => p.enabled && p.models.length > 0) ? null : (
                              <div className="muted-empty" style={{ padding: 10 }}>
                                {localModels.length === 0
                                  ? "No hay modelos descargados ni APIs activas todavía."
                                  : "Sin coincidencias en tus modelos locales."}
                              </div>
                            )
                          ) : (
                            groupedPickerModels.map((grp) => (
                              <div
                                key={`${grp.family}-${grp.baseName}`}
                                className="model-pop-group"
                              >
                                <div className="model-pop-group-head">
                                  <span className="truncate-text">{grp.baseName}</span>
                                  {grp.params && (
                                    <span className="composer-model-quant">{grp.params}</span>
                                  )}
                                </div>
                                {grp.items.map(({ file, meta }) => {
                                  const isActive = session.modelPath === file.path;
                                  const gb = file.size_mb / 1024;
                                  return (
                                    <div
                                      key={file.path}
                                      className={`model-pop-row ${isActive ? "active" : ""}`}
                                      onClick={() => {
                                        setActiveModelPath(file.path);
                                        void persistSession({
                                          ...session,
                                          modelPath: file.path,
                                        });
                                        setModelPickerOpen(false);
                                      }}
                                    >
                                      <span className="composer-model-quant">
                                        {meta.quant}
                                      </span>
                                      <span className="model-pop-quality truncate-text">
                                        {meta.quantQuality}
                                      </span>
                                      <span className="model-pop-size tabular-nums">
                                        {gb >= 1 ? `${gb.toFixed(1)} GB` : `${file.size_mb} MB`}
                                      </span>
                                      {isActive && (
                                        <Check size={13} style={{ flexShrink: 0 }} />
                                      )}
                                    </div>
                                  );
                                })}
                              </div>
                            ))
                          )}
                        </div>

                        <div className="model-pop-runtime-bar">
                          <span className="model-pop-runtime-label">Runtime</span>
                          <div className="model-pop-runtime-chips">
                            {(["auto", ...installedBackends] as RuntimeBackendKind[])
                              .filter((v, i, arr) => arr.indexOf(v) === i)
                              .map((bk) => (
                                <button
                                  key={bk}
                                  type="button"
                                  className={`runtime-chip-btn ${selectedBackend === bk ? "active" : ""}`}
                                  onClick={() => setSelectedBackend(bk)}
                                >
                                  {bk === "auto"
                                    ? "Auto"
                                    : bk === "vulkan"
                                      ? "Vulkan"
                                      : bk === "metal"
                                        ? "Metal"
                                        : bk.toUpperCase()}
                                </button>
                              ))}
                          </div>
                        </div>

                        <div className="model-pop-footer" style={{ display: "flex", gap: 6 }}>
                          <button
                            type="button"
                            className="model-pop-hub-btn"
                            style={{ flex: 1 }}
                            onClick={() => {
                              setModelPickerOpen(false);
                              window.dispatchEvent(
                                new CustomEvent("loors:open-models-modal")
                              );
                            }}
                          >
                            {t("agent.localModelsBtn")}
                          </button>
                          <button
                            type="button"
                            className="model-pop-hub-btn"
                            style={{ flex: 1 }}
                            onClick={() => {
                              setModelPickerOpen(false);
                              window.dispatchEvent(
                                new CustomEvent("loors:open-models-modal", {
                                  detail: { tab: "cloud" },
                                })
                              );
                            }}
                          >
                            {t("agent.cloudApisBtn")}
                          </button>
                        </div>
                      </div>
                    )}
                  </div>

                  <button
                    type="button"
                    className="icon-btn"
                    title="Opciones del modelo"
                    disabled={!session.modelPath}
                    onClick={() => openTuningModal(session.modelPath)}
                  >
                    <Settings size={14} />
                  </button>

                  <ReasoningEffortSelect
                    value={session.reasoningEffort ?? "medium"}
                    modelPath={session.modelPath}
                    onChange={(next) =>
                      void persistSession({ ...session, reasoningEffort: next })
                    }
                  />
                </div>

                <div className="composer-right">
                  <div className="composer-action-group">
                    {running && (
                      <button
                        type="button"
                        className="composer-send-btn is-stop"
                        title="Detener respuesta"
                        onClick={handleStop}
                      >
                        <Square size={12} fill="currentColor" />
                      </button>
                    )}
                    {(!running ||
                      input.trim().length > 0 ||
                      pendingAttachments.length > 0) && (
                      <button
                        type="button"
                        className="composer-send-btn"
                        title={running ? "Encolar mensaje" : "Enviar"}
                        disabled={
                          (!input.trim() && pendingAttachments.length === 0) ||
                          !session.modelPath
                        }
                        onClick={() => void sendTurn(input)}
                      >
                        <ArrowUp size={16} strokeWidth={2.3} />
                      </button>
                    )}
                  </div>
                </div>
              </div>
            </div>

            <div className="composer-env-bar">
              <div className="composer-env-left">
                <div className="effort-pop-wrap" ref={wsMenuRef}>
                  <button
                    type="button"
                    className={`composer-env-pill ${!session.workspace || session.workspace === "." ? "is-none" : ""}`}
                    title={session.workspace || "Sin proyecto enlazado"}
                    onClick={() => setWsMenuOpen((v) => !v)}
                  >
                    <Folder size={12} />
                    <span className="truncate-text" style={{ maxWidth: 160 }}>
                      {activeWsShort}
                    </span>
                    <ChevronUp size={11} className="effort-pill-chev" />
                  </button>

                  {wsMenuOpen && (
                    <div className="effort-popover" role="menu" style={{ minWidth: 220 }}>
                      <div className="effort-popover-title">
                        {locale === "es"
                          ? "Proyecto de esta conversación"
                          : "Conversation workspace"}
                      </div>
                      <button
                        type="button"
                        role="menuitem"
                        className={`effort-pop-item ${!session.workspace || session.workspace === "." ? "active" : ""}`}
                        onClick={() => {
                          setWsMenuOpen(false);
                          void persistSession({ ...session, workspace: "", pinnedFiles: [] });
                        }}
                      >
                        <div className="effort-pop-item-text">
                          <span className="effort-pop-item-label">
                            {locale === "es" ? "Sin proyecto" : "No project"}
                          </span>
                          <span className="effort-pop-item-desc">
                            {locale === "es" ? "Conversación libre" : "General chat"}
                          </span>
                        </div>
                        {(!session.workspace || session.workspace === ".") && (
                          <Check size={12} style={{ color: "#c084fc", flexShrink: 0 }} />
                        )}
                      </button>
                      {projects.map((p) => {
                        const name = p.split(/[\\/]/).filter(Boolean).pop() || p;
                        const active = normWs(session.workspace) === normWs(p);
                        return (
                          <button
                            key={p}
                            type="button"
                            role="menuitem"
                            className={`effort-pop-item ${active ? "active" : ""}`}
                            title={p}
                            onClick={() => {
                              setWsMenuOpen(false);
                              void persistSession({ ...session, workspace: p, pinnedFiles: [] });
                            }}
                          >
                            <div className="effort-pop-item-text">
                              <span className="effort-pop-item-label truncate-text">{name}</span>
                            </div>
                            {active && (
                              <Check size={12} style={{ color: "#c084fc", flexShrink: 0 }} />
                            )}
                          </button>
                        );
                      })}
                      <button
                        type="button"
                        role="menuitem"
                        className="effort-pop-item"
                        onClick={() => {
                          setWsMenuOpen(false);
                          void handlePickWorkspace();
                        }}
                      >
                        <div className="effort-pop-item-text">
                          <span className="effort-pop-item-label" style={{ color: "#a78bfa" }}>
                            {locale === "es"
                              ? "+ Elegir otra carpeta…"
                              : "+ Choose another folder…"}
                          </span>
                        </div>
                      </button>
                    </div>
                  )}
                </div>

                <div className="effort-pop-wrap" ref={permMenuRef}>
                  <button
                    type="button"
                    className={`composer-env-pill ${permMenuOpen ? "is-open" : ""}`}
                    title="Permisos locales del agente"
                    onClick={() => setPermMenuOpen((v) => !v)}
                  >
                    {session.permissionMode === "read_only" ? (
                      <Eye size={12} />
                    ) : session.permissionMode === "ask" ? (
                      <Lock size={12} />
                    ) : session.permissionMode === "auto_review" ? (
                      <Shield size={12} style={{ color: "#a78bfa" }} />
                    ) : (
                      <Zap size={12} style={{ color: "#f59e0b" }} />
                    )}
                    <span>
                      {session.permissionMode === "read_only"
                        ? t("agent.permReadOnly")
                        : session.permissionMode === "ask"
                          ? t("agent.permAsk")
                          : session.permissionMode === "auto_review"
                            ? t("agent.permAuto")
                            : t("agent.permTurbo")}
                    </span>
                    <ChevronUp size={11} className="effort-pill-chev" />
                  </button>

                  {permMenuOpen && (
                    <div
                      className="effort-popover"
                      role="menu"
                      style={{ left: 0, right: "auto", minWidth: 268 }}
                    >
                      <div className="effort-popover-title">{t("agent.localPermissions")}</div>
                      {(
                        [
                          {
                            id: "read_only" as PermissionMode,
                            label: t("agent.permReadOnly"),
                            desc: t("agent.permReadOnlyDesc"),
                            icon: <Eye size={14} />,
                          },
                          {
                            id: "ask" as PermissionMode,
                            label: t("agent.permAsk"),
                            desc: t("agent.permAskDesc"),
                            icon: <Lock size={14} />,
                          },
                          {
                            id: "auto_review" as PermissionMode,
                            label: t("agent.permAuto"),
                            desc: t("agent.permAutoDesc"),
                            icon: <Shield size={14} style={{ color: "#a78bfa" }} />,
                          },
                          {
                            id: "full_auto" as PermissionMode,
                            label: t("agent.permTurbo"),
                            desc: t("agent.permTurboDesc"),
                            icon: <Zap size={14} style={{ color: "#f59e0b" }} />,
                          },
                        ]
                      ).map((opt) => {
                        const active = session.permissionMode === opt.id;
                        return (
                          <button
                            key={opt.id}
                            type="button"
                            role="menuitem"
                            className={`effort-pop-item ${active ? "active" : ""}`}
                            onClick={() => {
                              setPermMenuOpen(false);
                              void persistSession({ ...session, permissionMode: opt.id });
                            }}
                          >
                            <div style={{ display: "flex", alignItems: "flex-start", gap: 9 }}>
                              <span style={{ color: "#94a3b8", marginTop: 2, flexShrink: 0 }}>
                                {opt.icon}
                              </span>
                              <div className="effort-pop-item-text">
                                <span className="effort-pop-item-label">{opt.label}</span>
                                <span className="effort-pop-item-desc">{opt.desc}</span>
                              </div>
                            </div>
                            {active && (
                              <Check size={12} style={{ color: "#c084fc", flexShrink: 0 }} />
                            )}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>

              <div className="composer-env-right">
                <div className="composer-model-wrap" ref={compactPopoverRef}>
                  <button
                    type="button"
                    className={`ctx-trigger-btn tabular-nums ${compactPopoverOpen ? "active" : ""}`}
                    title={`Contexto: ${Math.round(estTokensUsed / 1024)}K / ${maxCtxLabel} · Compactación: ${Math.round(effectiveCompactTokens / 1024)}K (${compactPct}%)`}
                    onClick={() => setCompactPopoverOpen((v) => !v)}
                  >
                    {Math.round(estTokensUsed / 1024)}K / {maxCtxLabel}
                  </button>

                  {compactPopoverOpen && (
                    <div className="compact-popover">
                      <div className="sheet-row-top">
                        <span className="sheet-label">
                          {locale === "es" ? "Compactar historial a" : "Compact history at"}
                        </span>
                        <div className="sheet-inline-val">
                          <button
                            type="button"
                            className={`sheet-pill-toggle ${(session.compactAtTokens ?? 0) === 0 && modelDefaultCompact === 0 ? "active" : ""}`}
                            onClick={() =>
                              void persistSession({ ...session, compactAtTokens: 0 })
                            }
                          >
                            Auto
                          </button>
                          <span className="sheet-readout tabular-nums">
                            {Math.round(effectiveCompactTokens / 1024)}K ({compactPct}%)
                          </span>
                        </div>
                      </div>
                      <input
                        type="range"
                        className="clean-slider"
                        min="4096"
                        max={effectiveMaxTokens}
                        step="2048"
                        value={effectiveCompactTokens}
                        onChange={(e) =>
                          void persistSession({
                            ...session,
                            compactAtTokens: Number(e.target.value),
                          })
                        }
                      />
                      <div className="compact-popover-foot">
                        <span>
                          {locale === "es"
                            ? `Contexto cargado del modelo: ${maxCtxLabel}`
                            : `Loaded model context: ${maxCtxLabel}`}
                        </span>
                      </div>

                      <div className="sheet-divider" />

                      <label className="check-inline">
                        <input
                          type="checkbox"
                          checked={session.useRag}
                          onChange={(e) =>
                            void persistSession({ ...session, useRag: e.target.checked })
                          }
                        />
                        <span>
                          {locale === "es" ? "Índice RAG del proyecto" : "Project RAG index"}
                        </span>
                      </label>

                      {skills.length > 0 && (
                        <div className="skills-checklist" style={{ marginTop: 4 }}>
                          {skills.map((sk) => {
                            const checked = session.enabledSkills.includes(sk.path);
                            return (
                              <label key={sk.path} className="check-inline">
                                <input
                                  type="checkbox"
                                  checked={checked}
                                  onChange={() => {
                                    const next = checked
                                      ? session.enabledSkills.filter((p) => p !== sk.path)
                                      : [...session.enabledSkills, sk.path];
                                    void persistSession({ ...session, enabledSkills: next });
                                  }}
                                />
                                <span className="truncate-text">{sk.name}</span>
                              </label>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
          </div>

          {rightPanelOpen && (
            <>
              {!(rightPanelTab === "browser" && browserExpanded) && (
              <div
                className="panel-resizer"
                role="separator"
                aria-orientation="vertical"
                title="Drag to resize (double-click to reset)"
                onMouseDown={(e) => {
                  e.preventDefault();
                  startAgentResize("right", e.clientX);
                }}
                onDoubleClick={() => {
                  setRightPanelWidth(390);
                  localStorage.setItem("loors_agent_right_w", "390");
                }}
              />
              )}
              <aside
                className={`agent-workbench-drawer ${rightPanelTab === "browser" ? "browser-mode" : ""} ${rightPanelTab === "browser" && browserExpanded ? "expanded" : ""}`}
                style={
                  rightPanelTab === "browser"
                    ? browserExpanded
                      ? undefined
                      : {
                          width: Math.max(rightPanelWidth, Math.round(window.innerWidth * 0.46)),
                          minWidth: 420,
                        }
                    : { width: rightPanelWidth, minWidth: rightPanelWidth }
                }
              >
              {rightPanelTab !== "browser" && (
              <div className="workbench-drawer-head">
                <div className="workbench-drawer-title">
                  {rightPanelTab === "files" && (
                    <>
                      <Folder size={13} />
                      <span>
                        {locale === "es" ? "Archivos" : "Files"} · {activeWsShort}
                      </span>
                    </>
                  )}
                  {rightPanelTab === "diff" && (
                    <>
                      <GitBranch size={13} />
                      <span>Git Diff · {activeWsShort}</span>
                    </>
                  )}
                </div>
              </div>
              )}

              {rightPanelTab === "files" && (
                <div className="workbench-pane">
                  <div className="workbench-search-bar">
                    <Search size={12} />
                    <input
                      type="text"
                      placeholder={
                        locale === "es"
                          ? "Filtrar archivos del proyecto…"
                          : "Filter project files…"
                      }
                      value={fileFilter}
                      onChange={(e) => {
                        const q = e.target.value;
                        setFileFilter(q);
                        if (session.workspace && session.workspace !== ".") {
                          invoke<string[]>("find_workspace_files", {
                            workspace: session.workspace,
                            query: q,
                          })
                            .then(setWorkspaceFiles)
                            .catch(() => {});
                        }
                      }}
                    />
                  </div>

                  {selectedPreviewFile ? (
                    <div className="workbench-file-preview">
                      <div className="workbench-file-preview-head">
                        <button
                          type="button"
                          className="btn-mini"
                          onClick={() => setSelectedPreviewFile(null)}
                        >
                          ← Volver al árbol
                        </button>
                        <span className="truncate-text" style={{ flex: 1, fontSize: 11.5, fontWeight: 600 }}>
                          {selectedPreviewFile}
                        </span>
                        <button
                          type="button"
                          className={`btn-mini ${session.pinnedFiles.includes(selectedPreviewFile) ? "btn-active" : ""}`}
                          onClick={() => togglePinFile(selectedPreviewFile)}
                          title="Fijar archivo al contexto del chat"
                        >
                          <Pin size={11} />
                          <span>
                            {session.pinnedFiles.includes(selectedPreviewFile) ? "Fijado" : "Fijar"}
                          </span>
                        </button>
                      </div>
                      <pre className="workbench-code-pre">{selectedPreviewContent}</pre>
                    </div>
                  ) : (
                    <div className="workbench-files-list">
                      {(!session.workspace || session.workspace === ".") ? (
                        <div className="muted-empty" style={{ padding: 14 }}>
                          {locale === "es"
                          ? "Elige un proyecto a la izquierda para ver su árbol de archivos."
                          : "Select a project on the left to browse its file tree."}
                        </div>
                      ) : workspaceFiles.length === 0 ? (
                        <div className="muted-empty" style={{ padding: 14 }}>
                          Sin archivos que coincidan.
                        </div>
                      ) : (
                        <WorkspaceFileTree
                          files={workspaceFiles}
                          pinnedFiles={session.pinnedFiles}
                          filterActive={fileFilter.trim().length > 0}
                          onOpenFile={(rel) => void handlePreviewWorkspaceFile(rel)}
                          onTogglePin={togglePinFile}
                        />
                      )}
                    </div>
                  )}
                  <div className="workbench-drawer-foot">
                    <span>
                      {locale === "es"
                        ? `${workspaceFiles.length} archivos en ${activeWsShort}`
                        : `${workspaceFiles.length} files in ${activeWsShort}`}
                    </span>
                    {session.pinnedFiles.length > 0 && (
                      <span>
                        {locale === "es"
                          ? `${session.pinnedFiles.length} fijado(s)`
                          : `${session.pinnedFiles.length} pinned`}
                      </span>
                    )}
                  </div>
                </div>
              )}

              {rightPanelTab === "diff" && (
                <div className="workbench-pane">
                  <div className="workbench-subbar">
                    <span>
                      {locale === "es"
                        ? "Cambios sin confirmar en el repositorio"
                        : "Uncommitted repository changes"}
                    </span>
                    <button
                      type="button"
                      className="btn-mini"
                      onClick={() => {
                        invoke<string>("get_workspace_diff", {
                          workspace: session.workspace || ".",
                        })
                          .then(setGitDiffText)
                          .catch(() => {});
                      }}
                    >
                      <RefreshCw size={11} />
                      <span>{locale === "es" ? "Actualizar" : "Refresh"}</span>
                    </button>
                  </div>
                  <div className="agent-diff-body">
                    {gitDiffText.trim() ? (
                      <DiffLines diff={gitDiffText} />
                    ) : (
                      <div className="muted-empty" style={{ padding: 14 }}>
                        {locale === "es"
                          ? "Sin cambios pendientes en Git. Cuando el agente edite archivos verás el diff aquí automáticamente."
                          : "No pending Git changes. File diffs will appear here automatically when the agent edits files."}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {rightPanelTab === "browser" && (
                <InteractiveBrowserPane
                  sessionId={session.id}
                  agentFrame={liveBrowserFrame}
                  agentBusy={running}
                  expanded={browserExpanded}
                  onToggleExpand={() => setBrowserExpanded((v) => !v)}
                  onClosePane={() => setRightPanelOpen(false)}
                />
              )}
            </aside>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
