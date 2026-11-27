import { useEffect, useState } from "react";
import {
  Copy,
  FolderOpen,
  FolderSearch,
  Play,
  PlugZap,
  Plus,
  Settings,
  Sparkles,
  Star,
  Trash2,
} from "lucide-react";
import { invoke } from "../lib/bridge";
import {
  isResourceKind,
  NODE_BLUEPRINTS,
  type CustomFieldDef,
  type CustomNodeDef,
  type CloudProviderConfig,
  type LocalModelFile,
  type McpToolInfo,
  type RuntimeStatusSnapshot,
  type SkillSummary,
} from "../types/graph";
import { useGraphStore } from "../store/useGraphStore";
import { getNodeDescription, getNodeGuide, getNodeLabel, useI18n } from "../i18n";

const TEMPLATE_VARS = [
  "{{prompt}}",
  "{{rag_context}}",
  "{{stderr}}",
  "{{stdout}}",
  "{{git_diff}}",
  "{{memory}}",
  "{{loop_ledger}}",
  "{{agent_output}}",
  "{{judge_reason}}",
  "{{item}}",
  "{{item_index}}",
  "{{iteration}}",
];

function VarInserter({
  onInsert,
}: {
  onInsert: (token: string) => void;
}) {
  const { locale } = useI18n();
  const nodes = useGraphStore((s) => s.nodes);
  const selectedNodeId = useGraphStore((s) => s.selectedNodeId);
  const upstreamSteps = nodes.filter(
    (n) =>
      n.id !== selectedNodeId &&
      !isResourceKind(n.data.kind) &&
      n.data.kind !== "task_input" &&
      n.data.kind !== "output"
  );

  return (
    <div className="var-bar">
      {TEMPLATE_VARS.map((v) => (
        <button
          key={v}
          type="button"
          className="var-chip"
          title={locale === "es" ? `Insertar ${v}` : `Insert ${v}`}
          onClick={() => onInsert(v)}
        >
          +{v.replace(/[{}]/g, "")}
        </button>
      ))}
      {upstreamSteps.slice(0, 6).map((n) => {
        const cleanTitle = n.data.title.replace(/\s*\([^)]*\)\s*/g, "").trim();
        const shortLabel =
          cleanTitle.length > 18 ? `${cleanTitle.slice(0, 17).trimEnd()}…` : cleanTitle;
        return (
          <button
            key={n.id}
            type="button"
            className="var-chip var-chip-node"
            title={
              locale === "es"
                ? `Insertar salida de "${n.data.title}" ({{node:${n.id}}})`
                : `Insert output from "${n.data.title}" ({{node:${n.id}}})`
            }
            onClick={() => onInsert(`{{node:${n.id}}}`)}
          >
            +node:{shortLabel}
          </button>
        );
      })}
    </div>
  );
}

const TOOL_GROUPS: { titleEn: string; titleEs: string; tools: { id: string; label: string }[] }[] = [
  {
    titleEn: "Code & Files",
    titleEs: "Código y Archivos",
    tools: [
      { id: "read_file", label: "read_file" },
      { id: "edit_file", label: "edit_file" },
      { id: "write_file", label: "write_file" },
      { id: "delete_file", label: "delete_file" },
    ],
  },
  {
    titleEn: "Search & Git",
    titleEs: "Búsqueda y Git",
    tools: [
      { id: "list_files", label: "list_files" },
      { id: "find_files", label: "find_files" },
      { id: "grep_search", label: "grep_search" },
      { id: "git_diff", label: "git_diff" },
    ],
  },
  {
    titleEn: "Terminal",
    titleEs: "Terminal",
    tools: [{ id: "run_cmd", label: "run_cmd" }],
  },
  {
    titleEn: "Web & Browser",
    titleEs: "Web y Navegador",
    tools: [
      { id: "web_search", label: "web_search" },
      { id: "fetch_url", label: "fetch_url" },
      { id: "browser_action", label: "browser_action" },
    ],
  },
  {
    titleEn: "Security & Reverse Engineering (Ghidra / Binary / Debug)",
    titleEs: "Ingeniería Pro y Ciberseguridad (Ghidra / Binary / Debug)",
    tools: [
      { id: "binary_inspect", label: "binary_inspect" },
      { id: "code_symbols", label: "code_symbols" },
      { id: "git_log", label: "git_log" },
      { id: "debug_crash", label: "debug_crash" },
      { id: "differential_test", label: "differential_test" },
    ],
  },
  {
    titleEn: "Data & Sandbox (SQL / Docker)",
    titleEs: "Datos y Sandbox (SQL / Docker)",
    tools: [
      { id: "sql_query", label: "sql_query" },
      { id: "docker_exec", label: "docker_exec" },
    ],
  },
];

const TOOL_PRESETS: Record<string, string[]> = {
  Coder: [
    "list_files",
    "find_files",
    "grep_search",
    "code_symbols",
    "read_file",
    "edit_file",
    "write_file",
    "delete_file",
    "run_cmd",
    "git_diff",
  ],
  "Bug Hunter": [
    "find_files",
    "grep_search",
    "code_symbols",
    "binary_inspect",
    "read_file",
    "write_file",
    "git_log",
    "git_diff",
    "debug_crash",
    "differential_test",
    "run_cmd",
  ],
  "Reverse / Ghidra": [
    "binary_inspect",
    "debug_crash",
    "differential_test",
    "code_symbols",
    "grep_search",
    "read_file",
    "write_file",
    "run_cmd",
  ],
  "QA / Browser": [
    "read_file",
    "run_cmd",
    "browser_action",
    "fetch_url",
    "git_diff",
  ],
  Research: ["web_search", "fetch_url", "browser_action", "read_file", "write_file"],
  Full: TOOL_GROUPS.flatMap((g) => g.tools.map((t) => t.id)),
};

const MCP_PRESETS: Record<
  string,
  { serverName: string; command: string; args: string; envJson: string; allowedTools: string }
> = {
  "Ghidra (GhidraMCP)": {
    serverName: "ghidra",
    command: "python",
    args: "bridge_mcp_ghidra.py --ghidra-server http://127.0.0.1:8080/",
    envJson: "{}",
    allowedTools: "",
  },
  "Radare2 (r2mcp)": {
    serverName: "r2",
    command: "r2mcp",
    args: "",
    envJson: "{}",
    allowedTools: "",
  },
  "clangd (C++ LSP)": {
    serverName: "clangd",
    command: "uvx",
    args: "mcp-language-server --lsp clangd --workspace .",
    envJson: "{}",
    allowedTools: "",
  },
  Filesystem: {
    serverName: "filesystem",
    command: "npx",
    args: "-y @modelcontextprotocol/server-filesystem .",
    envJson: "{}",
    allowedTools: "",
  },
  GitHub: {
    serverName: "github",
    command: "npx",
    args: "-y @modelcontextprotocol/server-github",
    envJson: '{\n  "GITHUB_PERSONAL_ACCESS_TOKEN": "${GITHUB_TOKEN}"\n}',
    allowedTools: "",
  },
  Jira: {
    serverName: "jira",
    command: "uvx",
    args: "mcp-atlassian",
    envJson:
      '{\n  "JIRA_URL": "${JIRA_URL}",\n  "JIRA_USERNAME": "${JIRA_EMAIL}",\n  "JIRA_API_TOKEN": "${JIRA_TOKEN}"\n}',
    allowedTools: "jira_get_issue, jira_add_comment, jira_search",
  },
};

function WorkspaceField({
  label,
  value,
  placeholder,
  onChange,
}: {
  label: string;
  value: string;
  placeholder?: string;
  onChange: (val: string) => void;
}) {
  const handlePick = async () => {
    try {
      const picked = await invoke<string | null>("pick_folder", {
        initialDir: value && value !== "." ? value : null,
      });
      if (picked) onChange(picked);
    } catch {
      // ignore cancel/error
    }
  };

  return (
    <label className="field">
      <span>{label}</span>
      <div style={{ display: "flex", gap: 6 }}>
        <input
          type="text"
          style={{ flex: 1, minWidth: 0 }}
          placeholder={placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
        <button
          type="button"
          className="btn-secondary"
          style={{ padding: "0 8px", flexShrink: 0 }}
          title="Elegir carpeta..."
          onClick={handlePick}
        >
          <FolderOpen size={14} />
        </button>
      </div>
    </label>
  );
}

export function Inspector() {
  const { locale, t } = useI18n();
  const L = (en: string, es: string) => (locale === "es" ? es : en);
  const nodes = useGraphStore((s) => s.nodes);
  const edges = useGraphStore((s) => s.edges);
  const selectedNodeId = useGraphStore((s) => s.selectedNodeId);
  const setSelectedNodeId = useGraphStore((s) => s.setSelectedNodeId);
  const updateNodeTitle = useGraphStore((s) => s.updateNodeTitle);
  const updateNodeConfig = useGraphStore((s) => s.updateNodeConfig);
  const deleteNode = useGraphStore((s) => s.deleteNode);
  const duplicateNode = useGraphStore((s) => s.duplicateNode);
  const attachResourceToNode = useGraphStore((s) => s.attachResourceToNode);
  const openTuningModal = useGraphStore((s) => s.openTuningModal);
  const setEditingCustomNode = useGraphStore((s) => s.setEditingCustomNode);
  const setActiveModelPath = useGraphStore((s) => s.setActiveModelPath);
  const selectedBackend = useGraphStore((s) => s.selectedBackend);

  const [scannedModels, setScannedModels] = useState<LocalModelFile[] | null>(
    null
  );
  const [cloudProviders, setCloudProviders] = useState<CloudProviderConfig[]>([]);
  const [runtimeLabel, setRuntimeLabel] = useState<string>("llama.cpp");

  useEffect(() => {
    invoke<LocalModelFile[]>("scan_local_models")
      .then((list) => setScannedModels(list))
      .catch(() => setScannedModels([]));
    invoke<CloudProviderConfig[]>("get_cloud_providers")
      .then((list) => setCloudProviders(list))
      .catch(() => setCloudProviders([]));
    invoke<RuntimeStatusSnapshot>("get_runtime_status")
      .then((snap) => {
        const inst = snap.installed ?? [];
        const picked =
          selectedBackend !== "auto"
            ? inst.find((r) => r.backend === selectedBackend) ?? inst[0]
            : inst.find((r) => r.backend === "cuda") ??
              inst.find((r) => r.backend === "vulkan") ??
              inst.find((r) => r.backend === "metal") ??
              inst[0];
        if (picked) {
          setRuntimeLabel(`llama.cpp ${picked.backend}`);
        } else {
          setRuntimeLabel(`llama.cpp ${selectedBackend}`);
        }
      })
      .catch(() => {});
  }, [selectedNodeId, selectedBackend]);
  const [discoveredSkills, setDiscoveredSkills] = useState<
    SkillSummary[] | null
  >(null);
  const [mcpTools, setMcpTools] = useState<McpToolInfo[] | null>(null);
  const [mcpTesting, setMcpTesting] = useState(false);
  const [mcpError, setMcpError] = useState<string | null>(null);
  const [savedWorkflows, setSavedWorkflows] = useState<
    { name: string; path: string }[] | null
  >(null);

  const handleScanWorkflows = async () => {
    try {
      const list = await invoke<{ name: string; path: string }[]>(
        "list_saved_workflows"
      );
      setSavedWorkflows(list);
    } catch {
      setSavedWorkflows([]);
    }
  };

  const node = nodes.find((n) => n.id === selectedNodeId);

  const workspacePath = String(
    nodes.find((n) => n.data.kind === "task_input")?.data.config.workspace ?? "."
  );

  const handleScanSkills = async () => {
    try {
      const skills = await invoke<SkillSummary[]>("list_skills", {
        workspace: workspacePath,
      });
      setDiscoveredSkills(skills);
    } catch {
      setDiscoveredSkills([]);
    }
  };

  const handleTestMcp = async (cfg: Record<string, unknown>) => {
    setMcpTesting(true);
    setMcpError(null);
    setMcpTools(null);
    try {
      let envObj: Record<string, string> = {};
      try {
        envObj = JSON.parse(String(cfg.envJson ?? "{}"));
      } catch {
        throw new Error("El campo Env JSON no es un JSON válido.");
      }
      const args = String(cfg.args ?? "")
        .trim()
        .split(/\s+/)
        .filter(Boolean);
      const allowedTools = String(cfg.allowedTools ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

      const tools = await invoke<McpToolInfo[]>("test_mcp_server", {
        config: {
          name: String(cfg.serverName ?? "mcp"),
          command: String(cfg.command ?? ""),
          args,
          env: envObj,
          allowedTools,
        },
        workspace: workspacePath,
      });
      setMcpTools(tools);
    } catch (err) {
      setMcpError(err instanceof Error ? err.message : String(err));
    } finally {
      setMcpTesting(false);
    }
  };

  if (!node) {
    return (
      <div className="loors-inspector">
        <div className="muted-empty" style={{ padding: "32px 14px", textAlign: "center" }}>
          {t("canvas.selectNodeHint")}
        </div>
      </div>
    );
  }

  const bp = NODE_BLUEPRINTS[node.data.kind];
  const cfg = node.data.config;
  const canConvertCustom =
    node.data.kind === "shell" || node.data.kind === "http_request";

  const handleConvertToCustom = () => {
    const def: CustomNodeDef =
      node.data.kind === "shell"
        ? {
            id: "",
            label: `${node.data.title} Custom`,
            category: "Custom",
            accent: "#f472b6",
            description: "Script reutilizable convertido desde Shell",
            runner: "shell",
            commandTemplate: String(cfg.command ?? "echo {{args}}"),
            promptTemplate: "",
            httpMethod: "POST",
            httpUrl: "",
            httpHeaders: "{}",
            httpBody: "{}",
            branchOnExit: true,
            fields: [
              {
                key: "args",
                label: "Argumentos",
                fieldType: "text",
                defaultValue: "",
              },
            ],
          }
        : {
            id: "",
            label: `${node.data.title} Custom`,
            category: "Custom",
            accent: "#38bdf8",
            description: "Llamada HTTP reutilizable convertida desde HTTP Request",
            runner: "http",
            commandTemplate: "",
            promptTemplate: "",
            httpMethod: String(cfg.method ?? "POST"),
            httpUrl: String(cfg.url ?? ""),
            httpHeaders: String(cfg.headersJson ?? "{}"),
            httpBody: String(cfg.bodyTemplate ?? "{}"),
            branchOnExit: false,
            fields: [],
          };
    setEditingCustomNode(def);
  };

  const toggleTool = (tool: string) => {
    const current = Array.isArray(cfg.tools) ? (cfg.tools as string[]) : [];
    const next = current.includes(tool)
      ? current.filter((t) => t !== tool)
      : [...current, tool];
    updateNodeConfig(node.id, { tools: next });
  };

  return (
    <div className="loors-inspector">
      <div className="inspector-head">
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="panel-title">
            {isResourceKind(node.data.kind)
              ? locale === "es"
                ? "Recurso"
                : "Resource"
              : locale === "es"
                ? "Paso"
                : "Step"}{" "}
            · {t("canvas.inspector")}
          </div>
          <span className="inspector-kind" style={{ color: bp.accent }}>
            {getNodeLabel(node.data.kind, locale)}
          </span>
          <p
            style={{
              margin: "4px 0 0",
              fontSize: 11.5,
              lineHeight: 1.4,
              color: "#a1a1aa",
            }}
          >
            {getNodeDescription(node.data.kind, locale)}
          </p>
        </div>
        <div className="inspector-head-actions">
          {!isResourceKind(node.data.kind) && (
            <button
              type="button"
              className="icon-btn"
              title={
                locale === "es"
                  ? "Ejecutar arnés desde este nodo (reutilizando salidas previas)"
                  : "Run harness from this node (reusing previous outputs)"
              }
              onClick={() =>
                window.dispatchEvent(
                  new CustomEvent("loors:run-workflow", {
                    detail: { startNodeId: node.id },
                  })
                )
              }
            >
              <Play size={13} style={{ color: "#4ade80" }} />
            </button>
          )}
          {canConvertCustom && (
            <button
              type="button"
              className="icon-btn"
              title={L("Save as reusable Custom Node", "Guardar como Nodo Custom reutilizable")}
              onClick={handleConvertToCustom}
            >
              <Star size={14} />
            </button>
          )}
          <button
            type="button"
            className="icon-btn"
            title={L("Duplicate node", "Duplicar nodo")}
            onClick={() => duplicateNode(node.id)}
          >
            <Copy size={14} />
          </button>
          <button
            type="button"
            className="icon-btn danger"
            title={L("Delete node", "Eliminar nodo")}
            onClick={() => deleteNode(node.id)}
          >
            <Trash2 size={14} />
          </button>
        </div>
      </div>

      <div className="inspector-body">
        <div
          style={{
            padding: "9px 11px",
            borderRadius: 9,
            border: "1px solid rgba(255,255,255,0.08)",
            background: "rgba(255,255,255,0.025)",
            fontSize: 11.5,
            lineHeight: 1.45,
            color: "#d4d4d8",
          }}
        >
          <span
            style={{
              display: "block",
              fontSize: 10,
              fontWeight: 600,
              textTransform: "uppercase",
              letterSpacing: "0.05em",
              color: "#a78bfa",
              marginBottom: 3,
            }}
          >
            {locale === "es" ? "Cómo usarlo" : "How to use"}
          </span>
          {getNodeGuide(node.data.kind, locale)}
        </div>

        <label className="field">
          <span>{locale === "es" ? "Nombre del nodo" : "Node name"}</span>
          <input
            type="text"
            value={node.data.title}
            onChange={(e) => updateNodeTitle(node.id, e.target.value)}
          />
        </label>

        {node.data.kind === "workspace" && (
          <>
            <WorkspaceField
              label={L("Project folder (Workspace)", "Carpeta del proyecto (Workspace)")}
              value={String(cfg.path ?? "")}
              placeholder={L("e.g. C:\\Users\\...\\my-project", "Ej: C:\\Users\\...\\mi-proyecto")}
              onChange={(val) => updateNodeConfig(node.id, { path: val })}
            />
            <label className="check-inline">
              <input
                type="checkbox"
                checked={cfg.inlineExec === true}
                onChange={(e) =>
                  updateNodeConfig(node.id, { inlineExec: e.target.checked })
                }
              />
              <span>{L("Use as inline step (show exec ports)", "Usar como paso en línea (mostrar puertos exec)")}</span>
            </label>
            <div className="hw-note">
              {locale === "es" ? (
                <>
                  Dos formas de usarlo:
                  <br />• <strong>Enchufable</strong>: conecta su puerto <code>workspace</code> al puerto <code>workspace</code> de un Agent, Shell o RAG.
                  <br />• <strong>En línea</strong>: activa el check arriba para encadenar <code>exec → exec</code>.
                </>
              ) : (
                <>
                  Two ways to use it:
                  <br />• <strong>Pluggable</strong>: connect its <code>workspace</code> port to the <code>workspace</code> port of an Agent, Shell, or RAG node.
                  <br />• <strong>Inline</strong>: enable the toggle above to chain <code>exec → exec</code>.
                </>
              )}
            </div>
          </>
        )}

        {node.data.kind === "task_input" && (
          <>
            <WorkspaceField
              label={L("Workspace (repository folder)", "Workspace (carpeta del repo)")}
              value={String(cfg.workspace ?? "")}
              placeholder="Ej: C:\Users\...\mi-proyecto"
              onChange={(val) => updateNodeConfig(node.id, { workspace: val })}
            />
            <label className="field">
              <span>{locale === "es" ? "Prompt inicial" : "Initial prompt"}</span>
              <textarea
                rows={5}
                value={String(cfg.prompt ?? "")}
                onChange={(e) =>
                  updateNodeConfig(node.id, { prompt: e.target.value })
                }
              />
            </label>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              <label className="field">
                <span>{locale === "es" ? "Límite llamadas LLM (0 = ∞)" : "Max LLM calls (0 = ∞)"}</span>
                <input
                  type="number"
                  min="0"
                  max="1000"
                  value={Number(cfg.maxLlmCalls ?? 0)}
                  onChange={(e) =>
                    updateNodeConfig(node.id, {
                      maxLlmCalls: Math.max(0, Number(e.target.value)),
                    })
                  }
                />
              </label>
              <label className="field">
                <span>{locale === "es" ? "Timeout máx. min (0 = ∞)" : "Max run mins (0 = ∞)"}</span>
                <input
                  type="number"
                  min="0"
                  max="1440"
                  value={Number(cfg.maxRunMinutes ?? 0)}
                  onChange={(e) =>
                    updateNodeConfig(node.id, {
                      maxRunMinutes: Math.max(0, Number(e.target.value)),
                    })
                  }
                />
              </label>
            </div>
          </>
        )}

        {node.data.kind === "trigger" && (() => {
          const tType = String(cfg.triggerType ?? "webhook");
          const port = Number(cfg.webhookPort ?? 14290);
          const mins = Number(cfg.intervalMinutes ?? 30);

          return (
            <>
              <label className="field">
                <span>{L("Trigger type", "Tipo de disparador")}</span>
                <select
                  value={tType}
                  onChange={(e) =>
                    updateNodeConfig(node.id, { triggerType: e.target.value })
                  }
                >
                  <option value="webhook">{L("Local HTTP Webhook (POST /trigger)", "Webhook HTTP local (POST /trigger)")}</option>
                  <option value="interval">{L("Periodic Schedule / Cron (every N minutes)", "Schedule / Cron periódico (cada N minutos)")}</option>
                  <option value="telegram">{L("Telegram Bot (receive messages)", "Telegram Bot (recibir mensajes)")}</option>
                </select>
              </label>

              {tType === "webhook" ? (
                <>
                  <label className="field">
                    <span>{L("Local HTTP port (127.0.0.1)", "Puerto HTTP local (127.0.0.1)")}</span>
                    <input
                      type="number"
                      min={1024}
                      max={65535}
                      value={port}
                      onChange={(e) =>
                        updateNodeConfig(node.id, {
                          webhookPort: Number(e.target.value),
                        })
                      }
                    />
                  </label>
                  <div className="hw-note">
                    Endpoint: <code>http://127.0.0.1:{port}/trigger</code>
                    <br />
                    {locale === "es" ? (
                      <>Se activa automáticamente al pulsar <strong>Ejecutar</strong> en el arnés.</>
                    ) : (
                      <>Activates automatically when you click <strong>Run</strong> on the harness.</>
                    )}
                  </div>
                </>
              ) : tType === "interval" ? (
                <>
                  <label className="field">
                    <span>{L("Run interval (minutes)", "Intervalo de ejecución (minutos)")}</span>
                    <input
                      type="number"
                      min={1}
                      max={1440}
                      value={mins}
                      onChange={(e) =>
                        updateNodeConfig(node.id, {
                          intervalMinutes: Math.max(1, Number(e.target.value)),
                        })
                      }
                    />
                  </label>
                  <div className="hw-note">
                    {locale === "es" ? (
                      <>Se activará automáticamente cada {mins} min al pulsar <strong>Ejecutar</strong> en el arnés.</>
                    ) : (
                      <>Triggers automatically every {mins} min when you click <strong>Run</strong> on the harness.</>
                    )}
                  </div>
                </>
              ) : (
                <>
                  <label className="field">
                    <span>Bot Token (@BotFather)</span>
                    <input
                      type="password"
                      placeholder={L("123456:ABC... or ${TELEGRAM_BOT_TOKEN}", "123456:ABC... o ${TELEGRAM_BOT_TOKEN}")}
                      value={String(cfg.botToken ?? "")}
                      onChange={(e) =>
                        updateNodeConfig(node.id, { botToken: e.target.value })
                      }
                    />
                  </label>
                  <label className="field">
                    <span>{L("Allowed Chat ID (optional)", "Chat ID permitido (opcional)")}</span>
                    <input
                      type="text"
                      placeholder={L("Empty = any chat (recommended to pin your ID)", "Vacío = cualquier chat (recomendado fijar tu ID)")}
                      value={String(cfg.allowedChatId ?? "")}
                      onChange={(e) =>
                        updateNodeConfig(node.id, {
                          allowedChatId: e.target.value,
                        })
                      }
                    />
                  </label>
                  <div className="hw-note">
                    {locale === "es" ? (
                      <>
                        Usa long polling (<code>getUpdates</code>): no necesita IP pública ni abrir puertos.
                        Al pulsar <strong>Ejecutar</strong> queda escuchando y cada mensaje dispara el arnés con su texto en <code>{"{{prompt}}"}</code>.
                      </>
                    ) : (
                      <>
                        Uses long polling (<code>getUpdates</code>): no public IP or open ports needed.
                        Click <strong>Run</strong> to start listening; each message triggers the harness with its text in <code>{"{{prompt}}"}</code>.
                      </>
                    )}
                  </div>
                </>
              )}

              <label className="field">
                <span>{L("Default Payload / Prompt", "Payload / Prompt por defecto")}</span>
                <textarea
                  rows={3}
                  value={String(cfg.payloadTemplate ?? "")}
                  onChange={(e) =>
                    updateNodeConfig(node.id, {
                      payloadTemplate: e.target.value,
                    })
                  }
                />
              </label>
            </>
          );
        })()}

        {node.data.kind === "local_model" && (
          <>
            <div className="field">
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6 }}>
                <span>{L("Local GGUF / API Model", "Modelo GGUF local / API")}</span>
                <span className="runtime-mini-tag">{runtimeLabel}</span>
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                <select
                  style={{ flex: 1, minWidth: 0 }}
                  value={String(cfg.modelPath ?? "")}
                  onChange={(e) => {
                    const val = e.target.value;
                    if (val === "__open_hub__") {
                      window.dispatchEvent(new CustomEvent("loors:open-models-modal"));
                      return;
                    }
                    const shortTitle = val.startsWith("cloud::")
                      ? val.split("::").slice(1).join("/")
                      : val.split(/[\\/]/).pop()?.replace(/\.gguf$/i, "") || "Local Model (GGUF)";
                    updateNodeTitle(node.id, shortTitle);
                    updateNodeConfig(node.id, { modelPath: val });
                    if (val) setActiveModelPath(val);
                  }}
                >
                  <option value="">{L("Select local or API model...", "Seleccionar modelo local o API...")}</option>
                  {cloudProviders
                    .filter((p) => p.enabled && p.models.length > 0)
                    .map((p) => (
                      <optgroup key={p.id} label={`API · ${p.name}`}>
                        {p.models.map((mid) => {
                          const uri = `cloud::${p.id}::${mid}`;
                          return (
                            <option key={uri} value={uri}>
                              {mid} ({p.name.split(" ")[0]})
                            </option>
                          );
                        })}
                      </optgroup>
                    ))}
                  {(scannedModels ?? []).map((m) => (
                    <option key={m.path} value={m.path}>
                      {m.name} ({(m.size_mb / 1024).toFixed(1)} GB)
                    </option>
                  ))}
                  {String(cfg.modelPath ?? "").trim() &&
                    !(scannedModels ?? []).some((m) => m.path === String(cfg.modelPath ?? "")) &&
                    !cloudProviders.some((p) =>
                      p.enabled && p.models.some((mid) => `cloud::${p.id}::${mid}` === String(cfg.modelPath ?? ""))
                    ) && (
                      <option value={String(cfg.modelPath ?? "")}>
                        {String(cfg.modelPath ?? "").startsWith("cloud::")
                          ? String(cfg.modelPath ?? "").split("::").slice(1).join("/")
                          : String(cfg.modelPath ?? "").split(/[\\/]/).pop()}
                      </option>
                    )}
                  <option value="__open_hub__">Explorar modelos o configurar APIs...</option>
                </select>
                <button
                  type="button"
                  className="btn-secondary"
                  style={{ padding: "0 9px", flexShrink: 0 }}
                  disabled={!String(cfg.modelPath ?? "").trim()}
                  title="Opciones del modelo (Contexto, KV Cache, Compactación, GPU, Temperatura)"
                  onClick={() => openTuningModal(String(cfg.modelPath ?? ""))}
                >
                  <Settings size={14} />
                </button>
              </div>
            </div>

            <div className="hw-note">
              {locale === "es"
                ? "El tamaño de contexto, KV Cache, capas GPU, temperatura y umbral de compactación se gestionan desde el botón de opciones (⚙) junto al modelo."
                : "Context size, KV cache, GPU layers, temperature, and compaction threshold are managed via the settings gear next to the model."}
            </div>
          </>
        )}

        {node.data.kind === "skill" && (
          <>
            <label className="field">
              <span>{L("Load mode", "Modo de carga")}</span>
              <select
                value={String(cfg.mode ?? "inject")}
                onChange={(e) =>
                  updateNodeConfig(node.id, { mode: e.target.value })
                }
              >
                <option value="inject">
                  Inyectar en system prompt (siempre activa)
                </option>
                <option value="on_demand">
                  Bajo demanda (expone tool load_skill — ahorra contexto)
                </option>
              </select>
            </label>
            <label className="field">
              <span>{L("Path to SKILL.md (optional if using inline)", "Ruta a SKILL.md (opcional si usas inline)")}</span>
              <input
                type="text"
                placeholder="Ej: .loors/skills/android-tdd/SKILL.md"
                value={String(cfg.skillPath ?? "")}
                onChange={(e) =>
                  updateNodeConfig(node.id, { skillPath: e.target.value })
                }
              />
            </label>
            <button
              type="button"
              className="btn-secondary"
              onClick={handleScanSkills}
            >
              <Sparkles size={14} />
              <span>Detectar Skills (global y workspace)</span>
            </button>
            {discoveredSkills !== null && (
              <div className="scanned-models">
                {discoveredSkills.length === 0 ? (
                  <div className="hw-note">
                    No se encontraron SKILL.md en{" "}
                    <code>%LOCALAPPDATA%/loors/skills</code> ni en{" "}
                    <code>.loors/skills</code>, <code>.agents/skills</code> o{" "}
                    <code>.claude/skills</code>.
                  </div>
                ) : (
                  discoveredSkills.map((sk) => (
                    <button
                      key={sk.path}
                      type="button"
                      className="model-pick"
                      onClick={() => {
                        updateNodeTitle(node.id, `Skill: ${sk.name}`);
                        updateNodeConfig(node.id, {
                          skillPath: sk.path,
                          description: sk.description,
                        });
                      }}
                    >
                      <span className="model-pick-name">{sk.name}</span>
                      <span className="model-pick-size">{sk.source}</span>
                    </button>
                  ))
                )}
              </div>
            )}
            <label className="field">
              <span>{L("Inline instructions (if not using a SKILL.md file)", "Instrucciones inline (si no usas archivo SKILL.md)")}</span>
              <textarea
                rows={5}
                placeholder={L("Write rules, conventions, or step-by-step instructions...", "Escribe reglas, convenciones o pasos paso a paso...")}
                value={String(cfg.inlineInstructions ?? "")}
                onChange={(e) =>
                  updateNodeConfig(node.id, {
                    inlineInstructions: e.target.value,
                  })
                }
              />
            </label>
          </>
        )}

        {node.data.kind === "mcp_server" && (
          <>
            <div className="field">
              <span>{L("Quick MCP presets", "Presets rápidos de MCP")}</span>
              <div className="tool-chips">
                {Object.entries(MCP_PRESETS).map(([label, preset]) => (
                  <button
                    key={label}
                    type="button"
                    className="btn-mini"
                    onClick={() => {
                      updateNodeTitle(node.id, `MCP: ${label}`);
                      updateNodeConfig(node.id, preset);
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <label className="field">
              <span>{L("Server name (prefix mcp__name__)", "Nombre del servidor (prefijo mcp__nombre__)")}</span>
              <input
                type="text"
                value={String(cfg.serverName ?? "")}
                onChange={(e) =>
                  updateNodeConfig(node.id, { serverName: e.target.value })
                }
              />
            </label>
            <label className="field">
              <span>{L("Command (stdio)", "Comando (stdio)")}</span>
              <input
                type="text"
                placeholder={L("npx / uvx / node / binary", "npx / uvx / node / binario")}
                value={String(cfg.command ?? "")}
                onChange={(e) =>
                  updateNodeConfig(node.id, { command: e.target.value })
                }
              />
            </label>
            <label className="field">
              <span>{L("Arguments", "Argumentos")}</span>
              <input
                type="text"
                placeholder="-y @modelcontextprotocol/server-filesystem ."
                value={String(cfg.args ?? "")}
                onChange={(e) =>
                  updateNodeConfig(node.id, { args: e.target.value })
                }
              />
            </label>
            <label className="field">
              <span>{L("Env JSON (use ${VAR} for secrets)", "Env JSON (usa ${VAR} para secretos)")}</span>
              <textarea
                rows={3}
                value={String(cfg.envJson ?? "{}")}
                onChange={(e) =>
                  updateNodeConfig(node.id, { envJson: e.target.value })
                }
              />
            </label>
            <label className="field">
              <span>{L("Tool allowlist (optional, comma-separated)", "Allowlist de tools (opcional, separadas por coma)")}</span>
              <input
                type="text"
                placeholder={L("e.g. get_issue, add_comment (empty = all)", "Ej: get_issue, add_comment (vacío = todas)")}
                value={String(cfg.allowedTools ?? "")}
                onChange={(e) =>
                  updateNodeConfig(node.id, { allowedTools: e.target.value })
                }
              />
            </label>
            <button
              type="button"
              className="btn-secondary"
              disabled={mcpTesting}
              onClick={() => handleTestMcp(cfg)}
            >
              <PlugZap size={14} />
              <span>
                {mcpTesting
                  ? L("Testing MCP connection…", "Probando conexión MCP…")
                  : L("Test MCP & list tools", "Probar MCP y listar tools")}
              </span>
            </button>
            {mcpError && <div className="hw-error">{mcpError}</div>}
            {mcpTools !== null && (
              <div className="scanned-models">
                <div className="hw-note">
                  {locale === "es"
                    ? `${mcpTools.length} herramienta(s) descubierta(s):`
                    : `${mcpTools.length} tool(s) discovered:`}
                </div>
                {mcpTools.map((t) => (
                  <div key={t.name} className="installed-item">
                    <div className="installed-meta">
                      <div className="installed-name">{t.name}</div>
                      <div className="installed-path">{t.description}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        {node.data.kind === "agent" && (() => {
          const modelEdge = edges.find(
            (e) => e.target === node.id && e.targetHandle === "model_ref"
          );
          const connectedModel = modelEdge
            ? nodes.find((n) => n.id === modelEdge.source)
            : null;
          const connectedModelPath = String(
            connectedModel?.data.config.modelPath ?? ""
          ).trim();
          const connectedModelDisplay = connectedModelPath
            ? connectedModelPath.split(/[\\/]/).pop() || connectedModelPath
            : connectedModel?.data.title ?? "";
          return (
          <>
            {connectedModel ? (
              <div className="hw-box">
                <div style={{ fontSize: 11.5, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6, flexWrap: "wrap" }}>
                  <span>
                    <strong>{locale === "es" ? "Modelo conectado:" : "Connected model:"}</strong> {connectedModelDisplay}
                  </span>
                  <span className="runtime-mini-tag">{runtimeLabel}</span>
                </div>
                <button
                  type="button"
                  className="btn-mini"
                  onClick={() => setSelectedNodeId(connectedModel.id)}
                >
                  {locale === "es"
                    ? "Configurar contexto, GPU y parámetros del LLM"
                    : "Configure context, GPU & LLM parameters"}
                </button>
              </div>
            ) : (
              <div
                style={{
                  padding: "8px 10px",
                  borderRadius: 8,
                  border: "1px solid rgba(245,158,11,0.35)",
                  background: "rgba(245,158,11,0.08)",
                  fontSize: 11.5,
                  color: "#fcd34d",
                }}
              >
                {locale === "es"
                  ? "Falta conectar un nodo Model (GGUF / API) al puerto 'model'."
                  : "No Model connected yet — wire a Model (GGUF / API) node to the 'model' port."}
              </div>
            )}
            <div className="field">
              <span>{locale === "es" ? "Conectar recursos en 1 clic" : "Quick-connect resources (1 click)"}</span>
              <div className="tool-chips">
                {!connectedModel && (
                  <button
                    type="button"
                    className="btn-mini"
                    onClick={() => attachResourceToNode(node.id, "local_model")}
                  >
                    <Plus size={11} /> Model
                  </button>
                )}
                <button
                  type="button"
                  className="btn-mini"
                  onClick={() => attachResourceToNode(node.id, "skill")}
                >
                  <Plus size={11} /> Skill
                </button>
                <button
                  type="button"
                  className="btn-mini"
                  onClick={() => attachResourceToNode(node.id, "mcp_server")}
                >
                  <Plus size={11} /> MCP
                </button>
                <button
                  type="button"
                  className="btn-mini"
                  onClick={() => attachResourceToNode(node.id, "knowledge_rag")}
                >
                  <Plus size={11} /> RAG
                </button>
              </div>
            </div>
            <label className="field">
              <span>System Prompt</span>
              <textarea
                rows={5}
                value={String(cfg.systemPrompt ?? "")}
                onChange={(e) =>
                  updateNodeConfig(node.id, { systemPrompt: e.target.value })
                }
              />
              <VarInserter
                onInsert={(tok) =>
                  updateNodeConfig(node.id, {
                    systemPrompt: `${String(cfg.systemPrompt ?? "")} ${tok}`.trim(),
                  })
                }
              />
            </label>
            <div className="field">
              <span>{locale === "es" ? "Presets de herramientas" : "Tool presets"}</span>
              <div className="tool-chips">
                {Object.entries(TOOL_PRESETS).map(([presetName, presetTools]) => (
                  <button
                    key={presetName}
                    type="button"
                    className="btn-mini"
                    onClick={() =>
                      updateNodeConfig(node.id, { tools: presetTools })
                    }
                  >
                    {presetName}
                  </button>
                ))}
              </div>
            </div>
            <div className="field">
              <span>{locale === "es" ? "Herramientas habilitadas" : "Enabled tools"}</span>
              <div className="tool-groups">
                {TOOL_GROUPS.map((group) => (
                  <div key={group.titleEn} className="tool-group">
                    <div className="tool-group-title">
                      {locale === "es" ? group.titleEs : group.titleEn}
                    </div>
                    <div className="tool-chips">
                      {group.tools.map((tool) => {
                        const active =
                          Array.isArray(cfg.tools) &&
                          cfg.tools.includes(tool.id);
                        return (
                          <button
                            key={tool.id}
                            type="button"
                            className={`chip ${active ? "active" : ""}`}
                            onClick={() => toggleTool(tool.id)}
                          >
                            {tool.label}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <label className="field">
              <span>
                {locale === "es"
                  ? "Imagen a inspeccionar (opcional, VLM)"
                  : "Image to inspect (optional, VLM)"}
              </span>
              <input
                type="text"
                placeholder={locale === "es" ? "Ej: .loors/screenshot.png" : "e.g. .loors/screenshot.png"}
                value={String(cfg.imagePath ?? "")}
                onChange={(e) =>
                  updateNodeConfig(node.id, { imagePath: e.target.value })
                }
              />
            </label>
            <label className="field">
              <span>{L("Max tool steps per iteration (0 = Auto)", "Max tool steps por iteración (0 = Auto, el LLM decide)")}</span>
              <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <input
                  type="number"
                  min="0"
                  max="200"
                  style={{ flex: 1 }}
                  value={Number(cfg.maxSteps ?? 0)}
                  onChange={(e) =>
                    updateNodeConfig(node.id, {
                      maxSteps: Math.max(0, Number(e.target.value)),
                    })
                  }
                />
                <button
                  type="button"
                  className={`btn-mini ${Number(cfg.maxSteps ?? 0) === 0 ? "btn-active" : ""}`}
                  onClick={() => updateNodeConfig(node.id, { maxSteps: 0 })}
                >
                  Auto
                </button>
                <button
                  type="button"
                  className={`btn-mini ${Number(cfg.maxSteps ?? 0) === 12 ? "btn-active" : ""}`}
                  onClick={() => updateNodeConfig(node.id, { maxSteps: 12 })}
                >
                  12
                </button>
                <button
                  type="button"
                  className={`btn-mini ${Number(cfg.maxSteps ?? 0) === 25 ? "btn-active" : ""}`}
                  onClick={() => updateNodeConfig(node.id, { maxSteps: 25 })}
                >
                  25
                </button>
              </div>
            </label>
            <label className="field">
              <span>{locale === "es" ? "Thinking / Esfuerzo" : "Thinking / Reasoning Effort"}</span>
              <select
                value={String(cfg.reasoningEffort ?? "")}
                onChange={(e) =>
                  updateNodeConfig(node.id, { reasoningEffort: e.target.value })
                }
              >
                <option value="">{locale === "es" ? "Auto (por defecto del modelo)" : "Auto (model default)"}</option>
                <option value="off">{locale === "es" ? "Off (sin thinking, rápido)" : "Off (no thinking, fast)"}</option>
                <option value="low">{locale === "es" ? "Bajo (Low)" : "Low"}</option>
                <option value="medium">{locale === "es" ? "Medio (Medium)" : "Medium"}</option>
                <option value="high">{locale === "es" ? "Alto (High)" : "High"}</option>
              </select>
            </label>
            <WorkspaceField
              label={L("Workspace override (optional, multi-project)", "Workspace override (opcional, multi-proyecto)")}
              value={String(cfg.workspace ?? "")}
              placeholder="Vacío = heredar de Task Input"
              onChange={(val) => updateNodeConfig(node.id, { workspace: val })}
            />
          </>
          );
        })()}

        {node.data.kind === "shell" && (
          <>
            <label className="field">
              <span>{L("Command", "Comando")}</span>
              <input
                type="text"
                value={String(cfg.command ?? "")}
                onChange={(e) =>
                  updateNodeConfig(node.id, { command: e.target.value })
                }
              />
            </label>
            <label className="field">
              <span>Docker Image (Sandbox opcional)</span>
              <input
                type="text"
                placeholder="Vacío = host local | Ej: ubuntu:24.04 o rust:1.85"
                value={String(cfg.dockerImage ?? "")}
                onChange={(e) =>
                  updateNodeConfig(node.id, { dockerImage: e.target.value })
                }
              />
            </label>
            <label className="field">
              <span>Timeout (segundos)</span>
              <input
                type="number"
                min="5"
                value={Number(cfg.timeoutSec ?? 120)}
                onChange={(e) =>
                  updateNodeConfig(node.id, {
                    timeoutSec: Number(e.target.value),
                  })
                }
              />
            </label>
            <WorkspaceField
              label={L("Workspace override (optional, multi-project)", "Workspace override (opcional, multi-proyecto)")}
              value={String(cfg.workspace ?? "")}
              placeholder="Vacío = heredar de Task Input"
              onChange={(val) => updateNodeConfig(node.id, { workspace: val })}
            />
          </>
        )}

        {node.data.kind === "condition" && (
          <div className="field">
            <span>{locale === "es" ? "Expresión condicional" : "Condition expression"}</span>
            <input
              type="text"
              placeholder="exit_code == 0"
              value={String(cfg.expression ?? "")}
              onChange={(e) =>
                updateNodeConfig(node.id, { expression: e.target.value })
              }
            />
            <div className="tool-chips" style={{ marginTop: 4 }}>
              {[
                { label: "exit_code == 0", expr: "exit_code == 0" },
                { label: "exit_code != 0", expr: "exit_code != 0" },
                { label: "contains:PASS", expr: "contains:PASS" },
                { label: "iteration < 5", expr: "iteration < 5" },
              ].map((p) => (
                <button
                  key={p.expr}
                  type="button"
                  className={`btn-mini ${String(cfg.expression ?? "").trim() === p.expr ? "active-select" : ""}`}
                  onClick={() => updateNodeConfig(node.id, { expression: p.expr })}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>
        )}

        {node.data.kind === "loop_guard" && (
          <>
            <label className="field">
              <span>
                {locale === "es"
                  ? "Máximo de iteraciones (0 = Continuo / Sin límite)"
                  : "Max iterations (0 = Continuous / Unlimited)"}
              </span>
              <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <input
                  type="number"
                  min="0"
                  max="10000"
                  style={{ flex: 1 }}
                  value={Number(cfg.maxIterations ?? 0)}
                  onChange={(e) =>
                    updateNodeConfig(node.id, {
                      maxIterations: Math.max(0, Number(e.target.value)),
                    })
                  }
                />
                <button
                  type="button"
                  className={`btn-mini ${Number(cfg.maxIterations ?? 0) === 0 ? "btn-active" : ""}`}
                  onClick={() => updateNodeConfig(node.id, { maxIterations: 0 })}
                >
                  Continuo (∞)
                </button>
                <button
                  type="button"
                  className={`btn-mini ${Number(cfg.maxIterations ?? 0) === 10 ? "btn-active" : ""}`}
                  onClick={() => updateNodeConfig(node.id, { maxIterations: 10 })}
                >
                  10
                </button>
              </div>
            </label>
            <label className="field">
              <span>
                {locale === "es"
                  ? "Plantilla de feedback al reintentar"
                  : "Retry feedback template"}
              </span>
              <textarea
                rows={4}
                value={String(cfg.feedbackTemplate ?? "")}
                onChange={(e) =>
                  updateNodeConfig(node.id, {
                    feedbackTemplate: e.target.value,
                  })
                }
              />
              <VarInserter
                onInsert={(tok) =>
                  updateNodeConfig(node.id, {
                    feedbackTemplate: `${String(cfg.feedbackTemplate ?? "")}\n${tok}`.trim(),
                  })
                }
              />
            </label>
          </>
        )}

        {node.data.kind === "git_checkpoint" && (
          <>
            <label className="field">
              <span>{L("Git Checkpoint mode", "Modo de Git Checkpoint")}</span>
              <select
                value={String(cfg.mode ?? "diff")}
                onChange={(e) =>
                  updateNodeConfig(node.id, { mode: e.target.value })
                }
              >
                <option value="diff">Capturar git diff ({"{{git_diff}}"})</option>
                <option value="snapshot">Crear snapshot seguro (git stash create)</option>
                <option value="rollback">Rollback de cambios no confirmados</option>
              </select>
            </label>
            <WorkspaceField
              label={L("Workspace override (optional, multi-project)", "Workspace override (opcional, multi-proyecto)")}
              value={String(cfg.workspace ?? "")}
              placeholder="Vacío = heredar de Task Input"
              onChange={(val) => updateNodeConfig(node.id, { workspace: val })}
            />
          </>
        )}

        {node.data.kind === "context_compactor" && (
          <>
            <label className="field">
              <span>{L("Max characters", "Máximo de caracteres")}</span>
              <input
                type="number"
                min="200"
                max="32000"
                value={Number(cfg.maxChars ?? 4000)}
                onChange={(e) =>
                  updateNodeConfig(node.id, {
                    maxChars: Number(e.target.value),
                  })
                }
              />
            </label>
            <label className="field">
              <span>{L("Compaction template", "Plantilla de compactación")}</span>
              <textarea
                rows={5}
                value={String(cfg.template ?? "")}
                onChange={(e) =>
                  updateNodeConfig(node.id, { template: e.target.value })
                }
              />
            </label>
          </>
        )}

        {node.data.kind === "human_gate" && (
          <label className="field">
            <span>{L("Message for human reviewer", "Mensaje para el revisor humano")}</span>
            <textarea
              rows={3}
              value={String(cfg.message ?? "")}
              onChange={(e) =>
                updateNodeConfig(node.id, { message: e.target.value })
              }
            />
          </label>
        )}

        {node.data.kind === "knowledge_rag" && (
          <>
            <label className="field">
              <span>{L("Knowledge mode", "Modo de conocimiento")}</span>
              <select
                value={String(cfg.mode ?? "hybrid")}
                onChange={(e) =>
                  updateNodeConfig(node.id, { mode: e.target.value })
                }
              >
                <option value="hybrid">{L("Hybrid — Knowledge Tree + BM25 RAG", "Híbrido — Árbol de Conocimiento + RAG BM25")}</option>
                <option value="tree">{L("Knowledge Tree only (compact Repo Map)", "Solo Árbol de Conocimiento (Repo Map compacto)")}</option>
                <option value="rag">{L("BM25 RAG only (Top-K relevant chunks)", "Solo RAG BM25 (Top-K fragmentos relevantes)")}</option>
              </select>
            </label>
            <label className="field">
              <span>{L("Subfolder to index (optional)", "Subcarpeta a indexar (opcional)")}</span>
              <input
                type="text"
                placeholder={L("Empty = full workspace | e.g. docs or src/core", "Vacío = todo el workspace | Ej: docs o src/core")}
                value={String(cfg.subpath ?? "")}
                onChange={(e) =>
                  updateNodeConfig(node.id, { subpath: e.target.value })
                }
              />
            </label>
            <label className="field">
              <span>{L("RAG query (for RAG / Hybrid mode)", "Consulta RAG (para modo RAG / Híbrido)")}</span>
              <textarea
                rows={3}
                value={String(cfg.queryTemplate ?? "{{current_prompt}}")}
                onChange={(e) =>
                  updateNodeConfig(node.id, { queryTemplate: e.target.value })
                }
              />
              <VarInserter
                onInsert={(tok) =>
                  updateNodeConfig(node.id, {
                    queryTemplate: `${String(cfg.queryTemplate ?? "")} ${tok}`.trim(),
                  })
                }
              />
            </label>
            <div style={{ display: "flex", gap: 8 }}>
              <label className="field" style={{ flex: 1 }}>
                <span>{L("Top-K chunks", "Top-K fragmentos")}</span>
                <input
                  type="number"
                  min="1"
                  max="20"
                  value={Number(cfg.topK ?? 5)}
                  onChange={(e) =>
                    updateNodeConfig(node.id, { topK: Number(e.target.value) })
                  }
                />
              </label>
              <label className="field" style={{ flex: 1 }}>
                <span>{L("Budget (chars)", "Presupuesto (chars)")}</span>
                <input
                  type="number"
                  min="500"
                  max="32000"
                  step="500"
                  value={Number(cfg.maxChars ?? 6000)}
                  onChange={(e) =>
                    updateNodeConfig(node.id, { maxChars: Number(e.target.value) })
                  }
                />
              </label>
            </div>
            <WorkspaceField
              label={L("Workspace override (optional, multi-project)", "Workspace override (opcional, multi-proyecto)")}
              value={String(cfg.workspace ?? "")}
              placeholder={L("Empty = inherit from Task Input", "Vacío = heredar de Task Input")}
              onChange={(val) => updateNodeConfig(node.id, { workspace: val })}
            />
            <label className="check-inline">
              <input
                type="checkbox"
                checked={cfg.inlineExec === true}
                onChange={(e) =>
                  updateNodeConfig(node.id, { inlineExec: e.target.checked })
                }
              />
              <span>{L("Use as inline step (show exec ports)", "Usar como paso en línea (mostrar puertos exec)")}</span>
            </label>
            <div className="hw-note">
              {locale === "es" ? (
                <>
                  Úsalo en línea (<code>exec → exec</code>) para rellenar{" "}
                  <code>{"{{rag_context}}"}</code> o conéctalo al puerto{" "}
                  <code>knowledge</code> de un Agent para darle las herramientas{" "}
                  <code>search_knowledge</code> y <code>knowledge_tree</code> bajo demanda.
                </>
              ) : (
                <>
                  Use inline (<code>exec → exec</code>) to populate{" "}
                  <code>{"{{rag_context}}"}</code>, or connect it to an Agent&apos;s{" "}
                  <code>knowledge</code> port to provide on-demand{" "}
                  <code>search_knowledge</code> and <code>knowledge_tree</code> tools.
                </>
              )}
            </div>
          </>
        )}

        {node.data.kind === "memory_file" && (
          <>
            <label className="field">
              <span>{L("Mode", "Modo")}</span>
              <select
                value={String(cfg.mode ?? "read")}
                onChange={(e) =>
                  updateNodeConfig(node.id, { mode: e.target.value })
                }
              >
                <option value="read">{L("Read file into {{memory}}", "Leer archivo en {{memory}}")}</option>
                <option value="append">{L("Append entry (append)", "Añadir entrada (append)")}</option>
                <option value="write">{L("Overwrite file (write)", "Sobrescribir archivo (write)")}</option>
              </select>
            </label>
            <label className="field">
              <span>{L("Relative path in workspace", "Ruta relativa en el workspace")}</span>
              <input
                type="text"
                value={String(cfg.filePath ?? "")}
                onChange={(e) =>
                  updateNodeConfig(node.id, { filePath: e.target.value })
                }
              />
            </label>
            <label className="field">
              <span>{L("Template (for append / write)", "Plantilla (para append / write)")}</span>
              <textarea
                rows={4}
                value={String(cfg.template ?? "")}
                onChange={(e) =>
                  updateNodeConfig(node.id, { template: e.target.value })
                }
              />
            </label>
            <WorkspaceField
              label={L("Workspace override (optional, multi-project)", "Workspace override (opcional, multi-proyecto)")}
              value={String(cfg.workspace ?? "")}
              placeholder="Vacío = heredar de Task Input"
              onChange={(val) => updateNodeConfig(node.id, { workspace: val })}
            />
          </>
        )}

        {node.data.kind === "llm_judge" && (
          <>
            <label className="field">
              <span>{locale === "es" ? "Thinking / Esfuerzo" : "Thinking / Reasoning Effort"}</span>
              <select
                value={String(cfg.reasoningEffort ?? "low")}
                onChange={(e) =>
                  updateNodeConfig(node.id, { reasoningEffort: e.target.value })
                }
              >
                <option value="off">{locale === "es" ? "Off (sin thinking, rápido)" : "Off (no thinking, fast)"}</option>
                <option value="low">{locale === "es" ? "Bajo (Low · recomendado)" : "Low (recommended)"}</option>
                <option value="medium">{locale === "es" ? "Medio (Medium)" : "Medium"}</option>
                <option value="high">{locale === "es" ? "Alto (High)" : "High"}</option>
              </select>
            </label>
            <label className="field">
              <span>{L("Evaluation rubric / criteria", "Rúbrica / Criterio de evaluación")}</span>
              <textarea
                rows={4}
                value={String(cfg.rubric ?? "")}
                onChange={(e) =>
                  updateNodeConfig(node.id, { rubric: e.target.value })
                }
              />
            </label>
            <label className="field">
              <span>Contexto enviado al Judge</span>
              <textarea
                rows={4}
                value={String(cfg.inputTemplate ?? "")}
                onChange={(e) =>
                  updateNodeConfig(node.id, { inputTemplate: e.target.value })
                }
              />
              <VarInserter
                onInsert={(tok) =>
                  updateNodeConfig(node.id, {
                    inputTemplate: `${String(cfg.inputTemplate ?? "")}\n${tok}`.trim(),
                  })
                }
              />
            </label>
            <label className="field">
              <span>Imagen / Screenshot a evaluar (opcional, VLM)</span>
              <input
                type="text"
                placeholder="Ej: .loors/screenshot.png"
                value={String(cfg.imagePath ?? "")}
                onChange={(e) =>
                  updateNodeConfig(node.id, { imagePath: e.target.value })
                }
              />
            </label>
          </>
        )}

        {node.data.kind === "http_request" && (
          <>
            <label className="field">
              <span>{L("HTTP method", "Método HTTP")}</span>
              <select
                value={String(cfg.method ?? "GET")}
                onChange={(e) =>
                  updateNodeConfig(node.id, { method: e.target.value })
                }
              >
                <option value="GET">GET</option>
                <option value="POST">POST</option>
                <option value="PUT">PUT</option>
                <option value="PATCH">PATCH</option>
                <option value="DELETE">DELETE</option>
              </select>
            </label>
            <label className="field">
              <span>URL (soporta {"{{vars}}"} y {"${ENV_VAR}"})</span>
              <input
                type="text"
                value={String(cfg.url ?? "")}
                onChange={(e) =>
                  updateNodeConfig(node.id, { url: e.target.value })
                }
              />
            </label>
            <label className="field">
              <span>{L('Headers JSON (use "${TOKEN}" for secrets)', 'Headers JSON (usa "${TOKEN}" para secretos)')}</span>
              <textarea
                rows={4}
                value={String(cfg.headersJson ?? "{}")}
                onChange={(e) =>
                  updateNodeConfig(node.id, { headersJson: e.target.value })
                }
              />
            </label>
            <label className="field">
              <span>Body JSON (para POST/PUT/PATCH)</span>
              <textarea
                rows={4}
                value={String(cfg.bodyTemplate ?? "")}
                onChange={(e) =>
                  updateNodeConfig(node.id, { bodyTemplate: e.target.value })
                }
              />
            </label>
          </>
        )}

        {node.data.kind === "swarm" && (() => {
          const workers = Array.isArray(cfg.workers)
            ? (cfg.workers as import("../types/graph").SwarmWorkerSpec[])
            : [];
          const setWorkers = (next: import("../types/graph").SwarmWorkerSpec[]) =>
            updateNodeConfig(node.id, { workers: next });

          const applyPreset = (preset: "engineering" | "research" | "security") => {
            if (preset === "engineering") {
              updateNodeConfig(node.id, {
                useWorktrees: true,
                maxRounds: 8,
                coordinatorPrompt:
                  "Decompose the engineering objective, assign backend/frontend/qa tasks via swarm_post with @mentions, verify test results, and call swarm_finish with a concise delivery summary.",
                workers: [
                  {
                    id: "backend",
                    name: "Backend",
                    role: "API & Logic",
                    systemPrompt: "Implement backend logic and unit tests. Post concrete results to @coordinator and @qa.",
                    modelPath: "",
                    tools: ["list_files", "grep_search", "read_file", "edit_file", "write_file", "run_cmd"],
                    maxSteps: 10,
                  },
                  {
                    id: "frontend",
                    name: "Frontend",
                    role: "UI & UX",
                    systemPrompt: "Implement UI components and styles cleanly. Coordinate contracts with @backend and report to @coordinator.",
                    modelPath: "",
                    tools: ["list_files", "grep_search", "read_file", "edit_file", "write_file", "run_cmd"],
                    maxSteps: 10,
                  },
                  {
                    id: "qa",
                    name: "QA",
                    role: "Tests & Audit",
                    systemPrompt: "Run builds/tests, inspect git_diff, and report pass or actionable failures to @coordinator.",
                    modelPath: "",
                    tools: ["read_file", "grep_search", "run_cmd", "git_diff"],
                    maxSteps: 8,
                  },
                ],
              });
            } else if (preset === "research") {
              updateNodeConfig(node.id, {
                useWorktrees: false,
                maxRounds: 6,
                coordinatorPrompt:
                  "Split the research topic into angles, dispatch @researcher-a and @researcher-b in parallel, have @factcheck verify claims, and call swarm_finish with the final report.",
                workers: [
                  {
                    id: "researcher-a",
                    name: "Researcher A",
                    role: "Primary Sources",
                    systemPrompt: "Gather primary sources, official docs, and data with web_search/fetch_url. Post findings to @coordinator.",
                    modelPath: "",
                    tools: ["web_search", "fetch_url", "read_file"],
                    maxSteps: 8,
                  },
                  {
                    id: "researcher-b",
                    name: "Researcher B",
                    role: "Counterpoints & Context",
                    systemPrompt: "Find independent perspectives, benchmarks, and edge cases. Post findings to @coordinator.",
                    modelPath: "",
                    tools: ["web_search", "fetch_url", "read_file"],
                    maxSteps: 8,
                  },
                  {
                    id: "factcheck",
                    name: "Fact-Checker",
                    role: "Verification",
                    systemPrompt: "Cross-check dates, numbers, and URLs from peers. Flag any contradiction to @coordinator.",
                    modelPath: "",
                    tools: ["web_search", "fetch_url"],
                    maxSteps: 6,
                  },
                ],
              });
            } else {
              updateNodeConfig(node.id, {
                useWorktrees: false,
                maxRounds: 8,
                coordinatorPrompt:
                  "Coordinate a Red/Blue security audit: @auditor finds concrete vulnerabilities, @verifier tries to reproduce or refute each finding, then call swarm_finish with only verified issues.",
                workers: [
                  {
                    id: "auditor",
                    name: "Red Team Auditor",
                    role: "Vulnerability Discovery",
                    systemPrompt: "Audit code for real security flaws with exact file:line evidence and post candidates to @verifier and @coordinator.",
                    modelPath: "",
                    tools: ["list_files", "grep_search", "read_file", "code_symbols"],
                    maxSteps: 10,
                  },
                  {
                    id: "verifier",
                    name: "Blue Team Verifier",
                    role: "Refutation & Remediation",
                    systemPrompt: "Challenge every finding, check existing mitigations, and propose minimal fixes to @coordinator.",
                    modelPath: "",
                    tools: ["read_file", "grep_search", "run_cmd"],
                    maxSteps: 8,
                  },
                ],
              });
            }
          };

          return (
            <>
              <div className="field">
                <span>{L("Team Presets", "Presets de equipo")}</span>
                <div className="swarm-presets-row">
                  <button type="button" className="btn-secondary" onClick={() => applyPreset("engineering")}>
                    {L("Engineering (3)", "Ingeniería (3)")}
                  </button>
                  <button type="button" className="btn-secondary" onClick={() => applyPreset("research")}>
                    {L("Research (3)", "Investigación (3)")}
                  </button>
                  <button type="button" className="btn-secondary" onClick={() => applyPreset("security")}>
                    {L("Security (2)", "Seguridad (2)")}
                  </button>
                </div>
              </div>

              <label className="field">
                <span>{L("Objective Template", "Objetivo del enjambre")}</span>
                <textarea
                  rows={2}
                  value={String(cfg.objectiveTemplate ?? "{{current_prompt}}")}
                  onChange={(e) => updateNodeConfig(node.id, { objectiveTemplate: e.target.value })}
                />
              </label>

              <label className="field">
                <span>{L("Coordinator Instructions", "Instrucciones del Coordinador")}</span>
                <textarea
                  rows={3}
                  value={String(cfg.coordinatorPrompt ?? "")}
                  onChange={(e) => updateNodeConfig(node.id, { coordinatorPrompt: e.target.value })}
                />
              </label>

              <div className="swarm-grid-2">
                <label className="field">
                  <span>{L("Max Rounds", "Máx. rondas")}</span>
                  <input
                    type="number"
                    min={1}
                    max={30}
                    value={Number(cfg.maxRounds ?? 8)}
                    onChange={(e) =>
                      updateNodeConfig(node.id, { maxRounds: Math.max(1, Number(e.target.value) || 8) })
                    }
                  />
                </label>
                <label className="field">
                  <span>{L("Max Parallel", "Paralelo máx.")}</span>
                  <input
                    type="number"
                    min={1}
                    max={8}
                    value={Number(cfg.maxConcurrency ?? 3)}
                    onChange={(e) =>
                      updateNodeConfig(node.id, { maxConcurrency: Math.max(1, Number(e.target.value) || 3) })
                    }
                  />
                </label>
              </div>

              <label className="field">
                <span>{L("Git Worktree Isolation", "Aislamiento con Git Worktrees")}</span>
                <select
                  value={cfg.useWorktrees ? "true" : "false"}
                  onChange={(e) => updateNodeConfig(node.id, { useWorktrees: e.target.value === "true" })}
                >
                  <option value="false">
                    {L("No — shared workspace (research / sequential edits)", "No — workspace compartido (investigación / edición ligera)")}
                  </option>
                  <option value="true">
                    {L("Yes — isolated worktree per worker + auto-patch", "Sí — worktree aislado por worker + parche automático")}
                  </option>
                </select>
              </label>

              <div className="field">
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span>
                    {L(`Workers (${workers.length})`, `Workers (${workers.length})`)}
                  </span>
                  <button
                    type="button"
                    className="btn-secondary"
                    style={{ padding: "3px 8px", fontSize: 11 }}
                    onClick={() =>
                      setWorkers([
                        ...workers,
                        {
                          id: `worker-${workers.length + 1}`,
                          name: `Worker ${workers.length + 1}`,
                          role: "Specialist",
                          systemPrompt: "Execute assigned tasks and report back to @coordinator.",
                          modelPath: "",
                          tools: ["read_file", "grep_search"],
                          maxSteps: 8,
                        },
                      ])
                    }
                  >
                    + {L("Add worker", "Añadir worker")}
                  </button>
                </div>

                <div className="swarm-workers-editor">
                  {workers.map((w, idx) => (
                    <div key={`${w.id}-${idx}`} className="swarm-worker-card">
                      <div className="swarm-worker-card-head">
                        <input
                          type="text"
                          value={w.id}
                          placeholder="id (e.g. backend)"
                          style={{ width: 92, fontFamily: "monospace", fontSize: 11 }}
                          onChange={(e) =>
                            setWorkers(
                              workers.map((item, i) =>
                                i === idx ? { ...item, id: e.target.value } : item
                              )
                            )
                          }
                        />
                        <input
                          type="text"
                          value={w.role}
                          placeholder={L("Role", "Rol")}
                          style={{ flex: 1, fontSize: 11 }}
                          onChange={(e) =>
                            setWorkers(
                              workers.map((item, i) =>
                                i === idx
                                  ? { ...item, role: e.target.value, name: e.target.value || item.id }
                                  : item
                              )
                            )
                          }
                        />
                        <button
                          type="button"
                          className="icon-btn danger"
                          title={L("Remove worker", "Quitar worker")}
                          onClick={() => setWorkers(workers.filter((_, i) => i !== idx))}
                        >
                          <Trash2 size={12} />
                        </button>
                      </div>
                      <textarea
                        rows={2}
                        value={w.systemPrompt}
                        placeholder={L("Worker instructions...", "Instrucciones del worker...")}
                        onChange={(e) =>
                          setWorkers(
                            workers.map((item, i) =>
                              i === idx ? { ...item, systemPrompt: e.target.value } : item
                            )
                          )
                        }
                      />
                      <input
                        type="text"
                        value={(w.tools ?? []).join(", ")}
                        placeholder="tools: read_file, grep_search, run_cmd..."
                        style={{ fontSize: 11, fontFamily: "monospace" }}
                        onChange={(e) =>
                          setWorkers(
                            workers.map((item, i) =>
                              i === idx
                                ? {
                                    ...item,
                                    tools: e.target.value
                                      .split(",")
                                      .map((s) => s.trim())
                                      .filter(Boolean),
                                  }
                                : item
                            )
                          )
                        }
                      />
                      <input
                        type="text"
                        value={w.modelPath ?? ""}
                        placeholder={L(
                          "Model override (empty = inherit model_ref, or cloud::provider::model)",
                          "Modelo opcional (vacío = hereda model_ref, o cloud::provider::model)"
                        )}
                        style={{ fontSize: 10.5, fontFamily: "monospace" }}
                        onChange={(e) =>
                          setWorkers(
                            workers.map((item, i) =>
                              i === idx ? { ...item, modelPath: e.target.value } : item
                            )
                          )
                        }
                      />
                    </div>
                  ))}
                </div>
              </div>

              <div className="hw-note">
                {L(
                  "Connect a local_model or cloud model to 'model'. Outputs are published to {{swarm_output}}, {{swarm_board}}, and {{agent_output}}.",
                  "Conecta un modelo al puerto 'model'. El resultado se publica en {{swarm_output}}, {{swarm_board}} y {{agent_output}}."
                )}
              </div>
            </>
          );
        })()}

        {node.data.kind === "parallel_fanout" && (
          <>
            <label className="field">
              <span>Aislamiento con Git Worktrees</span>
              <select
                value={cfg.useWorktrees === false ? "false" : "true"}
                onChange={(e) =>
                  updateNodeConfig(node.id, {
                    useWorktrees: e.target.value === "true",
                  })
                }
              >
                <option value="true">
                  {L(
                    "Yes — create 2 isolated temporary git worktrees (Best-of-N)",
                    "Sí — crear 2 git worktrees temporales aislados (Best-of-N)"
                  )}
                </option>
                <option value="false">
                  {L(
                    "No — run both branches in the current workspace",
                    "No — ejecutar ambas ramas sobre el workspace actual"
                  )}
                </option>
              </select>
            </label>
            <div className="hw-note">
              {locale === "es" ? (
                <>
                  Conecta <code>branch_a</code> y <code>branch_b</code> a dos agentes
                  o estrategias distintas, y conecta <code>merged</code> a un{" "}
                  <strong>LLM Judge</strong> o <strong>Agent</strong> para elegir la
                  mejor solución.
                </>
              ) : (
                <>
                  Connect <code>branch_a</code> and <code>branch_b</code> to two
                  different agents or strategies, and connect <code>merged</code> to
                  an <strong>LLM Judge</strong> or <strong>Agent</strong> to pick the
                  best solution.
                </>
              )}
            </div>
          </>
        )}

        {node.data.kind === "subgraph" && (
          <>
            <label className="field">
              <span>{L("Sub-harness .loors.json file", "Archivo .loors.json del Sub-arnés")}</span>
              <input
                type="text"
                placeholder={L("Path to a .loors.json harness", "Ruta a un flujo .loors.json")}
                value={String(cfg.workflowPath ?? "")}
                onChange={(e) =>
                  updateNodeConfig(node.id, { workflowPath: e.target.value })
                }
              />
            </label>
            <button
              type="button"
              className="btn-secondary"
              onClick={handleScanWorkflows}
            >
              <FolderSearch size={14} />
              <span>{L("Choose from Library", "Elegir flujo de Biblioteca")}</span>
            </button>
            {savedWorkflows !== null && (
              <div className="scanned-models">
                {savedWorkflows.length === 0 ? (
                  <div className="hw-note">
                    {L(
                      "No saved harnesses in library yet (use Harnesses / Import → Save).",
                      "Aún no hay flujos guardados en la biblioteca (usa Flujos / Importar → Guardar)."
                    )}
                  </div>
                ) : (
                  savedWorkflows.map((wf) => (
                    <button
                      key={wf.path}
                      type="button"
                      className="model-pick"
                      onClick={() => {
                        updateNodeTitle(node.id, `Sub: ${wf.name}`);
                        updateNodeConfig(node.id, { workflowPath: wf.path });
                      }}
                    >
                      <span className="model-pick-name">{wf.name}</span>
                      <span className="model-pick-size">.loors.json</span>
                    </button>
                  ))
                )}
              </div>
            )}
            <label className="field">
              <span>{L("Prompt injected into sub-harness", "Prompt inyectado al sub-arnés")}</span>
              <textarea
                rows={3}
                value={String(cfg.inputTemplate ?? "{{current_prompt}}")}
                onChange={(e) =>
                  updateNodeConfig(node.id, { inputTemplate: e.target.value })
                }
              />
            </label>
          </>
        )}

        {node.data.kind === "custom" && (
          <>
            <div className="hw-note">
              Runner: <strong>{String(cfg.runner ?? "shell")}</strong>
            </div>
            {Array.isArray(cfg.customFields) &&
              (cfg.customFields as CustomFieldDef[]).map((f) => (
                <label key={f.key} className="field">
                  <span>
                    {f.label} (<code>{`{{${f.key}}}`}</code>)
                  </span>
                  {f.fieldType === "textarea" ? (
                    <textarea
                      rows={3}
                      value={String(cfg[f.key] ?? f.defaultValue ?? "")}
                      onChange={(e) =>
                        updateNodeConfig(node.id, { [f.key]: e.target.value })
                      }
                    />
                  ) : (
                    <input
                      type={f.fieldType === "number" ? "number" : "text"}
                      value={String(cfg[f.key] ?? f.defaultValue ?? "")}
                      onChange={(e) =>
                        updateNodeConfig(node.id, {
                          [f.key]:
                            f.fieldType === "number"
                              ? Number(e.target.value)
                              : e.target.value,
                        })
                      }
                    />
                  )}
                </label>
              ))}
            {cfg.runner === "shell" && (
              <label className="field">
                <span>{L("Command template", "Plantilla de comando")}</span>
                <input
                  type="text"
                  value={String(cfg.commandTemplate ?? "")}
                  onChange={(e) =>
                    updateNodeConfig(node.id, {
                      commandTemplate: e.target.value,
                    })
                  }
                />
              </label>
            )}
            {cfg.runner === "prompt" && (
              <label className="field">
                <span>{L("Prompt template", "Plantilla de prompt")}</span>
                <textarea
                  rows={4}
                  value={String(cfg.promptTemplate ?? "")}
                  onChange={(e) =>
                    updateNodeConfig(node.id, {
                      promptTemplate: e.target.value,
                    })
                  }
                />
              </label>
            )}
            {cfg.runner === "http" && (
              <label className="field">
                <span>URL</span>
                <input
                  type="text"
                  value={String(cfg.httpUrl ?? "")}
                  onChange={(e) =>
                    updateNodeConfig(node.id, { httpUrl: e.target.value })
                  }
                />
              </label>
            )}
          </>
        )}

        {node.data.kind === "notify" && (() => {
          const channel = String(cfg.channel ?? "telegram");
          return (
            <>
              <label className="field">
                <span>{L("Delivery channel", "Canal de envío")}</span>
                <select
                  value={channel}
                  onChange={(e) =>
                    updateNodeConfig(node.id, { channel: e.target.value })
                  }
                >
                  <option value="telegram">Telegram Bot</option>
                  <option value="discord">Discord Webhook</option>
                  <option value="webhook">Webhook HTTP (JSON POST)</option>
                </select>
              </label>

              {channel === "telegram" ? (
                <>
                  <label className="field">
                    <span>Bot Token</span>
                    <input
                      type="password"
                      placeholder="Vacío = heredar del Trigger Telegram o ${TELEGRAM_BOT_TOKEN}"
                      value={String(cfg.botToken ?? "")}
                      onChange={(e) =>
                        updateNodeConfig(node.id, { botToken: e.target.value })
                      }
                    />
                  </label>
                  <label className="field">
                    <span>Chat ID destino</span>
                    <input
                      type="text"
                      placeholder="Vacío = responder al mismo chat del Trigger"
                      value={String(cfg.chatId ?? "")}
                      onChange={(e) =>
                        updateNodeConfig(node.id, { chatId: e.target.value })
                      }
                    />
                  </label>
                </>
              ) : (
                <label className="field">
                  <span>Webhook URL</span>
                  <input
                    type="text"
                    placeholder={
                      channel === "discord"
                        ? "https://discord.com/api/webhooks/..."
                        : "https://ejemplo.com/webhook"
                    }
                    value={String(cfg.webhookUrl ?? "")}
                    onChange={(e) =>
                      updateNodeConfig(node.id, { webhookUrl: e.target.value })
                    }
                  />
                </label>
              )}

              <label className="field">
                <span>{L("Message template", "Plantilla del mensaje")}</span>
                <textarea
                  rows={4}
                  value={String(cfg.messageTemplate ?? "{{agent_output}}")}
                  onChange={(e) =>
                    updateNodeConfig(node.id, {
                      messageTemplate: e.target.value,
                    })
                  }
                />
              </label>
              <VarInserter
                onInsert={(v) =>
                  updateNodeConfig(node.id, {
                    messageTemplate: `${String(cfg.messageTemplate ?? "")}${v}`,
                  })
                }
              />
            </>
          );
        })()}

        {node.data.kind === "for_each" && (
          <>
            <label className="field">
              <span>{locale === "es" ? "Fuente de elementos (JSON array o líneas)" : "Items source (JSON array or lines)"}</span>
              <input
                type="text"
                value={String(cfg.itemsSource ?? "{{agent_output}}")}
                onChange={(e) =>
                  updateNodeConfig(node.id, { itemsSource: e.target.value })
                }
              />
              <VarInserter
                onInsert={(tok) =>
                  updateNodeConfig(node.id, { itemsSource: tok })
                }
              />
            </label>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              <label className="field">
                <span>{locale === "es" ? "Modo de división" : "Split mode"}</span>
                <select
                  value={String(cfg.splitMode ?? "auto")}
                  onChange={(e) =>
                    updateNodeConfig(node.id, { splitMode: e.target.value })
                  }
                >
                  <option value="auto">Auto (JSON / lines)</option>
                  <option value="json_array">JSON Array</option>
                  <option value="lines">Lines</option>
                </select>
              </label>
              <label className="field">
                <span>{locale === "es" ? "Máx. items (0 = todos)" : "Max items (0 = all)"}</span>
                <input
                  type="number"
                  min="0"
                  max="1000"
                  value={Number(cfg.maxItems ?? 0)}
                  onChange={(e) =>
                    updateNodeConfig(node.id, {
                      maxItems: Math.max(0, Number(e.target.value)),
                    })
                  }
                />
              </label>
            </div>
          </>
        )}

        {node.data.kind === "json_validator" && (
          <>
            <label className="field">
              <span>{locale === "es" ? "Fuente a validar" : "Source to validate"}</span>
              <input
                type="text"
                value={String(cfg.sourceTemplate ?? "{{agent_output}}")}
                onChange={(e) =>
                  updateNodeConfig(node.id, { sourceTemplate: e.target.value })
                }
              />
              <VarInserter
                onInsert={(tok) =>
                  updateNodeConfig(node.id, { sourceTemplate: tok })
                }
              />
            </label>
            <label className="field">
              <span>{locale === "es" ? "Tipo JSON esperado" : "Expected JSON type"}</span>
              <select
                value={String(cfg.expectType ?? "object")}
                onChange={(e) =>
                  updateNodeConfig(node.id, { expectType: e.target.value })
                }
              >
                <option value="object">Object {"{...}"}</option>
                <option value="array">Array {"[...]"}</option>
                <option value="any">Any valid JSON</option>
              </select>
            </label>
            <label className="field">
              <span>{locale === "es" ? "Claves obligatorias (separadas por comas)" : "Required keys (comma-separated)"}</span>
              <input
                type="text"
                placeholder="title, summary, url"
                value={String(cfg.requiredKeys ?? "")}
                onChange={(e) =>
                  updateNodeConfig(node.id, { requiredKeys: e.target.value })
                }
              />
            </label>
          </>
        )}

        {node.data.kind === "output" && (
          <label className="field">
            <span>{L("Output label", "Etiqueta de salida")}</span>
            <input
              type="text"
              value={String(cfg.label ?? "")}
              onChange={(e) =>
                updateNodeConfig(node.id, { label: e.target.value })
              }
            />
          </label>
        )}
      </div>
    </div>
  );
}
