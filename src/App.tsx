import { useEffect, useMemo, useState } from "react";
import {
  Background,
  Controls,
  MiniMap,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type NodeTypes,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { checkHeadlessHealth, invoke, listen } from "./lib/bridge";
import { WebAuthGate } from "./components/WebAuthGate";
import {
  Eye,
  EyeOff,
  FolderOpen,
  LayoutGrid,
  MessageSquare,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Play,
  Plus,
  RefreshCw,
  Settings,
  Sliders,
  Sparkles,
  Square,
  Workflow,
  X,
} from "lucide-react";
import { LoopyNode } from "./components/nodes/LoopyNode";
import { Sidebar } from "./components/Sidebar";
import { Inspector } from "./components/Inspector";
import { ConsolePanel } from "./components/ConsolePanel";
import { HumanGateModal } from "./components/HumanGateModal";
import { WorkflowIoModal } from "./components/WorkflowIoModal";
import { SettingsModal, type SettingsTab } from "./components/SettingsModal";
import { type UpdateCheckResult } from "./components/UpdateModal";
import { ArchitectChat } from "./components/ArchitectChat";
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
  type EngineEvent,
  type LoopyNodeKind,
  type ModelLoadProgressEvent,
  type RuntimeStatusSnapshot,
} from "./types/graph";

const nodeTypes: NodeTypes = {
  loopyNode: LoopyNode,
};

function LoopyStudioInner() {
  const { locale, t } = useI18n();
  const { screenToFlowPosition, fitView } = useReactFlow();
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
  const setSelectedNodeId = useGraphStore((s) => s.setSelectedNodeId);
  const exportWorkflow = useGraphStore((s) => s.exportWorkflow);
  const importWorkflow = useGraphStore((s) => s.importWorkflow);
  const selectedBackend = useGraphStore((s) => s.selectedBackend);
  const runStatus = useGraphStore((s) => s.runStatus);
  const loadedModelName = useGraphStore((s) => s.loadedModelName);
  const loadedContextSize = useGraphStore((s) => s.loadedContextSize);
  const modelLoadProgress = useGraphStore((s) => s.modelLoadProgress);
  const setModelLoadProgress = useGraphStore((s) => s.setModelLoadProgress);
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
    window.addEventListener("loopy:auth-required", onAuthRequired);
    return () => window.removeEventListener("loopy:auth-required", onAuthRequired);
  }, []);
  const leftPanelOpen = useGraphStore((s) => s.leftPanelOpen);
  const setLeftPanelOpen = useGraphStore((s) => s.setLeftPanelOpen);
  const rightPanelOpen = useGraphStore((s) => s.rightPanelOpen);
  const setRightPanelOpen = useGraphStore((s) => s.setRightPanelOpen);
  const sidebarCollapsed = !leftPanelOpen;
  const rightPanelCollapsed = !rightPanelOpen;
  const [harnessLeftWidth, setHarnessLeftWidth] = useState<number>(() => {
    const saved = Number(localStorage.getItem("loopy_harness_left_w"));
    return Number.isFinite(saved) && saved >= 190 && saved <= 440 ? saved : 256;
  });
  const [harnessRightWidth, setHarnessRightWidth] = useState<number>(() => {
    const saved = Number(localStorage.getItem("loopy_harness_right_w"));
    return Number.isFinite(saved) && saved >= 280 && saved <= 640 ? saved : 360;
  });

  const startHarnessResize = (side: "left" | "right", startX: number) => {
    const initial = side === "left" ? harnessLeftWidth : harnessRightWidth;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    const onMove = (ev: MouseEvent) => {
      const dx = ev.clientX - startX;
      if (side === "left") {
        const next = Math.min(440, Math.max(190, initial + dx));
        setHarnessLeftWidth(next);
        localStorage.setItem("loopy_harness_left_w", String(next));
      } else {
        const next = Math.min(640, Math.max(280, initial - dx));
        setHarnessRightWidth(next);
        localStorage.setItem("loopy_harness_right_w", String(next));
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
  const [banner, setBanner] = useState<string | null>(null);
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
    window.addEventListener("loopy:open-models-modal", onOpenModels);
    window.addEventListener("loopy:open-runtime-modal", onOpenRuntime);
    window.addEventListener("loopy:run-workflow", onRunWorkflow);
    return () => {
      window.removeEventListener("loopy:open-models-modal", onOpenModels);
      window.removeEventListener("loopy:open-runtime-modal", onOpenRuntime);
      window.removeEventListener("loopy:run-workflow", onRunWorkflow);
    };
  });

  // Re-fit canvas cleanly whenever Harness Studio becomes visible or its viewport resizes
  useEffect(() => {
    if (appMode !== "harness") return;
    const t = window.setTimeout(() => {
      fitView({ padding: 0.18, duration: 220 });
    }, 140);
    return () => window.clearTimeout(t);
  }, [appMode, consoleOpen, sidebarCollapsed, rightPanelCollapsed, fitView]);

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
    listen<EngineEvent>("loopy://engine-event", (event) => {
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
    listen<ModelLoadProgressEvent>("loopy://model-load-progress", (event) => {
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
    if (!dimResourceEdges) return edges;
    const kindById = new Map(nodes.map((n) => [n.id, n.data.kind]));
    return edges.map((edge) => {
      const srcKind = kindById.get(edge.source);
      const isResourceWire =
        Boolean(srcKind && isResourceKind(srcKind)) &&
        edge.sourceHandle !== "exec";
      if (!isResourceWire) return edge;
      const connectedToSelected =
        selectedNodeId != null &&
        (edge.source === selectedNodeId || edge.target === selectedNodeId);
      return {
        ...edge,
        style: {
          ...(edge.style ?? {}),
          opacity: connectedToSelected ? 1 : 0.22,
          strokeWidth: connectedToSelected ? 2.2 : 1.3,
        },
      };
    });
  }, [edges, nodes, dimResourceEdges, selectedNodeId]);

  // Auto-center the React Flow canvas whenever switching to Harnesses mode
  useEffect(() => {
    if (appMode !== "harness") return;
    const id = window.setTimeout(() => {
      fitView({ padding: 0.18, duration: 200 });
    }, 60);
    return () => window.clearTimeout(id);
  }, [appMode, fitView]);

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

    // Prevent accidentally running on "." (loopy/src-tauri) — prompt user to pick a real project folder first
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
      });
    } catch (err) {
      setBanner(
        typeof err === "string"
          ? err
          : "Ejecuta Loopy con Tauri (`npm run tauri dev`) para lanzar el motor Rust."
      );
      applyEngineEvent({
        type: "run_finished",
        run_id: "local",
        outcome: "failed",
        total_iterations: 0,
        summary: "Backend Tauri no disponible en modo navegador.",
      });
    }
  };

  const handleStop = async () => {
    try {
      await invoke("stop_workflow");
      await invoke("stop_interval_trigger");
      await invoke("stop_webhook_trigger");
      await invoke("stop_telegram_trigger");
      setTriggerArmed(false);
    } catch {
      // ignore if outside Tauri
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
    const droppedKind = e.dataTransfer.getData("application/loopy-node-kind") as LoopyNodeKind;
    if (droppedKind && NODE_BLUEPRINTS[droppedKind]) {
      const flowPos = screenToFlowPosition({ x: e.clientX, y: e.clientY });
      addNode(droppedKind, flowPos);
      return;
    }

    const file = e.dataTransfer.files?.[0];
    if (!file) return;
    if (!file.name.endsWith(".json")) {
      setBanner("Arrastra un archivo .loopy.json válido.");
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

  return (
    <div className="loopy-shell">
      <header className="loopy-topbar">
        <div className="topbar-left">
          <div className="brand">
            <RefreshCw
              size={17}
              className={`brand-icon ${isRunning || agentRunning ? "spin" : ""}`}
            />
            <span>Loopy</span>
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
              {isRunning && <span className="mode-live-dot amber" />}
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
                  setTimeout(() => fitView({ padding: 0.18, duration: 220 }), 50);
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
              <input
                className="workflow-name"
                value={workflowName}
                onChange={(e) => setWorkflowName(e.target.value)}
                aria-label="Harness name"
              />
            </>
          )}

          {appMode === "agent" && isRunning && (
            <div className="bg-run-pill is-harness">
              <span className="live-pulse" />
              <span>Arnés ejecutándose</span>
              <button
                type="button"
                className="bg-pill-link"
                onClick={() => setAppMode("harness")}
              >
                Ver
              </button>
              <button
                type="button"
                className="vram-unload"
                title="Detener arnés"
                onClick={handleStop}
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
              <button type="button" className="btn-danger" onClick={handleStop}>
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
        className="loopy-workspace"
        style={{
          display: appMode === "harness" ? "grid" : "none",
          gridTemplateColumns: [
            sidebarCollapsed ? null : `${harnessLeftWidth}px`,
            sidebarCollapsed ? null : "4px",
            "1fr",
            rightPanelCollapsed ? null : "4px",
            rightPanelCollapsed ? null : `${harnessRightWidth}px`,
          ]
            .filter(Boolean)
            .join(" "),
        }}
      >
        <Sidebar collapsed={sidebarCollapsed} />
        {!sidebarCollapsed && (
          <div
            className="panel-resizer"
            role="separator"
            aria-orientation="vertical"
            title="Drag to resize (double-click to reset)"
            onMouseDown={(e) => {
              e.preventDefault();
              startHarnessResize("left", e.clientX);
            }}
            onDoubleClick={() => {
              setHarnessLeftWidth(256);
              localStorage.setItem("loopy_harness_left_w", "256");
            }}
          />
        )}

        <div className="loopy-center">
          <main
            className="loopy-canvas"
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
              fitView
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
                  {(Object.keys(NODE_BLUEPRINTS) as LoopyNodeKind[])
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
                            className="loopy-node-dot"
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
          <div
            className="panel-resizer"
            role="separator"
            aria-orientation="vertical"
            title="Drag to resize (double-click to reset)"
            onMouseDown={(e) => {
              e.preventDefault();
              startHarnessResize("right", e.clientX);
            }}
            onDoubleClick={() => {
              setHarnessRightWidth(360);
              localStorage.setItem("loopy_harness_right_w", "360");
            }}
          />
        )}

        <aside
          className="loopy-right-panel"
          style={{ display: rightPanelCollapsed ? "none" : "flex" }}
        >
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

          <div
            className="right-panel-pane"
            style={{ display: rightPanelTab === "inspector" ? "flex" : "none" }}
          >
            <Inspector />
          </div>
          <div
            className="right-panel-pane"
            style={{ display: rightPanelTab === "architect" ? "flex" : "none" }}
          >
            <ArchitectChat
              open={true}
              onApplyGraph={(wf) => {
                importWorkflow(wf);
                invoke("save_workflow_to_library", {
                  name: wf.name || "arnes",
                  content: JSON.stringify(wf, null, 2),
                }).catch(() => {});
                setRightPanelTab("inspector");
                setTimeout(() => {
                  autoLayout();
                  setTimeout(() => fitView({ padding: 0.16, duration: 250 }), 30);
                }, 30);
                setBanner(`Arnés aplicado y guardado: ${wf.name}`);
              }}
            />
          </div>
        </aside>
      </div>

      <SettingsModal
        open={settingsOpen}
        initialTab={settingsTab}
        updateInfo={updateInfo}
        onUpdateChecked={(res) => setUpdateInfo(res)}
        onClose={() => setSettingsOpen(false)}
        onNotice={(msg) => setBanner(msg)}
      />
      <WorkflowIoModal
        open={ioOpen}
        onClose={() => setIoOpen(false)}
        onNotice={(msg) => setBanner(msg)}
      />
      <ModelTuningModal />
      <HumanGateModal />
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
      <LoopyStudioInner />
    </ReactFlowProvider>
  );
}
export default App;
