import { Handle, Position, useConnection, type NodeProps } from "@xyflow/react";
import {
  Bot,
  Boxes,
  CheckCircle2,
  Cpu,
  FileText,
  FileSpreadsheet,
  Filter,
  Flag,
  GitBranch,
  GitCommitHorizontal,
  GitFork,
  Globe,
  Layers,
  LoaderCircle,
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
  type PortSpec,
} from "../../types/graph";
import { getNodeLabel } from "../../i18n";
import { arePortsCompatible, getPortLabel, getVisibleNodePorts, PORT_COLORS } from "../nodePorts";
import { useGraphStore } from "../../store/useGraphStore";

export function NodeIcon({ kind }: { kind: LoorsNodeKind }) {
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
    case "data_transform":
      return <Filter {...props} />;
    case "create_excel":
    case "create_csv":
      return <FileSpreadsheet {...props} />;
    case "create_word":
    case "create_pdf":
    case "read_document":
      return <FileText {...props} />;
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

export function LoorsNode({ id, data, selected }: NodeProps<LoorsFlowNode>) {
  const edges = useGraphStore((s) => s.edges);
  const inspectorSelected = useGraphStore((s) => s.selectedNodeId === id);
  const fromHandle = useConnection((connection) => connection.fromHandle);
  const locale = useGraphStore((s) => s.locale);
  const swarmAgents = useGraphStore((s) => s.swarmAgents);
  const bp = NODE_BLUEPRINTS[data.kind];
  const statusLabels = locale === "es"
    ? { running: "En ejecución", success: "Completado", idle: "En espera" }
    : { running: "Running", success: "Completed", idle: "Idle" };
  const statusLabel = data.statusMessage ||
    (data.status in statusLabels
      ? statusLabels[data.status as keyof typeof statusLabels]
      : data.status);
  const nodeSwarmRoster =
    data.kind === "swarm"
      ? Object.values(swarmAgents).filter((a) => a.nodeId === id)
      : [];
  const isResource = isResourceKind(data.kind);
  const accent =
    data.kind === "custom" && typeof data.config.accent === "string"
      ? data.config.accent
      : bp.accent;

  const { inputs: visibleInputs, outputs: visibleOutputs } = getVisibleNodePorts(id, data, edges);
  const rows = Math.max(visibleInputs.length, visibleOutputs.length);
  const typeLabel = getNodeLabel(data.kind, locale);
  const title = data.title === bp.label ? typeLabel : data.title;

  const portClass = (port: PortSpec, type: "source" | "target") => {
    const compatible = fromHandle && fromHandle.type !== type
      && arePortsCompatible(fromHandle.id, port.id);
    return ["loors-handle", port.kind === "exec" ? "handle-exec" : "handle-data",
      compatible && "is-compatible"].filter(Boolean).join(" ");
  };

  return (
    <div
      className={`loors-node ${isResource ? "is-resource" : "is-step"} ${
        selected || inspectorSelected ? "is-selected" : ""
      } ${fromHandle ? "is-wiring" : ""} status-${data.status}`}
      style={{ ["--node-accent" as string]: accent }}
    >
      <div className="loors-node-header">
        <span className="loors-node-icon" style={{ color: accent }}>
          <NodeIcon kind={data.kind} />
        </span>
        <div className="loors-node-heading">
          <span className="loors-node-title" title={title}>{title}</span>
          {title !== typeLabel && <span className="loors-node-type">{typeLabel}</span>}
        </div>
        {data.status !== "idle" && (
          <span
            className="loors-node-status"
            title={statusLabel}
            role="img"
            aria-label={statusLabel}
          >
            {data.status === "success" ? <CheckCircle2 size={14} />
              : data.status === "running" ? <LoaderCircle size={14} className="spin" />
              : <ShieldAlert size={14} />}
          </span>
        )}
      </div>

      {nodeSwarmRoster.length > 0 && (
        <div className="swarm-node-roster">
          {nodeSwarmRoster.slice(0, 6).map((a) => (
            <span
              key={a.agentId}
              className={`swarm-roster-chip is-${a.status}`}
              title={`${a.agentName} (${a.role}): ${a.summary}`}
            >
              <span className="swarm-roster-dot" />
              <span>@{a.agentId}</span>
            </span>
          ))}
          {nodeSwarmRoster.length > 6 && (
            <span className="swarm-roster-chip">
              +{nodeSwarmRoster.length - 6}
            </span>
          )}
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
          const inputLabel = inp && getPortLabel(inp, locale);
          const outputLabel = out && getPortLabel(out, locale, data.kind);
          return (
            <div key={idx} className="loors-port-row">
              <div className="loors-port-left">
                {inp && (
                  <>
                    <Handle
                      type="target"
                      position={Position.Left}
                      id={inp.id}
                      className={portClass(inp, "target")}
                      title={inputLabel}
                      aria-label={inputLabel}
                      style={{ background: "transparent", ["--port-color" as string]: PORT_COLORS[inp.kind] }}
                    />
                    <span className={`loors-port-label ${inp.kind === "exec" || inp.id.endsWith("_ref") ? "is-technical" : ""}`}>{inputLabel}</span>
                  </>
                )}
              </div>
              <div className="loors-port-right">
                {out && (
                  <>
                    <span className={`loors-port-label ${out.kind === "exec" || out.id.endsWith("_ref") ? "is-technical" : ""}`}>{outputLabel}</span>
                    <Handle
                      type="source"
                      position={Position.Right}
                      id={out.id}
                      className={portClass(out, "source")}
                      title={outputLabel}
                      aria-label={outputLabel}
                      style={{ background: "transparent", ["--port-color" as string]: PORT_COLORS[out.kind] }}
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
