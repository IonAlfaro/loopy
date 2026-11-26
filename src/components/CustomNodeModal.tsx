import { useEffect, useState } from "react";
import { Plus, Trash2, Wrench, X } from "lucide-react";
import { invoke } from "../lib/bridge";
import { useI18n } from "../i18n";
import type { CustomFieldDef, CustomNodeDef } from "../types/graph";

interface CustomNodeModalProps {
  open: boolean;
  initialDef?: CustomNodeDef | null;
  onClose: () => void;
  onCreated: () => void;
}

const ACCENT_PRESETS = ["#f472b6", "#38bdf8", "#4ade80", "#fb923c", "#c084fc", "#facc15"];

export function CustomNodeModal({
  open,
  initialDef = null,
  onClose,
  onCreated,
}: CustomNodeModalProps) {
  const { locale } = useI18n();
  const L = (en: string, es: string) => (locale === "es" ? es : en);

  const [label, setLabel] = useState(() => L("My Custom Node", "Mi Nodo Custom"));
  const [description, setDescription] = useState(() =>
    L("Runs a custom step", "Ejecuta un paso personalizado")
  );
  const [accent, setAccent] = useState("#f472b6");
  const [runner, setRunner] = useState<"shell" | "prompt" | "http">("shell");
  const [commandTemplate, setCommandTemplate] = useState("echo {{message}}");
  const [promptTemplate, setPromptTemplate] = useState(() =>
    L(
      "Analyze the following diff and suggest improvements:\n{{git_diff}}\nExtra: {{criteria}}",
      "Analiza el siguiente diff y responde con mejoras:\n{{git_diff}}\nExtra: {{criterio}}"
    )
  );
  const [httpMethod, setHttpMethod] = useState("POST");
  const [httpUrl, setHttpUrl] = useState("https://hooks.example.com/notify");
  const [httpHeaders, setHttpHeaders] = useState("{}");
  const [httpBody, setHttpBody] = useState('{"text": "{{message}}"}');
  const [fields, setFields] = useState<CustomFieldDef[]>([
    { key: "message", label: "Message", fieldType: "text", defaultValue: "Hello from Loopy" },
  ]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    if (initialDef) {
      setLabel(initialDef.label || L("My Custom Node", "Mi Nodo Custom"));
      setDescription(
        initialDef.description || L("Runs a custom step", "Ejecuta un paso personalizado")
      );
      setAccent(initialDef.accent || "#f472b6");
      setRunner(initialDef.runner || "shell");
      setCommandTemplate(initialDef.commandTemplate || "");
      setPromptTemplate(initialDef.promptTemplate || "");
      setHttpMethod(initialDef.httpMethod || "POST");
      setHttpUrl(initialDef.httpUrl || "https://hooks.example.com/notify");
      setHttpHeaders(initialDef.httpHeaders || "{}");
      setHttpBody(initialDef.httpBody || "{}");
      setFields(
        Array.isArray(initialDef.fields) && initialDef.fields.length > 0
          ? initialDef.fields.map((f) => ({ ...f }))
          : []
      );
    } else {
      setLabel(L("My Custom Node", "Mi Nodo Custom"));
      setDescription(L("Runs a custom step", "Ejecuta un paso personalizado"));
      setAccent("#f472b6");
      setRunner("shell");
      setCommandTemplate("echo {{message}}");
      setPromptTemplate(
        L(
          "Analyze the following diff and suggest improvements:\n{{git_diff}}\nExtra: {{criteria}}",
          "Analiza el siguiente diff y responde con mejoras:\n{{git_diff}}\nExtra: {{criterio}}"
        )
      );
      setHttpMethod("POST");
      setHttpUrl("https://hooks.example.com/notify");
      setHttpHeaders("{}");
      setHttpBody('{"text": "{{message}}"}');
      setFields([
        {
          key: "message",
          label: L("Message", "Mensaje"),
          fieldType: "text",
          defaultValue: L("Hello from Loopy", "Hola desde Loopy"),
        },
      ]);
    }
  }, [open, initialDef, locale]);

  if (!open) return null;

  const addField = () => {
    setFields([
      ...fields,
      {
        key: `field_${fields.length + 1}`,
        label: L(`Field ${fields.length + 1}`, `Campo ${fields.length + 1}`),
        fieldType: "text",
        defaultValue: "",
      },
    ]);
  };

  const updateField = (idx: number, patch: Partial<CustomFieldDef>) => {
    setFields(fields.map((f, i) => (i === idx ? { ...f, ...patch } : f)));
  };

  const removeField = (idx: number) => {
    setFields(fields.filter((_, i) => i !== idx));
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    const id =
      (initialDef?.id && initialDef.id.trim()) ||
      label
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, "-")
        .replace(/^-|-$/g, "") ||
      "custom-node";

    const def: CustomNodeDef = {
      id,
      label: label.trim() || "Custom Node",
      category: "Custom",
      accent,
      description: description.trim(),
      runner,
      commandTemplate,
      promptTemplate,
      httpMethod,
      httpUrl,
      httpHeaders,
      httpBody,
      branchOnExit: true,
      fields: fields.filter((f) => f.key.trim().length > 0),
    };

    try {
      await invoke("save_custom_node", { def });
      onCreated();
      onClose();
    } catch (err) {
      setError(
        typeof err === "string"
          ? err
          : L(
              "Run Loopy in desktop mode (Tauri) to save custom nodes to disk.",
              "Ejecuta Loopy en modo escritorio (Tauri) para guardar nodos custom en disco."
            )
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card modal-wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div className="modal-title">
            <Wrench size={18} style={{ color: accent }} />
            <span>
              {initialDef?.id
                ? L("Edit Custom Node", "Editar Nodo Personalizado")
                : L("Create Custom Node", "Crear Nodo Personalizado")}
            </span>
          </div>
          <button type="button" className="icon-btn" onClick={onClose}>
            <X size={16} />
          </button>
        </div>

        <div className="modal-body">
          <div className="two-col">
            <label className="field">
              <span>{L("Node name", "Nombre del nodo")}</span>
              <input
                type="text"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
              />
            </label>
            <div className="field">
              <span>{L("Color", "Color")}</span>
              <div className="color-row">
                {ACCENT_PRESETS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    className={`color-swatch ${accent === c ? "active" : ""}`}
                    style={{ background: c }}
                    onClick={() => setAccent(c)}
                  />
                ))}
              </div>
            </div>
          </div>

          <label className="field">
            <span>{L("Description", "Descripción")}</span>
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </label>

          <label className="field">
            <span>{L("Execution type (Runner)", "Tipo de ejecución (Runner)")}</span>
            <select
              value={runner}
              onChange={(e) =>
                setRunner(e.target.value as "shell" | "prompt" | "http")
              }
            >
              <option value="shell">
                {L(
                  "Script / CLI (PowerShell, Python, Node, adb...)",
                  "Script / CLI (PowerShell, Python, Node, adb...)"
                )}
              </option>
              <option value="prompt">
                {L(
                  "Agent Preset (reusable prompt with local/cloud model)",
                  "Agent Preset (prompt reutilizable con modelo local/cloud)"
                )}
              </option>
              <option value="http">
                {L(
                  "HTTP / Webhook Preset (Slack, GitHub, Jira...)",
                  "HTTP / Webhook Preset (Slack, GitHub, Jira...)"
                )}
              </option>
            </select>
          </label>

          {runner === "shell" && (
            <label className="field">
              <span>
                {L(
                  "Command template (use {{your_field}}, {{stderr}}, {{git_diff}})",
                  "Plantilla de comando (usa {{tu_campo}}, {{stderr}}, {{git_diff}})"
                )}
              </span>
              <input
                type="text"
                value={commandTemplate}
                onChange={(e) => setCommandTemplate(e.target.value)}
              />
            </label>
          )}

          {runner === "prompt" && (
            <label className="field">
              <span>
                {L(
                  "Prompt template (use {{your_field}} and context variables)",
                  "Plantilla de prompt (usa {{tu_campo}} y variables del contexto)"
                )}
              </span>
              <textarea
                rows={4}
                value={promptTemplate}
                onChange={(e) => setPromptTemplate(e.target.value)}
              />
            </label>
          )}

          {runner === "http" && (
            <>
              <div className="two-col">
                <label className="field">
                  <span>{L("Method", "Método")}</span>
                  <select
                    value={httpMethod}
                    onChange={(e) => setHttpMethod(e.target.value)}
                  >
                    <option value="GET">GET</option>
                    <option value="POST">POST</option>
                    <option value="PUT">PUT</option>
                    <option value="PATCH">PATCH</option>
                  </select>
                </label>
                <label className="field">
                  <span>URL</span>
                  <input
                    type="text"
                    value={httpUrl}
                    onChange={(e) => setHttpUrl(e.target.value)}
                  />
                </label>
              </div>
              <label className="field">
                <span>Headers JSON</span>
                <input
                  type="text"
                  value={httpHeaders}
                  onChange={(e) => setHttpHeaders(e.target.value)}
                />
              </label>
              <label className="field">
                <span>Body JSON</span>
                <textarea
                  rows={3}
                  value={httpBody}
                  onChange={(e) => setHttpBody(e.target.value)}
                />
              </label>
            </>
          )}

          <div className="installed-list">
            <div className="section-head">
              <div className="panel-title">
                {L("Editable Inspector fields", "Campos editables en el Inspector")}
              </div>
              <button type="button" className="btn-secondary" onClick={addField}>
                <Plus size={13} />
                <span>{L("Add field", "Añadir campo")}</span>
              </button>
            </div>
            {fields.map((f, idx) => (
              <div key={idx} className="field-builder-row">
                <input
                  type="text"
                  placeholder="key"
                  value={f.key}
                  onChange={(e) => updateField(idx, { key: e.target.value })}
                />
                <input
                  type="text"
                  placeholder={L("Label", "Etiqueta")}
                  value={f.label}
                  onChange={(e) => updateField(idx, { label: e.target.value })}
                />
                <select
                  value={f.fieldType}
                  onChange={(e) =>
                    updateField(idx, {
                      fieldType: e.target.value as "text" | "textarea" | "number",
                    })
                  }
                >
                  <option value="text">{L("Text", "Texto")}</option>
                  <option value="textarea">{L("Multiline", "Multilínea")}</option>
                  <option value="number">{L("Number", "Número")}</option>
                </select>
                <input
                  type="text"
                  placeholder="Default"
                  value={f.defaultValue}
                  onChange={(e) =>
                    updateField(idx, { defaultValue: e.target.value })
                  }
                />
                <button
                  type="button"
                  className="icon-btn danger"
                  onClick={() => removeField(idx)}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>

          {error && <div className="hw-error">{error}</div>}

          <div className="modal-footer">
            <button type="button" className="btn-secondary" onClick={onClose}>
              {L("Cancel", "Cancelar")}
            </button>
            <button
              type="button"
              className="btn-primary"
              disabled={saving}
              onClick={handleSave}
            >
              <span>
                {saving
                  ? L("Saving…", "Guardando…")
                  : L("Save Custom Node", "Guardar Nodo Custom")}
              </span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
