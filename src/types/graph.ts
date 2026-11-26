import type { Edge, Node } from "@xyflow/react";

export type LoopyNodeKind =
  | "task_input"
  | "trigger"
  | "workspace"
  | "local_model"
  | "skill"
  | "mcp_server"
  | "agent"
  | "shell"
  | "condition"
  | "loop_guard"
  | "for_each"
  | "json_validator"
  | "git_checkpoint"
  | "context_compactor"
  | "human_gate"
  | "memory_file"
  | "knowledge_rag"
  | "llm_judge"
  | "http_request"
  | "parallel_fanout"
  | "subgraph"
  | "custom"
  | "notify"
  | "output";

export type PortKind =
  | "exec"
  | "model"
  | "skill"
  | "mcp"
  | "data"
  | "true"
  | "false"
  | "retry";

export interface PortSpec {
  id: string;
  label: string;
  kind: PortKind;
}

export type NodeRunStatus = "idle" | "running" | "success" | "error" | "paused";

export type LogStreamKind = "system" | "stdout" | "stderr" | "agent" | "thinking";

export type RunStatus =
  | "idle"
  | "running"
  | "completed"
  | "exhausted"
  | "failed"
  | "cancelled";

export type EngineEvent =
  | {
      type: "run_started";
      run_id: string;
      workflow_name: string;
    }
  | {
      type: "node_status";
      run_id: string;
      node_id: string;
      status: NodeRunStatus;
      iteration: number;
      message: string | null;
    }
  | {
      type: "node_log";
      run_id: string;
      node_id: string;
      node_title: string;
      iteration: number;
      stream: LogStreamKind;
      text: string;
    }
  | {
      type: "iteration_changed";
      run_id: string;
      iteration: number;
      max_iterations: number;
    }
  | {
      type: "model_state";
      loaded: boolean;
      model_name: string | null;
      context_size: number | null;
    }
  | {
      type: "human_gate_waiting";
      run_id: string;
      node_id: string;
      node_title: string;
      iteration: number;
      message: string;
      git_diff: string;
    }
  | {
      type: "run_finished";
      run_id: string;
      outcome: "completed" | "exhausted" | "failed" | "cancelled";
      total_iterations: number;
      summary: string;
    };

export interface HumanGatePrompt {
  runId: string;
  nodeId: string;
  nodeTitle: string;
  iteration: number;
  message: string;
  gitDiff: string;
}

export interface LocalModelFile {
  name: string;
  path: string;
  size_mb: number;
}

export interface SkillSummary {
  name: string;
  description: string;
  path: string;
  source: string;
}

export interface McpToolInfo {
  name: string;
  description: string;
}

export interface CustomFieldDef {
  key: string;
  label: string;
  fieldType: "text" | "textarea" | "number";
  defaultValue: string;
}

export interface CustomNodeDef {
  id: string;
  label: string;
  category: string;
  accent: string;
  description: string;
  runner: "shell" | "prompt" | "http";
  commandTemplate: string;
  promptTemplate: string;
  httpMethod: string;
  httpUrl: string;
  httpHeaders: string;
  httpBody: string;
  branchOnExit: boolean;
  fields: CustomFieldDef[];
}

export interface RunLogEntry {
  id: string;
  timestamp: string;
  nodeId: string;
  nodeTitle: string;
  iteration: number;
  stream: LogStreamKind;
  text: string;
}

export type AppMode = "agent" | "harness";

export type PermissionMode = "read_only" | "ask" | "auto_review" | "full_auto";

export type ReasoningEffort = "off" | "low" | "medium" | "high";

export interface CloudProviderConfig {
  id: string;
  name: string;
  kind: "openai_compat" | "anthropic" | string;
  baseUrl: string;
  apiKey: string;
  models: string[];
  enabled: boolean;
}

export function isCloudModelPath(modelPath: string): boolean {
  return modelPath.trim().startsWith("cloud::");
}

export function parseCloudModelPath(
  modelPath: string
): { providerId: string; modelId: string } | null {
  if (!isCloudModelPath(modelPath)) return null;
  const parts = modelPath.trim().split("::");
  if (parts.length < 3) return null;
  const providerId = parts[1].trim();
  const modelId = parts.slice(2).join("::").trim();
  if (!providerId || !modelId) return null;
  return { providerId, modelId };
}

export function formatModelDisplayName(
  modelPath: string,
  providers?: CloudProviderConfig[]
): string {
  const parsed = parseCloudModelPath(modelPath);
  if (parsed) {
    const prov = providers?.find((p) => p.id === parsed.providerId);
    return prov ? `${parsed.modelId} (${prov.name.split(" ")[0]})` : `${parsed.providerId}/${parsed.modelId}`;
  }
  return modelPath.split(/[\\/]/).pop() ?? modelPath;
}

export interface ModelTuningProfile {
  contextSize: number;
  compactAtTokens?: number;
  cacheTypeK: string;
  cacheTypeV: string;
  flashAttn: boolean;
  gpuLayers: number;
  batchSize: number;
  ubatchSize: number;
  threads: number;
  mlock: boolean;
  noMmap: boolean;
  extraArgs: string;
  temperature: number;
  topP: number;
  minP: number;
  repeatPenalty: number;
  maxTokens: number;
  seed: number;
  mmprojPath: string;
  effectiveContextSize?: number;
}

export interface AgentToolCallRecord {
  id: string;
  name: string;
  argsJson: string;
  status: string;
  outputPreview: string;
  durationMs: number;
  filePath?: string | null;
  previousContent?: string | null;
  fileExisted?: boolean;
  diffPreview?: string | null;
  addedLines: number;
  removedLines: number;
  screenshotPath?: string | null;
  cursorX?: number | null;
  cursorY?: number | null;
  undone: boolean;
}

export interface AgentChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  thinking: string;
  attachments?: string[];
  toolCalls: AgentToolCallRecord[];
  timestamp: number;
}

export interface AgentSession {
  id: string;
  title: string;
  workspace: string;
  modelPath: string;
  permissionMode: PermissionMode;
  useRag: boolean;
  compactAtTokens?: number;
  reasoningEffort?: ReasoningEffort;
  enabledSkills: string[];
  pinnedFiles: string[];
  allowedSessionTools: string[];
  messages: AgentChatMessage[];
  updatedAt: number;
}

export interface AgentSessionSummary {
  id: string;
  title: string;
  workspace: string;
  updatedAt: number;
  messageCount: number;
  permissionMode: PermissionMode;
}

export interface AgentTodoItem {
  title: string;
  status: "pending" | "in_progress" | "done" | "failed" | string;
}

export interface SavedMcpServer {
  id: string;
  name: string;
  enabled: boolean;
  command: string;
  args: string[];
  env: Record<string, string>;
  allowedTools: string[];
}

export interface AgentArtifactPreview {
  title: string;
  path: string;
  kind: "markdown" | "html" | string;
  content: string;
}

export interface PendingAgentQuestion {
  callId: string;
  question: string;
  options: string[];
  allowMultiple: boolean;
}

export type AgentChatEvent =
  | {
      type: "token";
      session_id: string;
      message_id: string;
      is_thinking: boolean;
      token: string;
    }
  | {
      type: "todo_updated";
      session_id: string;
      items: AgentTodoItem[];
    }
  | {
      type: "question_requested";
      session_id: string;
      call_id: string;
      question: string;
      options: string[];
      allow_multiple: boolean;
    }
  | {
      type: "artifact_updated";
      session_id: string;
      title: string;
      path: string;
      kind: string;
      content: string;
    }
  | {
      type: "tool_started";
      session_id: string;
      message_id: string;
      call: AgentToolCallRecord;
    }
  | {
      type: "tool_finished";
      session_id: string;
      message_id: string;
      call: AgentToolCallRecord;
    }
  | {
      type: "permission_requested";
      session_id: string;
      message_id: string;
      call_id: string;
      tool_name: string;
      summary: string;
      preview: string;
    }
  | {
      type: "turn_finished";
      session_id: string;
      status: string;
      context_used_chars: number;
      context_max_tokens: number;
      summary: string;
    };

export interface BrowserFrameEvent {
  url: string;
  title: string;
  action: string;
  target_label: string | null;
  cursor_x: number | null;
  cursor_y: number | null;
  frame_base64: string;
  console_errors: string[];
  network_errors: string[];
}

export interface WorkspaceMemoryFileInfo {
  name: string;
  relPath: string;
  content: string;
  sizeBytes: number;
}

export interface GraphValidationIssue {
  nodeId: string;
  title: string;
  message: string;
}

export function isResourceKind(kind: LoopyNodeKind): boolean {
  return (
    kind === "local_model" ||
    kind === "skill" ||
    kind === "mcp_server" ||
    kind === "workspace" ||
    kind === "knowledge_rag"
  );
}

export interface LoopyNodeData extends Record<string, unknown> {
  kind: LoopyNodeKind;
  title: string;
  status: NodeRunStatus;
  statusMessage?: string | null;
  config: Record<string, unknown>;
}

export type LoopyFlowNode = Node<LoopyNodeData, "loopyNode">;
export type LoopyFlowEdge = Edge;

export interface LoopyWorkflowFile {
  schemaVersion: 1;
  name: string;
  nodes: LoopyFlowNode[];
  edges: LoopyFlowEdge[];
}

export function parseWorkflowJson(raw: string): LoopyWorkflowFile {
  const parsed = JSON.parse(raw) as Partial<LoopyWorkflowFile>;
  if (!Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) {
    throw new Error("El JSON no contiene arrays válidos de 'nodes' y 'edges'.");
  }
  return {
    schemaVersion: 1,
    name:
      typeof parsed.name === "string" && parsed.name.trim()
        ? parsed.name
        : "imported-workflow",
    nodes: parsed.nodes,
    edges: parsed.edges,
  };
}

export type RuntimeBackendKind = "auto" | "cuda" | "vulkan" | "metal" | "cpu";

export interface GpuInfo {
  name: string;
  vendor: string;
  vram_mb: number | null;
}

export interface HardwareProfile {
  os: string;
  arch: string;
  cpu_brand: string;
  cpu_cores: number;
  total_ram_mb: number;
  gpus: GpuInfo[];
  recommended_backend: RuntimeBackendKind;
  available_backends: RuntimeBackendKind[];
}

export interface RuntimeInstallInfo {
  backend: RuntimeBackendKind;
  version: string;
  binary_path: string;
  asset_name: string;
}

export interface RuntimeStatusSnapshot {
  install_dir: string;
  installed: RuntimeInstallInfo[];
  custom_binary_path?: string | null;
}

export interface RuntimeDownloadEvent {
  backend: RuntimeBackendKind;
  stage: string;
  downloaded_bytes: number;
  total_bytes: number | null;
  percent: number | null;
  message: string;
}

export interface ModelLoadProgressEvent {
  stage: "unloading" | "starting" | "loading" | "ready" | "error" | "unloaded" | string;
  model_name: string;
  percent: number | null;
  message: string;
}

export interface NodeBlueprint {
  kind: LoopyNodeKind;
  label: string;
  category: "Entrada" | "IA Local" | "Sistema" | "Control" | "Salida";
  accent: string;
  description: string;
  inputs: PortSpec[];
  outputs: PortSpec[];
  defaultConfig: Record<string, unknown>;
}

export const NODE_BLUEPRINTS: Record<LoopyNodeKind, NodeBlueprint> = {
  task_input: {
    kind: "task_input",
    label: "Task Input",
    category: "Entrada",
    accent: "#38bdf8",
    description: "Define la tarea inicial y el workspace del proyecto.",
    inputs: [{ id: "exec", label: "exec", kind: "exec" }],
    outputs: [
      { id: "exec", label: "exec", kind: "exec" },
      { id: "prompt", label: "prompt", kind: "data" },
    ],
    defaultConfig: {
      workspace: ".",
      prompt: "Fix the failing tests and verify everything builds cleanly.",
    },
  },
  trigger: {
    kind: "trigger",
    label: "Trigger (Webhook / Cron)",
    category: "Entrada",
    accent: "#06b6d4",
    description:
      "Dispara el arnés por Webhook HTTP, cada N minutos (Cron) o al recibir un mensaje en un Bot de Telegram.",
    inputs: [],
    outputs: [
      { id: "exec", label: "exec", kind: "exec" },
      { id: "payload", label: "payload", kind: "data" },
    ],
    defaultConfig: {
      triggerType: "webhook",
      webhookPort: 14290,
      intervalMinutes: 30,
      botToken: "",
      allowedChatId: "",
      payloadTemplate: "Evento recibido en Trigger.",
    },
  },
  workspace: {
    kind: "workspace",
    label: "Workspace / Proyecto",
    category: "Sistema",
    accent: "#0ea5e9",
    description:
      "Carpeta de proyecto enchufable: conéctala a Agent/Shell/RAG (workspace) o úsala en línea (exec) para cambiar de proyecto en mitad del flujo.",
    inputs: [{ id: "exec", label: "exec", kind: "exec" }],
    outputs: [
      { id: "exec", label: "exec", kind: "exec" },
      { id: "workspace_ref", label: "workspace", kind: "data" },
    ],
    defaultConfig: {
      path: "",
      inlineExec: false,
    },
  },
  local_model: {
    kind: "local_model",
    label: "Local Model (GGUF)",
    category: "IA Local",
    accent: "#a855f7",
    description: "Carga un modelo GGUF en el runtime embebido de llama.cpp.",
    inputs: [],
    outputs: [{ id: "model_ref", label: "model", kind: "model" }],
    defaultConfig: {
      modelPath: "models/qwen2.5-coder-7b-instruct-q4_k_m.gguf",
      mmprojPath: "",
      contextSize: 0,
      gpuLayers: -1,
      temperature: 0.2,
      topP: 0.95,
      maxTokens: 0,
      flashAttn: true,
    },
  },
  skill: {
    kind: "skill",
    label: "Skill (SKILL.md)",
    category: "IA Local",
    accent: "#2dd4bf",
    description: "Enchufa una skill (SKILL.md o inline) a un Agent Node (inject u on_demand).",
    inputs: [],
    outputs: [{ id: "skill_ref", label: "skill", kind: "skill" }],
    defaultConfig: {
      mode: "inject",
      skillPath: "",
      description: "Reglas e instrucciones especializadas para el agente",
      inlineInstructions: "",
    },
  },
  mcp_server: {
    kind: "mcp_server",
    label: "MCP Server (stdio)",
    category: "Sistema",
    accent: "#fb923c",
    description: "Conecta un servidor MCP por stdio (Jira, GitHub, Postgres, Playwright...) a un agente.",
    inputs: [],
    outputs: [{ id: "mcp_ref", label: "mcp", kind: "mcp" }],
    defaultConfig: {
      serverName: "filesystem",
      command: "npx",
      args: "-y @modelcontextprotocol/server-filesystem .",
      envJson: "{}",
      allowedTools: "",
    },
  },
  agent: {
    kind: "agent",
    label: "Agent Node",
    category: "IA Local",
    accent: "#818cf8",
    description: "Ejecuta un agente con herramientas de código, skills y MCP conectados.",
    inputs: [
      { id: "exec", label: "exec", kind: "exec" },
      { id: "model_ref", label: "model", kind: "model" },
      { id: "skill_ref", label: "skills", kind: "skill" },
      { id: "mcp_ref", label: "mcp", kind: "mcp" },
      { id: "knowledge_ref", label: "knowledge", kind: "data" },
      { id: "workspace_ref", label: "workspace", kind: "data" },
      { id: "feedback", label: "retry", kind: "retry" },
    ],
    outputs: [
      { id: "exec", label: "exec", kind: "exec" },
      { id: "response", label: "output", kind: "data" },
    ],
    defaultConfig: {
      systemPrompt:
        "You are an expert software engineer. Use your tools to explore, read, make surgical edits, and verify changes.",
      tools: [
        "list_files",
        "find_files",
        "grep_search",
        "read_file",
        "edit_file",
        "write_file",
        "run_cmd",
        "git_diff",
      ],
      maxSteps: 0,
    },
  },
  shell: {
    kind: "shell",
    label: "Shell / Test",
    category: "Sistema",
    accent: "#f59e0b",
    description: "Ejecuta un comando de terminal (tests, build, lint) y captura stdout/stderr.",
    inputs: [
      { id: "exec", label: "exec", kind: "exec" },
      { id: "workspace_ref", label: "workspace", kind: "data" },
    ],
    outputs: [
      { id: "exec", label: "exec", kind: "exec" },
      { id: "stderr", label: "stderr", kind: "data" },
    ],
    defaultConfig: {
      command: "cargo test",
      timeoutSec: 120,
    },
  },
  condition: {
    kind: "condition",
    label: "Condition",
    category: "Control",
    accent: "#ec4899",
    description: "Evalúa una condición y bifurca el flujo en true o false.",
    inputs: [{ id: "exec", label: "exec", kind: "exec" }],
    outputs: [
      { id: "true", label: "true", kind: "true" },
      { id: "false", label: "false", kind: "false" },
    ],
    defaultConfig: {
      expression: "exit_code == 0",
    },
  },
  loop_guard: {
    kind: "loop_guard",
    label: "Loop Guard",
    category: "Control",
    accent: "#22c55e",
    description: "Controla el límite de iteraciones e inyecta feedback de vuelta al agente.",
    inputs: [
      { id: "exec", label: "exec", kind: "exec" },
      { id: "feedback", label: "error", kind: "data" },
    ],
    outputs: [
      { id: "retry", label: "retry", kind: "retry" },
      { id: "exhausted", label: "max_hit", kind: "false" },
    ],
    defaultConfig: {
      maxIterations: 5,
      feedbackTemplate: "Los tests fallaron. Corrige el código usando este error:\n{{stderr}}",
    },
  },
  git_checkpoint: {
    kind: "git_checkpoint",
    label: "Git Checkpoint",
    category: "Sistema",
    accent: "#fb923c",
    description: "Captura git diff ({{git_diff}}), crea un snapshot o hace rollback seguro.",
    inputs: [{ id: "exec", label: "exec", kind: "exec" }],
    outputs: [{ id: "exec", label: "exec", kind: "exec" }],
    defaultConfig: {
      mode: "diff",
    },
  },
  knowledge_rag: {
    kind: "knowledge_rag",
    label: "Knowledge / RAG",
    category: "IA Local",
    accent: "#06b6d4",
    description:
      "Índice RAG local (BM25) + Árbol de Conocimiento (Repo Map). Rellena {{rag_context}} o expone herramientas al Agent.",
    inputs: [
      { id: "exec", label: "exec", kind: "exec" },
      { id: "workspace_ref", label: "workspace", kind: "data" },
    ],
    outputs: [
      { id: "exec", label: "exec", kind: "exec" },
      { id: "knowledge_ref", label: "knowledge", kind: "data" },
    ],
    defaultConfig: {
      mode: "hybrid",
      subpath: "",
      queryTemplate: "{{current_prompt}}",
      topK: 5,
      maxChars: 6000,
      workspace: "",
      inlineExec: false,
    },
  },
  context_compactor: {
    kind: "context_compactor",
    label: "Context Compactor",
    category: "Control",
    accent: "#06b6d4",
    description: "Compacta y formatea el contexto entre iteraciones para evitar saturación.",
    inputs: [{ id: "exec", label: "exec", kind: "exec" }],
    outputs: [{ id: "exec", label: "exec", kind: "exec" }],
    defaultConfig: {
      maxChars: 4000,
      template:
        "Objetivo: {{prompt}}\nIteración: {{iteration}}\nÚltimo error:\n{{stderr}}\nDiff actual:\n{{git_diff}}",
    },
  },
  human_gate: {
    kind: "human_gate",
    label: "Human Gate",
    category: "Control",
    accent: "#eab308",
    description: "Pausa el arnés para revisar el git diff y aprobar o devolver feedback.",
    inputs: [{ id: "exec", label: "exec", kind: "exec" }],
    outputs: [
      { id: "approved", label: "approved", kind: "true" },
      { id: "rejected", label: "feedback", kind: "retry" },
    ],
    defaultConfig: {
      message: "Revisa el diff generado. ¿Aprobamos los cambios o pedimos ajustes?",
    },
  },
  memory_file: {
    kind: "memory_file",
    label: "Memory / State File",
    category: "Sistema",
    accent: "#60a5fa",
    description: "Lee, sobrescribe o añade entradas a BACKLOG.md / DECISIONS.md ({{memory}}).",
    inputs: [{ id: "exec", label: "exec", kind: "exec" }],
    outputs: [{ id: "exec", label: "exec", kind: "exec" }],
    defaultConfig: {
      mode: "read",
      filePath: ".loopy/BACKLOG.md",
      template:
        "## Iteración {{iteration}}\n- Resultado: {{agent_output}}\n- Evaluación: {{judge_reason}}\n",
    },
  },
  llm_judge: {
    kind: "llm_judge",
    label: "LLM Judge / Router",
    category: "IA Local",
    accent: "#f43f5e",
    description: "Evalúa calidad/mejora con IA local y decide pass (keep) o fail (revert/retry).",
    inputs: [
      { id: "exec", label: "exec", kind: "exec" },
      { id: "model_ref", label: "model", kind: "model" },
    ],
    outputs: [
      { id: "pass", label: "pass", kind: "true" },
      { id: "fail", label: "fail", kind: "false" },
    ],
    defaultConfig: {
      rubric:
        "Evalúa si los cambios cumplen el objetivo, pasan los tests y mejoran el proyecto sin regresiones.",
      inputTemplate:
        "Objetivo: {{prompt}}\nExit code: {{exit_code}}\nStderr:\n{{stderr}}\nDiff:\n{{git_diff}}\nMemoria:\n{{memory}}",
    },
  },
  http_request: {
    kind: "http_request",
    label: "HTTP / API (Jira, etc.)",
    category: "Sistema",
    accent: "#2dd4bf",
    description: "Conecta el arnés con Jira, GitHub, webhooks o APIs REST ({{http_response}}).",
    inputs: [{ id: "exec", label: "exec", kind: "exec" }],
    outputs: [
      { id: "ok", label: "ok", kind: "true" },
      { id: "error", label: "error", kind: "false" },
    ],
    defaultConfig: {
      method: "GET",
      url: "https://tu-empresa.atlassian.net/rest/api/3/issue/PROJ-123",
      headersJson: "{\n  \"Authorization\": \"Basic ${JIRA_AUTH_B64}\",\n  \"Accept\": \"application/json\"\n}",
      bodyTemplate: "",
    },
  },
  parallel_fanout: {
    kind: "parallel_fanout",
    label: "Parallel Fan-Out (Worktrees)",
    category: "Control",
    accent: "#38bdf8",
    description: "Ejecuta Rama A y Rama B en paralelo en git worktrees aislados (Best-of-N) y fusiona resultados.",
    inputs: [{ id: "exec", label: "exec", kind: "exec" }],
    outputs: [
      { id: "branch_a", label: "branch_a", kind: "data" },
      { id: "branch_b", label: "branch_b", kind: "data" },
      { id: "merged", label: "merged", kind: "true" },
    ],
    defaultConfig: {
      useWorktrees: true,
    },
  },
  subgraph: {
    kind: "subgraph",
    label: "Sub-arnés (Subgraph)",
    category: "Control",
    accent: "#c084fc",
    description: "Ejecuta otro flujo .loopy.json completo como un único bloque reutilizable.",
    inputs: [{ id: "exec", label: "exec", kind: "exec" }],
    outputs: [
      { id: "ok", label: "ok", kind: "true" },
      { id: "error", label: "error", kind: "false" },
    ],
    defaultConfig: {
      workflowPath: "",
      inputTemplate: "{{current_prompt}}",
    },
  },
  custom: {
    kind: "custom",
    label: "Custom Node",
    category: "Sistema",
    accent: "#f472b6",
    description: "Nodo personalizado definido por el usuario (CLI, Prompt o HTTP).",
    inputs: [
      { id: "exec", label: "exec", kind: "exec" },
      { id: "model_ref", label: "model", kind: "model" },
    ],
    outputs: [
      { id: "ok", label: "ok", kind: "true" },
      { id: "error", label: "error", kind: "false" },
    ],
    defaultConfig: {
      runner: "shell",
      commandTemplate: "echo Hola desde mi nodo custom",
      branchOnExit: true,
      accent: "#f472b6",
      customFields: [],
    },
  },
  notify: {
    kind: "notify",
    label: "Notify (Telegram / Discord)",
    category: "Salida",
    accent: "#38bdf8",
    description:
      "Envía resultados o alertas por Telegram Bot, Discord Webhook o Webhook HTTP.",
    inputs: [{ id: "exec", label: "exec", kind: "exec" }],
    outputs: [{ id: "exec", label: "exec", kind: "exec" }],
    defaultConfig: {
      channel: "telegram",
      botToken: "",
      chatId: "",
      webhookUrl: "",
      messageTemplate: "{{agent_output}}",
    },
  },
  for_each: {
    kind: "for_each",
    label: "For Each / Iterator",
    category: "Control",
    accent: "#a78bfa",
    description: "Itera sobre un array JSON o líneas de texto, emitiendo {{item}} por 'each' y cerrando por 'done'.",
    inputs: [{ id: "exec", label: "exec", kind: "exec" }],
    outputs: [
      { id: "each", label: "each", kind: "retry" },
      { id: "done", label: "done", kind: "true" },
    ],
    defaultConfig: {
      itemsSource: "{{agent_output}}",
      splitMode: "auto",
      maxItems: 0,
    },
  },
  json_validator: {
    kind: "json_validator",
    label: "JSON Validator",
    category: "Control",
    accent: "#10b981",
    description: "Extrae y valida JSON estricto + claves obligatorias; enruta a 'valid' o 'invalid'.",
    inputs: [{ id: "exec", label: "exec", kind: "exec" }],
    outputs: [
      { id: "valid", label: "valid", kind: "true" },
      { id: "invalid", label: "invalid", kind: "false" },
    ],
    defaultConfig: {
      sourceTemplate: "{{agent_output}}",
      expectType: "object",
      requiredKeys: "",
    },
  },
  output: {
    kind: "output",
    label: "Output / End",
    category: "Salida",
    accent: "#14b8a6",
    description: "Finaliza el flujo y resume iteraciones y cambios aplicados.",
    inputs: [{ id: "exec", label: "exec", kind: "exec" }],
    outputs: [],
    defaultConfig: {
      label: "Completed",
    },
  },
};

export function validateGraphBeforeRun(
  nodes: LoopyFlowNode[],
  edges: LoopyFlowEdge[]
): GraphValidationIssue[] {
  const issues: GraphValidationIssue[] = [];
  const taskInput = nodes.find((n) => n.data.kind === "task_input");
  const triggerNode = nodes.find((n) => n.data.kind === "trigger");
  if (!taskInput && !triggerNode) {
    issues.push({
      nodeId: nodes[0]?.id ?? "",
      title: "Flujo",
      message: "Falta un nodo de entrada (Task Input o Trigger).",
    });
  }
  if (triggerNode) {
    const hasOut = edges.some((e) => e.source === triggerNode.id);
    if (!hasOut) {
      issues.push({
        nodeId: triggerNode.id,
        title: triggerNode.data.title,
        message: "Conecta la salida 'exec' del Trigger al siguiente paso.",
      });
    }
    if (
      String(triggerNode.data.config.triggerType ?? "webhook") === "telegram" &&
      !String(triggerNode.data.config.botToken ?? "").trim()
    ) {
      issues.push({
        nodeId: triggerNode.id,
        title: triggerNode.data.title,
        message: "Introduce el Bot Token de Telegram (@BotFather) o ${TELEGRAM_BOT_TOKEN}.",
      });
    }
  }
  if (taskInput) {
    const ws = String(taskInput.data.config.workspace ?? "").trim();
    if (!ws || ws === ".") {
      issues.push({
        nodeId: taskInput.id,
        title: taskInput.data.title,
        message: "Elige una carpeta de proyecto (Workspace) válida.",
      });
    }
    const hasOut = edges.some((e) => e.source === taskInput.id);
    if (!hasOut) {
      issues.push({
        nodeId: taskInput.id,
        title: taskInput.data.title,
        message: "Conecta la salida 'exec' de Task Input al primer paso.",
      });
    }
  }

  for (const n of nodes) {
    if (n.data.kind === "local_model") {
      const mp = String(n.data.config.modelPath ?? "").trim();
      if (!mp || mp === "models/qwen2.5-coder-7b-instruct-q4_k_m.gguf") {
        issues.push({
          nodeId: n.id,
          title: n.data.title,
          message: "Selecciona un modelo GGUF local o un modelo Cloud/API en este nodo.",
        });
      }
    }
    if (n.data.kind === "agent" || n.data.kind === "llm_judge") {
      const hasModel = edges.some(
        (e) => e.target === n.id && e.targetHandle === "model_ref"
      );
      if (!hasModel) {
        issues.push({
          nodeId: n.id,
          title: n.data.title,
          message: "Falta conectar un nodo Local Model al puerto 'model'.",
        });
      }
    }
    if (n.data.kind === "loop_guard") {
      const hasRetry = edges.some(
        (e) => e.source === n.id && e.sourceHandle === "retry"
      );
      if (!hasRetry) {
        issues.push({
          nodeId: n.id,
          title: n.data.title,
          message: "Conecta el puerto 'retry' del Loop Guard hacia atrás para cerrar el bucle.",
        });
      }
    }
  }
  return issues;
}


export interface ParsedGgufMeta {
  filename: string;
  baseName: string;
  family: string;
  params: string | null;
  quant: string;
  quantQuality: string;
  quantColor: "q-balanced" | "q-high" | "q-max" | "q-compact" | "q-vision" | "q-default";
  recommended: boolean;
  isMmproj: boolean;
  sourceLabel: string;
  sizeGb: number;
}

export function parseGgufMetadata(
  filenameOrPath: string,
  sizeBytes?: number
): ParsedGgufMeta {
  const norm = filenameOrPath.replace(/\\/g, "/");
  const lowerPath = norm.toLowerCase();
  const filename = norm.split("/").pop() || norm;

  const sourceLabel =
    lowerPath.includes(".lmstudio") || lowerPath.includes("lm-studio")
      ? "LM Studio"
      : lowerPath.includes("/loopy/") || lowerPath.includes("\\loopy\\")
        ? "Loopy"
        : norm.includes("/")
          ? "Local"
          : "Hugging Face";

  let stem = filename.replace(/\.gguf$/i, "");
  stem = stem.replace(/-\d{5}-of-\d{5}$/i, "");

  const isMmproj = /mmproj/i.test(stem);

  const quantRegex =
    /(?:^|[-._])((?:UD-)?(?:IQ[1-4]_[A-Z0-9_]+|Q[2-8](?:_[A-Z0-9]+)*|BF16|F16|FP16|F32|MXFP4(?:_MOE)?))$/i;
  let quant = isMmproj ? "MMPROJ" : "GGUF";
  const i1Match = stem.match(/\.(i1[-_](?:IQ|Q)[0-9A-Z_]+)$/i);
  if (i1Match) {
    quant = i1Match[1].toUpperCase();
    stem = stem.slice(0, i1Match.index);
  } else {
    const qm = stem.match(quantRegex);
    if (qm) {
      quant = qm[1].toUpperCase();
      stem = stem.slice(0, stem.length - qm[0].length);
    }
  }

  stem = stem.replace(/^[^_]+_gguf_/i, "");
  const orgPrefixMatch = stem.match(/^([a-z0-9-]+)_([A-Za-z].*)/);
  const cleanStem =
    orgPrefixMatch && !/^[0-9]/.test(orgPrefixMatch[1])
      ? orgPrefixMatch[2]
      : stem;

  const baseName = cleanStem.replace(/[-_.]+$/g, "") || filename;

  const lowName = baseName.toLowerCase();
  let family = "GGUF";
  if (isMmproj) family = "Visión / mmproj";
  else if (lowName.includes("qwen")) family = "Qwen";
  else if (lowName.includes("gemma")) family = "Gemma";
  else if (lowName.includes("deepseek")) family = "DeepSeek";
  else if (lowName.includes("llama") || lowName.includes("codellama")) family = "Llama";
  else if (lowName.includes("mistral") || lowName.includes("devstral") || lowName.includes("codestral")) family = "Mistral";
  else if (lowName.includes("phi")) family = "Phi";
  else if (lowName.includes("gpt-oss") || lowName.includes("glm")) family = lowName.includes("glm") ? "GLM" : "GPT-OSS";

  const paramsMatch = baseName.match(/(?:^|[-_.\s])(\d+(?:\.\d+)?[BM](?:-[A-Z]\d+B)?)(?:$|[-_.\s])/i);
  const params = paramsMatch ? paramsMatch[1].toUpperCase() : null;

  let quantQuality = "GGUF Quantization";
  let quantColor: ParsedGgufMeta["quantColor"] = "q-default";
  let recommended = false;

  const qUp = quant.toUpperCase();
  if (isMmproj) {
    quantQuality = "Vision Projector (VLM)";
    quantColor = "q-vision";
  } else if (
    qUp.includes("Q4_K_M") ||
    qUp.includes("Q4_K_XL") ||
    qUp.includes("IQ4_NL") ||
    qUp.includes("Q4_K_L")
  ) {
    quantQuality = "Balanced";
    quantColor = "q-balanced";
    recommended = true;
  } else if (qUp.includes("Q5") || qUp.includes("Q6")) {
    quantQuality = "High precision";
    quantColor = "q-high";
  } else if (qUp.includes("Q8") || qUp.includes("F16") || qUp.includes("BF16") || qUp.includes("F32")) {
    quantQuality = "Max fidelity";
    quantColor = "q-max";
  } else if (
    qUp.includes("Q2") ||
    qUp.includes("Q3") ||
    qUp.includes("IQ2") ||
    qUp.includes("IQ3") ||
    qUp.includes("Q4_0") ||
    qUp.includes("Q4_K_S") ||
    qUp.includes("IQ4_XS")
  ) {
    quantQuality = "Compact · Low VRAM";
    quantColor = "q-compact";
  }

  return {
    filename,
    baseName,
    family,
    params,
    quant,
    quantQuality,
    quantColor,
    recommended,
    isMmproj,
    sourceLabel,
    sizeGb: sizeBytes ? sizeBytes / (1024 * 1024 * 1024) : 0,
  };
}


export interface ModelModalityCaps {
  text: boolean;
  vision: boolean;
  thinking: boolean;
  tools: boolean;
}

export function detectModelModalities(
  nameOrPath: string,
  hasMmproj = false
): ModelModalityCaps {
  const n = (nameOrPath.split(/[\\/]/).pop() ?? nameOrPath).toLowerCase();
  const isMmproj = n.includes("mmproj");
  const vision =
    hasMmproj ||
    isMmproj ||
    /(?:^|[-_.\s])(vl|vlm|vision|llava|pixtral|internvl|minicpm-v|paligemma|molmo|qwen2\.?5-vl|qwen3-vl|qwen3\.?[5-9]|gemma-?[34]|inkling|gpt-4o|gpt-5|claude-3|claude-4|gemini-[23])/.test(
      n
    );
  const thinking = detectModelReasoningCaps(nameOrPath).supported || /inkling|gemma-?4|glm-?4\.[56]/.test(n);
  const tools = !isMmproj;
  return {
    text: !isMmproj,
    vision,
    thinking: !isMmproj && thinking,
    tools,
  };
}

export interface ModelReasoningCaps {
  supported: boolean;
  allowOff: boolean;
  hint: string;
}

export function detectModelReasoningCaps(modelPath: string): ModelReasoningCaps {
  const name = (modelPath.split(/[\\/]/).pop() ?? modelPath).toLowerCase();
  if (!name.trim()) {
    return { supported: false, allowOff: false, hint: "" };
  }
  if (name.includes("gpt-oss") || /(^|[:/])o[134](-|$)/.test(name)) {
    return {
      supported: true,
      allowOff: false,
      hint: "Niveles nativos low / medium / high",
    };
  }
  if (
    /claude-(3-7|sonnet-4|opus-4|4)|gemini-2\.5|qwen[._ -]?[34]|qwq|deepseek[._ -]?(r1|v3\.1|v3\.2)|r1[._ -]?distill|glm[._ -]?(4\.[5-9]|z1|5)|thinking|reasoner|magistral|cogito|nemotron|seed-oss|kimi-k2|minimax-m1|phi-4-reasoning/.test(
      name
    )
  ) {
    return {
      supported: true,
      allowOff: true,
      hint: "Thinking + presupuesto de tokens",
    };
  }
  return {
    supported: false,
    allowOff: false,
    hint: "Este modelo no usa thinking",
  };
}
