import { create } from "zustand";
import {
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  type Connection,
  type EdgeChange,
  type NodeChange,
} from "@xyflow/react";
import {
  NODE_BLUEPRINTS,
  type AppMode,
  type CustomNodeDef,
  type EngineEvent,
  type HumanGatePrompt,
  type LoorsFlowEdge,
  type LoorsFlowNode,
  type LoorsNodeKind,
  type LoorsWorkflowFile,
  type ModelLoadProgressEvent,
  type RunLogEntry,
  type RunStatus,
  type RuntimeBackendKind,
} from "../types/graph";
import { HARNESS_TEMPLATES } from "../templates/harnesses";

const INITIAL_NODES: LoorsFlowNode[] = [
  {
    id: "input-1",
    type: "loorsNode",
    position: { x: 40, y: 180 },
    data: {
      kind: "task_input",
      title: "Task Input",
      status: "idle",
      config: { ...NODE_BLUEPRINTS.task_input.defaultConfig },
    },
  },
  {
    id: "model-1",
    type: "loorsNode",
    position: { x: 40, y: 380 },
    data: {
      kind: "local_model",
      title: "Local Model (GGUF)",
      status: "idle",
      config: { ...NODE_BLUEPRINTS.local_model.defaultConfig },
    },
  },
  {
    id: "agent-1",
    type: "loorsNode",
    position: { x: 340, y: 200 },
    data: {
      kind: "agent",
      title: "Agent: Coder",
      status: "idle",
      config: { ...NODE_BLUEPRINTS.agent.defaultConfig },
    },
  },
  {
    id: "shell-1",
    type: "loorsNode",
    position: { x: 640, y: 200 },
    data: {
      kind: "shell",
      title: "Shell: Run Tests",
      status: "idle",
      config: { ...NODE_BLUEPRINTS.shell.defaultConfig },
    },
  },
  {
    id: "cond-1",
    type: "loorsNode",
    position: { x: 920, y: 200 },
    data: {
      kind: "condition",
      title: "Tests Pass?",
      status: "idle",
      config: { ...NODE_BLUEPRINTS.condition.defaultConfig },
    },
  },
  {
    id: "guard-1",
    type: "loorsNode",
    position: { x: 640, y: 420 },
    data: {
      kind: "loop_guard",
      title: "Loop Guard (max 5)",
      status: "idle",
      config: { ...NODE_BLUEPRINTS.loop_guard.defaultConfig },
    },
  },
  {
    id: "out-1",
    type: "loorsNode",
    position: { x: 1200, y: 150 },
    data: {
      kind: "output",
      title: "Done",
      status: "idle",
      config: { ...NODE_BLUEPRINTS.output.defaultConfig },
    },
  },
];

const INITIAL_EDGES: LoorsFlowEdge[] = [
  {
    id: "e-in-agent",
    source: "input-1",
    sourceHandle: "exec",
    target: "agent-1",
    targetHandle: "exec",
  },
  {
    id: "e-model-agent",
    source: "model-1",
    sourceHandle: "model_ref",
    target: "agent-1",
    targetHandle: "model_ref",
    style: { stroke: "#a855f7", strokeDasharray: "5 4" },
  },
  {
    id: "e-agent-shell",
    source: "agent-1",
    sourceHandle: "exec",
    target: "shell-1",
    targetHandle: "exec",
  },
  {
    id: "e-shell-cond",
    source: "shell-1",
    sourceHandle: "exec",
    target: "cond-1",
    targetHandle: "exec",
  },
  {
    id: "e-cond-out",
    source: "cond-1",
    sourceHandle: "true",
    target: "out-1",
    targetHandle: "exec",
    style: { stroke: "#22c55e" },
    label: "pass",
  },
  {
    id: "e-cond-guard",
    source: "cond-1",
    sourceHandle: "false",
    target: "guard-1",
    targetHandle: "exec",
    style: { stroke: "#ef4444" },
    label: "fail",
  },
  {
    id: "e-guard-agent",
    source: "guard-1",
    sourceHandle: "retry",
    target: "agent-1",
    targetHandle: "feedback",
    animated: true,
    style: { stroke: "#22c55e", strokeWidth: 2 },
    label: "loop retry",
  },
];

interface GraphStoreState {
  workflowName: string;
  nodes: LoorsFlowNode[];
  edges: LoorsFlowEdge[];
  selectedNodeId: string | null;
  selectedBackend: RuntimeBackendKind;
  runStatus: RunStatus;
  activeRunId: string | null;
  currentIteration: number;
  maxIterations: number | null;
  runSummary: string | null;
  activeActivity: string | null;
  loadedModelName: string | null;
  loadedContextSize: number | null;
  modelLoadProgress: ModelLoadProgressEvent | null;
  logs: RunLogEntry[];
  consoleOpen: boolean;
  pendingGate: HumanGatePrompt | null;
  customNodes: CustomNodeDef[];
  appMode: AppMode;
  locale: "en" | "es";
  leftPanelOpen: boolean;
  rightPanelOpen: boolean;
  rightPanelTab: "inspector" | "architect";
  dimResourceEdges: boolean;
  tuningModalModelPath: string | null;
  editingCustomNode: CustomNodeDef | null;
  architectSeedPrompt: string | null;
  agentRunning: boolean;
  agentActiveTitle: string | null;
  activeModelPath: string;
  setAppMode: (mode: AppMode) => void;
  setLocale: (locale: "en" | "es") => void;
  setLeftPanelOpen: (open: boolean) => void;
  setRightPanelOpen: (open: boolean) => void;
  setActiveModelPath: (modelPath: string) => void;
  setModelLoadProgress: (ev: ModelLoadProgressEvent | null) => void;
  setRightPanelTab: (tab: "inspector" | "architect") => void;
  setDimResourceEdges: (dim: boolean) => void;
  openTuningModal: (modelPath: string | null) => void;
  setEditingCustomNode: (def: CustomNodeDef | null) => void;
  setArchitectSeedPrompt: (prompt: string | null) => void;
  setAgentStatus: (running: boolean, title?: string | null) => void;
  syncAgentContextToHarness: (workspace: string, modelPath: string) => void;
  setCustomNodes: (defs: CustomNodeDef[]) => void;
  addCustomNodeToCanvas: (def: CustomNodeDef) => void;
  attachResourceToNode: (
    targetNodeId: string,
    resourceKind: "local_model" | "skill" | "mcp_server" | "knowledge_rag" | "workspace"
  ) => void;
  duplicateNode: (id: string) => void;
  setWorkflowName: (name: string) => void;
  setSelectedNodeId: (id: string | null) => void;
  setSelectedBackend: (backend: RuntimeBackendKind) => void;
  setConsoleOpen: (open: boolean) => void;
  clearLogs: () => void;
  clearPendingGate: () => void;
  newWorkflow: () => void;
  loadTemplate: (templateId: string) => void;
  prepareRun: () => void;
  applyEngineEvent: (event: EngineEvent) => void;
  onNodesChange: (changes: NodeChange<LoorsFlowNode>[]) => void;
  onEdgesChange: (changes: EdgeChange<LoorsFlowEdge>[]) => void;
  onConnect: (connection: Connection) => void;
  addNode: (kind: LoorsNodeKind, position?: { x: number; y: number }) => void;
  autoLayout: () => void;
  updateNodeTitle: (id: string, title: string) => void;
  updateNodeConfig: (id: string, patch: Record<string, unknown>) => void;
  deleteNode: (id: string) => void;
  exportWorkflow: () => LoorsWorkflowFile;
  importWorkflow: (file: LoorsWorkflowFile) => void;
}

function formatNow(): string {
  const d = new Date();
  return d.toTimeString().slice(0, 8);
}

export const useGraphStore = create<GraphStoreState>((set, get) => ({
  workflowName: "fix-tests-loop",
  nodes: INITIAL_NODES,
  edges: INITIAL_EDGES,
  selectedNodeId: null,
  selectedBackend: "auto",
  runStatus: "idle",
  activeRunId: null,
  currentIteration: 0,
  maxIterations: null,
  runSummary: null,
  activeActivity: null,
  loadedModelName: null,
  loadedContextSize: null,
  modelLoadProgress: null,
  logs: [],
  consoleOpen: false,
  pendingGate: null,
  customNodes: [],
  appMode: (typeof window !== "undefined" && window.localStorage.getItem("loors_app_mode") === "harness")
    ? "harness"
    : "agent",
  locale:
    typeof window !== "undefined" && window.localStorage.getItem("loors_locale") === "es"
      ? "es"
      : "en",
  leftPanelOpen: true,
  rightPanelOpen: true,
  rightPanelTab: "inspector",
  dimResourceEdges: true,
  tuningModalModelPath: null,
  editingCustomNode: null,
  architectSeedPrompt: null,
  agentRunning: false,
  agentActiveTitle: null,
  activeModelPath:
    (typeof window !== "undefined" && window.localStorage.getItem("loors_active_model_path")) ||
    "",

  setAppMode: (appMode) => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem("loors_app_mode", appMode);
    }
    set({ appMode });
  },
  setLocale: (locale) => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem("loors_locale", locale);
    }
    set({ locale });
  },
  setLeftPanelOpen: (leftPanelOpen) => set({ leftPanelOpen }),
  setRightPanelOpen: (rightPanelOpen) => set({ rightPanelOpen }),
  setModelLoadProgress: (modelLoadProgress) => set({ modelLoadProgress }),
  setActiveModelPath: (modelPath) => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem("loors_active_model_path", modelPath);
    }
    const shortName = modelPath.split(/[\\/]/).pop()?.replace(/\.gguf$/i, "") || "";
    set({
      activeModelPath: modelPath,
      nodes: get().nodes.map((n) =>
        n.data.kind === "local_model" && modelPath
          ? {
              ...n,
              data: {
                ...n.data,
                title: shortName || n.data.title,
                config: { ...n.data.config, modelPath },
              },
            }
          : n
      ),
    });
  },
  setRightPanelTab: (rightPanelTab) => set({ rightPanelTab }),
  setDimResourceEdges: (dimResourceEdges) => set({ dimResourceEdges }),
  openTuningModal: (tuningModalModelPath) => set({ tuningModalModelPath }),
  setEditingCustomNode: (editingCustomNode) => set({ editingCustomNode }),
  setArchitectSeedPrompt: (architectSeedPrompt) => set({ architectSeedPrompt }),
  setAgentStatus: (agentRunning, agentActiveTitle = null) =>
    set({ agentRunning, agentActiveTitle }),
  syncAgentContextToHarness: (workspace, modelPath) =>
    set({
      nodes: get().nodes.map((n) => {
        if (n.data.kind === "task_input" && workspace && workspace !== ".") {
          return { ...n, data: { ...n.data, config: { ...n.data.config, workspace } } };
        }
        if (n.data.kind === "workspace" && workspace && workspace !== ".") {
          return { ...n, data: { ...n.data, config: { ...n.data.config, path: workspace } } };
        }
        if (n.data.kind === "local_model" && modelPath) {
          const shortName = modelPath.split(/[\\/]/).pop()?.replace(/\.gguf$/i, "") || "";
          return {
            ...n,
            data: {
              ...n.data,
              title: shortName || n.data.title,
              config: { ...n.data.config, modelPath },
            },
          };
        }
        return n;
      }),
    }),

  setCustomNodes: (customNodes) => set({ customNodes }),

  duplicateNode: (id) => {
    const src = get().nodes.find((n) => n.id === id);
    if (!src) return;
    const copyId = `${src.data.kind}-${Date.now().toString(36)}`;
    const copy: LoorsFlowNode = {
      ...src,
      id: copyId,
      position: { x: src.position.x + 48, y: src.position.y + 48 },
      selected: false,
      data: {
        ...src.data,
        title: `${src.data.title} (copia)`,
        status: "idle",
        statusMessage: null,
        config: { ...src.data.config },
      },
    };
    set({
      nodes: [...get().nodes, copy],
      selectedNodeId: copyId,
    });
  },

  addCustomNodeToCanvas: (def) => {
    const count = get().nodes.length;
    const id = `custom-${def.id}-${Date.now().toString(36)}`;
    const fieldDefaults: Record<string, unknown> = {};
    for (const f of def.fields) {
      fieldDefaults[f.key] = f.fieldType === "number" ? Number(f.defaultValue || 0) : f.defaultValue;
    }
    const newNode: LoorsFlowNode = {
      id,
      type: "loorsNode",
      position: {
        x: 260 + (count % 4) * 50,
        y: 140 + (count % 4) * 45,
      },
      data: {
        kind: "custom",
        title: def.label,
        status: "idle",
        config: {
          customNodeId: def.id,
          accent: def.accent,
          runner: def.runner,
          commandTemplate: def.commandTemplate,
          promptTemplate: def.promptTemplate,
          httpMethod: def.httpMethod,
          httpUrl: def.httpUrl,
          httpHeaders: def.httpHeaders,
          httpBody: def.httpBody,
          branchOnExit: def.branchOnExit,
          customFields: def.fields,
          ...fieldDefaults,
        },
      },
    };
    set({
      nodes: [...get().nodes, newNode],
      selectedNodeId: id,
    });
  },

  attachResourceToNode: (targetNodeId, resourceKind) => {
    const state = get();
    const target = state.nodes.find((n) => n.id === targetNodeId);
    if (!target) return;

    const handleMap: Record<
      "local_model" | "skill" | "mcp_server" | "knowledge_rag" | "workspace",
      { src: string; tgt: string }
    > = {
      local_model: { src: "model_ref", tgt: "model_ref" },
      skill: { src: "skill_ref", tgt: "skill_ref" },
      mcp_server: { src: "mcp_ref", tgt: "mcp_ref" },
      knowledge_rag: { src: "knowledge_ref", tgt: "knowledge_ref" },
      workspace: { src: "workspace_ref", tgt: "workspace_ref" },
    };
    const handles = handleMap[resourceKind];
    const existingAttached = state.edges.filter(
      (e) => e.target === targetNodeId && e.targetHandle?.endsWith("_ref")
    ).length;

    const bp = NODE_BLUEPRINTS[resourceKind];
    const id = `${resourceKind}-${Date.now().toString(36)}`;
    const config = { ...bp.defaultConfig };
    if (resourceKind === "local_model" && state.activeModelPath) {
      config.modelPath = state.activeModelPath;
    }

    const newNode: LoorsFlowNode = {
      id,
      type: "loorsNode",
      position: {
        x: Math.max(20, target.position.x - 270),
        y: target.position.y + existingAttached * 125,
      },
      data: {
        kind: resourceKind,
        title: bp.label,
        status: "idle",
        config,
      },
    };
    const newEdge: LoorsFlowEdge = {
      id: `e-${id}-${targetNodeId}`,
      source: id,
      sourceHandle: handles.src,
      target: targetNodeId,
      targetHandle: handles.tgt,
      type: "smoothstep",
    };

    set({
      nodes: [...state.nodes, newNode],
      edges: [...state.edges, newEdge],
      selectedNodeId: id,
    });
  },

  setWorkflowName: (workflowName) => set({ workflowName }),
  setSelectedNodeId: (selectedNodeId) => set({ selectedNodeId }),
  setSelectedBackend: (selectedBackend) => set({ selectedBackend }),
  setConsoleOpen: (consoleOpen) => set({ consoleOpen }),
  clearLogs: () => set({ logs: [], runSummary: null }),
  clearPendingGate: () => set({ pendingGate: null }),

  newWorkflow: () => {
    const prevNodes = get().nodes;
    const storeActiveModel = get().activeModelPath.trim();
    const prevNodeModel = String(
      prevNodes.find((n) => n.data.kind === "local_model")?.data.config.modelPath ?? ""
    ).trim();
    const effectiveModel =
      storeActiveModel ||
      (prevNodeModel && prevNodeModel !== "models/qwen2.5-coder-7b-instruct-q4_k_m.gguf"
        ? prevNodeModel
        : "");
    const shortModelTitle =
      effectiveModel.split(/[\\/]/).pop()?.replace(/\.gguf$/i, "") || "Local Model (GGUF)";
    const prevWorkspace = String(
      prevNodes.find((n) => n.data.kind === "task_input")?.data.config.workspace ?? "."
    );

    const baseNodes: LoorsFlowNode[] = [
      {
        id: "in-1",
        type: "loorsNode",
        position: { x: 40, y: 160 },
        data: {
          kind: "task_input",
          title: "Task Input",
          status: "idle",
          config: {
            workspace: prevWorkspace,
            prompt: "",
          },
        },
      },
      {
        id: "model-1",
        type: "loorsNode",
        position: { x: 40, y: 360 },
        data: {
          kind: "local_model",
          title: shortModelTitle,
          status: "idle",
          config: {
            ...NODE_BLUEPRINTS.local_model.defaultConfig,
            modelPath: effectiveModel,
            maxTokens: 0,
          },
        },
      },
      {
        id: "agent-1",
        type: "loorsNode",
        position: { x: 360, y: 160 },
        data: {
          kind: "agent",
          title: "Agent",
          status: "idle",
          config: {
            ...NODE_BLUEPRINTS.agent.defaultConfig,
            maxSteps: 0,
          },
        },
      },
      {
        id: "out-1",
        type: "loorsNode",
        position: { x: 680, y: 160 },
        data: {
          kind: "output",
          title: "Output",
          status: "idle",
          config: { label: "Completado" },
        },
      },
    ];

    const baseEdges: LoorsFlowEdge[] = [
      { id: "e-in-agent", source: "in-1", sourceHandle: "exec", target: "agent-1", targetHandle: "exec" },
      {
        id: "e-model-agent",
        source: "model-1",
        sourceHandle: "model_ref",
        target: "agent-1",
        targetHandle: "model_ref",
        style: { stroke: "#a855f7", strokeDasharray: "5 4" },
      },
      { id: "e-agent-out", source: "agent-1", sourceHandle: "exec", target: "out-1", targetHandle: "exec" },
    ];

    set({
      workflowName: "nuevo-arnes",
      nodes: baseNodes,
      edges: baseEdges,
      selectedNodeId: null,
      runStatus: "idle",
      runSummary: null,
      pendingGate: null,
    });
  },

  loadTemplate: (templateId) => {
    const tpl = HARNESS_TEMPLATES.find((t) => t.id === templateId);
    if (!tpl) return;
    const prevNodes = get().nodes;
    const storeActiveModel = get().activeModelPath.trim();
    const prevNodeModel = String(
      prevNodes.find((n) => n.data.kind === "local_model")?.data.config.modelPath ?? ""
    ).trim();
    const effectivePrevModel =
      storeActiveModel ||
      (prevNodeModel && prevNodeModel !== "models/qwen2.5-coder-7b-instruct-q4_k_m.gguf"
        ? prevNodeModel
        : "");
    const shortModelTitle =
      effectivePrevModel.split(/[\\/]/).pop()?.replace(/\.gguf$/i, "") || "";
    const prevWorkspace = String(
      prevNodes.find((n) => n.data.kind === "task_input")?.data.config.workspace ?? ""
    );
    const hasRealPrevWorkspace =
      prevWorkspace.trim().length > 0 && prevWorkspace.trim() !== ".";

    set({
      workflowName: tpl.name,
      nodes: tpl.nodes.map((n) => {
        const nextConfig = { ...n.data.config };
        let nextTitle = n.data.title;
        if (n.data.kind === "local_model" && effectivePrevModel) {
          nextConfig.modelPath = effectivePrevModel;
          if (shortModelTitle) nextTitle = shortModelTitle;
        }
        if (n.data.kind === "task_input" && hasRealPrevWorkspace) {
          nextConfig.workspace = prevWorkspace;
        }
        return {
          ...n,
          data: { ...n.data, title: nextTitle, config: nextConfig, status: "idle" },
        };
      }),
      edges: tpl.edges.map((e) => ({ ...e })),
      selectedNodeId: null,
      runStatus: "idle",
      runSummary: null,
      pendingGate: null,
    });
  },

  prepareRun: () =>
    set({
      runStatus: "running",
      currentIteration: 1,
      maxIterations: null,
      runSummary: null,
      activeActivity: "Iniciando arnés...",
      logs: [],
      consoleOpen: true,
      pendingGate: null,
      nodes: get().nodes.map((n) => ({
        ...n,
        data: { ...n.data, status: "idle", statusMessage: null },
      })),
    }),

  applyEngineEvent: (event) => {
    switch (event.type) {
      case "run_started":
        set({
          activeRunId: event.run_id,
          runStatus: "running",
          currentIteration: 1,
          runSummary: null,
        });
        break;

      case "node_status": {
        const targetNode = get().nodes.find((n) => n.id === event.node_id);
        const activity =
          event.status === "running"
            ? `${targetNode?.data.title ?? event.node_id}${event.message ? ` · ${event.message}` : ""}`
            : get().activeActivity;
        set({
          currentIteration: event.iteration,
          activeActivity: activity,
          nodes: get().nodes.map((n) =>
            n.id === event.node_id
              ? {
                  ...n,
                  data: {
                    ...n.data,
                    status: event.status,
                    statusMessage:
                      event.status === "running" ? event.message : null,
                  },
                }
              : n
          ),
        });
        break;
      }

      case "model_state":
        set({
          loadedModelName: event.loaded ? event.model_name : null,
          loadedContextSize: event.loaded ? event.context_size : null,
        });
        break;

      case "node_log": {
        const entry: RunLogEntry = {
          id: `${event.run_id}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          timestamp: formatNow(),
          nodeId: event.node_id,
          nodeTitle: event.node_title,
          iteration: event.iteration,
          stream: event.stream,
          text: event.text,
        };
        set({ logs: [...get().logs.slice(-500), entry] });
        break;
      }

      case "iteration_changed":
        set({
          currentIteration: event.iteration,
          maxIterations: event.max_iterations,
        });
        break;

      case "human_gate_waiting":
        set({
          pendingGate: {
            runId: event.run_id,
            nodeId: event.node_id,
            nodeTitle: event.node_title,
            iteration: event.iteration,
            message: event.message,
            gitDiff: event.git_diff,
          },
        });
        break;

      case "run_finished":
        set({
          runStatus: event.outcome,
          currentIteration: event.total_iterations,
          runSummary: event.summary,
          activeActivity: null,
          pendingGate: null,
        });
        break;
    }
  },

  onNodesChange: (changes) =>
    set({
      nodes: applyNodeChanges(changes, get().nodes),
    }),

  onEdgesChange: (changes) =>
    set({
      edges: applyEdgeChanges(changes, get().edges),
    }),

  onConnect: (connection) => {
    const isRetry =
      connection.sourceHandle === "retry" || connection.targetHandle === "feedback";
    const isModel =
      connection.sourceHandle === "model_ref" || connection.targetHandle === "model_ref";
    const isSkill =
      connection.sourceHandle === "skill_ref" || connection.targetHandle === "skill_ref";
    const isMcp =
      connection.sourceHandle === "mcp_ref" || connection.targetHandle === "mcp_ref";
    const isWorkspace =
      connection.sourceHandle === "workspace_ref" || connection.targetHandle === "workspace_ref";
    const isKnowledge =
      connection.sourceHandle === "knowledge_ref" || connection.targetHandle === "knowledge_ref";

    const nextEdge: LoorsFlowEdge = {
      ...connection,
      id: `e-${connection.source}-${connection.sourceHandle ?? "out"}-${connection.target}-${connection.targetHandle ?? "in"}-${Date.now()}`,
      animated: isRetry,
      style: isRetry
        ? { stroke: "#22c55e", strokeWidth: 2 }
        : isModel
          ? { stroke: "#a855f7", strokeDasharray: "5 4" }
          : isSkill
            ? { stroke: "#2dd4bf", strokeDasharray: "5 4" }
            : isMcp
              ? { stroke: "#fb923c", strokeDasharray: "5 4" }
              : isWorkspace
                ? { stroke: "#0ea5e9", strokeDasharray: "5 4" }
                : isKnowledge
                  ? { stroke: "#06b6d4", strokeDasharray: "5 4" }
                  : undefined,
    };

    set({
      edges: addEdge(nextEdge, get().edges),
    });
  },

  addNode: (kind, position) => {
    const bp = NODE_BLUEPRINTS[kind];
    const count = get().nodes.length;
    const id = `${kind}-${Date.now().toString(36)}`;
    const newNode: LoorsFlowNode = {
      id,
      type: "loorsNode",
      position: position ?? {
        x: 240 + (count % 4) * 50,
        y: 120 + (count % 4) * 45,
      },
      data: {
        kind,
        title: bp.label,
        status: "idle",
        config: { ...bp.defaultConfig },
      },
    };
    set({
      nodes: [...get().nodes, newNode],
      selectedNodeId: id,
    });
  },

  autoLayout: () => {
    const { nodes, edges } = get();
    const resourceKinds = new Set([
      "local_model",
      "skill",
      "mcp_server",
      "workspace",
      "knowledge_rag",
    ]);
    const execNodes = nodes.filter((n) => !resourceKinds.has(n.data.kind));
    const resNodes = nodes.filter((n) => resourceKinds.has(n.data.kind));

    // BFS column assignment from task_input along non-retry edges
    const colMap = new Map<string, number>();
    const start =
      execNodes.find((n) => n.data.kind === "trigger") ??
      execNodes.find((n) => n.data.kind === "task_input") ??
      execNodes[0];
    if (start) {
      const queue: string[] = [start.id];
      colMap.set(start.id, 0);
      while (queue.length > 0) {
        const curr = queue.shift()!;
        const currCol = colMap.get(curr) ?? 0;
        for (const e of edges) {
          if (e.source === curr && e.sourceHandle !== "retry" && !colMap.has(e.target)) {
            if (!resourceKinds.has(nodes.find((n) => n.id === e.target)?.data.kind ?? "")) {
              colMap.set(e.target, currCol + 1);
              queue.push(e.target);
            }
          }
        }
      }
    }

    const colCounts = new Map<number, number>();
    const positioned = nodes.map((n) => {
      if (resourceKinds.has(n.data.kind)) {
        const idx = resNodes.findIndex((r) => r.id === n.id);
        return { ...n, position: { x: 40, y: 360 + idx * 170 } };
      }
      const col = colMap.get(n.id) ?? 1;
      const row = colCounts.get(col) ?? 0;
      colCounts.set(col, row + 1);
      return {
        ...n,
        position: { x: 40 + col * 290, y: 120 + row * 210 },
      };
    });

    set({ nodes: positioned });
  },

  updateNodeTitle: (id, title) =>
    set({
      nodes: get().nodes.map((node) =>
        node.id === id ? { ...node, data: { ...node.data, title } } : node
      ),
    }),

  updateNodeConfig: (id, patch) =>
    set({
      nodes: get().nodes.map((node) =>
        node.id === id
          ? {
              ...node,
              data: {
                ...node.data,
                config: { ...node.data.config, ...patch },
              },
            }
          : node
      ),
    }),

  deleteNode: (id) =>
    set({
      nodes: get().nodes.filter((n) => n.id !== id),
      edges: get().edges.filter((e) => e.source !== id && e.target !== id),
      selectedNodeId: get().selectedNodeId === id ? null : get().selectedNodeId,
    }),

  exportWorkflow: () => ({
    schemaVersion: 1,
    name: get().workflowName,
    nodes: get().nodes,
    edges: get().edges,
  }),

  importWorkflow: (file) => {
    const activeModel = get().activeModelPath.trim();
    const shortModelTitle =
      activeModel.split(/[\\/]/).pop()?.replace(/\.gguf$/i, "") || "";
    set({
      workflowName: file.name || "imported-workflow",
      nodes: (file.nodes || []).map((n) => {
        if (n.data.kind === "local_model" && activeModel) {
          return {
            ...n,
            type: "loorsNode",
            data: {
              ...n.data,
              title: shortModelTitle || n.data.title,
              config: { ...n.data.config, modelPath: activeModel },
              status: "idle",
            },
          };
        }
        return {
          ...n,
          type: "loorsNode",
          data: { ...n.data, status: "idle" },
        };
      }),
      edges: file.edges || [],
      selectedNodeId: null,
      runStatus: "idle",
      runSummary: null,
      pendingGate: null,
    });
  },
}));
