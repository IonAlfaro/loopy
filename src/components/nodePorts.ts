import type { LoorsNodeKind, PortSpec } from "../types/graph";

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
  };
  const label = nodeKind === "llm_judge" && port.id === "pass" ? ["Passed", "Aprobado"]
    : nodeKind === "llm_judge" && port.id === "fail" ? ["Failed", "No aprobado"]
    : labels[port.id];
  return label?.[locale === "es" ? 1 : 0] ?? port.label;
}
