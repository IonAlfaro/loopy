import { Check, ChevronUp, Eye, Lock, Shield, Zap } from "lucide-react";
import { useI18n } from "../i18n";
import type { PermissionMode } from "../types/graph";

export function AgentPermissionPicker({ mode, permMenuOpen, onToggle, onSelect }: {
  mode: PermissionMode;
  permMenuOpen: boolean;
  onToggle: () => void;
  onSelect: (mode: PermissionMode) => void;
}) {
  const { t } = useI18n();
  return <><button
                    type="button"
                    className={`composer-env-pill ${permMenuOpen ? "is-open" : ""}`}
                    title={t("agent.localPermissions")} aria-expanded={permMenuOpen}
                    onClick={() => onToggle()}
                  >
                    {mode === "read_only" ? (
                      <Eye size={12} />
                    ) : mode === "ask" ? (
                      <Lock size={12} />
                    ) : mode === "auto_review" ? (
                      <Shield size={12} style={{ color: "#a78bfa" }} />
                    ) : (
                      <Zap size={12} style={{ color: "#f59e0b" }} />
                    )}
                    <span>
                      {mode === "read_only"
                        ? t("agent.permReadOnly")
                        : mode === "ask"
                          ? t("agent.permAsk")
                          : mode === "auto_review"
                            ? t("agent.permAuto")
                            : t("agent.permTurbo")}
                    </span>
                    <ChevronUp size={11} className="effort-pill-chev" />
                  </button>

                  {permMenuOpen && (
                    <div
                      className="effort-popover"
                      role="menu"
                      style={{ left: 0, right: "auto", minWidth: 268 }}
                    >
                      <div className="effort-popover-title">{t("agent.localPermissions")}</div>
                      {(
                        [
                          {
                            id: "read_only" as PermissionMode,
                            label: t("agent.permReadOnly"),
                            desc: t("agent.permReadOnlyDesc"),
                            icon: <Eye size={14} />,
                          },
                          {
                            id: "ask" as PermissionMode,
                            label: t("agent.permAsk"),
                            desc: t("agent.permAskDesc"),
                            icon: <Lock size={14} />,
                          },
                          {
                            id: "auto_review" as PermissionMode,
                            label: t("agent.permAuto"),
                            desc: t("agent.permAutoDesc"),
                            icon: <Shield size={14} style={{ color: "#a78bfa" }} />,
                          },
                          {
                            id: "full_auto" as PermissionMode,
                            label: t("agent.permTurbo"),
                            desc: t("agent.permTurboDesc"),
                            icon: <Zap size={14} style={{ color: "#f59e0b" }} />,
                          },
                        ]
                      ).map((opt) => {
                        const active = mode === opt.id;
                        return (
                          <button
                            key={opt.id}
                            type="button"
                            role="menuitemradio" aria-checked={active}
                            className={`effort-pop-item ${active ? "active" : ""}`}
                            onClick={() => {
                              onSelect(opt.id);
                            }}
                          >
                            <div style={{ display: "flex", alignItems: "flex-start", gap: 9 }}>
                              <span style={{ color: "#94a3b8", marginTop: 2, flexShrink: 0 }}>
                                {opt.icon}
                              </span>
                              <div className="effort-pop-item-text">
                                <span className="effort-pop-item-label">{opt.label}</span>
                                <span className="effort-pop-item-desc">{opt.desc}</span>
                              </div>
                            </div>
                            {active && (
                              <Check size={12} style={{ color: "#c084fc", flexShrink: 0 }} />
                            )}
                          </button>
                        );
                      })}
                    </div>
                  )}</>;
}
