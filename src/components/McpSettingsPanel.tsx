import { useEffect, useState } from "react";
import { Check, PlugZap, Plus, Trash2 } from "lucide-react";
import { invoke } from "../lib/bridge";
import { useI18n } from "../i18n";
import type { SavedMcpServer } from "../types/graph";

interface McpToolInfo {
  name: string;
  description: string;
}

interface McpSettingsPanelProps {
  onNotice?: (msg: string) => void;
}

export function McpSettingsPanel({ onNotice }: McpSettingsPanelProps) {
  const { locale } = useI18n();
  const [servers, setServers] = useState<SavedMcpServer[]>([]);
  const [loading, setLoading] = useState(true);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, string>>({});

  // Quick-add form
  const [name, setName] = useState("");
  const [command, setCommand] = useState("npx");
  const [argsText, setArgsText] = useState("-y @modelcontextprotocol/server-filesystem .");
  const [envText, setEnvText] = useState("");

  useEffect(() => {
    invoke<SavedMcpServer[]>("get_mcp_servers")
      .then((list) => setServers(list))
      .catch(() => setServers([]))
      .finally(() => setLoading(false));
  }, []);

  const persist = async (next: SavedMcpServer[], toast?: string) => {
    setServers(next);
    try {
      await invoke("save_mcp_servers", { servers: next });
      if (toast) onNotice?.(toast);
    } catch (err) {
      onNotice?.(String(err));
    }
  };

  const handleAdd = async () => {
    const cleanName = name.trim();
    const cleanCmd = command.trim();
    if (!cleanName || !cleanCmd) return;
    const args = argsText
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    const env: Record<string, string> = {};
    for (const line of envText.split("\n")) {
      const idx = line.indexOf("=");
      if (idx > 0) {
        const k = line.slice(0, idx).trim();
        const v = line.slice(idx + 1).trim();
        if (k) env[k] = v;
      }
    }
    const created: SavedMcpServer = {
      id: `mcp-${Date.now().toString(36)}`,
      name: cleanName,
      enabled: true,
      command: cleanCmd,
      args,
      env,
      allowedTools: [],
    };
    await persist(
      [...servers, created],
      locale === "es"
        ? `Servidor MCP '${cleanName}' guardado para Modo Agente.`
        : `MCP server '${cleanName}' saved for Agent Mode.`
    );
    setName("");
    setEnvText("");
  };

  const handleTest = async (srv: SavedMcpServer) => {
    setTestingId(srv.id);
    setTestResults((prev) => ({
      ...prev,
      [srv.id]: locale === "es" ? "Conectando..." : "Connecting...",
    }));
    try {
      const tools = await invoke<McpToolInfo[]>("test_mcp_server", {
        config: {
          name: srv.name,
          command: srv.command,
          args: srv.args,
          env: srv.env,
          allowedTools: srv.allowedTools,
        },
        workspace: ".",
      });
      setTestResults((prev) => ({
        ...prev,
        [srv.id]:
          tools.length > 0
            ? `OK (${tools.length}): ${tools.slice(0, 6).map((t) => t.name).join(", ")}${tools.length > 6 ? "..." : ""}`
            : locale === "es"
              ? "Conectado (0 herramientas)."
              : "Connected (0 tools).",
      }));
    } catch (err) {
      setTestResults((prev) => ({
        ...prev,
        [srv.id]: `Error: ${String(err)}`,
      }));
    } finally {
      setTestingId(null);
    }
  };

  return (
    <div className="settings-section-stack">
      <div className="settings-group">
        <div className="settings-group-title">
          {locale === "es"
            ? "Servidores MCP en Modo Agente"
            : "MCP Servers for Agent Mode"}
        </div>
        <div className="settings-group-desc">
          {locale === "es"
            ? "Los servidores activos se conectan automáticamente en el chat del Modo Agente y exponen sus herramientas como mcp__<servidor>__<tool>. Admite variables ${ENV_VAR} en env."
            : "Enabled servers connect automatically in Agent Mode chat and expose their tools as mcp__<server>__<tool>. Supports ${ENV_VAR} expansion in env values."}
        </div>

        {loading ? (
          <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
            {locale === "es" ? "Cargando servidores MCP..." : "Loading MCP servers..."}
          </div>
        ) : servers.length === 0 ? (
          <div
            style={{
              padding: "12px 14px",
              borderRadius: 8,
              border: "1px dashed var(--border-subtle)",
              fontSize: 12,
              color: "var(--text-muted)",
            }}
          >
            {locale === "es"
              ? "Aún no tienes servidores MCP configurados. Añade uno abajo (ej. filesystem, github, postgres, brave-search)."
              : "No MCP servers configured yet. Add one below (e.g. filesystem, github, postgres, brave-search)."}
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {servers.map((srv) => (
              <div
                key={srv.id}
                style={{
                  padding: "10px 12px",
                  borderRadius: 8,
                  background: "var(--bg-surface-2)",
                  border: "1px solid var(--border-subtle)",
                  display: "flex",
                  flexDirection: "column",
                  gap: 6,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                  <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                    <input
                      type="checkbox"
                      checked={srv.enabled}
                      onChange={(e) => {
                        const next = servers.map((s) =>
                          s.id === srv.id ? { ...s, enabled: e.target.checked } : s
                        );
                        void persist(next);
                      }}
                    />
                    <strong style={{ fontSize: 13 }}>{srv.name}</strong>
                    <code style={{ fontSize: 11, color: "var(--text-muted)" }}>
                      {srv.command} {srv.args.join(" ")}
                    </code>
                  </label>
                  <div style={{ display: "flex", gap: 6 }}>
                    <button
                      type="button"
                      className="btn-secondary btn-xs"
                      disabled={testingId === srv.id}
                      onClick={() => void handleTest(srv)}
                    >
                      <PlugZap size={12} />
                      <span>{locale === "es" ? "Probar" : "Test"}</span>
                    </button>
                    <button
                      type="button"
                      className="btn-secondary btn-xs"
                      title={locale === "es" ? "Eliminar" : "Delete"}
                      onClick={() =>
                        void persist(
                          servers.filter((s) => s.id !== srv.id),
                          locale === "es" ? "Servidor MCP eliminado." : "MCP server removed."
                        )
                      }
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                </div>
                {testResults[srv.id] && (
                  <div style={{ fontSize: 11, color: testResults[srv.id].startsWith("OK") ? "#4ade80" : "#f87171" }}>
                    {testResults[srv.id]}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="settings-group">
        <div className="settings-group-title">
          {locale === "es" ? "Añadir servidor MCP (stdio)" : "Add MCP Server (stdio)"}
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          <label className="field">
            <span>{locale === "es" ? "Nombre" : "Name"}</span>
            <input
              type="text"
              placeholder="github / filesystem / postgres"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label className="field">
            <span>{locale === "es" ? "Comando" : "Command"}</span>
            <input
              type="text"
              placeholder="npx / uvx / node / python"
              value={command}
              onChange={(e) => setCommand(e.target.value)}
            />
          </label>
        </div>
        <label className="field">
          <span>{locale === "es" ? "Argumentos (separados por espacio)" : "Arguments (space-separated)"}</span>
          <input
            type="text"
            value={argsText}
            onChange={(e) => setArgsText(e.target.value)}
          />
        </label>
        <label className="field">
          <span>{locale === "es" ? "Variables de entorno (KEY=VALUE, una por línea, opcional)" : "Environment variables (KEY=VALUE per line, optional)"}</span>
          <textarea
            rows={2}
            placeholder="GITHUB_TOKEN=${GITHUB_TOKEN}"
            value={envText}
            onChange={(e) => setEnvText(e.target.value)}
          />
        </label>
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <button
            type="button"
            className="btn-primary btn-xs"
            disabled={!name.trim() || !command.trim()}
            onClick={() => void handleAdd()}
          >
            {name.trim() ? <Plus size={13} /> : <Check size={13} />}
            <span>{locale === "es" ? "Añadir servidor MCP" : "Add MCP Server"}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
