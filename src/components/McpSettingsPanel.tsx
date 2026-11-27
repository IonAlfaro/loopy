import { useEffect, useState } from "react";
import { PlugZap, Plus, Trash2 } from "lucide-react";
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
  const L = (en: string, es: string) => locale === "es" ? es : en;
  const [servers, setServers] = useState<SavedMcpServer[]>([]);
  const [loading, setLoading] = useState(true);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, string>>({});

  const [adding, setAdding] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [command, setCommand] = useState("npx");
  const [argsText, setArgsText] = useState("");
  const [envText, setEnvText] = useState("");

  useEffect(() => {
    invoke<SavedMcpServer[]>("get_mcp_servers")
      .then((list) => setServers(list))
      .catch((err) => setError(String(err)))
      .finally(() => setLoading(false));
  }, []);

  const persist = async (next: SavedMcpServer[], toast?: string) => {
    setSaving(true);
    setError(null);
    try {
      await invoke("save_mcp_servers", { servers: next });
      setServers(next);
      if (toast) onNotice?.(toast);
      return true;
    } catch (err) {
      setError(String(err));
      return false;
    } finally {
      setSaving(false);
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
    const saved = await persist(
      [...servers, created],
      locale === "es"
        ? `Servidor MCP '${cleanName}' guardado para Modo Agente.`
        : `MCP server '${cleanName}' saved for Agent Mode.`
    );
    if (!saved) return;
    setAdding(false);
    setName("");
    setCommand("npx");
    setArgsText("");
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
    <div className="mcp-settings">
      <div className="mcp-list-head">
        <p>{L("Connect tools that the agent can use in its conversations.", "Conecta herramientas que el agente puede usar en sus conversaciones.")}</p>
        {!adding && (
          <button type="button" className="btn-primary" onClick={() => setAdding(true)}>
            <Plus size={14} /> {L("Add server", "Añadir servidor")}
          </button>
        )}
      </div>

      {error && <p className="mcp-settings-error" role="alert">{error}</p>}

      {loading ? (
        <p className="mcp-settings-note" role="status">{L("Loading servers…", "Cargando servidores…")}</p>
      ) : servers.length > 0 ? (
        <ul className="mcp-server-list">
          {servers.map((server) => (
            <li key={server.id}>
              <div className="mcp-server-row">
                <span className="mcp-server-icon"><PlugZap size={16} /></span>
                <div className="mcp-server-meta">
                  <strong className="truncate-text" title={server.name}>{server.name}</strong>
                  <code className="truncate-text" title={[server.command, ...server.args].join(" ")}>
                    {server.command} {server.args.join(" ")}
                  </code>
                </div>
                <div className="mcp-server-actions">
                  <label className="mcp-server-enabled">
                    <span>{server.enabled ? L("Enabled", "Activo") : L("Disabled", "Desactivado")}</span>
                    <input type="checkbox" role="switch" checked={server.enabled} disabled={saving}
                      aria-label={`${L("Enable", "Activar")} ${server.name}`}
                      onChange={(event) => {
                        const enabled = event.target.checked;
                        void persist(servers.map((item) => item.id === server.id ? { ...item, enabled } : item));
                      }} />
                  </label>
                  <button type="button" className="btn-secondary" disabled={testingId !== null || saving} onClick={() => void handleTest(server)}>
                    {testingId === server.id ? L("Testing…", "Probando…") : L("Test", "Probar")}
                  </button>
                  <button type="button" className="icon-btn danger" disabled={saving || testingId === server.id}
                    aria-label={`${L("Remove", "Eliminar")} ${server.name}`}
                    title={L("Remove server", "Eliminar servidor")}
                    onClick={() => void persist(servers.filter((item) => item.id !== server.id), L("MCP server removed.", "Servidor MCP eliminado."))}>
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
              {testResults[server.id] && (
                <p className="mcp-test-result" data-error={testResults[server.id].startsWith("Error:")} role="status">
                  {testResults[server.id]}
                </p>
              )}
            </li>
          ))}
        </ul>
      ) : !adding && !error && (
        <div className="mcp-settings-empty">
          <span className="mcp-server-icon"><PlugZap size={18} /></span>
          <div>
            <strong>{L("No servers configured", "Todavía no hay servidores")}</strong>
            <p>{L("Add a server to make its tools available to Agent Mode.", "Añade un servidor para usar sus herramientas en el modo Agente.")}</p>
          </div>
        </div>
      )}

      {adding && (
        <form className="mcp-add-form" onSubmit={(event) => { event.preventDefault(); if (!loading && !saving) void handleAdd(); }}>
          <h3>{L("New MCP server", "Nuevo servidor MCP")}</h3>
          <div className="mcp-form-grid">
            <label className="field">
              <span>{L("Name", "Nombre")}</span>
              <input type="text" value={name} placeholder="filesystem" autoFocus required onChange={(event) => setName(event.target.value)} />
            </label>
            <label className="field">
              <span>{L("Command", "Comando")}</span>
              <input type="text" value={command} placeholder="npx" required onChange={(event) => setCommand(event.target.value)} />
            </label>
          </div>
          <label className="field">
            <span>{L("Arguments", "Argumentos")}</span>
            <input type="text" value={argsText} onChange={(event) => setArgsText(event.target.value)}
              placeholder={L("Separate arguments with spaces", "Separa los argumentos con espacios")} />
          </label>
          <details className="mcp-form-advanced">
            <summary>{L("Environment variables", "Variables de entorno")}</summary>
            <label className="field">
              <span>{L("Optional · one KEY=VALUE per line", "Opcional · un par CLAVE=VALOR por línea")}</span>
              <textarea rows={3} value={envText} onChange={(event) => setEnvText(event.target.value)}
                placeholder={"API_TOKEN=${API_TOKEN}"} />
            </label>
          </details>
          <div className="mcp-form-footer">
            <button type="button" className="btn-secondary" disabled={saving} onClick={() => setAdding(false)}>
              {L("Cancel", "Cancelar")}
            </button>
            <button type="submit" className="btn-primary" disabled={loading || saving || !name.trim() || !command.trim()}>
              {saving ? L("Saving…", "Guardando…") : L("Add server", "Añadir servidor")}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
