import { useEffect, useRef, useState } from "react";
import {
  ClipboardCopy,
  Download,
  FolderOpen,
  Save,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { invoke } from "../lib/bridge";
import { useGraphStore } from "../store/useGraphStore";
import { useI18n } from "../i18n";
import { HARNESS_TEMPLATES } from "../templates/harnesses";
import { parseWorkflowJson } from "../types/graph";

interface SavedWorkflowEntry {
  name: string;
  path: string;
}

interface WorkflowIoModalProps {
  open: boolean;
  onClose: () => void;
  onNotice: (msg: string) => void;
}

export function WorkflowIoModal({ open, onClose, onNotice }: WorkflowIoModalProps) {
  const { t } = useI18n();
  const workflowName = useGraphStore((s) => s.workflowName);
  const exportWorkflow = useGraphStore((s) => s.exportWorkflow);
  const importWorkflow = useGraphStore((s) => s.importWorkflow);
  const loadTemplate = useGraphStore((s) => s.loadTemplate);

  const [savedList, setSavedList] = useState<SavedWorkflowEntry[]>([]);
  const [pasteJson, setPasteJson] = useState("");
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const refreshLibrary = () => {
    invoke<SavedWorkflowEntry[]>("list_saved_workflows")
      .then(setSavedList)
      .catch(() => setSavedList([]));
  };

  useEffect(() => {
    if (!open) return;
    setStatusMsg(null);
    setErrorMsg(null);
    refreshLibrary();
  }, [open]);

  if (!open) return null;

  const handleSaveLibrary = async () => {
    setErrorMsg(null);
    const data = exportWorkflow();
    const content = JSON.stringify(data, null, 2);
    try {
      const savedPath = await invoke<string>("save_workflow_to_library", {
        name: data.name || "workflow",
        content,
      });
      setStatusMsg(`Guardado en biblioteca: ${savedPath}`);
      onNotice(`Guardado: ${data.name}`);
      refreshLibrary();
    } catch (err) {
      setErrorMsg(
        typeof err === "string"
          ? err
          : "Biblioteca local disponible en modo escritorio (usa Descargar JSON en navegador)."
      );
    }
  };

  const handleLoadFromLibrary = async (entry: SavedWorkflowEntry) => {
    setErrorMsg(null);
    try {
      const raw = await invoke<string>("load_workflow_from_library", {
        path: entry.path,
      });
      const wf = parseWorkflowJson(raw);
      importWorkflow(wf);
      onNotice(`Loaded harness: ${wf.name}`);
      onClose();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  };

  const handleDeleteFromLibrary = async (entry: SavedWorkflowEntry) => {
    try {
      await invoke("delete_workflow_from_library", { path: entry.path });
      refreshLibrary();
    } catch (err) {
      setErrorMsg(typeof err === "string" ? err : "No se pudo eliminar.");
    }
  };

  const handleDownloadFile = () => {
    const data = exportWorkflow();
    const blob = new Blob([JSON.stringify(data, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${data.name || "workflow"}.loors.json`;
    a.click();
    URL.revokeObjectURL(url);
    setStatusMsg(`Exportado ${data.name || "workflow"}.loors.json`);
  };

  const handleCopyJson = async () => {
    const content = JSON.stringify(exportWorkflow(), null, 2);
    try {
      await navigator.clipboard.writeText(content);
      setStatusMsg("JSON copiado al portapapeles.");
    } catch {
      setErrorMsg("No se pudo acceder al portapapeles.");
    }
  };

  const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setErrorMsg(null);
    try {
      const wf = parseWorkflowJson(await file.text());
      importWorkflow(wf);
      onNotice(`Importado: ${wf.name}`);
      onClose();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Archivo JSON inválido.");
    }
    e.target.value = "";
  };

  const handleImportPaste = () => {
    setErrorMsg(null);
    try {
      const wf = parseWorkflowJson(pasteJson);
      importWorkflow(wf);
      setPasteJson("");
      onNotice(`Importado desde JSON: ${wf.name}`);
      onClose();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "JSON inválido.");
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card modal-wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div className="modal-title">
            <FolderOpen size={18} />
            <span>{t("library.title")}</span>
          </div>
          <button type="button" className="icon-btn" aria-label={t("models.close")} onClick={onClose}>
            <X size={16} />
          </button>
        </div>

        <div className="modal-body">
          <div className="io-actions" style={{ flexWrap: "nowrap", gap: 8 }}>
            <button
              type="button"
              className="btn-primary"
              title={workflowName}
              onClick={handleSaveLibrary}
            >
              <Save size={14} />
              <span>{t("library.save")}</span>
            </button>
            <button
              type="button"
              className="btn-secondary"
              onClick={handleDownloadFile}
            >
              <Download size={14} />
              <span>{t("library.export")}</span>
            </button>
            <button
              type="button"
              className="btn-secondary"
              onClick={handleCopyJson}
            >
              <ClipboardCopy size={14} />
              <span>{t("library.copyJson")}</span>
            </button>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => fileRef.current?.click()}
            >
              <Upload size={14} />
              <span>{t("library.import")}</span>
            </button>
            <input
              ref={fileRef}
              type="file"
              accept=".json,.loors.json"
              hidden
              onChange={handleImportFile}
            />
          </div>

          {statusMsg && <div className="hw-note">{statusMsg}</div>}
          {errorMsg && <div className="hw-error">{errorMsg}</div>}

          <div className="installed-list">
            <div className="panel-title">Biblioteca local de arneses</div>
            {savedList.length === 0 ? (
              <div className="hw-note">
                Aún no has guardado arneses en tu biblioteca local. También
                puedes arrastrar y soltar un archivo <code>.loors.json</code>{" "}
                directamente sobre el canvas.
              </div>
            ) : (
              savedList.map((entry) => (
                <div key={entry.path} className="installed-item">
                  <div className="installed-meta">
                    <div className="installed-name">{entry.name}</div>
                    <div className="installed-path">{entry.path}</div>
                  </div>
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={() => handleLoadFromLibrary(entry)}
                  >
                    Cargar
                  </button>
                  <button
                    type="button"
                    className="icon-btn danger"
                    title="Eliminar arnés"
                    onClick={() => handleDeleteFromLibrary(entry)}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ))
            )}
          </div>

          <div className="installed-list">
            <div className="panel-title">Plantillas de ejemplo</div>
            {HARNESS_TEMPLATES.map((tpl) => (
              <div key={tpl.id} className="installed-item">
                <div className="installed-meta">
                  <div className="installed-name">{tpl.label}</div>
                </div>
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => {
                    loadTemplate(tpl.id);
                    onNotice(`Plantilla cargada: ${tpl.name}`);
                    onClose();
                  }}
                >
                  Usar
                </button>
              </div>
            ))}
          </div>

          <label className="field">
            <span>Importar pegando JSON directamente</span>
            <textarea
              rows={4}
              placeholder='Pega aquí el contenido de un .loors.json {"schemaVersion": 1, "name": "...", "nodes": [...], "edges": [...]}'
              value={pasteJson}
              onChange={(e) => setPasteJson(e.target.value)}
            />
          </label>

          <div className="modal-footer">
            <button
              type="button"
              className="btn-secondary"
              disabled={!pasteJson.trim()}
              onClick={handleImportPaste}
            >
              <Upload size={14} />
              <span>Importar JSON pegado</span>
            </button>
            <button type="button" className="btn-primary" onClick={onClose}>
              Cerrar
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
