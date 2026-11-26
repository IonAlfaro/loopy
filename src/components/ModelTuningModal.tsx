import { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Trash2, X } from "lucide-react";
import { invoke } from "../lib/bridge";
import { useGraphStore } from "../store/useGraphStore";
import {
  parseGgufMetadata,
  type HardwareProfile,
  type LocalModelFile,
  type ModelTuningProfile,
} from "../types/graph";

const DEFAULT_PROFILE: ModelTuningProfile = {
  contextSize: 0,
  compactAtTokens: 0,
  cacheTypeK: "f16",
  cacheTypeV: "f16",
  flashAttn: true,
  gpuLayers: -1,
  batchSize: 2048,
  ubatchSize: 512,
  threads: 0,
  mlock: false,
  noMmap: false,
  extraArgs: "",
  temperature: 0.2,
  topP: 0.95,
  minP: 0.05,
  repeatPenalty: 1.05,
  maxTokens: 6144,
  seed: -1,
  mmprojPath: "",
};

const KV_TYPES = ["f16", "q8_0", "q5_0", "q4_0", "iq4_nl"];

function kvFactor(kind: string): number {
  switch (kind) {
    case "q8_0":
      return 0.5;
    case "q5_0":
      return 0.34;
    case "q4_0":
    case "iq4_nl":
      return 0.28;
    default:
      return 1.0;
  }
}

export function ModelTuningModal() {
  const modelPath = useGraphStore((s) => s.tuningModalModelPath);
  const openTuningModal = useGraphStore((s) => s.openTuningModal);
  const selectedBackend = useGraphStore((s) => s.selectedBackend);
  const activeModelPath = useGraphStore((s) => s.activeModelPath);
  const setActiveModelPath = useGraphStore((s) => s.setActiveModelPath);

  const [models, setModels] = useState<LocalModelFile[]>([]);
  const [activePath, setActivePath] = useState("");
  const [profile, setProfile] = useState<ModelTuningProfile>(DEFAULT_PROFILE);
  const [hw, setHw] = useState<HardwareProfile | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!modelPath) return;
    setActivePath(modelPath);
    setStatusMsg(null);
    setAdvancedOpen(false);
    invoke<LocalModelFile[]>("scan_local_models")
      .then(setModels)
      .catch(() => {});
    invoke<HardwareProfile>("detect_hardware")
      .then(setHw)
      .catch(() => {});
  }, [modelPath]);

  useEffect(() => {
    if (!modelPath || !activePath) return;
    invoke<ModelTuningProfile>("get_model_profile", { modelPath: activePath })
      .then((loaded) => setProfile({ ...DEFAULT_PROFILE, ...loaded }))
      .catch(() => setProfile(DEFAULT_PROFILE));
  }, [modelPath, activePath]);

  const currentModelInfo = models.find((m) => m.path === activePath);
  const modelMeta = useMemo(
    () =>
      activePath
        ? parseGgufMetadata(
            activePath,
            currentModelInfo ? currentModelInfo.size_mb * 1024 * 1024 : undefined
          )
        : null,
    [activePath, currentModelInfo]
  );

  const mmprojFiles = useMemo(
    () => models.filter((m) => m.name.toLowerCase().includes("mmproj")),
    [models]
  );
  const mainModels = useMemo(
    () => models.filter((m) => !m.name.toLowerCase().includes("mmproj")),
    [models]
  );

  if (!modelPath) return null;

  const patch = (next: Partial<ModelTuningProfile>) => {
    setProfile((prev) => {
      const merged = { ...prev, ...next };
      if (merged.cacheTypeV !== "f16") {
        merged.flashAttn = true;
      }
      if (
        next.contextSize !== undefined &&
        next.contextSize > 0 &&
        (merged.compactAtTokens ?? 0) > next.contextSize
      ) {
        merged.compactAtTokens = next.contextSize;
      }
      return merged;
    });
  };

  const maxModelCtx =
    profile.contextSize > 0
      ? profile.contextSize
      : profile.effectiveContextSize && profile.effectiveContextSize > 0
        ? profile.effectiveContextSize
        : 32768;

  const compactTokens =
    (profile.compactAtTokens ?? 0) > 0
      ? Math.min(maxModelCtx, profile.compactAtTokens ?? 0)
      : Math.round(maxModelCtx * 0.75);
  const compactPct = Math.min(100, Math.round((compactTokens / maxModelCtx) * 100));

  const totalRamGb = hw ? hw.total_ram_mb / 1024 : 64;
  const weightsGb = currentModelInfo ? currentModelInfo.size_mb / 1024 : 16;
  const baseF16KvPer32K = Math.max(1.2, Math.min(4.8, weightsGb * 0.14));
  const kvFactorAvg = (kvFactor(profile.cacheTypeK) + kvFactor(profile.cacheTypeV)) / 2;
  const estimatedKvGb = (maxModelCtx / 32768) * baseF16KvPer32K * kvFactorAvg;
  const freeGb = Math.max(0, totalRamGb - weightsGb - estimatedKvGb);
  const weightsPct = Math.min(100, (weightsGb / totalRamGb) * 100);
  const kvPct = Math.min(100 - weightsPct, (estimatedKvGb / totalRamGb) * 100);
  const vForcedFa = profile.cacheTypeV !== "f16";

  const handleSave = async (reload: boolean) => {
    if (!activePath) return;
    setSaving(true);
    setStatusMsg(reload ? "Recargando modelo en llama.cpp…" : null);
    try {
      if (reload) {
        await invoke("reload_model_with_profile", {
          backend: selectedBackend,
          modelPath: activePath,
          profile,
        });
      } else {
        await invoke("save_model_tuning_profile", {
          modelPath: activePath,
          profile,
        });
      }
      const updated = await invoke<ModelTuningProfile>("get_model_profile", {
        modelPath: activePath,
      });
      setProfile({ ...DEFAULT_PROFILE, ...updated });
      window.dispatchEvent(
        new CustomEvent("loors:model-profile-updated", {
          detail: { modelPath: activePath, profile: updated },
        })
      );
      if (reload) {
        openTuningModal(null);
      } else {
        setStatusMsg("Configuración guardada.");
      }
    } catch (err) {
      setStatusMsg(`Error: ${String(err)}`);
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteModel = async () => {
    if (!activePath) return;
    const shortName = activePath.split(/[\\/]/).pop() ?? activePath;
    if (!window.confirm(`¿Eliminar permanentemente "${shortName}" del disco?`)) {
      return;
    }
    setSaving(true);
    try {
      await invoke("delete_local_model", { path: activePath });
      if (activeModelPath === activePath) {
        setActiveModelPath("");
      }
      window.dispatchEvent(new CustomEvent("loors:models-changed"));
      openTuningModal(null);
    } catch (err) {
      setStatusMsg(`Error: ${String(err)}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="modal-backdrop"
      style={{ zIndex: 120 }}
      onClick={() => openTuningModal(null)}
    >
      <div className="sheet-modal" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-header">
          <div className="sheet-title-col">
            <h3>Opciones del modelo</h3>
            <span className="sheet-subtitle truncate-text">
              {modelMeta
                ? `${modelMeta.baseName} · ${modelMeta.quant}${
                    modelMeta.sizeGb > 0 ? ` · ${modelMeta.sizeGb.toFixed(1)} GB` : ""
                  }`
                : activePath}
            </span>
          </div>
          <button
            type="button"
            className="icon-btn"
            onClick={() => openTuningModal(null)}
          >
            <X size={16} />
          </button>
        </div>

        <div className="sheet-body">
          {/* Model Switcher if multiple */}
          {mainModels.length > 1 && (
            <div className="sheet-row">
              <span className="sheet-label">Modelo</span>
              <select
                className="sheet-control"
                value={activePath}
                onChange={(e) => setActivePath(e.target.value)}
              >
                {mainModels.map((m) => (
                  <option key={m.path} value={m.path}>
                    {m.name} ({(m.size_mb / 1024).toFixed(1)} GB)
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* Slim Memory Estimate */}
          <div className="sheet-mem">
            <div className="sheet-mem-head tabular-nums">
              <span>Memoria estimada</span>
              <span>
                {(weightsGb + estimatedKvGb).toFixed(1)} GB usados ·{" "}
                {freeGb.toFixed(1)} GB libres
              </span>
            </div>
            <div className="vram-bar-track">
              <div className="vram-seg-weights" style={{ width: `${weightsPct}%` }} />
              <div className="vram-seg-kv" style={{ width: `${kvPct}%` }} />
            </div>
          </div>

          <div className="sheet-divider" />

          {/* Context Size (-c) */}
          <div className="sheet-row-stack">
            <div className="sheet-row-top">
              <span className="sheet-label">Contexto llama.cpp (-c)</span>
              <div className="sheet-inline-val">
                <button
                  type="button"
                  className={`sheet-pill-toggle ${profile.contextSize === 0 ? "active" : ""}`}
                  onClick={() => patch({ contextSize: profile.contextSize === 0 ? maxModelCtx : 0 })}
                >
                  Auto
                </button>
                <span className="sheet-readout tabular-nums">
                  {Math.round(maxModelCtx / 1024)}K ({maxModelCtx.toLocaleString()})
                </span>
              </div>
            </div>
            <input
              type="range"
              className="clean-slider"
              min="4096"
              max="262144"
              step="4096"
              value={maxModelCtx}
              onChange={(e) => patch({ contextSize: Number(e.target.value) })}
            />
          </div>

          {/* Compaction Threshold Slider */}
          <div className="sheet-row-stack">
            <div className="sheet-row-top">
              <span className="sheet-label">Compactar historial a</span>
              <div className="sheet-inline-val">
                <button
                  type="button"
                  className={`sheet-pill-toggle ${(profile.compactAtTokens ?? 0) === 0 ? "active" : ""}`}
                  onClick={() =>
                    patch({
                      compactAtTokens:
                        (profile.compactAtTokens ?? 0) === 0 ? compactTokens : 0,
                    })
                  }
                >
                  Auto (75%)
                </button>
                <span className="sheet-readout tabular-nums">
                  {Math.round(compactTokens / 1024)}K / {Math.round(maxModelCtx / 1024)}K ({compactPct}%)
                </span>
              </div>
            </div>
            <input
              type="range"
              className="clean-slider"
              min="4096"
              max={maxModelCtx}
              step="2048"
              value={compactTokens}
              onChange={(e) => patch({ compactAtTokens: Number(e.target.value) })}
            />
          </div>

          {/* KV Cache K / V */}
          <div className="sheet-row">
            <span className="sheet-label">KV Cache K</span>
            <div className="seg-group">
              {KV_TYPES.map((k) => (
                <button
                  key={k}
                  type="button"
                  className={`seg-item ${profile.cacheTypeK === k ? "active" : ""}`}
                  onClick={() => patch({ cacheTypeK: k })}
                >
                  {k.toUpperCase()}
                </button>
              ))}
            </div>
          </div>

          <div className="sheet-row">
            <span className="sheet-label">KV Cache V</span>
            <div className="seg-group">
              {KV_TYPES.map((k) => (
                <button
                  key={k}
                  type="button"
                  className={`seg-item ${profile.cacheTypeV === k ? "active" : ""}`}
                  onClick={() => patch({ cacheTypeV: k })}
                >
                  {k.toUpperCase()}
                </button>
              ))}
            </div>
          </div>

          {/* Flash Attention */}
          <div className="sheet-row">
            <div>
              <span className="sheet-label">Flash Attention</span>
              {vForcedFa && (
                <span className="sheet-hint">Necesario con Cache V cuantizado</span>
              )}
            </div>
            <input
              type="checkbox"
              className="clean-checkbox"
              checked={profile.flashAttn}
              disabled={vForcedFa}
              onChange={(e) => patch({ flashAttn: e.target.checked })}
            />
          </div>

          {/* GPU Layers */}
          <div className="sheet-row-stack">
            <div className="sheet-row-top">
              <span className="sheet-label">Capas en GPU (-ngl)</span>
              <div className="sheet-inline-val">
                <button
                  type="button"
                  className={`sheet-pill-toggle ${profile.gpuLayers < 0 ? "active" : ""}`}
                  onClick={() => patch({ gpuLayers: profile.gpuLayers < 0 ? 64 : -1 })}
                >
                  Todas
                </button>
                <span className="sheet-readout tabular-nums">
                  {profile.gpuLayers < 0 ? "Todas (-1)" : profile.gpuLayers}
                </span>
              </div>
            </div>
            <input
              type="range"
              className="clean-slider"
              min="0"
              max="128"
              step="1"
              value={profile.gpuLayers < 0 ? 128 : profile.gpuLayers}
              onChange={(e) => patch({ gpuLayers: Number(e.target.value) })}
            />
          </div>

          {/* Temperature */}
          <div className="sheet-row-stack">
            <div className="sheet-row-top">
              <span className="sheet-label">Temperatura</span>
              <span className="sheet-readout tabular-nums">
                {profile.temperature.toFixed(2)}
              </span>
            </div>
            <input
              type="range"
              className="clean-slider"
              min="0"
              max="1.5"
              step="0.05"
              value={profile.temperature}
              onChange={(e) => patch({ temperature: Number(e.target.value) })}
            />
          </div>

          {/* Collapsible Advanced Section */}
          <button
            type="button"
            className="sheet-advanced-toggle"
            onClick={() => setAdvancedOpen((v) => !v)}
          >
            {advancedOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            <span>Parámetros avanzados</span>
          </button>

          {advancedOpen && (
            <div className="sheet-advanced-grid">
              <label className="sheet-field">
                <span>Max tokens salida</span>
                <input
                  type="number"
                  step="512"
                  min="256"
                  value={profile.maxTokens}
                  onChange={(e) => patch({ maxTokens: Number(e.target.value) })}
                />
              </label>
              <label className="sheet-field">
                <span>Top-P</span>
                <input
                  type="number"
                  step="0.02"
                  min="0"
                  max="1"
                  value={profile.topP}
                  onChange={(e) => patch({ topP: Number(e.target.value) })}
                />
              </label>
              <label className="sheet-field">
                <span>Min-P</span>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  max="1"
                  value={profile.minP}
                  onChange={(e) => patch({ minP: Number(e.target.value) })}
                />
              </label>
              <label className="sheet-field">
                <span>Repeat Penalty</span>
                <input
                  type="number"
                  step="0.02"
                  min="0.8"
                  max="2"
                  value={profile.repeatPenalty}
                  onChange={(e) => patch({ repeatPenalty: Number(e.target.value) })}
                />
              </label>
              <label className="sheet-field">
                <span>Batch (-b)</span>
                <input
                  type="number"
                  step="128"
                  min="128"
                  value={profile.batchSize}
                  onChange={(e) => patch({ batchSize: Number(e.target.value) })}
                />
              </label>
              <label className="sheet-field">
                <span>Micro-Batch (-ub)</span>
                <input
                  type="number"
                  step="64"
                  min="64"
                  value={profile.ubatchSize}
                  onChange={(e) => patch({ ubatchSize: Number(e.target.value) })}
                />
              </label>
              <label className="sheet-field">
                <span>Hilos CPU (-t)</span>
                <input
                  type="number"
                  min="0"
                  value={profile.threads}
                  onChange={(e) => patch({ threads: Number(e.target.value) })}
                />
              </label>
              <label className="sheet-field">
                <span>Semilla (-1 = azar)</span>
                <input
                  type="number"
                  step="1"
                  value={profile.seed}
                  onChange={(e) => patch({ seed: Number(e.target.value) })}
                />
              </label>
              <label className="sheet-field sheet-span-2">
                <span>Proyector Visión (mmproj)</span>
                <select
                  value={profile.mmprojPath}
                  onChange={(e) => patch({ mmprojPath: e.target.value })}
                >
                  <option value="">Ninguno</option>
                  {mmprojFiles.map((m) => (
                    <option key={m.path} value={m.path}>
                      {m.name} ({m.size_mb} MB)
                    </option>
                  ))}
                </select>
              </label>
              <label className="sheet-field sheet-span-2">
                <span>Flags CLI adicionales</span>
                <input
                  type="text"
                  placeholder="--rope-scaling linear"
                  value={profile.extraArgs}
                  onChange={(e) => patch({ extraArgs: e.target.value })}
                />
              </label>
              <label className="check-inline">
                <input
                  type="checkbox"
                  checked={profile.mlock}
                  onChange={(e) => patch({ mlock: e.target.checked })}
                />
                <span>Bloquear en RAM (--mlock)</span>
              </label>
              <label className="check-inline">
                <input
                  type="checkbox"
                  checked={profile.noMmap}
                  onChange={(e) => patch({ noMmap: e.target.checked })}
                />
                <span>Desactivar mmap (--no-mmap)</span>
              </label>
            </div>
          )}

          {statusMsg && <div className="sheet-status">{statusMsg}</div>}
        </div>

        <div className="sheet-footer">
          <button
            type="button"
            className="btn-ghost-danger"
            disabled={saving || !activePath}
            onClick={() => void handleDeleteModel()}
          >
            <Trash2 size={13} />
            <span>Eliminar modelo</span>
          </button>

          <div style={{ display: "flex", gap: 8 }}>
            <button
              type="button"
              className="btn-secondary"
              disabled={saving}
              onClick={() => openTuningModal(null)}
            >
              Cerrar
            </button>
            <button
              type="button"
              className="btn-secondary"
              disabled={saving}
              onClick={() => void handleSave(false)}
            >
              Guardar
            </button>
            <button
              type="button"
              className="btn-primary"
              disabled={saving}
              onClick={() => void handleSave(true)}
            >
              Aplicar y recargar
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
