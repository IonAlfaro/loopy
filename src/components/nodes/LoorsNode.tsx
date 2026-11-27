import { Handle, Position, type NodeProps } from "@xyflow/react";
import {
  Bot,
  Boxes,
  CheckCircle2,
  Cpu,
  FileText,
  Flag,
  GitBranch,
  GitCommitHorizontal,
  GitFork,
  Globe,
  Layers,
  Minimize2,
  PlayCircle,
  PlugZap,
  Radio,
  Repeat,
  Scale,
  Send,
  ShieldAlert,
  Sparkles,
  Terminal,
  Users,
  Wrench,
} from "lucide-react";
import {
  isResourceKind,
  NODE_BLUEPRINTS,
  type LoorsFlowNode,
  type LoorsNodeKind,
  type PortKind,
} from "../../types/graph";
import { useGraphStore } from "../../store/useGraphStore";

const PORT_COLORS: Record<PortKind, string> = {
  exec: "#94a3b8",
  model: "#a855f7",
  skill: "#2dd4bf",
  mcp: "#fb923c",
  data: "#38bdf8",
  true: "#22c55e",
  false: "#ef4444",
  retry: "#4ade80",
};

function NodeIcon({ kind }: { kind: LoorsNodeKind }) {
  const props = { size: 13, strokeWidth: 2.1 };
  switch (kind) {
    case "task_input":
      return <PlayCircle {...props} />;
    case "trigger":
      return <Radio {...props} />;
    case "local_model":
      return <Cpu {...props} />;
    case "skill":
      return <Sparkles {...props} />;
    case "mcp_server":
      return <PlugZap {...props} />;
    case "agent":
      return <Bot {...props} />;
    case "llm_judge":
      return <Scale {...props} />;
    case "shell":
      return <Terminal {...props} />;
    case "http_request":
      return <Globe {...props} />;
    case "memory_file":
      return <FileText {...props} />;
    case "condition":
      return <GitBranch {...props} />;
    case "loop_guard":
      return <Repeat {...props} />;
    case "for_each":
      return <Repeat {...props} />;
    case "json_validator":
      return <CheckCircle2 {...props} />;
    case "git_checkpoint":
      return <GitCommitHorizontal {...props} />;
    case "context_compactor":
      return <Minimize2 {...props} />;
    case "human_gate":
      return <ShieldAlert {...props} />;
    case "parallel_fanout":
      return <GitFork {...props} />;
    case "swarm":
      return <Users {...props} />;
    case "subgraph":
      return <Layers {...props} />;
    case "custom":
      return <Wrench {...props} />;
    case "notify":
      return <Send {...props} />;
    case "output":
      return <Flag {...props} />;
    default:
      return <Boxes {...props} />;
  }
}

function summarizeConfig(node: LoorsFlowNode["data"], locale: "en" | "es"): string {
  const es = locale === "es";
  const c = node.config;
  switch (node.kind) {
    case "task_input": {
      const ws = String(c.workspace ?? "").trim();
      const wsLabel =
        !ws || ws === "."
          ? es ? "Sin proyecto" : "No project"
          : ws.split(/[\\/]/).filter(Boolean).pop() ?? ws;
      const promptShort = String(c.prompt ?? "").slice(0, 42) || (es ? "Sin prompt" : "No prompt");
      return `${wsLabel} · ${promptShort}`;
    }
    case "trigger": {
      const tType = String(c.triggerType ?? "webhook");
      if (tType === "interval") {
        return es
          ? `Cron · cada ${Number(c.intervalMinutes ?? 30)} min`
          : `Cron · every ${Number(c.intervalMinutes ?? 30)} min`;
      }
      if (tType === "telegram") {
        const cid = String(c.allowedChatId ?? "").trim();
        return cid ? `Telegram Bot · chat ${cid}` : "Telegram Bot (polling)";
      }
      return `Webhook HTTP · :${Number(c.webhookPort ?? 14290)}/trigger`;
    }
    case "workspace": {
      const p = String(c.path ?? "").trim();
      return p ? p.split(/[\\/]/).filter(Boolean).pop() ?? p : es ? "Sin carpeta asignada" : "No folder selected";
    }
    case "local_model": {
      const p = String(c.modelPath ?? (es ? "Sin GGUF" : "No model"));
      const name = p.split(/[\\/]/).pop() || p;
      const ctx = Number(c.contextSize ?? 0);
      return `${name} · ${ctx === 0 ? "Auto ctx" : `${Math.round(ctx / 1024)}k`}`;
    }
    case "skill":
      return `${String(c.mode ?? "inject")} · ${String(c.skillPath || "inline")}`;
    case "mcp_server":
      return `${String(c.serverName ?? "mcp")} (${String(c.command ?? "")})`;
    case "agent": {
      const tools = Array.isArray(c.tools) ? c.tools.length : 0;
      const ms = Number(c.maxSteps ?? 0);
      return `${tools} tools · ${
        ms === 0
          ? es ? "Sin límite de pasos" : "Unlimited steps"
          : es ? `max ${ms} pasos` : `max ${ms} steps`
      }`;
    }
    case "shell":
      return `$ ${String(c.command ?? "")}`;
    case "condition":
      return String(c.expression ?? "");
    case "loop_guard": {
      const mi = Number(c.maxIterations ?? 0);
      return mi === 0
        ? es ? "Continuo (sin límite)" : "Continuous (no limit)"
        : es ? `max ${mi} iteraciones` : `max ${mi} iterations`;
    }
    case "git_checkpoint":
      return `${es ? "modo" : "mode"}: ${String(c.mode ?? "diff")}`;
    case "context_compactor":
      return `max ${String(c.maxChars ?? 4000)} chars`;
    case "human_gate":
      return String(c.message ?? (es ? "Esperar aprobación" : "Wait for approval")).slice(0, 56);
    case "memory_file":
      return `${String(c.mode ?? "read")} · ${String(c.filePath ?? "")}`;
    case "knowledge_rag":
      return `${String(c.mode ?? "hybrid")} · top ${String(c.topK ?? 5)} · ${String(c.maxChars ?? 6000)}c`;
    case "llm_judge":
      return String(c.rubric ?? (es ? "Evaluar calidad" : "Evaluate quality")).slice(0, 56);
    case "http_request":
      return `${String(c.method ?? "GET")} ${String(c.url ?? "")}`.slice(0, 56);
    case "parallel_fanout":
      return c.useWorktrees
        ? es ? "2 ramas · git worktrees aislados" : "2 branches · isolated git worktrees"
        : es ? "2 ramas en paralelo" : "2 parallel branches";
    case "swarm": {
      const workers = Array.isArray(c.workers) ? c.workers.length : 0;
      const rounds = Number(c.maxRounds ?? 8);
      const wt = Boolean(c.useWorktrees);
      return es
        ? `${workers} workers · máx ${rounds} rondas${wt ? " · worktrees" : ""}`
        : `${workers} workers · max ${rounds} rounds${wt ? " · worktrees" : ""}`;
    }
    case "subgraph":
      return String(c.workflowPath || (es ? "Sin .loors.json asignado" : "No .loors.json assigned")).slice(0, 56);
    case "custom":
      return `${String(c.runner ?? "shell")} · ${String(c.commandTemplate || c.httpUrl || c.promptTemplate || "custom")}`.slice(
        0,
        56
      );
    case "notify": {
      const ch = String(c.channel ?? "telegram");
      if (ch === "telegram") {
        const cid = String(c.chatId ?? "").trim();
        return cid ? `Telegram · chat ${cid}` : es ? "Telegram · responde al Trigger" : "Telegram · replies to Trigger";
      }
      if (ch === "discord") {
        return "Discord Webhook";
      }
      return `Webhook · ${String(c.webhookUrl ?? "").slice(0, 34) || (es ? "sin URL" : "no URL")}`;
    }
    case "for_each": {
      const maxI = Number(c.maxItems ?? 0);
      return maxI > 0 ? `each (max ${maxI})` : `each (${String(c.splitMode ?? "auto")})`;
    }
    case "json_validator": {
      const keys = String(c.requiredKeys ?? "").trim();
      return keys ? `JSON · ${keys}` : `JSON (${String(c.expectType ?? "object")})`;
    }
    case "output":
      return String(c.label ?? (es ? "Fin" : "Done"));
  }
}

export function LoorsNode({ id, data, selected }: NodeProps<LoorsFlowNode>) {
  const edges = useGraphStore((s) => s.edges);
  const locale = useGraphStore((s) => s.locale);
  const swarmAgents = useGraphStore((s) => s.swarmAgents);
  const bp = NODE_BLUEPRINTS[data.kind];
  const nodeSwarmRoster =
    data.kind === "swarm"
      ? Object.values(swarmAgents).filter((a) => a.nodeId === id)
      : [];
  const isResource = isResourceKind(data.kind);
  const accent =
    data.kind === "custom" && typeof data.config.accent === "string"
      ? data.config.accent
      : bp.accent;

  const hasExecEdge = edges.some(
    (e) =>
      (e.source === id && e.sourceHandle === "exec") ||
      (e.target === id && e.targetHandle === "exec")
  );
  const hideExec =
    (data.kind === "workspace" || data.kind === "knowledge_rag") &&
    data.config.inlineExec !== true &&
    !hasExecEdge;

  const visibleInputs = hideExec
    ? bp.inputs.filter((p) => p.kind !== "exec")
    : bp.inputs;
  const visibleOutputs = hideExec
    ? bp.outputs.filter((p) => p.kind !== "exec")
    : bp.outputs;
  const rows = Math.max(visibleInputs.length, visibleOutputs.length);

  return (
    <div
      className={`loors-node ${isResource ? "is-resource" : "is-step"} ${
        selected ? "is-selected" : ""
      } status-${data.status}`}
      style={{ ["--node-accent" as string]: accent }}
    >
      <div className="loors-node-header">
        <span className="loors-node-icon" style={{ color: accent }}>
          <NodeIcon kind={data.kind} />
        </span>
        <span className="loors-node-title">{data.title}</span>
        {data.status === "success" ? (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 4, flexShrink: 0 }}>
            {data.statusMessage && (
              <span style={{ fontSize: 10, color: "#a1a1aa", fontVariantNumeric: "tabular-nums" }}>
                {data.statusMessage}
              </span>
            )}
            <CheckCircle2 size={13} style={{ color: "#4ade80", flexShrink: 0 }} />
          </span>
        ) : (
          <span
            className={`loors-node-badge ${
              isResource ? "badge-resource" : "badge-step"
            }`}
          >
            {isResource
              ? locale === "es"
                ? "RECURSO"
                : "RESOURCE"
              : locale === "es"
                ? "PASO"
                : "STEP"}
          </span>
        )}
      </div>

      <div className="loors-node-summary">{summarizeConfig(data, locale)}</div>

      {nodeSwarmRoster.length > 0 && (
        <div className="swarm-node-roster">
          {nodeSwarmRoster.map((a) => (
            <span
              key={a.agentId}
              className={`swarm-roster-chip is-${a.status}`}
              title={`${a.agentName} (${a.role}): ${a.summary}`}
            >
              <span className="swarm-roster-dot" />
              <span>@{a.agentId}</span>
            </span>
          ))}
        </div>
      )}

      {data.status === "running" && data.statusMessage && (
        <div className="loors-node-live">
          <span className="live-pulse" />
          <span>{data.statusMessage}</span>
        </div>
      )}

      <div className="loors-node-ports">
        {Array.from({ length: rows }).map((_, idx) => {
          const inp = visibleInputs[idx];
          const out = visibleOutputs[idx];
          return (
            <div key={idx} className="loors-port-row">
              <div className="loors-port-left">
                {inp && (
                  <>
                    <Handle
                      type="target"
                      position={Position.Left}
                      id={inp.id}
                      className={`loors-handle ${
                        inp.kind === "exec" ? "handle-exec" : "handle-data"
                      }`}
                      style={{ background: PORT_COLORS[inp.kind] }}
                    />
                    <span className="loors-port-label">{inp.label}</span>
                  </>
                )}
              </div>
              <div className="loors-port-right">
                {out && (
                  <>
                    <span className="loors-port-label">{out.label}</span>
                    <Handle
                      type="source"
                      position={Position.Right}
                      id={out.id}
                      className={`loors-handle ${
                        out.kind === "exec" ? "handle-exec" : "handle-data"
                      }`}
                      style={{ background: PORT_COLORS[out.kind] }}
                    />
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
