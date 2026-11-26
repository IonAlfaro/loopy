import { useState } from "react";
import { Check, MessageSquareWarning, ShieldAlert } from "lucide-react";
import { invoke } from "../lib/bridge";
import { useGraphStore } from "../store/useGraphStore";

export function HumanGateModal() {
  const pendingGate = useGraphStore((s) => s.pendingGate);
  const clearPendingGate = useGraphStore((s) => s.clearPendingGate);
  const [feedback, setFeedback] = useState("");
  const [submitting, setSubmitting] = useState(false);

  if (!pendingGate) return null;

  const submit = async (approved: boolean) => {
    setSubmitting(true);
    try {
      await invoke("resolve_human_gate", {
        decision: {
          approved,
          feedback: approved ? null : feedback.trim() || null,
        },
      });
      setFeedback("");
      clearPendingGate();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="modal-backdrop">
      <div className="modal-card modal-wide">
        <div className="modal-header">
          <div className="modal-title">
            <ShieldAlert size={18} style={{ color: "#eab308" }} />
            <span>
              {pendingGate.nodeTitle} · Iteración #{pendingGate.iteration}
            </span>
          </div>
        </div>

        <div className="modal-body">
          <div className="hw-note">{pendingGate.message}</div>

          <div className="field">
            <span>Git Diff / Estado actual del workspace</span>
            <pre className="diff-viewer">
              {pendingGate.gitDiff.trim() || "(Sin cambios detectados en git)"}
            </pre>
          </div>

          <label className="field">
            <span>Feedback para el agente (si rechazas / pides otra iteración)</span>
            <textarea
              rows={3}
              placeholder="Ej: Falta cubrir el caso de borde cuando el array está vacío..."
              value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
            />
          </label>

          <div className="modal-footer">
            <button
              type="button"
              className="btn-secondary"
              disabled={submitting}
              onClick={() => submit(false)}
            >
              <MessageSquareWarning size={14} />
              <span>Rechazar y reintentar con feedback</span>
            </button>
            <button
              type="button"
              className="btn-primary"
              disabled={submitting}
              onClick={() => submit(true)}
            >
              <Check size={14} />
              <span>Aprobar y continuar</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
