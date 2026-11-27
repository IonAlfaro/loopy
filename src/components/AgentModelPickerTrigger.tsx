import { Cloud, ChevronUp } from "lucide-react";
import { isCloudModelPath, parseCloudModelPath, type CloudProviderConfig } from "../types/graph";

export function AgentModelPickerTrigger({ modelPath, cloudProviders, activeModelMeta, chooseLabel, modelPickerOpen, onToggle }: {
  modelPath: string;
  cloudProviders: CloudProviderConfig[];
  activeModelMeta: { baseName: string; quant: string } | null | undefined;
  chooseLabel: string;
  modelPickerOpen: boolean;
  onToggle: () => void;
}) {
  return (<button
                      type="button"
                      className="composer-model-btn"
                      title={modelPath || chooseLabel}
                      aria-expanded={modelPickerOpen}
                      onClick={() => onToggle()}
                    >
                      {isCloudModelPath(modelPath) ? (
                        (() => {
                          const parsed = parseCloudModelPath(modelPath);
                          const prov = cloudProviders.find(
                            (p) => p.id === parsed?.providerId
                          );
                          return (
                            <>
                              <Cloud size={12} style={{ color: "#a78bfa", flexShrink: 0 }} />
                              <span className="composer-model-title truncate-text">
                                {parsed?.modelId ?? modelPath}
                              </span>
                              <span className="composer-model-quant">
                                {prov?.name.split(" ")[0] ?? parsed?.providerId ?? "API"}
                              </span>
                            </>
                          );
                        })()
                      ) : activeModelMeta ? (
                        <>
                          <span className="composer-model-title truncate-text">
                            {activeModelMeta.baseName}
                          </span>
                          <span className="composer-model-quant">
                            {activeModelMeta.quant}
                          </span>
                        </>
                      ) : (
                        <span className="composer-model-title">{chooseLabel}</span>
                      )}
                      <ChevronUp size={12} style={{ color: "var(--muted)", flexShrink: 0 }} />
                    </button>);
}
