import { NODE_BLUEPRINTS, type LoorsFlowEdge, type LoorsFlowNode, type LoorsNodeKind, type PortKind, type PortSpec } from "../types/graph";

export const PORT_COLORS: Record<PortKind, string> = {
  exec: "#94a3b8",
  model: "#a855f7",
  skill: "#2dd4bf",
  mcp: "#fb923c",
  data: "#38bdf8",
  true: "#22c55e",
  false: "#ef4444",
  retry: "#4ade80",
};

export function getVisibleNodePorts(id: string, data: LoorsFlowNode["data"], edges: LoorsFlowEdge[]) {
  const { inputs, outputs } = NODE_BLUEPRINTS[data.kind];
  if (data.kind !== "workspace" && data.kind !== "knowledge_rag") return { inputs, outputs };
  const usesInlineFlow = data.config.inlineExec === true || edges.some((edge) =>
    (edge.source === id && (edge.sourceHandle ?? "exec") === "exec") ||
    (edge.target === id && (edge.targetHandle ?? "exec") === "exec"),
  );
  if (!usesInlineFlow) {
    return { inputs: inputs.filter((port) => port.kind !== "exec"), outputs: outputs.filter((port) => port.kind !== "exec") };
  }
  return { inputs, outputs };
}

export function arePortsCompatible(source: string | null | undefined, target: string | null | undefined) {
  return source === target || (!source?.endsWith("_ref") && !target?.endsWith("_ref"));
}

export function getPortLabel(port: PortSpec, locale: "en" | "es", nodeKind?: LoorsNodeKind) {
  const labels: Record<string, [string, string]> = {
    exec: ["Flow", "Flujo"],
    model_ref: ["Model", "Modelo"],
    skill_ref: ["Skill", "Skill"],
    mcp_ref: ["MCP", "MCP"],
    knowledge_ref: ["Knowledge", "Conocimiento"],
    workspace_ref: ["Project", "Proyecto"],
    retry: ["Retry", "Reintentar"],
    feedback: ["Feedback", "Comentarios"],
    true: ["True", "Verdadero"],
    false: ["False", "Falso"],
    exhausted: ["Limit reached", "Límite alcanzado"],
    approved: ["Approved", "Aprobado"],
    rejected: ["Returned with feedback", "Devuelto con comentarios"],
    ok: ["Success", "Éxito"],
    error: ["Error", "Error"],
    each: ["For each item", "Por cada elemento"],
    done: ["Finished", "Al terminar"],
    valid: ["Valid", "Válido"],
    invalid: ["Invalid", "No válido"],
    branch_a: ["Branch A", "Rama A"],
    branch_b: ["Branch B", "Rama B"],
    merged: ["Merged", "Unión"],
  };
  const label = nodeKind === "llm_judge" && port.id === "pass" ? ["Passed", "Aprobado"]
    : nodeKind === "llm_judge" && port.id === "fail" ? ["Failed", "No aprobado"]
    : labels[port.id];
  return label?.[locale === "es" ? 1 : 0] ?? port.label;
}
