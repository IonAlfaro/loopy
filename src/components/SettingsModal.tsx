import { ModalBackdrop } from "./ModalBackdrop";
import { useEffect, useState } from "react";
import {
  ArrowDownToLine,
  Boxes,
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
  const settingsLabel = locale === "es" ? "Configuración" : "Settings";
  const autoSaveHarnesses = useGraphStore((s) => s.autoSaveHarnesses);
  const setAutoSaveHarnesses = useGraphStore((s) => s.setAutoSaveHarnesses);
  const [tab, setTab] = useState<SettingsTab>(initialTab);

  useEffect(() => {
    if (open) {
      setTab(initialTab);
    }
  }, [open, initialTab]);

  if (!open) return null;

  const navItems: {
    id: SettingsTab;
    label: string;
    icon: React.ReactNode;
    badge?: string;
    menuLabel?: string;
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
      label: locale === "es" ? "Servidores MCP" : "MCP Servers",
      icon: <PlugZap size={15} />,
    },
    {
      id: "runtime",
      label: t("runtime.title"),
      menuLabel: locale === "es" ? "Runtime local" : "Local runtime",
      icon: <Cpu size={15} />,
    },
    {
      id: "updates",
      label: locale === "es" ? "Actualizaciones" : "Updates",
      icon: <ArrowDownToLine size={15} />,
      badge: updateInfo?.updateAvailable ? `v${updateInfo.latestVersion}` : undefined,
    },
  ];

  const languages: { code: AppLocale; label: string }[] = [
    { code: "en", label: "English" },
    { code: "es", label: "Español" },
  ];

  return (
    <ModalBackdrop label={settingsLabel} onClose={onClose}>
      <div
        className="modal-card settings-modal-shell"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="settings-window-head">
          <div className="settings-window-title">
            <Settings size={19} aria-hidden="true" />
            <h2>{settingsLabel}</h2>
          </div>
          <button type="button" className="icon-btn" aria-label={t("models.close")} onClick={onClose}>
            <X size={18} />
          </button>
        </header>
        <aside className="settings-sidebar">
          <nav className="settings-nav" role="tablist" aria-label={settingsLabel} aria-orientation="vertical" onKeyDown={(event) => {
            const ids = navItems.map((item) => item.id);
            const current = ids.indexOf(tab);
            const next = { ArrowUp: current - 1, ArrowLeft: current - 1,
              ArrowDown: current + 1, ArrowRight: current + 1, Home: 0, End: ids.length - 1 }[event.key];
            if (typeof next !== "number") return;
            event.preventDefault();
            const target = ids[(next + ids.length) % ids.length];
            setTab(target);
            event.currentTarget.querySelector<HTMLButtonElement>(`#settings-tab-${target}`)?.focus();
          }}>
            {navItems.map((item) => {
              const active = tab === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  role="tab"
                  id={`settings-tab-${item.id}`}
                  aria-controls="settings-panel"
                  aria-selected={active}
                  tabIndex={active ? 0 : -1}
                  className={`settings-nav-btn ${active ? "active" : ""}`}
                  onClick={() => setTab(item.id)}
                >
                  <span className="settings-nav-icon">{item.icon}</span>
                  <span className="truncate-text" style={{ flex: 1, textAlign: "left" }}>
                    {item.menuLabel ?? item.label}
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
          <div key={tab} className="settings-main-body" id="settings-panel" role="tabpanel" aria-labelledby={`settings-tab-${tab}`} tabIndex={0}>
            <h3 className="settings-main-title">{navItems.find((item) => item.id === tab)?.label}</h3>
            {tab === "general" && (
              <div className="settings-section-stack">
                <div className="settings-group settings-preference-row">
                  <div id="settings-language-label" className="settings-group-title">
                    {locale === "es" ? "Idioma de la interfaz" : "Interface language"}
                  </div>
                  <div className="settings-lang-grid" role="group" aria-labelledby="settings-language-label">
                    {languages.map((lang) => {
                      const active = locale === lang.code;
                      return (
                        <button
                          key={lang.code}
                          type="button"
                          className={`settings-lang-card ${active ? "active" : ""}`}
                          aria-pressed={active}
                          onClick={() => setLocale(lang.code)}
                        >
                          {lang.label}
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div className="settings-group">
                  <div className="settings-group-title">
                    {locale === "es" ? "Guardado de arneses" : "Harness saving"}
                  </div>
                  <label className="settings-toggle-row">
                    <span>
                      <strong>{locale === "es" ? "Guardar automáticamente" : "Autosave changes"}</strong>
                      <small>{locale === "es"
                        ? "Guarda los arneses de la biblioteca cuando dejas de editar y al cerrar la pestaña."
                        : "Saves library harnesses after you stop editing and when you close a tab."}</small>
                    </span>
                    <input type="checkbox" role="switch" checked={autoSaveHarnesses}
                      onChange={(event) => setAutoSaveHarnesses(event.target.checked)} />
                  </label>
                </div>

                <details className="settings-group settings-shortcuts">
                  <summary className="settings-group-title">{locale === "es" ? "Atajos de teclado" : "Keyboard shortcuts"}</summary>
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
                </details>
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
    </ModalBackdrop>
  );
}
