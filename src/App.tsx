import { PanelResizer } from "./components/PanelResizer";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  Controls,
  MiniMap,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  useNodesInitialized,
  useReactFlow,
  type Viewport,
  type NodeTypes,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { checkHeadlessHealth, invoke, listen } from "./lib/bridge";
import { WebAuthGate } from "./components/WebAuthGate";
import {
  Check,
  Eye,
  EyeOff,
  FolderOpen,
  LayoutGrid,
  Maximize2,
  Minimize2,
  MessageSquare,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Play,
  Plus,
  RefreshCw,
  Save,
  Settings,
  Sliders,
  Sparkles,
  Square,
  Workflow,
  X,
} from "lucide-react";
import { arePortsCompatible } from "./components/nodePorts";
import { LoorsNode } from "./components/nodes/LoorsNode";
import { Sidebar } from "./components/Sidebar";
import { Inspector } from "./components/Inspector";
import { ConsolePanel } from "./components/ConsolePanel";
import { ModalBackdrop } from "./components/ModalBackdrop";
import { HumanGateModal } from "./components/HumanGateModal";
import { WorkflowIoModal } from "./components/WorkflowIoModal";
import { SettingsModal, type SettingsTab } from "./components/SettingsModal";
import { type UpdateCheckResult } from "./components/UpdateModal";
import { ArchitectChat } from "./components/ArchitectChat";
import { DownloadsDock } from "./components/DownloadsDock";
import { AgentWorkspaceView } from "./components/AgentWorkspaceView";
import { ModelTuningModal } from "./components/ModelTuningModal";
import { useGraphStore } from "./store/useGraphStore";
import { useI18n } from "./i18n";
import {
  isResourceKind,
  NODE_BLUEPRINTS,
  parseGgufMetadata,
  parseWorkflowJson,
  validateGraphBeforeRun,
  workflowRevision,
  type EngineEvent,
  type LoorsNodeKind,
  type ModelLoadProgressEvent,
  type RuntimeStatusSnapshot,
} from "./types/graph";

const nodeTypes: NodeTypes = {
  loorsNode: LoorsNode,
  loopyNode: LoorsNode,
};

function LoorsStudioInner() {
  const { locale, t } = useI18n();
  const { screenToFlowPosition, fitView, setViewport } = useReactFlow();
  const nodesInitialized = useNodesInitialized();
  const canvasRef = useRef<HTMLElement>(null);
  const harnessViewports = useRef(new Map<string, Viewport>());
  const appMode = useGraphStore((s) => s.appMode);
  const setAppMode = useGraphStore((s) => s.setAppMode);
  const rightPanelTab = useGraphStore((s) => s.rightPanelTab);
  const setRightPanelTab = useGraphStore((s) => s.setRightPanelTab);
  const dimResourceEdges = useGraphStore((s) => s.dimResourceEdges);
  const setDimResourceEdges = useGraphStore((s) => s.setDimResourceEdges);
  const selectedNodeId = useGraphStore((s) => s.selectedNodeId);
  const agentRunning = useGraphStore((s) => s.agentRunning);
  const agentActiveTitle = useGraphStore((s) => s.agentActiveTitle);

  const workflowName = useGraphStore((s) => s.workflowName);
  const setWorkflowName = useGraphStore((s) => s.setWorkflowName);
  const nodes = useGraphStore((s) => s.nodes);
  const edges = useGraphStore((s) => s.edges);
  const onNodesChange = useGraphStore((s) => s.onNodesChange);
  const onEdgesChange = useGraphStore((s) => s.onEdgesChange);
  const onConnect = useGraphStore((s) => s.onConnect);
  const addNode = useGraphStore((s) => s.addNode);
  const autoLayout = useGraphStore((s) => s.autoLayout);
  const harnessTabs = useGraphStore((s) => s.harnessTabs);
  const activeHarnessTabId = useGraphStore((s) => s.activeHarnessTabId);
  const createHarnessTab = useGraphStore((s) => s.createHarnessTab);
  const switchHarnessTab = useGraphStore((s) => s.switchHarnessTab);
  const closeHarnessTab = useGraphStore((s) => s.closeHarnessTab);
  const savedLibraryName = useGraphStore((s) => s.savedLibraryName);
  const dirty = useGraphStore((s) => s.dirty);
  const autoSaveHarnesses = useGraphStore((s) => s.autoSaveHarnesses);
  const pendingGate = useGraphStore((s) => s.pendingGate);
  const setSelectedNodeId = useGraphStore((s) => s.setSelectedNodeId);
  const exportWorkflow = useGraphStore((s) => s.exportWorkflow);
  const importWorkflow = useGraphStore((s) => s.importWorkflow);
  const selectedBackend = useGraphStore((s) => s.selectedBackend);
  const runStatus = useGraphStore((s) => s.runStatus);
  const loadedModelName = useGraphStore((s) => s.loadedModelName);
  const loadedContextSize = useGraphStore((s) => s.loadedContextSize);
  const modelLoadProgress = useGraphStore((s) => s.modelLoadProgress);
  const setModelLoadProgress = useGraphStore((s) => s.setModelLoadProgress);
  const upsertModelDownload = useGraphStore((s) => s.upsertModelDownload);
  const prepareRun = useGraphStore((s) => s.prepareRun);
  const applyEngineEvent = useGraphStore((s) => s.applyEngineEvent);
  const newWorkflow = useGraphStore((s) => s.newWorkflow);
  const updateNodeConfig = useGraphStore((s) => s.updateNodeConfig);
  const consoleOpen = useGraphStore((s) => s.consoleOpen);
  const setConsoleOpen = useGraphStore((s) => s.setConsoleOpen);

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("general");
  const [updateInfo, setUpdateInfo] = useState<UpdateCheckResult | null>(null);
  const [ioOpen, setIoOpen] = useState(false);
  const [webAuthRequired, setWebAuthRequired] = useState(false);

  useEffect(() => {
    void checkHeadlessHealth().then((res) => {
      if (res.isHeadlessServer && res.authRequired && !res.authenticated) {
        setWebAuthRequired(true);
      }
    });
    const onAuthRequired = () => setWebAuthRequired(true);
    window.addEventListener("loors:auth-required", onAuthRequired);
    return () => window.removeEventListener("loors:auth-required", onAuthRequired);
  }, []);
  const leftPanelOpen = useGraphStore((s) => s.leftPanelOpen);
  const setLeftPanelOpen = useGraphStore((s) => s.setLeftPanelOpen);
  const rightPanelOpen = useGraphStore((s) => s.rightPanelOpen);
  const setRightPanelOpen = useGraphStore((s) => s.setRightPanelOpen);
  const sidebarCollapsed = !leftPanelOpen;
  const rightPanelCollapsed = !rightPanelOpen;
  const [wideInspector, setWideInspector] = useState(false);
  const inspectorExpanded = wideInspector && rightPanelOpen && rightPanelTab === "inspector";
  const paletteHidden = sidebarCollapsed || inspectorExpanded;
  const [harnessLeftWidth, setHarnessLeftWidth] = useState<number>(() => {
    const saved = Number(localStorage.getItem("loors_harness_left_w"));
    return Number.isFinite(saved) && saved >= 190 && saved <= 440 ? saved : 256;
  });
  const [harnessRightWidth, setHarnessRightWidth] = useState<number>(() => {
    const saved = Number(localStorage.getItem("loors_harness_right_w"));
    return Number.isFinite(saved) && saved >= 280 && saved <= 640 ? saved : 360;
  });

  const [banner, setBanner] = useState<string | null>(null);
  const [pendingHarnessClose, setPendingHarnessClose] = useState<string | null>(null);
  const [closeError, setCloseError] = useState<string | null>(null);
  const [closingHarnessId, setClosingHarnessId] = useState<string | null>(null);
  const closeInProgress = useRef(false);
  const saveQueue = useRef(Promise.resolve());
  const [runtimeSnap, setRuntimeSnap] = useState<RuntimeStatusSnapshot | null>(null);
  const [triggerArmed, setTriggerArmed] = useState(false);
  const [quickAdd, setQuickAdd] = useState<{
    screenX: number;
    screenY: number;
    flowPos: { x: number; y: number };
    query: string;
  } | null>(null);

  useEffect(() => {
    invoke<RuntimeStatusSnapshot>("get_runtime_status")
      .then(setRuntimeSnap)
      .catch(() => {});
    invoke<{
      webhook_running: boolean;
      interval_running: boolean;
      telegram_running?: boolean;
    }>("get_trigger_status")
      .then((st) =>
        setTriggerArmed(
          Boolean(st.webhook_running || st.interval_running || st.telegram_running)
        )
      )
      .catch(() => {});
  }, [settingsOpen, selectedBackend]);

  const activeRuntimeInfo = useMemo(() => {
    const installed = runtimeSnap?.installed ?? [];
    if (installed.length === 0) return null;
    if (selectedBackend !== "auto") {
      return (
        installed.find((rt) => rt.backend === selectedBackend) ?? installed[0]
      );
    }
    return (
      installed.find((rt) => rt.backend === "cuda") ??
      installed.find((rt) => rt.backend === "vulkan") ??
      installed.find((rt) => rt.backend === "metal") ??
      installed[0]
    );
  }, [runtimeSnap, selectedBackend]);

  const activeRuntimeLabel = activeRuntimeInfo
    ? `llama.cpp ${activeRuntimeInfo.backend}`
    : `llama.cpp ${selectedBackend}`;

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (document.querySelector("dialog.loors-dialog[open]")) return;
      if ((e.ctrlKey || e.metaKey) && e.key === "1") {
        e.preventDefault();
        setAppMode("agent");
      } else if ((e.ctrlKey || e.metaKey) && e.key === "2") {
        e.preventDefault();
        setAppMode("harness");
      } else if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === "b" || e.key === "B")) {
        e.preventDefault();
        setRightPanelOpen(!rightPanelOpen);
      } else if ((e.ctrlKey || e.metaKey) && (e.key === "b" || e.key === "B")) {
        e.preventDefault();
        setLeftPanelOpen(!leftPanelOpen);
      } else if ((e.ctrlKey || e.metaKey) && (e.key === "j" || e.key === "J")) {
        if (appMode === "harness") {
          e.preventDefault();
          setConsoleOpen(!consoleOpen);
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [appMode, consoleOpen, setAppMode, setConsoleOpen]);

  useEffect(() => {
    const onOpenModels = (ev: Event) => {
      const detail = (ev as CustomEvent<{ tab?: "local" | "discover" | "cloud" }>).detail;
      setSettingsTab(detail?.tab === "cloud" ? "cloud" : "models");
      setSettingsOpen(true);
    };
    const onOpenRuntime = () => {
      setSettingsTab("runtime");
      setSettingsOpen(true);
    };
    const onRunWorkflow = (ev: Event) => {
      const detail = (ev as CustomEvent<{ startNodeId?: string }>).detail;
      void handleRun(detail?.startNodeId);
    };
    window.addEventListener("loors:open-models-modal", onOpenModels);
    window.addEventListener("loors:open-runtime-modal", onOpenRuntime);
    window.addEventListener("loors:run-workflow", onRunWorkflow);
    return () => {
      window.removeEventListener("loors:open-models-modal", onOpenModels);
      window.removeEventListener("loors:open-runtime-modal", onOpenRuntime);
      window.removeEventListener("loors:run-workflow", onRunWorkflow);
    };
  });

  // Silent background check for app updates on startup
  useEffect(() => {
    invoke<UpdateCheckResult>("check_app_update", { repo: null })
      .then((res) => {
        if (res.updateAvailable) {
          setUpdateInfo(res);
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    invoke<import("./types/graph").ModelDownloadEvent[]>("list_active_model_downloads")
      .then((list) => {
        if (cancelled || !Array.isArray(list)) return;
        for (const ev of list) {
          upsertModelDownload(ev);
        }
      })
      .catch(() => {});

    listen<import("./types/graph").ModelDownloadEvent>("loors://model-download", (ev) => {
      if (cancelled) return;
      upsertModelDownload(ev.payload);
      if (ev.payload.stage === "done") {
        window.dispatchEvent(new CustomEvent("loors:models-changed"));
      }
    })
      .then((fn) => {
        if (cancelled) {
          fn();
        } else {
          unlisten = fn;
        }
      })
      .catch(() => {});

    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, [upsertModelDownload]);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    listen<EngineEvent>("loors://engine-event", (event) => {
      if (!cancelled) applyEngineEvent(event.payload);
    })
      .then((fn) => {
        if (cancelled) {
          fn();
        } else {
          unlisten = fn;
        }
      })
      .catch(() => {
        // Running outside Tauri (plain Vite browser preview)
      });

    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, [applyEngineEvent]);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    let clearTimer: ReturnType<typeof setTimeout> | undefined;
    listen<ModelLoadProgressEvent>("loors://model-load-progress", (event) => {
      if (cancelled) return;
      if (clearTimer) clearTimeout(clearTimer);
      const p = event.payload;
      if (p.stage === "ready" || p.stage === "unloaded") {
        setModelLoadProgress(p);
        clearTimer = setTimeout(() => {
          if (!cancelled) setModelLoadProgress(null);
        }, 1400);
      } else if (p.stage === "error") {
        setModelLoadProgress(null);
      } else {
        setModelLoadProgress(p);
      }
    })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch(() => {});

    return () => {
      cancelled = true;
      if (clearTimer) clearTimeout(clearTimer);
      if (unlisten) unlisten();
    };
  }, [setModelLoadProgress]);

  const displayEdges = useMemo(() => {
    const kindById = new Map(nodes.map((node) => [node.id, node.data.kind]));
    return edges.map((edge) => {
      const sourceKind = kindById.get(edge.source);
      const dimmed = dimResourceEdges && sourceKind && isResourceKind(sourceKind)
        && edge.sourceHandle !== "exec";
      const connected = edge.source === selectedNodeId || edge.target === selectedNodeId;
      if (!dimmed && !connected) return edge;
      return {
        ...edge,
        className: connected
          ? [edge.className, "is-connected-to-selection"].filter(Boolean).join(" ")
          : edge.className,
        style: {
          ...edge.style,
          opacity: connected ? 1 : 0.5,
          strokeWidth: connected ? 2.6 : edge.style?.strokeWidth ?? 1.7,
        },
      };
    });
  }, [edges, nodes, dimResourceEdges, selectedNodeId]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (appMode !== "harness" || !nodesInitialized || !canvas) return;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry.contentRect.width || !entry.contentRect.height) return;
      observer.disconnect();
      const savedViewport = harnessViewports.current.get(activeHarnessTabId);
      if (savedViewport) void setViewport(savedViewport);
      else void fitView({ padding: 0.18 });
    });
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [appMode, activeHarnessTabId, nodesInitialized, fitView, setViewport]);

  const handleRun = async (startNodeId?: string) => {
    setBanner(null);

    if (agentRunning) {
      const stopFirst = window.confirm(
        "El Modo Agente está respondiendo ahora mismo usando la GPU local.\n¿Detener al Agente para liberar la GPU y ejecutar este Arnés?"
      );
      if (!stopFirst) return;
      try {
        await invoke("stop_agent_turn");
      } catch {
        // ignore
      }
    }

    let graph = exportWorkflow();

    // Prevent accidentally running on "." (loors/src-tauri) — prompt user to pick a real project folder first
    const ti = graph.nodes.find((n) => n.data.kind === "task_input");
    const ws = String(ti?.data.config.workspace ?? "").trim();
    if (ti && (ws === "" || ws === ".")) {
      try {
        const picked = await invoke<string | null>("pick_folder", { initialDir: null });
        if (!picked) {
          setBanner("Elige una carpeta de proyecto antes de ejecutar.");
          return;
        }
        updateNodeConfig(ti.id, { workspace: picked });
        graph = {
          ...graph,
          nodes: graph.nodes.map((n) =>
            n.id === ti.id
              ? { ...n, data: { ...n.data, config: { ...n.data.config, workspace: picked } } }
              : n
          ),
        };
      } catch {
        // fallback if picker unavailable
      }
    }

    const issues = validateGraphBeforeRun(graph.nodes, graph.edges);
    if (issues.length > 0) {
      setBanner(`${issues[0].title}: ${issues[0].message}`);
      if (issues[0].nodeId) setSelectedNodeId(issues[0].nodeId);
      else setSelectedNodeId(null);
      setRightPanelOpen(true);
      setRightPanelTab("inspector");
      return;
    }

    try {
      const trigNode = graph.nodes.find((n) => n.data.kind === "trigger");
      if (trigNode) {
        const tType = String(trigNode.data.config.triggerType ?? "webhook");
        const port = Number(trigNode.data.config.webhookPort ?? 14290);
        const mins = Math.max(1, Number(trigNode.data.config.intervalMinutes ?? 30));
        if (tType === "telegram") {
          const botToken = String(trigNode.data.config.botToken ?? "").trim();
          const allowedChatId = String(trigNode.data.config.allowedChatId ?? "").trim();
          await invoke("start_telegram_trigger", {
            botToken,
            allowedChatId,
            graph,
            backend: selectedBackend,
          });
          setTriggerArmed(true);
          setConsoleOpen(true);
          setBanner("Bot de Telegram escuchando mensajes. Envía un mensaje a tu bot para disparar el arnés.");
          return;
        }
        if (tType === "interval") {
          await invoke("start_interval_trigger", {
            minutes: mins,
            graph,
            backend: selectedBackend,
          });
          setTriggerArmed(true);
        } else {
          await invoke("start_webhook_trigger", {
            port,
            graph,
            backend: selectedBackend,
          });
          setTriggerArmed(true);
        }
      }

      prepareRun();
      await invoke<string>("start_workflow", {
        graph,
        backend: selectedBackend,
        startNodeId: startNodeId ?? null,
        tabId: activeHarnessTabId,
      });
    } catch (err) {
      setBanner(
        typeof err === "string"
          ? err
          : "Ejecuta Loors con Tauri (`npm run tauri dev`) para lanzar el motor Rust."
      );
      applyEngineEvent({
        type: "run_finished",
        tabId: activeHarnessTabId,
        run_id: "local",
        outcome: "failed",
        total_iterations: 0,
        summary: "Backend Tauri no disponible en modo navegador.",
      });
    }
  };

  const handleStop = async (targetTabId?: string) => {
    const tid = targetTabId ?? activeHarnessTabId;
    try {
      await invoke("stop_workflow", { tabId: tid });
      await invoke("stop_interval_trigger");
      await invoke("stop_webhook_trigger");
      await invoke("stop_telegram_trigger");
      setTriggerArmed(false);
      return true;
    } catch {
      return false;
    }
  };

  const handleStopAgentFromTopbar = async () => {
    try {
      await invoke("stop_agent_turn");
    } catch {
      // ignore
    }
  };

  const handleUnloadModel = async () => {
    try {
      await invoke("unload_model");
      setBanner("Modelo descargado de VRAM.");
    } catch {
      // ignore
    }
  };

  const handleCanvasDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    const droppedKind = e.dataTransfer.getData("application/loors-node-kind") as LoorsNodeKind;
    if (droppedKind && NODE_BLUEPRINTS[droppedKind]) {
      const flowPos = screenToFlowPosition({ x: e.clientX, y: e.clientY });
      addNode(droppedKind, flowPos);
      return;
    }

    const file = e.dataTransfer.files?.[0];
    if (!file) return;
    if (!file.name.endsWith(".json")) {
      setBanner("Arrastra un archivo .loors.json válido.");
      return;
    }
    try {
      const parsed = parseWorkflowJson(await file.text());
      importWorkflow(parsed);
      setBanner(`Arnés importado: ${parsed.name}`);
    } catch (err) {
      setBanner(err instanceof Error ? err.message : "JSON de arnés inválido.");
    }
  };

  const handlePaneDoubleClick = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    if (!target.classList.contains("react-flow__pane")) return;
    const flowPos = screenToFlowPosition({ x: e.clientX, y: e.clientY });
    setQuickAdd({
      screenX: e.clientX,
      screenY: e.clientY,
      flowPos,
      query: "",
    });
  };

  const isRunning = runStatus === "running";

  const [justSaved, setJustSaved] = useState(false);

  const getHarnessSnapshot = (tabId: string) => {
    const state = useGraphStore.getState();
    return tabId === state.activeHarnessTabId
      ? state
      : state.harnessTabs.find((tab) => tab.id === tabId);
  };

  const saveHarness = (tabId: string, fromArchitect = false) => {
    const revision = (snapshot: NonNullable<ReturnType<typeof getHarnessSnapshot>>) =>
      workflowRevision({ schemaVersion: 1, name: snapshot.workflowName, nodes: snapshot.nodes, edges: snapshot.edges });
    const applied = fromArchitect ? getHarnessSnapshot(tabId) : null;
    const save = saveQueue.current.then(async () => {
      const snapshot = getHarnessSnapshot(tabId);
      if (!snapshot) return false;
      if (applied && (revision(snapshot) !== revision(applied)
        || snapshot.savedLibraryName !== applied.savedLibraryName)) return false;
      const linkedName = snapshot.savedLibraryName;
      const workflowName = snapshot.workflowName.trim() || linkedName || "harness";
      const name = linkedName || workflowName;
      const path = await invoke<string>("save_workflow_to_library", {
        name,
        createOnly: !linkedName,
        content: JSON.stringify({
          schemaVersion: 1,
          name: workflowName,
          exportedAt: new Date().toISOString(),
          nodes: snapshot.nodes,
          edges: snapshot.edges,
        }, null, 2),
      });
      const current = getHarnessSnapshot(tabId);
      if (!current) return false;
      const unchanged = current.savedLibraryName === linkedName && (fromArchitect
        ? revision(current) === revision(snapshot)
        : current.nodes === snapshot.nodes && current.edges === snapshot.edges
          && current.workflowName === snapshot.workflowName);
      if (!unchanged) return false;
      const state = useGraphStore.getState();
      if (state.activeHarnessTabId === tabId) {
        state.markSaved(name);
      } else {
        useGraphStore.setState({
          harnessTabs: state.harnessTabs.map((tab) =>
            tab.id === tabId ? { ...tab, savedLibraryName: name, dirty: false } : tab
          ),
        });
      }
      return { name, path };
    });
    saveQueue.current = save.then(() => {}, () => {});
    return save;
  };

  const saveFailure = (error: unknown) =>
    typeof error === "string" ? error : error instanceof Error ? error.message
      : locale === "es" ? "No se pudo guardar el arnés." : "Could not save the harness.";

  const handleSaveWorkflow = async (silent = false) => {
    const tabId = activeHarnessTabId;
    try {
      const saved = await saveHarness(tabId);
      if (saved && !silent) {
        const { name } = saved;
        setJustSaved(true);
        window.setTimeout(() => setJustSaved(false), 1600);
        setBanner(locale === "es" ? `Guardado: ${name}` : `Saved: ${name}`);
      }
    } catch (error) {
      setBanner(saveFailure(error));
    }
  };

  const dismissHarnessClose = () => {
    setPendingHarnessClose(null);
    setCloseError(null);
  };

  const finishHarnessClose = async (tabId: string, save: boolean, discard = false) => {
    if (closeInProgress.current) return;
    closeInProgress.current = true;
    setClosingHarnessId(tabId);
    setCloseError(null);
    try {
      if (save && !(await saveHarness(tabId))) {
        throw new Error(locale === "es"
          ? "El arnés cambió mientras se guardaba. Vuelve a guardar antes de cerrar."
          : "The harness changed during saving. Save again before closing.");
      }
      if (getHarnessSnapshot(tabId)?.runStatus === "running" && !(await handleStop(tabId))) {
        throw new Error(locale === "es" ? "No se pudo detener la ejecución." : "Could not stop the run.");
      }
      if (!discard && getHarnessSnapshot(tabId)?.dirty) {
        throw new Error(locale === "es" ? "Hay cambios sin guardar." : "There are unsaved changes.");
      }
      closeHarnessTab(tabId);
      harnessViewports.current.delete(tabId);
      dismissHarnessClose();
    } catch (error) {
      setPendingHarnessClose(tabId);
      setCloseError(saveFailure(error));
    } finally {
      closeInProgress.current = false;
      setClosingHarnessId(null);
    }
  };

  const requestHarnessClose = (tabId: string) => {
    const tab = getHarnessSnapshot(tabId);
    if (!tab || closeInProgress.current) return;
    if (!tab.dirty || (autoSaveHarnesses && tab.savedLibraryName)) {
      void finishHarnessClose(tabId, tab.dirty);
    } else {
      setPendingHarnessClose(tabId);
    }
  };

  // Auto-save active library harness after 1.5s of inactivity when enabled in Settings
  useEffect(() => {
    if (!autoSaveHarnesses || !dirty || !savedLibraryName) return;
    const id = window.setTimeout(() => {
      void handleSaveWorkflow(true);
    }, 1500);
    return () => window.clearTimeout(id);
  }, [activeHarnessTabId, autoSaveHarnesses, dirty, savedLibraryName, nodes, edges, workflowName]);

  // Ctrl+S / Cmd+S shortcut in Harness mode
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (document.querySelector("dialog.loors-dialog[open]")) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s" && appMode === "harness") {
        e.preventDefault();
        void handleSaveWorkflow(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeHarnessTabId, appMode, locale]);

  const runningHarnessCount = harnessTabs.filter(
    (tab) => (tab.id === activeHarnessTabId ? runStatus : tab.runStatus) === "running"
  ).length;
  const anyHarnessRunning = runningHarnessCount > 0;

  return (
    <div className="loors-shell">
      <header className="loors-topbar">
        <div className="topbar-left">
          <div className="brand">
            <RefreshCw
              size={17}
              className={`brand-icon ${anyHarnessRunning || agentRunning ? "spin" : ""}`}
            />
            <span>Loors</span>
          </div>

          <div className="mode-switcher" role="tablist" aria-label="Modo de trabajo">
            <button
              type="button"
              role="tab"
              aria-selected={appMode === "agent"}
              className={`mode-switch-btn ${appMode === "agent" ? "active" : ""}`}
              title="Modo Agente autónomo (Ctrl+1)"
              onClick={() => setAppMode("agent")}
            >
              <MessageSquare size={13} />
              <span>{t("nav.agent")}</span>
              {agentRunning && <span className="mode-live-dot" />}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={appMode === "harness"}
              className={`mode-switch-btn ${appMode === "harness" ? "active" : ""}`}
              title="Harnesses (Ctrl+2)"
              onClick={() => setAppMode("harness")}
            >
              <Workflow size={13} />
              <span>{t("nav.harnesses")}</span>
              {anyHarnessRunning && <span className="mode-live-dot amber" />}
            </button>
          </div>

          {appMode === "harness" && (
            <>
              <button
                type="button"
                className="icon-btn"
                title={t("nav.new")}
                aria-label={t("nav.new")}
                onClick={() => {
                  newWorkflow();
                  setRightPanelTab("inspector");
                }}
              >
                <Plus size={15} />
              </button>
              <button
                type="button"
                className="icon-btn"
                title={t("nav.library")}
                aria-label={t("nav.library")}
                onClick={() => setIoOpen(true)}
              >
                <FolderOpen size={15} />
              </button>
              <button
                type="button"
                className="icon-btn"
                style={{ position: "relative" }}
                title={
                  justSaved
                    ? locale === "es"
                      ? "¡Guardado!"
                      : "Saved!"
                    : locale === "es"
                      ? "Guardar arnés (Ctrl+S)"
                      : "Save harness (Ctrl+S)"
                }
                aria-label={locale === "es" ? "Guardar arnés" : "Save harness"}
                onClick={() => void handleSaveWorkflow(false)}
              >
                {justSaved ? (
                  <Check size={14} style={{ color: "#34d399" }} />
                ) : (
                  <Save size={14} />
                )}
                {dirty && !justSaved && (
                  <span
                    style={{
                      position: "absolute",
                      top: 3,
                      right: 3,
                      width: 6,
                      height: 6,
                      borderRadius: 999,
                      background: "#a78bfa",
                    }}
                  />
                )}
              </button>
              <input
                className="workflow-name"
                value={workflowName}
                onChange={(e) => setWorkflowName(e.target.value)}
                aria-label="Harness name"
              />
            </>
          )}

          {appMode === "agent" && anyHarnessRunning && (
            <div className="bg-run-pill is-harness">
              <span className="live-pulse" />
              <span>
                {locale === "es"
                  ? runningHarnessCount > 1
                    ? `${runningHarnessCount} arneses ejecutándose`
                    : "Arnés ejecutándose"
                  : runningHarnessCount > 1
                    ? `${runningHarnessCount} harnesses running`
                    : "Harness running"}
              </span>
              <button
                type="button"
                className="bg-pill-link"
                onClick={() => setAppMode("harness")}
              >
                {locale === "es" ? "Ver" : "View"}
              </button>
              <button
                type="button"
                className="vram-unload"
                title={locale === "es" ? "Detener todos los arneses" : "Stop all harnesses"}
                onClick={() => void invoke("stop_workflow", { tabId: null }).catch(() => {})}
              >
                <Square size={11} />
              </button>
            </div>
          )}

          {appMode === "harness" && agentRunning && (
            <div className="bg-run-pill is-agent">
              <span className="live-pulse" />
              <span className="truncate-text" style={{ maxWidth: 160 }}>
                Agente: {agentActiveTitle || "respondiendo"}
              </span>
              <button
                type="button"
                className="bg-pill-link"
                onClick={() => setAppMode("agent")}
              >
                Ver
              </button>
              <button
                type="button"
                className="vram-unload"
                title="Detener agente"
                onClick={() => void handleStopAgentFromTopbar()}
              >
                <Square size={11} />
              </button>
            </div>
          )}
        </div>

        <div className="topbar-tools">
          {banner && (
            <span className="topbar-banner" title={banner}>
              {banner}
            </span>
          )}
          {modelLoadProgress &&
          (modelLoadProgress.stage === "unloading" ||
            modelLoadProgress.stage === "starting" ||
            modelLoadProgress.stage === "loading") ? (
            <div
              className="model-vram-pill is-loading-model"
              title={modelLoadProgress.message}
            >
              <RefreshCw size={12} className="spin" style={{ color: "#38bdf8", flexShrink: 0 }} />
              <div className="topbar-load-col">
                <div className="topbar-load-row">
                  <span className="model-vram-name truncate-text" style={{ maxWidth: 160 }}>
                    {modelLoadProgress.stage === "unloading"
                      ? locale === "es"
                        ? `Liberando ${parseGgufMetadata(modelLoadProgress.model_name).baseName}…`
                        : `Unloading ${parseGgufMetadata(modelLoadProgress.model_name).baseName}…`
                      : locale === "es"
                        ? `Cargando ${parseGgufMetadata(modelLoadProgress.model_name).baseName}`
                        : `Loading ${parseGgufMetadata(modelLoadProgress.model_name).baseName}`}
                  </span>
                  {modelLoadProgress.percent != null && (
                    <span className="topbar-load-pct tabular-nums">
                      {modelLoadProgress.percent}%
                    </span>
                  )}
                </div>
                <div className="topbar-load-track">
                  <div
                    className="topbar-load-fill"
                    style={{ width: `${Math.max(4, modelLoadProgress.percent ?? 10)}%` }}
                  />
                </div>
              </div>
            </div>
          ) : loadedModelName ? (
            (() => {
              const meta = parseGgufMetadata(loadedModelName);
              return (
                <div
                  className="model-vram-pill"
                  title={`Cargado en VRAM: ${loadedModelName} (${loadedContextSize ?? ""} ctx · ${activeRuntimeLabel})`}
                >
                  <span className="live-pulse" />
                  <span className="model-vram-name">{meta.baseName}</span>
                  <span className="runtime-mini-tag">{activeRuntimeLabel}</span>
                  <button
                    type="button"
                    className="vram-unload"
                    title="Descargar modelo de VRAM"
                    onClick={handleUnloadModel}
                  >
                    <X size={12} />
                  </button>
                </div>
              );
            })()
          ) : null}
          <button
            type="button"
            className="topbar-icon-btn"
            aria-label={leftPanelOpen ? "Hide left panel" : "Show left panel"}
            title={leftPanelOpen ? "Hide left panel (Ctrl+B)" : "Show left panel (Ctrl+B)"}
            onClick={() => setLeftPanelOpen(!leftPanelOpen)}
          >
            {leftPanelOpen ? <PanelLeftClose size={15} /> : <PanelLeftOpen size={15} />}
          </button>
          <button
            type="button"
            className="topbar-icon-btn"
            aria-label={rightPanelOpen ? "Hide right panel" : "Show right panel"}
            title={rightPanelOpen ? "Hide right panel (Ctrl+Shift+B)" : "Show right panel (Ctrl+Shift+B)"}
            onClick={() => setRightPanelOpen(!rightPanelOpen)}
          >
            {rightPanelOpen ? <PanelRightClose size={15} /> : <PanelRightOpen size={15} />}
          </button>
          <button
            type="button"
            className="topbar-icon-btn settings-gear-btn"
            aria-label={locale === "es" ? "Configuración" : "Settings"}
            title={
              updateInfo?.updateAvailable
                ? `${locale === "es" ? "Configuración" : "Settings"} · v${updateInfo.latestVersion}`
                : locale === "es"
                  ? "Configuración (Idioma, Modelos, APIs, Runtime, Actualizaciones)"
                  : "Settings (Language, Models, APIs, Runtime, Updates)"
            }
            onClick={() => {
              setSettingsTab(updateInfo?.updateAvailable ? "updates" : "general");
              setSettingsOpen(true);
            }}
          >
            <Settings size={16} />
            {updateInfo?.updateAvailable && <span className="settings-update-dot" />}
          </button>
        </div>

        {appMode === "harness" && (
          <div className="topbar-run">
            {isRunning || triggerArmed ? (
              <button type="button" className="btn-danger" onClick={() => void handleStop()}>
                <Square size={14} />
                <span>{t("nav.stop")}</span>
              </button>
            ) : (
              <button type="button" className="btn-primary" onClick={() => handleRun()}>
                <Play size={14} />
                <span>{t("nav.run")}</span>
              </button>
            )}
          </div>
        )}
      </header>

      <div
        className="agent-mode-shell"
        style={{ display: appMode === "agent" ? "flex" : "none" }}
      >
        <AgentWorkspaceView />
      </div>

      <div
        className="loors-workspace"
        style={{
          display: appMode === "harness" ? "grid" : "none",
          gridTemplateColumns: [
            paletteHidden ? null : `minmax(0, min(${harnessLeftWidth}px, 28vw))`,
            paletteHidden ? null : "4px",
            "minmax(0, 1fr)",
            rightPanelCollapsed ? null : "4px",
            rightPanelCollapsed ? null : inspectorExpanded ? "min(680px, 62%)" : `minmax(0, min(${harnessRightWidth}px, 45vw))`,
          ]
            .filter(Boolean)
            .join(" "),
        }}
      >
        <Sidebar collapsed={paletteHidden} />
        {!paletteHidden && (
          <PanelResizer
            label={locale === "es" ? "Ajustar panel izquierdo" : "Resize left panel"}
            side="left"
            width={harnessLeftWidth}
            min={190}
            max={440}
            defaultWidth={256}
            storageKey="loors_harness_left_w"
            onResize={setHarnessLeftWidth}
          />
        )}

        <div className="loors-center">
          <div className="harness-tabbar" role="tablist" aria-label="Harness tabs">
            <div className="harness-tabs-scroll">
              {harnessTabs.map((tab) => {
                const isActive = tab.id === activeHarnessTabId;
                const status = isActive ? runStatus : tab.runStatus;
                const title = isActive ? workflowName : tab.workflowName;
                const hasGate = Boolean(isActive ? pendingGate : tab.pendingGate);
                return (
                  <div
                    key={tab.id}
                    role="tab"
                    aria-selected={isActive}
                    className={`harness-tab ${isActive ? "active" : ""} ${status === "running" ? "is-running" : ""}`}
                    title={title}
                    onClick={() => {
                      if (!isActive) {
                        switchHarnessTab(tab.id);
                      }
                    }}
                  >
                    <span
                      className={`harness-tab-dot ${
                        hasGate
                          ? "gate"
                          : status === "running"
                            ? "running"
                            : status === "completed"
                              ? "done"
                              : status === "failed"
                                ? "failed"
                                : ""
                      }`}
                    />
                    <span className="harness-tab-title truncate-text">
                      {title || "harness"}
                    </span>
                    {harnessTabs.length > 1 && (
                      <button
                        type="button"
                        className="harness-tab-close"
                        disabled={closingHarnessId === tab.id}
                        title={locale === "es" ? "Cerrar pestaña" : "Close tab"}
                        onClick={(e) => {
                          e.stopPropagation();
                          requestHarnessClose(tab.id);
                        }}
                      >
                        <X size={11} />
                      </button>
                    )}
                  </div>
                );
              })}
              <button
                type="button"
                className="harness-tab-add"
                title={locale === "es" ? "Nueva pestaña de arnés" : "New harness tab"}
                onClick={() => {
                  createHarnessTab();
                  setRightPanelTab("inspector");
                }}
              >
                <Plus size={13} />
              </button>
            </div>
          </div>

          <main
            ref={canvasRef}
            className="loors-canvas"
            onDragOver={(e) => e.preventDefault()}
            onDrop={handleCanvasDrop}
            onDoubleClick={handlePaneDoubleClick}
          >
            <ReactFlow
              nodes={nodes}
              edges={displayEdges}
              nodeTypes={nodeTypes}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              isValidConnection={(connection) =>
                arePortsCompatible(connection.sourceHandle ?? null, connection.targetHandle ?? null)
              }
              onConnectEnd={(_, connection) => {
                if (connection.isValid || !connection.fromHandle || !connection.toHandle) return;
                if (!arePortsCompatible(connection.fromHandle.id, connection.toHandle.id)) {
                  setBanner(locale === "es"
                    ? "Los puertos de recursos deben ser del mismo tipo."
                    : "Resource ports must have the same type.");
                }
              }}
              onNodeClick={(_, node) => {
                setSelectedNodeId(node.id);
                setRightPanelTab("inspector");
                setQuickAdd(null);
              }}
              onPaneClick={() => {
                setSelectedNodeId(null);
                setQuickAdd(null);
              }}
              deleteKeyCode={["Backspace", "Delete"]}
              onMoveEnd={(_, viewport) => {
                if (appMode === "harness" && canvasRef.current?.clientWidth) {
                  harnessViewports.current.set(activeHarnessTabId, viewport);
                }
              }}
              minZoom={0.2}
              colorMode="dark"
            >
              <Background gap={22} size={1} color="#222228" />
              <Controls />
              {!consoleOpen && (
                <MiniMap
                  nodeColor="#7c3aed"
                  maskColor="rgba(9, 9, 11, 0.8)"
                />
              )}
              <Panel position="top-left" className="canvas-hud">
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => {
                    autoLayout();
                    setTimeout(() => fitView({ padding: 0.16, duration: 250 }), 30);
                  }}
                >
                  <LayoutGrid size={13} />
                  <span>{t("canvas.arrange")}</span>
                </button>
                <button
                  type="button"
                  className={`btn-secondary ${dimResourceEdges ? "btn-active" : ""}`}
                  onClick={() => setDimResourceEdges(!dimResourceEdges)}
                >
                  {dimResourceEdges ? <EyeOff size={13} /> : <Eye size={13} />}
                  <span>{t("canvas.wires")}</span>
                </button>
              </Panel>
            </ReactFlow>

            {quickAdd && (
              <div
                className="quick-add-menu"
                style={{
                  left: Math.min(
                    Math.max(16, quickAdd.screenX - (sidebarCollapsed ? 24 : 268)),
                    window.innerWidth - 580
                  ),
                  top: Math.min(quickAdd.screenY - 52, window.innerHeight - 360),
                }}
              >
                <input
                  type="text"
                  autoFocus
                  placeholder="Añadir nodo aquí…"
                  value={quickAdd.query}
                  onChange={(e) =>
                    setQuickAdd({ ...quickAdd, query: e.target.value })
                  }
                  onKeyDown={(e) => {
                    if (e.key === "Escape") setQuickAdd(null);
                  }}
                />
                <div className="quick-add-list">
                  {(Object.keys(NODE_BLUEPRINTS) as LoorsNodeKind[])
                    .filter((k) => k !== "custom")
                    .filter((k) => {
                      const q = quickAdd.query.trim().toLowerCase();
                      if (!q) return true;
                      const bp = NODE_BLUEPRINTS[k];
                      return (
                        bp.label.toLowerCase().includes(q) ||
                        bp.description.toLowerCase().includes(q)
                      );
                    })
                    .slice(0, 8)
                    .map((k) => {
                      const bp = NODE_BLUEPRINTS[k];
                      return (
                        <button
                          key={k}
                          type="button"
                          className="quick-add-item"
                          onClick={() => {
                            addNode(k, quickAdd.flowPos);
                            setQuickAdd(null);
                          }}
                        >
                          <span
                            className="loors-node-dot"
                            style={{ background: bp.accent }}
                          />
                          <span>{bp.label}</span>
                        </button>
                      );
                    })}
                </div>
              </div>
            )}
          </main>

          <ConsolePanel />
        </div>

        {!rightPanelCollapsed && (
          !inspectorExpanded ? <PanelResizer
            label={locale === "es" ? "Ajustar panel derecho" : "Resize right panel"}
            side="right"
            width={harnessRightWidth}
            min={280}
            max={640}
            defaultWidth={360}
            storageKey="loors_harness_right_w"
            onResize={setHarnessRightWidth}
          /> : <div />
        )}

        <aside
          className={`loors-right-panel ${inspectorExpanded ? "is-wide-inspector" : ""}`}
          style={{ display: rightPanelCollapsed ? "none" : "flex" }}
        >
          <div className="right-panel-heading">
          <div className="right-panel-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={rightPanelTab === "inspector"}
              className={`right-panel-tab ${rightPanelTab === "inspector" ? "active" : ""}`}
              onClick={() => setRightPanelTab("inspector")}
            >
              <Sliders size={13} />
              <span>{t("canvas.inspector")}</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={rightPanelTab === "architect"}
              className={`right-panel-tab ${rightPanelTab === "architect" ? "active" : ""}`}
              onClick={() => setRightPanelTab("architect")}
            >
              <Sparkles size={13} style={{ color: "#a855f7" }} />
              <span>{t("canvas.architect")}</span>
            </button>
          </div>

            {rightPanelTab === "inspector" && (
              <button
                type="button"
                className="icon-btn inspector-width-toggle"
                aria-pressed={inspectorExpanded}
                aria-label={locale === "es" ? "Vista amplia del Inspector" : "Wide Inspector"}
                title={locale === "es" ? "Vista amplia del Inspector" : "Wide Inspector"}
                onClick={() => setWideInspector((wide) => !wide)}
              >
                {inspectorExpanded ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
              </button>
            )}
          </div>

          <div
            className="right-panel-pane"
            style={{ display: rightPanelTab === "inspector" ? "flex" : "none" }}
          >
            <Inspector onRun={() => void handleRun()} onShowConsole={() => setConsoleOpen(true)} onStartHarness={() => {
              createHarnessTab();
              const state = useGraphStore.getState();
              state.setSelectedNodeId(state.nodes.find((node) => node.data.kind === "task_input")?.id ?? null);
            }} />
          </div>
          <div
            className="right-panel-pane"
            style={{ display: rightPanelTab === "architect" ? "flex" : "none" }}
          >
            <ArchitectChat
              open={true}
              onApplyGraph={(wf, opts) => {
                const state = useGraphStore.getState();
                const { activeHarnessTabId: tabId, savedLibraryName } = state;
                const restore = opts.restore;
                const libraryName = restore ? restore.libraryName : opts.isPatch ? savedLibraryName : null;
                const shouldSave = !restore || (opts.isPatch && Boolean(libraryName));
                importWorkflow(wf, libraryName, {
                  preserveModels: true,
                  preserveSelection: opts.isPatch || Boolean(restore),
                  dirty: shouldSave || Boolean(restore?.dirty),
                });
                if (!opts.isPatch && !restore) {
                  autoLayout();
                  setRightPanelTab("inspector");
                  setTimeout(() => {
                    if (useGraphStore.getState().activeHarnessTabId === tabId) {
                      fitView({ padding: 0.16, duration: 250 });
                    }
                  }, 30);
                }
                const applied = opts.summary || (locale === "es" ? `Arnés aplicado: ${wf.name}` : `Harness applied: ${wf.name}`);
                setBanner(applied);
                if (shouldSave) {
                  void saveHarness(tabId, true).then((saved) => {
                    if (saved && useGraphStore.getState().activeHarnessTabId === tabId) {
                      setBanner(locale === "es" ? `Guardado: ${saved.name}` : `Saved: ${saved.name}`);
                    }
                  }).catch((error) => setBanner(saveFailure(error)));
                }
              }}
            />
          </div>
        </aside>
      </div>

      <SettingsModal
        open={settingsOpen}
        initialTab={settingsTab}
        updateInfo={updateInfo}
        onUpdateChecked={setUpdateInfo}
        onClose={() => setSettingsOpen(false)}
        onNotice={(msg) => setBanner(msg)}
      />
      <WorkflowIoModal
        open={ioOpen}
        onSave={() => saveHarness(activeHarnessTabId)}
        onClose={() => setIoOpen(false)}
        onNotice={(msg) => setBanner(msg)}
      />
      {pendingHarnessClose && (
        <ModalBackdrop
          label={locale === "es" ? "Cerrar arnés" : "Close harness"}
          onClose={closingHarnessId ? undefined : dismissHarnessClose}
        >
          <div className="modal-card">
            <div className="modal-header">
              <strong>{locale === "es" ? "Cambios sin guardar" : "Unsaved changes"}</strong>
            </div>
            <div className="modal-body">
              <p>{getHarnessSnapshot(pendingHarnessClose)?.workflowName}</p>
              {closeError && <p role="alert">{closeError}</p>}
            </div>
            <div className="modal-footer harness-close-actions">
              <button type="button" className="btn-secondary" disabled={!!closingHarnessId} onClick={dismissHarnessClose}>
                {locale === "es" ? "Cancelar" : "Cancel"}
              </button>
              <button type="button" className="btn-secondary" disabled={!!closingHarnessId} onClick={() => void finishHarnessClose(pendingHarnessClose, false, true)}>
                {locale === "es" ? "Descartar" : "Discard"}
              </button>
              <button type="button" className="btn-primary" disabled={!!closingHarnessId} onClick={() => void finishHarnessClose(pendingHarnessClose, true)}>
                {closingHarnessId
                  ? locale === "es" ? "Guardando…" : "Saving…"
                  : locale === "es" ? "Guardar" : "Save"}
              </button>
            </div>
          </div>
        </ModalBackdrop>
      )}
      <ModelTuningModal />
      <HumanGateModal />
      <DownloadsDock onNotice={(msg) => setBanner(msg)} />
      {webAuthRequired && (
        <WebAuthGate
          onAuthenticated={() => {
            setWebAuthRequired(false);
            window.location.reload();
          }}
        />
      )}
    </div>
  );
}

export function App() {
  return (
    <ReactFlowProvider>
      <LoorsStudioInner />
    </ReactFlowProvider>
  );
}
export default App;
