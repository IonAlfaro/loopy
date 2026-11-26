import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Pencil,
  Plus,
  Search,
  Trash2,
  Wrench,
} from "lucide-react";
import { invoke } from "../lib/bridge";
import {
  NODE_BLUEPRINTS,
  type CustomNodeDef,
  type LoorsNodeKind,
} from "../types/graph";
import { useGraphStore } from "../store/useGraphStore";
import { getNodeDescription, getNodeLabel, useI18n, type TranslationKey } from "../i18n";
import { CustomNodeModal } from "./CustomNodeModal";

const NODE_SECTIONS: { id: string; titleKey: TranslationKey; kinds: LoorsNodeKind[] }[] = [
  {
    id: "essentials",
    titleKey: "sidebar.essentials",
    kinds: ["task_input", "trigger", "agent", "shell", "llm_judge", "loop_guard", "for_each", "json_validator", "output"],
  },
  {
    id: "context",
    titleKey: "sidebar.contextResources",
    kinds: ["local_model", "knowledge_rag", "memory_file", "workspace"],
  },
  {
    id: "advanced",
    titleKey: "sidebar.advanced",
    kinds: [
      "condition",
      "human_gate",
      "git_checkpoint",
      "context_compactor",
      "http_request",
      "notify",
      "skill",
      "mcp_server",
      "parallel_fanout",
      "subgraph",
    ],
  },
];

export function Sidebar({ collapsed = false }: { collapsed?: boolean }) {
  const { locale, t } = useI18n();
  const nodes = useGraphStore((s) => s.nodes);
  const addNode = useGraphStore((s) => s.addNode);
  const customNodes = useGraphStore((s) => s.customNodes);
  const setCustomNodes = useGraphStore((s) => s.setCustomNodes);
  const addCustomNodeToCanvas = useGraphStore((s) => s.addCustomNodeToCanvas);
  const editingCustomNode = useGraphStore((s) => s.editingCustomNode);
  const setEditingCustomNode = useGraphStore((s) => s.setEditingCustomNode);

  const [createOpen, setCreateOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const [collapsedSections, setCollapsedSections] = useState<Record<string, boolean>>({
    advanced: true,
    custom: true,
  });

  const toggleSection = (title: string) => {
    setCollapsedSections((prev) => ({ ...prev, [title]: !prev[title] }));
  };

  const workspacePath = String(
    nodes.find((n) => n.data.kind === "task_input")?.data.config.workspace ?? "."
  );

  const refreshCustomNodes = useCallback(() => {
    invoke<CustomNodeDef[]>("list_custom_nodes", { workspace: workspacePath })
      .then(setCustomNodes)
      .catch(() => {});
  }, [workspacePath, setCustomNodes]);

  useEffect(() => {
    refreshCustomNodes();
  }, [refreshCustomNodes]);

  const handleDeleteCustom = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    try {
      await invoke("delete_custom_node", { id });
      refreshCustomNodes();
    } catch {
      // ignore
    }
  };

  const q = filter.trim().toLowerCase();

  const filteredCustom = useMemo(() => {
    if (!q) return customNodes;
    return customNodes.filter(
      (d) =>
        d.label.toLowerCase().includes(q) ||
        d.description.toLowerCase().includes(q)
    );
  }, [customNodes, q]);

  return (
    <>
      {!collapsed && (
        <aside className="loors-sidebar">
          <div className="sidebar-search">
            <Search size={13} className="sidebar-search-icon" />
            <input
              type="text"
              placeholder={t("sidebar.searchNode")}
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
          </div>

      {NODE_SECTIONS.map((sec) => {
        const matched = sec.kinds.filter((kind) => {
          if (!q) return true;
          const bp = NODE_BLUEPRINTS[kind];
          return (
            bp.label.toLowerCase().includes(q) ||
            bp.description.toLowerCase().includes(q)
          );
        });
        if (matched.length === 0) return null;
        const isCollapsed = !q && Boolean(collapsedSections[sec.id]);
        return (
          <div key={sec.id} className="palette-section">
            <button
              type="button"
              className="palette-section-toggle"
              onClick={() => toggleSection(sec.id)}
            >
              {isCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
              <span className="panel-title" style={{ marginBottom: 0 }}>
                {t(sec.titleKey)}
              </span>
              <span className="palette-count">{matched.length}</span>
            </button>
            {!isCollapsed && (
              <div className="palette-list">
                {matched.map((kind) => {
                  const bp = NODE_BLUEPRINTS[kind];
                  return (
                    <button
                      key={kind}
                      type="button"
                      draggable
                      onDragStart={(e) => {
                        e.dataTransfer.setData("application/loors-node-kind", kind);
                        e.dataTransfer.effectAllowed = "move";
                      }}
                      className="palette-item compact-row"
                      title={`${getNodeDescription(kind, locale)}\n(${locale === "es" ? "Haz clic o arrastra al lienzo" : "Click or drag to canvas"})`}
                      onClick={() => addNode(kind)}
                    >
                      <span
                        className="palette-dot"
                        style={{ background: bp.accent }}
                      />
                      <span className="palette-name">{getNodeLabel(kind, locale)}</span>
                      <Plus size={12} className="palette-plus" />
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}

      <div className="palette-section">
        <div className="section-head">
          <button
            type="button"
            className="palette-section-toggle"
            style={{ marginBottom: 0, width: "auto" }}
            onClick={() => toggleSection("custom")}
          >
            {!q && collapsedSections["custom"] ? (
              <ChevronRight size={12} />
            ) : (
              <ChevronDown size={12} />
            )}
            <span className="panel-title" style={{ marginBottom: 0 }}>
              {t("sidebar.customNodes")}
            </span>
          </button>
          <button
            type="button"
            className="btn-mini"
            onClick={() => {
              setEditingCustomNode(null);
              setCreateOpen(true);
            }}
          >
            <Wrench size={11} />
            <span>{t("sidebar.create")}</span>
          </button>
        </div>

        {!(!q && collapsedSections["custom"]) && filteredCustom.length > 0 && (
          <div className="palette-list">
            {filteredCustom.map((def) => (
              <div
                key={def.id}
                role="button"
                tabIndex={0}
                className="palette-item compact-row"
                title={def.description || `${def.runner} custom`}
                onClick={() => addCustomNodeToCanvas(def)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") addCustomNodeToCanvas(def);
                }}
              >
                <span
                  className="palette-dot"
                  style={{ background: def.accent || "#f472b6" }}
                />
                <span className="palette-name" style={{ flex: 1 }}>
                  {def.label}
                </span>
                <button
                  type="button"
                  className="icon-btn"
                  title="Editar nodo custom"
                  onClick={(e) => {
                    e.stopPropagation();
                    setEditingCustomNode(def);
                    setCreateOpen(true);
                  }}
                >
                  <Pencil size={12} />
                </button>
                <button
                  type="button"
                  className="icon-btn danger"
                  title="Eliminar nodo custom"
                  onClick={(e) => handleDeleteCustom(e, def.id)}
                >
                  <Trash2 size={12} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
        </aside>
      )}

      <CustomNodeModal
        open={createOpen || editingCustomNode !== null}
        initialDef={editingCustomNode}
        onClose={() => {
          setCreateOpen(false);
          setEditingCustomNode(null);
        }}
        onCreated={refreshCustomNodes}
      />
    </>
  );
}
