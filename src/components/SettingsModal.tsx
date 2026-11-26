import { useEffect, useState } from "react";
import {
  ArrowDownToLine,
  Boxes,
  Check,
  Cloud,
  Cpu,
  Globe,
  PlugZap,
  Settings,
  X,
} from "lucide-react";
import { useI18n, type AppLocale } from "../i18n";
import { useGraphStore } from "../store/useGraphStore";
import { McpSettingsPanel } from "./McpSettingsPanel";
import { ModelsModal } from "./ModelsModal";
import { RuntimeModal } from "./RuntimeModal";
import { UpdateModal, type UpdateCheckResult } from "./UpdateModal";

export type SettingsTab = "general" | "models" | "cloud" | "mcp" | "runtime" | "updates";

interface SettingsModalProps {
  open: boolean;
  initialTab?: SettingsTab;
  updateInfo: UpdateCheckResult | null;
  onUpdateChecked: (res: UpdateCheckResult | null) => void;
  onClose: () => void;
  onNotice: (msg: string) => void;
}

export function SettingsModal({
  open,
  initialTab = "general",
  updateInfo,
  onUpdateChecked,
  onClose,
  onNotice,
}: SettingsModalProps) {
  const { locale, setLocale, t } = useI18n();
  const autoSaveHarnesses = useGraphStore((s) => s.autoSaveHarnesses);
  const setAutoSaveHarnesses = useGraphStore((s) => s.setAutoSaveHarnesses);
  const [tab, setTab] = useState<SettingsTab>(initialTab);

  useEffect(() => {
    if (open) {
      setTab(initialTab);
    }
  }, [open, initialTab]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const navItems: {
    id: SettingsTab;
    label: string;
    icon: React.ReactNode;
    badge?: string;
  }[] = [
    {
      id: "general",
      label: locale === "es" ? "General e Idioma" : "General & Language",
      icon: <Globe size={15} />,
    },
    {
      id: "models",
      label: t("models.title"),
      icon: <Boxes size={15} />,
    },
    {
      id: "cloud",
      label: t("models.tabCloud"),
      icon: <Cloud size={15} />,
    },
    {
      id: "mcp",
      label: "MCP Servers",
      icon: <PlugZap size={15} />,
    },
    {
      id: "runtime",
      label: t("runtime.title"),
      icon: <Cpu size={15} />,
    },
    {
      id: "updates",
      label: locale === "es" ? "Actualizaciones" : "Updates",
      icon: <ArrowDownToLine size={15} />,
      badge: updateInfo?.updateAvailable ? `v${updateInfo.latestVersion}` : undefined,
    },
  ];

  const languages: { code: AppLocale; name: string; native: string; desc: string }[] = [
    {
      code: "en",
      name: "English",
      native: "English (Default)",
      desc: "Use Loors in English across all views and modals.",
    },
    {
      code: "es",
      name: "Spanish",
      native: "Español",
      desc: "Usa Loors en español en todas las pantallas y modales.",
    },
  ];

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal-card settings-modal-shell"
        onClick={(e) => e.stopPropagation()}
      >
        <aside className="settings-sidebar">
          <div className="settings-sidebar-head">
            <Settings size={15} style={{ color: "#94a3b8" }} />
            <span>{locale === "es" ? "Configuración" : "Settings"}</span>
          </div>
          <nav className="settings-nav" role="tablist" aria-orientation="vertical">
            {navItems.map((item) => {
              const active = tab === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  className={`settings-nav-btn ${active ? "active" : ""}`}
                  onClick={() => setTab(item.id)}
                >
                  <span className="settings-nav-icon">{item.icon}</span>
                  <span className="truncate-text" style={{ flex: 1, textAlign: "left" }}>
                    {item.label}
                  </span>
                  {item.badge && (
                    <span className="settings-nav-badge">{item.badge}</span>
                  )}
                </button>
              );
            })}
          </nav>
        </aside>

        <div className="settings-main">
          <div className="settings-main-head">
            <div className="settings-main-title">
              {navItems.find((i) => i.id === tab)?.label}
            </div>
            <button
              type="button"
              className="icon-btn"
              aria-label={t("models.close")}
              onClick={onClose}
            >
              <X size={16} />
            </button>
          </div>

          <div className="settings-main-body">
            {tab === "general" && (
              <div className="settings-section-stack">
                <div className="settings-group">
                  <div className="settings-group-title">
                    {locale === "es" ? "Idioma de la interfaz" : "Interface language"}
                  </div>
                  <div className="settings-group-desc">
                    {locale === "es"
                      ? "Cambia el idioma al instante sin reiniciar la aplicación."
                      : "Switch the application language immediately without restarting."}
                  </div>
                  <div className="settings-lang-grid">
                    {languages.map((lang) => {
                      const active = locale === lang.code;
                      return (
                        <button
                          key={lang.code}
                          type="button"
                          className={`settings-lang-card ${active ? "active" : ""}`}
                          onClick={() => setLocale(lang.code)}
                        >
                          <div className="settings-lang-top">
                            <strong>{lang.native}</strong>
                            {active && <Check size={14} style={{ color: "#a78bfa" }} />}
                          </div>
                          <span>{lang.desc}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div className="settings-group">
                  <div className="settings-group-title">
                    {locale === "es" ? "Guardado de arneses" : "Harness saving"}
                  </div>
                  <div className="settings-group-desc">
                    {locale === "es"
                      ? "Guarda automáticamente los cambios de los arneses de tu biblioteca y conserva las pestañas abiertas al reiniciar."
                      : "Automatically save changes to library harnesses and restore open tabs on restart."}
                  </div>
                  <label
                    className="settings-shortcut-row"
                    style={{ cursor: "pointer", padding: "10px 12px", borderRadius: 8, background: "var(--panel-2)", border: "1px solid var(--border)" }}
                  >
                    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                      <strong style={{ fontSize: 12.5, fontWeight: 600, color: "var(--text)" }}>
                        {locale === "es" ? "Auto-guardado automático" : "Automatic auto-save"}
                      </strong>
                      <span style={{ fontSize: 11.5, color: "var(--muted)" }}>
                        {locale === "es"
                          ? "Guarda tras 1,5 s de inactividad y al cerrar pestañas (siempre puedes usar Ctrl+S)."
                          : "Saves after 1.5s of inactivity and when closing tabs (Ctrl+S always works)."}
                      </span>
                    </div>
                    <input
                      type="checkbox"
                      checked={autoSaveHarnesses}
                      onChange={(e) => setAutoSaveHarnesses(e.target.checked)}
                      style={{ width: 16, height: 16, accentColor: "#8b5cf6", cursor: "pointer", flexShrink: 0 }}
                    />
                  </label>
                </div>

                <div className="settings-group">
                  <div className="settings-group-title">
                    {locale === "es" ? "Atajos de teclado" : "Keyboard shortcuts"}
                  </div>
                  <div className="settings-shortcuts-list">
                    <div className="settings-shortcut-row">
                      <span>{locale === "es" ? "Guardar arnés actual" : "Save current harness"}</span>
                      <kbd>Ctrl + S</kbd>
                    </div>
                    <div className="settings-shortcut-row">
                      <span>{locale === "es" ? "Cambiar a Modo Agente" : "Switch to Agent Mode"}</span>
                      <kbd>Ctrl + 1</kbd>
                    </div>
                    <div className="settings-shortcut-row">
                      <span>{locale === "es" ? "Cambiar a Arneses" : "Switch to Harnesses"}</span>
                      <kbd>Ctrl + 2</kbd>
                    </div>
                    <div className="settings-shortcut-row">
                      <span>{locale === "es" ? "Mostrar / ocultar barra lateral" : "Toggle left sidebar"}</span>
                      <kbd>Ctrl + B</kbd>
                    </div>
                    <div className="settings-shortcut-row">
                      <span>{locale === "es" ? "Mostrar / ocultar panel derecho" : "Toggle right panel"}</span>
                      <kbd>Ctrl + Shift + B</kbd>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {tab === "models" && (
              <ModelsModal
                open={open}
                embedded
                initialTab="local"
                onClose={onClose}
                onNotice={onNotice}
              />
            )}

            {tab === "cloud" && (
              <ModelsModal
                open={open}
                embedded
                initialTab="cloud"
                onClose={onClose}
                onNotice={onNotice}
              />
            )}

            {tab === "mcp" && <McpSettingsPanel onNotice={onNotice} />}

            {tab === "runtime" && (
              <RuntimeModal open={open} embedded onClose={onClose} />
            )}

            {tab === "updates" && (
              <UpdateModal
                open={open}
                embedded
                initialResult={updateInfo}
                onClose={onClose}
                onUpdateChecked={onUpdateChecked}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
