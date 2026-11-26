import { useState } from "react";
import { KeyRound, Lock, RefreshCw } from "lucide-react";
import { setServerToken } from "../lib/bridge";
import { useI18n } from "../i18n";

interface WebAuthGateProps {
  onAuthenticated: () => void;
}

export function WebAuthGate({ onAuthenticated }: WebAuthGateProps) {
  const { locale } = useI18n();
  const L = (en: string, es: string) => (locale === "es" ? es : en);

  const [token, setToken] = useState("");
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = token.trim();
    if (!trimmed) return;
    setChecking(true);
    setError(null);
    try {
      const resp = await fetch("/api/auth/verify", {
        method: "POST",
        headers: { Authorization: `Bearer ${trimmed}` },
      });
      if (!resp.ok) {
        setError(L("Invalid server token.", "Token de servidor inválido."));
        return;
      }
      setServerToken(trimmed);
      onAuthenticated();
    } catch {
      setError(L("Could not reach Loors Headless Server.", "No se pudo conectar con el servidor Loors."));
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="modal-backdrop" style={{ zIndex: 9999, background: "#09090b" }}>
      <form
        className="modal-card"
        style={{ width: 400, padding: 24, display: "flex", flexDirection: "column", gap: 14 }}
        onSubmit={(e) => void handleSubmit(e)}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div
            style={{
              width: 36,
              height: 36,
              borderRadius: 10,
              background: "rgba(139, 92, 246, 0.14)",
              border: "1px solid rgba(167, 139, 250, 0.28)",
              color: "#c4b5fd",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Lock size={17} />
          </div>
          <div>
            <div style={{ fontSize: 15, fontWeight: 600, color: "var(--text)" }}>
              Loors Headless Server
            </div>
            <div style={{ fontSize: 12, color: "var(--muted)" }}>
              {L("Enter the server access token to continue.", "Introduce el token de acceso del servidor.")}
            </div>
          </div>
        </div>

        <div className="cloud-key-input-wrap">
          <KeyRound size={13} className="cloud-key-icon" />
          <input
            type="password"
            autoFocus
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder={L("Bearer token...", "Token Bearer...")}
            className="cloud-field-input"
          />
        </div>

        {error && <div className="cloud-drawer-error">{error}</div>}

        <button
          type="submit"
          className="btn-primary"
          disabled={checking || !token.trim()}
          style={{ justifyContent: "center", padding: "8px 14px" }}
        >
          {checking && <RefreshCw size={13} className="spin" />}
          <span>{L("Connect to Loors", "Conectar a Loors")}</span>
        </button>
      </form>
    </div>
  );
}
