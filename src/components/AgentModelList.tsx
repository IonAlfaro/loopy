import { Check, ChevronDown, ChevronRight, Cloud, Eye, EyeOff, Pin, PinOff } from "lucide-react";
import { parseGgufMetadata, type CloudProviderConfig, type LocalModelFile } from "../types/graph";
import type { useAgentModelGroups } from "./useAgentModelGroups";

export function AgentModelList({ modelPath, cloudProviders, localModels, groupedPickerModels, modelPickerQuery, pinnedModels, hiddenModels, showHiddenModels, collapsedModelGroups, locale, onSelect, onToggleGroup, togglePinModel, toggleHideModel }: {
  modelPath: string;
  cloudProviders: CloudProviderConfig[];
  localModels: LocalModelFile[];
  groupedPickerModels: ReturnType<typeof useAgentModelGroups>;
  modelPickerQuery: string;
  pinnedModels: string[];
  hiddenModels: string[];
  showHiddenModels: boolean;
  collapsedModelGroups: Record<string, boolean>;
  locale: string;
  onSelect: (path: string) => void;
  onToggleGroup: (key: string) => void;
  togglePinModel: (path: string) => void;
  toggleHideModel: (path: string) => void;
}) {
  return (<div className="model-pop-list">
                          {(() => {
                            const q = modelPickerQuery.trim().toLowerCase();
                            const pinnedCloudItems: {
                              key: string;
                              label: string;
                              badge: string;
                            }[] = [];
                            for (const prov of cloudProviders) {
                              if (!prov.enabled) continue;
                              for (const mid of prov.models) {
                                const uri = `cloud::${prov.id}::${mid}`;
                                if (!pinnedModels.includes(uri)) continue;
                                if (hiddenModels.includes(uri) && !showHiddenModels) continue;
                                if (
                                  q &&
                                  !mid.toLowerCase().includes(q) &&
                                  !prov.name.toLowerCase().includes(q)
                                ) {
                                  continue;
                                }
                                pinnedCloudItems.push({
                                  key: uri,
                                  label: mid,
                                  badge: prov.name.split(" ")[0] || prov.id,
                                });
                              }
                            }
                            const pinnedLocalItems = localModels
                              .filter((f) => {
                                if (!pinnedModels.includes(f.path)) return false;
                                if (hiddenModels.includes(f.path) && !showHiddenModels) return false;
                                if (!q) return true;
                                const meta = parseGgufMetadata(f.name);
                                return (
                                  meta.baseName.toLowerCase().includes(q) ||
                                  meta.quant.toLowerCase().includes(q) ||
                                  f.name.toLowerCase().includes(q)
                                );
                              })
                              .map((f) => ({ file: f, meta: parseGgufMetadata(f.name) }));

                            if (pinnedCloudItems.length === 0 && pinnedLocalItems.length === 0) {
                              return null;
                            }

                            return (
                              <div className="model-pop-group">
                                <div className="model-pop-group-head">
                                  <span className="truncate-text" style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                                    <Pin size={11} style={{ color: "#a78bfa" }} />
                                    {locale === "es" ? "Fijados" : "Pinned"}
                                  </span>
                                  <span className="composer-model-quant">
                                    {pinnedCloudItems.length + pinnedLocalItems.length}
                                  </span>
                                </div>
                                {pinnedCloudItems.map((item) => {
                                  const isActive = modelPath === item.key;
                                  const isHidden = hiddenModels.includes(item.key);
                                  return (
                                    <div
                                      key={`pin-${item.key}`}
                                      className={`model-pop-row ${isActive ? "active" : ""} ${isHidden ? "is-hidden-model" : ""}`}
                                      onClick={() => {
                                        onSelect(item.key);
                                      }}
                                    >
                                      <Cloud size={11} style={{ color: "#a78bfa", flexShrink: 0 }} />
                                      <span className="model-pop-quality truncate-text" style={{ flex: 1, color: "#e2e8f0" }}>
                                        {item.label}
                                      </span>
                                      <span className="composer-model-quant">{item.badge}</span>
                                      <div className="model-pop-row-actions has-pinned">
                                        <button
                                          type="button"
                                          className="model-pop-action-btn pinned"
                                          title={locale === "es" ? "Desfijar modelo" : "Unpin model"}
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            togglePinModel(item.key);
                                          }}
                                        >
                                          <PinOff size={11} />
                                        </button>
                                        <button
                                          type="button"
                                          className="model-pop-action-btn"
                                          title={
                                            isHidden
                                              ? locale === "es"
                                                ? "Mostrar modelo"
                                                : "Unhide model"
                                              : locale === "es"
                                                ? "Ocultar modelo"
                                                : "Hide model"
                                          }
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            toggleHideModel(item.key);
                                          }}
                                        >
                                          {isHidden ? <Eye size={11} /> : <EyeOff size={11} />}
                                        </button>
                                      </div>
                                      {isActive && <Check size={13} style={{ flexShrink: 0 }} />}
                                    </div>
                                  );
                                })}
                                {pinnedLocalItems.map(({ file, meta }) => {
                                  const isActive = modelPath === file.path;
                                  const isHidden = hiddenModels.includes(file.path);
                                  const gb = file.size_mb / 1024;
                                  return (
                                    <div
                                      key={`pin-${file.path}`}
                                      className={`model-pop-row ${isActive ? "active" : ""} ${isHidden ? "is-hidden-model" : ""}`}
                                      onClick={() => {
                                        onSelect(file.path);
                                      }}
                                    >
                                      <span className="composer-model-quant">{meta.quant}</span>
                                      <span className="model-pop-quality truncate-text" style={{ color: "#e2e8f0" }}>
                                        {meta.baseName}
                                      </span>
                                      <span className="model-pop-size tabular-nums">
                                        {gb >= 1 ? `${gb.toFixed(1)} GB` : `${file.size_mb} MB`}
                                      </span>
                                      <div className="model-pop-row-actions has-pinned">
                                        <button
                                          type="button"
                                          className="model-pop-action-btn pinned"
                                          title={locale === "es" ? "Desfijar modelo" : "Unpin model"}
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            togglePinModel(file.path);
                                          }}
                                        >
                                          <PinOff size={11} />
                                        </button>
                                        <button
                                          type="button"
                                          className="model-pop-action-btn"
                                          title={
                                            isHidden
                                              ? locale === "es"
                                                ? "Mostrar modelo"
                                                : "Unhide model"
                                              : locale === "es"
                                                ? "Ocultar modelo"
                                                : "Hide model"
                                          }
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            toggleHideModel(file.path);
                                          }}
                                        >
                                          {isHidden ? <Eye size={11} /> : <EyeOff size={11} />}
                                        </button>
                                      </div>
                                      {isActive && <Check size={13} style={{ flexShrink: 0 }} />}
                                    </div>
                                  );
                                })}
                              </div>
                            );
                          })()}

                          {cloudProviders
                            .filter((p) => p.enabled && p.models.length > 0)
                            .map((prov) => {
                              const q = modelPickerQuery.trim().toLowerCase();
                              const matchingModels = prov.models.filter((m) => {
                                const uri = `cloud::${prov.id}::${m}`;
                                if (hiddenModels.includes(uri) && !showHiddenModels) return false;
                                return (
                                  !q ||
                                  m.toLowerCase().includes(q) ||
                                  prov.name.toLowerCase().includes(q)
                                );
                              });
                              if (matchingModels.length === 0) return null;
                              const groupKey = `cloud:${prov.id}`;
                              const isCollapsed = !q && Boolean(collapsedModelGroups[groupKey]);
                              return (
                                <div key={prov.id} className="model-pop-group">
                                  <div
                                    className="model-pop-group-head clickable"
                                    onClick={() =>
                                      onToggleGroup(groupKey)
                                    }
                                  >
                                    {isCollapsed ? (
                                      <ChevronRight size={12} style={{ color: "var(--muted)", flexShrink: 0 }} />
                                    ) : (
                                      <ChevronDown size={12} style={{ color: "var(--muted)", flexShrink: 0 }} />
                                    )}
                                    <span className="truncate-text" style={{ display: "inline-flex", alignItems: "center", gap: 5, flex: 1 }}>
                                      <Cloud size={11} style={{ color: "#a78bfa" }} />
                                      {prov.name}
                                    </span>
                                    <span className="composer-model-quant">{matchingModels.length}</span>
                                    <span className="composer-model-quant">API</span>
                                  </div>
                                  {!isCollapsed &&
                                    matchingModels.map((mid) => {
                                      const uri = `cloud::${prov.id}::${mid}`;
                                      const isActive = modelPath === uri;
                                      const isPinned = pinnedModels.includes(uri);
                                      const isHidden = hiddenModels.includes(uri);
                                      return (
                                        <div
                                          key={uri}
                                          className={`model-pop-row ${isActive ? "active" : ""} ${isHidden ? "is-hidden-model" : ""}`}
                                          onClick={() => {
                                            onSelect(uri);
                                          }}
                                        >
                                          <span className="model-pop-quality truncate-text" style={{ flex: 1, color: "#e2e8f0" }}>
                                            {mid}
                                          </span>
                                          <div className={`model-pop-row-actions ${isPinned ? "has-pinned" : ""}`}>
                                            <button
                                              type="button"
                                              className={`model-pop-action-btn ${isPinned ? "pinned" : ""}`}
                                              title={
                                                isPinned
                                                  ? locale === "es"
                                                    ? "Desfijar modelo"
                                                    : "Unpin model"
                                                  : locale === "es"
                                                    ? "Fijar modelo"
                                                    : "Pin model"
                                              }
                                              onClick={(e) => {
                                                e.stopPropagation();
                                                togglePinModel(uri);
                                              }}
                                            >
                                              {isPinned ? <PinOff size={11} /> : <Pin size={11} />}
                                            </button>
                                            <button
                                              type="button"
                                              className="model-pop-action-btn"
                                              title={
                                                isHidden
                                                  ? locale === "es"
                                                    ? "Mostrar modelo"
                                                    : "Unhide model"
                                                  : locale === "es"
                                                    ? "Ocultar modelo"
                                                    : "Hide model"
                                              }
                                              onClick={(e) => {
                                                e.stopPropagation();
                                                toggleHideModel(uri);
                                              }}
                                            >
                                              {isHidden ? <Eye size={11} /> : <EyeOff size={11} />}
                                            </button>
                                          </div>
                                          {isActive && (
                                            <Check size={13} style={{ flexShrink: 0 }} />
                                          )}
                                        </div>
                                      );
                                    })}
                                </div>
                              );
                            })}

                          {groupedPickerModels.length === 0 ? (
                            cloudProviders.some((p) => p.enabled && p.models.length > 0) ? null : (
                              <div className="muted-empty" style={{ padding: 10 }}>
                                {localModels.length === 0
                                  ? "No hay modelos descargados ni APIs activas todavía."
                                  : "Sin coincidencias en tus modelos locales."}
                              </div>
                            )
                          ) : (
                            groupedPickerModels.map((grp) => {
                              const visibleItems = grp.items.filter(
                                ({ file }) => showHiddenModels || !hiddenModels.includes(file.path)
                              );
                              if (visibleItems.length === 0) return null;
                              const groupKey = `local:${grp.family}-${grp.baseName}`;
                              const q = modelPickerQuery.trim();
                              const isCollapsed = !q && Boolean(collapsedModelGroups[groupKey]);
                              return (
                                <div
                                  key={`${grp.family}-${grp.baseName}`}
                                  className="model-pop-group"
                                >
                                  <div
                                    className="model-pop-group-head clickable"
                                    onClick={() =>
                                      onToggleGroup(groupKey)
                                    }
                                  >
                                    {isCollapsed ? (
                                      <ChevronRight size={12} style={{ color: "var(--muted)", flexShrink: 0 }} />
                                    ) : (
                                      <ChevronDown size={12} style={{ color: "var(--muted)", flexShrink: 0 }} />
                                    )}
                                    <span className="truncate-text" style={{ flex: 1 }}>{grp.baseName}</span>
                                    {grp.params && (
                                      <span className="composer-model-quant">{grp.params}</span>
                                    )}
                                  </div>
                                  {!isCollapsed &&
                                    visibleItems.map(({ file, meta }) => {
                                      const isActive = modelPath === file.path;
                                      const isPinned = pinnedModels.includes(file.path);
                                      const isHidden = hiddenModels.includes(file.path);
                                      const gb = file.size_mb / 1024;
                                      return (
                                        <div
                                          key={file.path}
                                          className={`model-pop-row ${isActive ? "active" : ""} ${isHidden ? "is-hidden-model" : ""}`}
                                          onClick={() => {
                                            onSelect(file.path);
                                          }}
                                        >
                                          <span className="composer-model-quant">
                                            {meta.quant}
                                          </span>
                                          <span className="model-pop-quality truncate-text">
                                            {meta.quantQuality}
                                          </span>
                                          <span className="model-pop-size tabular-nums">
                                            {gb >= 1 ? `${gb.toFixed(1)} GB` : `${file.size_mb} MB`}
                                          </span>
                                          <div className={`model-pop-row-actions ${isPinned ? "has-pinned" : ""}`}>
                                            <button
                                              type="button"
                                              className={`model-pop-action-btn ${isPinned ? "pinned" : ""}`}
                                              title={
                                                isPinned
                                                  ? locale === "es"
                                                    ? "Desfijar modelo"
                                                    : "Unpin model"
                                                  : locale === "es"
                                                    ? "Fijar modelo"
                                                    : "Pin model"
                                              }
                                              onClick={(e) => {
                                                e.stopPropagation();
                                                togglePinModel(file.path);
                                              }}
                                            >
                                              {isPinned ? <PinOff size={11} /> : <Pin size={11} />}
                                            </button>
                                            <button
                                              type="button"
                                              className="model-pop-action-btn"
                                              title={
                                                isHidden
                                                  ? locale === "es"
                                                    ? "Mostrar modelo"
                                                    : "Unhide model"
                                                  : locale === "es"
                                                    ? "Ocultar modelo"
                                                    : "Hide model"
                                              }
                                              onClick={(e) => {
                                                e.stopPropagation();
                                                toggleHideModel(file.path);
                                              }}
                                            >
                                              {isHidden ? <Eye size={11} /> : <EyeOff size={11} />}
                                            </button>
                                          </div>
                                          {isActive && (
                                            <Check size={13} style={{ flexShrink: 0 }} />
                                          )}
                                        </div>
                                      );
                                    })}
                                </div>
                              );
                            })
                          )}
                        </div>);
}
