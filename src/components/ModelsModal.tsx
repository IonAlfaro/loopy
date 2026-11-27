import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Boxes,
  Check,
  ChevronDown,
  ChevronRight,
  Cloud,
  Cpu,
  Download,
  ExternalLink,
  Eye,
  EyeOff,
  Globe,
  HardDrive,
  Heart,
  KeyRound,
  Plus,
  RefreshCw,
  Save,
  Search,
  Settings,
  Trash2,
  X,
} from "lucide-react";
import { invoke } from "../lib/bridge";
import { useGraphStore } from "../store/useGraphStore";
import { useI18n } from "../i18n";
import {
  detectModelModalities,
  parseGgufMetadata,
  type CloudProviderConfig,
  type LocalModelFile,
} from "../types/graph";

interface HfModelRepo {
  id: string;
  downloads: number;
  likes: number;
  last_modified?: string | null;
}

interface HfGgufFile {
  filename: string;
  size_bytes: number;
  download_url: string;
}

interface HardwareSnapshot {
  total_ram_mb: number;
  gpus: { name: string; vendor: string; vram_mb: number | null }[];
}

interface ModelsModalProps {
  open: boolean;
  embedded?: boolean;
  initialTab?: "local" | "discover" | "cloud";
  onClose: () => void;
  onNotice: (msg: string) => void;
}

const DEFAULT_CLOUD_PROVIDERS: CloudProviderConfig[] = [
  {
    id: "openai",
    name: "OpenAI / ChatGPT",
    kind: "openai_compat",
    baseUrl: "https://api.openai.com/v1",
    apiKey: "",
    models: [],
    enabled: false,
  },
  {
    id: "anthropic",
    name: "Anthropic / Claude",
    kind: "anthropic",
    baseUrl: "https://api.anthropic.com",
    apiKey: "",
    models: [],
    enabled: false,
  },
  {
    id: "gemini",
    name: "Google Gemini",
    kind: "openai_compat",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    apiKey: "",
    models: [],
    enabled: false,
  },
  {
    id: "github",
    name: "GitHub Models / Copilot",
    kind: "openai_compat",
    baseUrl: "https://models.inference.ai.azure.com",
    apiKey: "",
    models: [],
    enabled: false,
  },
  {
    id: "openrouter",
    name: "OpenRouter / OpenCode",
    kind: "openai_compat",
    baseUrl: "https://openrouter.ai/api/v1",
    apiKey: "",
    models: [],
    enabled: false,
  },
  {
    id: "lmstudio",
    name: "LM Studio",
    kind: "openai_compat",
    baseUrl: "http://127.0.0.1:1234/v1",
    apiKey: "",
    models: [],
    enabled: false,
  },
  {
    id: "ollama",
    name: "Ollama",
    kind: "openai_compat",
    baseUrl: "http://127.0.0.1:11434/v1",
    apiKey: "",
    models: [],
    enabled: false,
  },
];

const PROVIDER_BRAND: Record<
  string,
  { badge: string; color: string; bg: string; descEn: string; descEs: string; keyUrl?: string }
> = {
  openai: {
    badge: "OA",
    color: "#34d399",
    bg: "rgba(16, 185, 129, 0.14)",
    descEn: "GPT-4o, o3, o4-mini & OpenAI API",
    descEs: "GPT-4o, o3, o4-mini y API de OpenAI",
    keyUrl: "https://platform.openai.com/api-keys",
  },
  anthropic: {
    badge: "AN",
    color: "#fbbf24",
    bg: "rgba(245, 158, 11, 0.14)",
    descEn: "Claude Sonnet, Opus & Haiku",
    descEs: "Claude Sonnet, Opus y Haiku",
    keyUrl: "https://console.anthropic.com/settings/keys",
  },
  gemini: {
    badge: "GM",
    color: "#60a5fa",
    bg: "rgba(59, 130, 246, 0.14)",
    descEn: "Gemini 2.5 Pro & Flash via Google AI",
    descEs: "Gemini 2.5 Pro y Flash vía Google AI",
    keyUrl: "https://aistudio.google.com/apikey",
  },
  github: {
    badge: "GH",
    color: "#e4e4e7",
    bg: "rgba(255, 255, 255, 0.09)",
    descEn: "GitHub Models & Copilot PAT",
    descEs: "GitHub Models y Copilot PAT",
    keyUrl: "https://github.com/settings/tokens",
  },
  openrouter: {
    badge: "OR",
    color: "#c4b5fd",
    bg: "rgba(139, 92, 246, 0.16)",
    descEn: "Unified gateway for 200+ cloud models",
    descEs: "Pasarela unificada para +200 modelos cloud",
    keyUrl: "https://openrouter.ai/keys",
  },
  lmstudio: {
    badge: "LM",
    color: "#a78bfa",
    bg: "rgba(139, 92, 246, 0.14)",
    descEn: "Local server on port 1234 (OpenAI / Anthropic + optional secret)",
    descEs: "Servidor local en puerto 1234 (OpenAI / Anthropic + secret opcional)",
  },
  ollama: {
    badge: "OL",
    color: "#38bdf8",
    bg: "rgba(56, 189, 248, 0.14)",
    descEn: "Local server on port 11434 (OpenAI / Anthropic + optional secret)",
    descEs: "Servidor local en puerto 11434 (OpenAI / Anthropic + secret opcional)",
  },
};

type HfSortMode = "trendingScore" | "downloads" | "likes" | "lastModified";

const HF_SORT_OPTIONS: { id: HfSortMode; labelEn: string; labelEs: string }[] = [
  { id: "trendingScore", labelEn: "Trending", labelEs: "Tendencia" },
  { id: "downloads", labelEn: "Most Downloaded", labelEs: "Más descargados" },
  { id: "likes", labelEn: "Most Liked", labelEs: "Más valorados" },
  { id: "lastModified", labelEn: "Most Recent", labelEs: "Más recientes" },
];

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }
  return `${Math.max(1, Math.round(bytes / (1024 * 1024)))} MB`;
}

function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function getHardwareFit(
  sizeGb: number,
  budgetGb: number,
  locale: "en" | "es"
): { label: string; cls: "fit-good" | "fit-warn" | "fit-heavy" } {
  if (budgetGb <= 0 || sizeGb <= 0) {
    return { label: "GGUF", cls: "fit-good" };
  }
  if (sizeGb <= budgetGb * 0.68) {
    return { label: locale === "es" ? "Óptimo" : "Optimal", cls: "fit-good" };
  }
  if (sizeGb <= budgetGb * 0.95) {
    return { label: locale === "es" ? "Ajustado" : "Tight", cls: "fit-warn" };
  }
  return { label: locale === "es" ? "Pesado" : "Heavy", cls: "fit-heavy" };
}

export function ModelsModal({
  open,
  embedded = false,
  initialTab,
  onClose,
  onNotice,
}: ModelsModalProps) {
  const { locale, t } = useI18n();
  const nodes = useGraphStore((s) => s.nodes);
  const activeModelPath = useGraphStore((s) => s.activeModelPath);
  const setActiveModelPath = useGraphStore((s) => s.setActiveModelPath);
  const openTuningModal = useGraphStore((s) => s.openTuningModal);
  const activeDownloads = useGraphStore((s) => s.modelDownloads);
  const startModelDownload = useGraphStore((s) => s.startModelDownload);
  const cancelModelDownload = useGraphStore((s) => s.cancelModelDownload);

  const [hubTab, setHubTab] = useState<"local" | "discover" | "cloud">(
    initialTab ?? "local"
  );
  const [localModels, setLocalModels] = useState<LocalModelFile[]>([]);
  const [cloudProviders, setCloudProviders] = useState<CloudProviderConfig[]>([]);
  const [savingCloud, setSavingCloud] = useState(false);
  const [fetchingProviderId, setFetchingProviderId] = useState<string | null>(null);
  const [providerErrors, setProviderErrors] = useState<Record<string, string>>({});
  const [providerModelSearch, setProviderModelSearch] = useState<Record<string, string>>({});
  const [expandedProviderId, setExpandedProviderId] = useState<string | null>(null);
  const [showKeyIds, setShowKeyIds] = useState<Record<string, boolean>>({});
  const [hardware, setHardware] = useState<HardwareSnapshot | null>(null);

  // Local filters
  const [localSearch, setLocalSearch] = useState("");
  const [familyFilter, setFamilyFilter] = useState<string>("Todos");

  // HF Discover state
  const [query, setQuery] = useState("");
  const [sortBy, setSortBy] = useState<HfSortMode>("trendingScore");
  const [repos, setRepos] = useState<HfModelRepo[]>([]);
  const [selectedRepo, setSelectedRepo] = useState<string | null>(null);
  const [ggufFiles, setGgufFiles] = useState<HfGgufFile[]>([]);
  const [quantFilter, setQuantFilter] = useState("");
  const [searching, setSearching] = useState(false);
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const graphModelPath = String(
    nodes.find((n) => n.data.kind === "local_model")?.data.config.modelPath ?? ""
  );
  const effectiveActivePath = activeModelPath || graphModelPath;

  const refreshLocal = useCallback(() => {
    invoke<LocalModelFile[]>("scan_local_models")
      .then((list) => {
        setLocalModels(list);
        if (list.length === 0 && !initialTab) {
          setHubTab((prev) => (prev === "local" ? "discover" : prev));
        }
      })
      .catch(() => setLocalModels([]));
  }, [initialTab]);

  const refreshCloudProviders = useCallback(() => {
    invoke<CloudProviderConfig[]>("get_cloud_providers")
      .then((list) =>
        setCloudProviders(list.length > 0 ? list : DEFAULT_CLOUD_PROVIDERS)
      )
      .catch(() =>
        setCloudProviders((prev) =>
          prev.length > 0 ? prev : DEFAULT_CLOUD_PROVIDERS
        )
      );
  }, []);

  const openRepoFiles = useCallback(async (repoId: string) => {
    setSelectedRepo(repoId);
    setLoadingFiles(true);
    setError(null);
    setQuantFilter("");
    try {
      const files = await invoke<HfGgufFile[]>("list_hf_gguf_files", {
        repoId,
      });
      setGgufFiles(files);
    } catch (err) {
      setError(typeof err === "string" ? err : "Error listando archivos GGUF.");
    } finally {
      setLoadingFiles(false);
    }
  }, []);

  const runSearch = useCallback(
    async (searchText: string, sortMode?: HfSortMode) => {
      const effectiveSort = sortMode ?? sortBy;
      setSearching(true);
      setError(null);
      setSelectedRepo(null);
      setGgufFiles([]);
      try {
        const results = await invoke<HfModelRepo[]>("search_hf_models", {
          query: searchText,
          sort: effectiveSort,
        });
        setRepos(results);
        if (results.length > 0) {
          void openRepoFiles(results[0].id);
        }
      } catch (err) {
        setError(
          typeof err === "string"
            ? err
            : locale === "es"
              ? "Ejecuta Loors en modo escritorio (Tauri) para buscar y descargar modelos de Hugging Face."
              : "Run Loors in desktop mode (Tauri) to browse and download models from Hugging Face."
        );
      } finally {
        setSearching(false);
      }
    },
    [openRepoFiles, sortBy, locale]
  );

  useEffect(() => {
    if (!open) return;
    if (initialTab) {
      setHubTab(initialTab);
    }
    setError(null);
    refreshLocal();
    refreshCloudProviders();
    invoke<HardwareSnapshot>("detect_hardware")
      .then(setHardware)
      .catch(() => setHardware(null));

    const onModelsChanged = () => refreshLocal();
    window.addEventListener("loors:models-changed", onModelsChanged);

    return () => {
      window.removeEventListener("loors:models-changed", onModelsChanged);
    };
  }, [open, initialTab, refreshLocal, refreshCloudProviders]);

  useEffect(() => {
    if (open && hubTab === "discover" && repos.length === 0 && !searching) {
      void runSearch(query);
    }
  }, [open, hubTab, repos.length, searching, query, runSearch]);

  const budgetGb = useMemo(() => {
    if (!hardware) return 24;
    const gpuVram = Math.max(0, ...hardware.gpus.map((g) => g.vram_mb ?? 0));
    const ramGb = hardware.total_ram_mb / 1024;
    if (gpuVram >= 4096) {
      return Math.max(gpuVram / 1024, ramGb * 0.72);
    }
    return ramGb * 0.72;
  }, [hardware]);

  const localFamilies = useMemo(() => {
    const fams = new Set<string>();
    for (const m of localModels) {
      fams.add(parseGgufMetadata(m.path, m.size_mb * 1024 * 1024).family);
    }
    return ["Todos", ...Array.from(fams)];
  }, [localModels]);

  const groupedLocalModels = useMemo(() => {
    const q = localSearch.trim().toLowerCase();
    const groups = new Map<
      string,
      {
        baseName: string;
        family: string;
        params: string | null;
        sourceLabel: string;
        items: { file: LocalModelFile; meta: ReturnType<typeof parseGgufMetadata> }[];
      }
    >();

    for (const file of localModels) {
      const meta = parseGgufMetadata(file.path, file.size_mb * 1024 * 1024);
      if (familyFilter !== "Todos" && meta.family !== familyFilter) continue;
      if (
        q &&
        !file.name.toLowerCase().includes(q) &&
        !meta.baseName.toLowerCase().includes(q) &&
        !meta.quant.toLowerCase().includes(q) &&
        !meta.family.toLowerCase().includes(q)
      ) {
        continue;
      }
      const key = `${meta.family}::${meta.baseName}`;
      const existing = groups.get(key);
      if (existing) {
        existing.items.push({ file, meta });
      } else {
        groups.set(key, {
          baseName: meta.baseName,
          family: meta.family,
          params: meta.params,
          sourceLabel: meta.sourceLabel,
          items: [{ file, meta }],
        });
      }
    }
    return Array.from(groups.values());
  }, [localModels, localSearch, familyFilter]);

  const filteredRepoFiles = useMemo(() => {
    const q = quantFilter.trim().toLowerCase();
    return ggufFiles.filter((f) => {
      if (!q) return true;
      const meta = parseGgufMetadata(f.filename, f.size_bytes);
      return (
        f.filename.toLowerCase().includes(q) ||
        meta.quant.toLowerCase().includes(q) ||
        meta.quantQuality.toLowerCase().includes(q)
      );
    });
  }, [ggufFiles, quantFilter]);

  if (!open) return null;

  const selectModel = (modelPath: string) => {
    setActiveModelPath(modelPath);
    const short = modelPath.startsWith("cloud::")
      ? modelPath.split("::").slice(1).join("/")
      : (modelPath.split(/[\\/]/).pop() ?? modelPath);
    onNotice(`Modelo activo: ${short}`);
  };

  const updateProvider = (
    index: number,
    patch: Partial<CloudProviderConfig>
  ) => {
    setCloudProviders((prev) =>
      prev.map((p, idx) => (idx === index ? { ...p, ...patch } : p))
    );
  };

  const addCustomProvider = () => {
    const id = `custom-${Date.now().toString(36)}`;
    setCloudProviders((prev) => [
      ...prev,
      {
        id,
        name: locale === "es" ? "Endpoint personalizado" : "Custom endpoint",
        kind: "openai_compat",
        baseUrl: "",
        apiKey: "",
        models: [],
        enabled: true,
      },
    ]);
    setExpandedProviderId(id);
  };

  const handleFetchProviderModels = async (index: number) => {
    const prov = cloudProviders[index];
    if (!prov) return;
    setFetchingProviderId(prov.id);
    setProviderErrors((prev) => {
      const next = { ...prev };
      delete next[prov.id];
      return next;
    });
    try {
      const models = await invoke<string[]>("fetch_cloud_provider_models", {
        provider: prov,
      });
      const updated = cloudProviders.map((p, idx) =>
        idx === index ? { ...p, models, enabled: true } : p
      );
      setCloudProviders(updated);
      await invoke("save_cloud_providers", { providers: updated });
      window.dispatchEvent(new CustomEvent("loors:providers-changed"));
      onNotice(`${prov.name}: ${models.length} modelos cargados`);
    } catch (err) {
      setProviderErrors((prev) => ({
        ...prev,
        [prov.id]: typeof err === "string" ? err : String(err),
      }));
    } finally {
      setFetchingProviderId(null);
    }
  };

  const removeProvider = (index: number) => {
    setCloudProviders((prev) => prev.filter((_, idx) => idx !== index));
  };

  const saveCloudProviders = async (silent = false) => {
    setSavingCloud(true);
    setError(null);
    try {
      await invoke("save_cloud_providers", { providers: cloudProviders });
      window.dispatchEvent(new CustomEvent("loors:providers-changed"));
      if (!silent) {
        onNotice("Proveedores Cloud / API guardados");
      }
    } catch (err) {
      setError(typeof err === "string" ? err : String(err));
    } finally {
      setSavingCloud(false);
    }
  };

  const useCloudModel = async (provider: CloudProviderConfig, modelId: string) => {
    const updated = cloudProviders.map((p) =>
      p.id === provider.id ? { ...p, enabled: true } : p
    );
    setCloudProviders(updated);
    try {
      await invoke("save_cloud_providers", { providers: updated });
      window.dispatchEvent(new CustomEvent("loors:providers-changed"));
    } catch {
      // ignore
    }
    selectModel(`cloud::${provider.id}::${modelId}`);
  };

  const enabledCloudCount = cloudProviders.filter((p) => p.enabled).length;

  const handleDeleteLocalModel = async (file: LocalModelFile) => {
    if (
      !window.confirm(
        `¿Seguro que quieres eliminar permanentemente "${file.name}" del disco?`
      )
    ) {
      return;
    }
    setError(null);
    try {
      await invoke("delete_local_model", { path: file.path });
      if (effectiveActivePath === file.path) {
        setActiveModelPath("");
      }
      refreshLocal();
      window.dispatchEvent(new CustomEvent("loors:models-changed"));
      onNotice(`Modelo eliminado: ${file.name}`);
    } catch (err) {
      setError(typeof err === "string" ? err : String(err));
    }
  };

  const handleDownload = (repoId: string, filename: string, sizeBytes?: number) => {
    setError(null);
    void startModelDownload(repoId, filename, sizeBytes ?? null).then((savedPath) => {
      if (savedPath) {
        refreshLocal();
        onNotice?.(
          locale === "es"
            ? `Modelo descargado: ${filename}`
            : `Downloaded: ${filename}`
        );
      }
    });
  };

  const findLocalMatch = (filename: string): LocalModelFile | undefined => {
    const bare = filename.split("/").pop()?.toLowerCase() ?? filename.toLowerCase();
    const safeName = filename.replace(/\//g, "_").toLowerCase();
    return localModels.find((m) => {
      const n = m.name.toLowerCase();
      return n === bare || n === safeName;
    });
  };

  const ramLabel = hardware
    ? `${Math.round(hardware.total_ram_mb / 1024)} GB RAM`
    : null;
  const gpuLabel = hardware?.gpus[0]
    ? `${hardware.gpus[0].name}${
        hardware.gpus[0].vram_mb
          ? ` (${Math.round(hardware.gpus[0].vram_mb / 1024)} GB VRAM)`
          : ""
      }`
    : null;

  const content = (
    <>
      {!embedded ? (
        <div className="modal-header hub-header">
          <div className="hub-title-wrap">
            <div className="modal-title">
              <Boxes size={19} style={{ color: "#a855f7" }} />
              <span>{t("models.title")}</span>
            </div>
            {(gpuLabel || ramLabel) && (
              <div className="hub-hw-pill" title="Hardware">
                <Cpu size={12} />
                <span>{[gpuLabel, ramLabel].filter(Boolean).join(" · ")}</span>
              </div>
            )}
          </div>

          <div className="hub-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={hubTab === "local"}
              className={`hub-tab-btn ${hubTab === "local" ? "active" : ""}`}
              onClick={() => setHubTab("local")}
            >
              <HardDrive size={14} />
              <span>{t("models.tabLocal")}</span>
              <span className="hub-tab-count">{localModels.length}</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={hubTab === "discover"}
              className={`hub-tab-btn ${hubTab === "discover" ? "active" : ""}`}
              onClick={() => setHubTab("discover")}
            >
              <Globe size={14} />
              <span>{t("models.tabDiscover")}</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={hubTab === "cloud"}
              className={`hub-tab-btn ${hubTab === "cloud" ? "active" : ""}`}
              onClick={() => setHubTab("cloud")}
            >
              <Cloud size={14} />
              <span>{t("models.tabCloud")}</span>
              {enabledCloudCount > 0 && (
                <span className="hub-tab-count">{enabledCloudCount}</span>
              )}
            </button>
          </div>

          <button type="button" className="icon-btn" aria-label={t("models.close")} onClick={onClose}>
            <X size={16} />
          </button>
        </div>
      ) : initialTab !== "cloud" ? (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 12, flexWrap: "wrap" }}>
          <div className="hub-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={hubTab === "local"}
              className={`hub-tab-btn ${hubTab === "local" ? "active" : ""}`}
              onClick={() => setHubTab("local")}
            >
              <HardDrive size={14} />
              <span>{t("models.tabLocal")}</span>
              <span className="hub-tab-count">{localModels.length}</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={hubTab === "discover"}
              className={`hub-tab-btn ${hubTab === "discover" ? "active" : ""}`}
              onClick={() => setHubTab("discover")}
            >
              <Globe size={14} />
              <span>{t("models.tabDiscover")}</span>
            </button>
          </div>
          {(gpuLabel || ramLabel) && (
            <div className="hub-hw-pill">
              <Cpu size={12} />
              <span>{[gpuLabel, ramLabel].filter(Boolean).join(" · ")}</span>
            </div>
          )}
        </div>
      ) : null}

      <div className="hub-body" style={embedded ? { padding: 0 } : undefined}>
          {hubTab === "cloud" ? (() => {
            const connectedCount = cloudProviders.filter((p) => p.enabled && p.models.length > 0).length;
            const totalCloudModels = cloudProviders
              .filter((p) => p.enabled)
              .reduce((acc, p) => acc + p.models.length, 0);

            return (
            <div className="hub-local-view" style={{ gap: 14 }}>
              <div className="cloud-summary-bar">
                <div className="cloud-summary-meta">
                  <span className={`cloud-status-dot ${connectedCount > 0 ? "online" : ""}`} />
                  <span>
                    {connectedCount > 0
                      ? locale === "es"
                        ? `${connectedCount} conectado(s) · ${totalCloudModels} modelos disponibles`
                        : `${connectedCount} connected · ${totalCloudModels} models available`
                      : locale === "es"
                        ? "Selecciona un proveedor para conectar tu clave API o endpoint local"
                        : "Select a provider below to connect your API key or local endpoint"}
                  </span>
                </div>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={addCustomProvider}
                  >
                    <Plus size={13} />
                    <span>{t("models.addCustom")}</span>
                  </button>
                  <button
                    type="button"
                    className="btn-primary"
                    disabled={savingCloud}
                    onClick={() => void saveCloudProviders(false)}
                  >
                    <Save size={13} />
                    <span>{savingCloud ? t("models.saving") : t("models.save")}</span>
                  </button>
                </div>
              </div>

              <div className="cloud-provider-list">
                {cloudProviders.map((prov, idx) => {
                  const isCustom = !["openai", "anthropic", "gemini", "github", "openrouter", "lmstudio", "ollama"].includes(prov.id);
                  const isLocalApi = prov.id === "ollama" || prov.id === "lmstudio";
                  const isFetching = fetchingProviderId === prov.id;
                  const provErr = providerErrors[prov.id];
                  const isExpanded = expandedProviderId === prov.id;
                  const isConnected = prov.enabled && prov.models.length > 0;
                  const hasKey = prov.apiKey.trim().length > 0;
                  const brand = PROVIDER_BRAND[prov.id] ?? {
                    badge: "API",
                    color: "#f472b6",
                    bg: "rgba(244, 114, 182, 0.14)",
                    descEn: prov.baseUrl || "Custom OpenAI-compatible or Anthropic API",
                    descEs: prov.baseUrl || "API personalizada compatible con OpenAI o Anthropic",
                  };
                  const searchFilter = (providerModelSearch[prov.id] ?? "").trim().toLowerCase();
                  const visibleModels = prov.models
                    .filter((m) => !searchFilter || m.toLowerCase().includes(searchFilter))
                    .slice(0, 30);

                  return (
                    <div
                      key={prov.id}
                      className={`cloud-row-item ${isExpanded ? "is-expanded" : ""} ${isConnected ? "is-connected" : ""}`}
                    >
                      <div
                        className="cloud-row-header"
                        onClick={() => setExpandedProviderId(isExpanded ? null : prov.id)}
                      >
                        <div
                          className="cloud-brand-avatar"
                          style={{ color: brand.color, background: brand.bg, borderColor: `${brand.color}33` }}
                        >
                          {brand.badge}
                        </div>

                        <div className="cloud-row-info">
                          <div className="cloud-row-title-line">
                            <span className="cloud-row-name">{prov.name}</span>
                            {isConnected ? (
                              <span className="cloud-pill connected">
                                {locale === "es"
                                  ? `${prov.models.length} modelos`
                                  : `${prov.models.length} models`}
                              </span>
                            ) : hasKey ? (
                              <span className="cloud-pill configured">
                                {locale === "es" ? "Clave guardada" : "Key saved"}
                              </span>
                            ) : null}
                          </div>
                          <div className="cloud-row-sub truncate-text">
                            {locale === "es" ? brand.descEs : brand.descEn}
                          </div>
                        </div>

                        <div
                          className="cloud-row-controls"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <button
                            type="button"
                            role="switch"
                            aria-checked={prov.enabled}
                            aria-label={prov.enabled ? `Disable ${prov.name}` : `Enable ${prov.name}`}
                            className={`cloud-toggle-btn ${prov.enabled ? "is-on" : ""}`}
                            onClick={() => updateProvider(idx, { enabled: !prov.enabled })}
                          >
                            <span className="cloud-toggle-thumb" />
                          </button>
                          <button
                            type="button"
                            className="cloud-expand-btn"
                            onClick={() => setExpandedProviderId(isExpanded ? null : prov.id)}
                          >
                            {isExpanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                          </button>
                        </div>
                      </div>

                      {isExpanded && (
                        <div className="cloud-row-drawer">
                          {(isCustom || isLocalApi) && (
                            <div className="cloud-drawer-grid">
                              {isCustom ? (
                                <label className="cloud-field-label">
                                  <span>{locale === "es" ? "Nombre" : "Provider name"}</span>
                                  <input
                                    type="text"
                                    value={prov.name}
                                    onChange={(e) => updateProvider(idx, { name: e.target.value })}
                                    className="cloud-field-input"
                                  />
                                </label>
                              ) : (
                                <label className="cloud-field-label">
                                  <span>{locale === "es" ? "URL base" : "Base URL"}</span>
                                  <input
                                    type="text"
                                    value={prov.baseUrl}
                                    onChange={(e) => updateProvider(idx, { baseUrl: e.target.value })}
                                    placeholder={
                                      prov.id === "lmstudio"
                                        ? "http://127.0.0.1:1234/v1"
                                        : "http://127.0.0.1:11434/v1"
                                    }
                                    className="cloud-field-input"
                                  />
                                </label>
                              )}
                              <label className="cloud-field-label">
                                <span>{locale === "es" ? "Compatibilidad API" : "API compatibility"}</span>
                                <select
                                  value={prov.kind}
                                  onChange={(e) => updateProvider(idx, { kind: e.target.value })}
                                  className="cloud-field-input"
                                >
                                  <option value="openai_compat">OpenAI-compatible (/v1)</option>
                                  <option value="anthropic">Anthropic (/v1/messages)</option>
                                </select>
                              </label>
                            </div>
                          )}

                          <div className="cloud-drawer-grid">
                            <label className="cloud-field-label" style={{ gridColumn: isCustom ? undefined : "1 / -1" }}>
                              <div className="cloud-label-head">
                                <span>
                                  {isLocalApi
                                    ? locale === "es"
                                      ? "Token / Secret del servidor (opcional)"
                                      : "Server Token / Secret (optional)"
                                    : t("models.apiKey")}
                                </span>
                                {brand.keyUrl && (
                                  <a
                                    href={brand.keyUrl}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="cloud-key-link"
                                  >
                                    <span>{locale === "es" ? "Obtener clave" : "Get API key"}</span>
                                    <ExternalLink size={11} />
                                  </a>
                                )}
                              </div>
                              <div className="cloud-key-input-wrap">
                                <KeyRound size={13} className="cloud-key-icon" />
                                <input
                                  type={showKeyIds[prov.id] ? "text" : "password"}
                                  value={prov.apiKey}
                                  onChange={(e) => updateProvider(idx, { apiKey: e.target.value })}
                                  placeholder={
                                    isLocalApi
                                      ? locale === "es"
                                        ? "Opcional — Bearer token o ${ENV_VAR}"
                                        : "Optional — Bearer token or ${ENV_VAR}"
                                      : "sk-... or ${API_KEY}"
                                  }
                                  className="cloud-field-input"
                                />
                                <button
                                  type="button"
                                  className="cloud-eye-btn"
                                  title={showKeyIds[prov.id] ? "Hide" : "Show"}
                                  onClick={() =>
                                    setShowKeyIds((prev) => ({ ...prev, [prov.id]: !prev[prov.id] }))
                                  }
                                >
                                  {showKeyIds[prov.id] ? <EyeOff size={13} /> : <Eye size={13} />}
                                </button>
                              </div>
                            </label>

                            {isCustom && (
                              <label className="cloud-field-label">
                                <span>{locale === "es" ? "URL base" : "Base URL"}</span>
                                <input
                                  type="text"
                                  value={prov.baseUrl}
                                  onChange={(e) => updateProvider(idx, { baseUrl: e.target.value })}
                                  placeholder="https://api.example.com/v1"
                                  className="cloud-field-input"
                                />
                              </label>
                            )}
                          </div>

                          <div className="cloud-drawer-actions">
                            <button
                              type="button"
                              className="btn-primary"
                              style={{ fontSize: 12, padding: "6px 12px" }}
                              disabled={isFetching}
                              onClick={() => void handleFetchProviderModels(idx)}
                            >
                              <RefreshCw size={12} className={isFetching ? "spin" : ""} />
                              <span>
                                {isFetching
                                  ? t("models.fetching")
                                  : prov.models.length > 0
                                    ? t("models.refreshModels")
                                    : t("models.connectLoad")}
                              </span>
                            </button>

                            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                              {prov.models.length > 8 && (
                                <input
                                  type="text"
                                  value={providerModelSearch[prov.id] ?? ""}
                                  onChange={(e) =>
                                    setProviderModelSearch((prev) => ({
                                      ...prev,
                                      [prov.id]: e.target.value,
                                    }))
                                  }
                                  placeholder={locale === "es" ? "Filtrar modelos…" : "Filter models…"}
                                  className="cloud-field-input"
                                  style={{ maxWidth: 180, padding: "4px 9px", fontSize: 12 }}
                                />
                              )}
                              {isCustom && (
                                <button
                                  type="button"
                                  className="btn-secondary"
                                  style={{ color: "#f87171", padding: "5px 9px", fontSize: 12 }}
                                  onClick={() => removeProvider(idx)}
                                >
                                  <Trash2 size={12} />
                                  <span>{locale === "es" ? "Eliminar" : "Remove"}</span>
                                </button>
                              )}
                            </div>
                          </div>

                          {provErr && (
                            <div className="cloud-drawer-error">{provErr}</div>
                          )}

                          {visibleModels.length > 0 && (
                            <div className="cloud-models-tray">
                              {visibleModels.map((mid) => {
                                const uri = `cloud::${prov.id}::${mid}`;
                                const isActive = effectiveActivePath === uri;
                                return (
                                  <button
                                    key={mid}
                                    type="button"
                                    className={`chip ${isActive ? "active" : ""}`}
                                    onClick={() => void useCloudModel(prov, mid)}
                                  >
                                    {isActive && <Check size={11} style={{ marginRight: 4, verticalAlign: -1 }} />}
                                    <span>{mid}</span>
                                  </button>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
            );
          })() : hubTab === "local" ? (
            <div className="hub-local-view">
              <div className="hub-toolbar">
                <div className="hub-search-box">
                  <Search size={14} className="hub-search-icon" />
                  <input
                    type="text"
                    value={localSearch}
                    onChange={(e) => setLocalSearch(e.target.value)}
                    placeholder={
                      locale === "es"
                        ? "Buscar entre tus modelos locales (nombre, familia o cuantización Q4, Q8, UD-Q4_K_XL...)"
                        : "Search your local models (name, family, or quantization Q4, Q8, UD-Q4_K_XL...)"
                    }
                  />
                  {localSearch && (
                    <button
                      type="button"
                      className="icon-btn"
                      onClick={() => setLocalSearch("")}
                    >
                      <X size={12} />
                    </button>
                  )}
                </div>
                <button
                  type="button"
                  className="btn-secondary"
                  title="Volver a escanear carpetas de LM Studio y Loors"
                  onClick={refreshLocal}
                >
                  <RefreshCw size={13} />
                  <span>{locale === "es" ? "Reescanear" : "Rescan"}</span>
                </button>
              </div>

              {localFamilies.length > 2 && (
                <div className="hub-filter-chips">
                  {localFamilies.map((fam) => (
                    <button
                      key={fam}
                      type="button"
                      className={`chip ${familyFilter === fam ? "active" : ""}`}
                      onClick={() => setFamilyFilter(fam)}
                    >
                      {fam === "Todos" ? (locale === "es" ? "Todos" : "All") : fam}
                    </button>
                  ))}
                </div>
              )}

              {groupedLocalModels.length === 0 ? (
                <div className="hub-empty-box">
                  <HardDrive size={28} style={{ color: "#64748b" }} />
                  <strong>
                    {localModels.length === 0
                      ? locale === "es"
                        ? "No hay archivos .gguf locales todavía"
                        : "No local .gguf models yet"
                      : locale === "es"
                        ? "Ningún modelo coincide con tu búsqueda"
                        : "No models match your search"}
                  </strong>
                  <p>
                    {localModels.length === 0
                      ? locale === "es"
                        ? "Loors detecta automáticamente modelos descargados en LM Studio y en su carpeta local, o puedes descargar cuantizaciones ahora desde Hugging Face."
                        : "Loors automatically detects GGUF models from LM Studio and its local folder, or you can download quantizations directly from Hugging Face."
                      : locale === "es"
                        ? "Prueba limpiando el filtro o explorando nuevos modelos en Hugging Face."
                        : "Try clearing the filter or exploring models on Hugging Face."}
                  </p>
                  <button
                    type="button"
                    className="btn-primary"
                    onClick={() => setHubTab("discover")}
                  >
                    <Globe size={14} />
                    <span>
                      {locale === "es"
                        ? "Explorar modelos en Hugging Face"
                        : "Explore models on Hugging Face"}
                    </span>
                  </button>
                </div>
              ) : (
                <div className="hub-card-grid">
                  {groupedLocalModels.map((grp) => {
                    const hasLocalMmproj = localModels.some((m) =>
                      m.name.toLowerCase().includes("mmproj")
                    );
                    const caps = detectModelModalities(grp.baseName, false);
                    return (
                    <div
                      key={`${grp.family}-${grp.baseName}`}
                      className="model-family-card"
                    >
                      <div className="model-family-head">
                        <div className="model-family-meta">
                          <div className="model-badges-row">
                            <span className="model-family-tag">{grp.family}</span>
                            {grp.params && (
                              <span className="model-param-tag">{grp.params}</span>
                            )}
                            <span className="model-source-tag">
                              {grp.sourceLabel}
                            </span>
                            {caps.text && (
                              <span className="cap-badge cap-text" title="Text / Chat">
                                Text
                              </span>
                            )}
                            {caps.vision && (
                              <span
                                className="cap-badge cap-vision"
                                title={
                                  hasLocalMmproj
                                    ? "Supports images (mmproj detected)"
                                    : "Vision model (download matching mmproj for image input)"
                                }
                              >
                                Images
                              </span>
                            )}
                            {caps.thinking && (
                              <span className="cap-badge cap-thinking" title="Reasoning / Thinking">
                                Thinking
                              </span>
                            )}
                            {caps.tools && (
                              <span className="cap-badge cap-tools" title="Function / Tool calling">
                                Tools
                              </span>
                            )}
                          </div>
                          <h4 className="model-family-title">{grp.baseName}</h4>
                        </div>
                        <span className="model-quant-count tabular-nums">
                          {grp.items.length}{" "}
                          {locale === "es"
                            ? grp.items.length === 1
                              ? "cuantización"
                              : "cuantizaciones"
                            : grp.items.length === 1
                              ? "quantization"
                              : "quantizations"}
                        </span>
                      </div>

                      <div className="quant-table">
                        {grp.items.map(({ file, meta }) => {
                          const isSelected = effectiveActivePath === file.path;
                          const sizeGb = file.size_mb / 1024;
                          const fit = getHardwareFit(sizeGb, budgetGb, locale);
                          return (
                            <div
                              key={file.path}
                              className={`quant-row ${isSelected ? "is-active" : ""}`}
                            >
                              <div className="quant-row-main">
                                <span className={`quant-pill ${meta.quantColor}`}>
                                  {meta.quant}
                                </span>
                                <div className="quant-desc-col">
                                  <div className="quant-quality-line">
                                    <span>{meta.quantQuality}</span>
                                    {meta.recommended && !isSelected && (
                                      <span className="rec-badge">
                                        {locale === "es" ? "★ Recomendado" : "★ Recommended"}
                                      </span>
                                    )}
                                  </div>
                                  <div
                                    className="quant-path-sub truncate-text"
                                    title={file.path}
                                  >
                                    {file.path}
                                  </div>
                                </div>
                              </div>

                              <div className="quant-row-actions">
                                <span className={`fit-badge ${fit.cls}`}>
                                  {fit.label}
                                </span>
                                <span className="quant-size tabular-nums">
                                  {sizeGb >= 1
                                    ? `${sizeGb.toFixed(2)} GB`
                                    : `${file.size_mb} MB`}
                                </span>
                                {!meta.isMmproj && (
                                  <button
                                    type="button"
                                    className="btn-secondary"
                                    title="Configurar opciones del modelo (KV Cache, Flash Attention, Compactación, Contexto...)"
                                    onClick={() => openTuningModal(file.path)}
                                  >
                                    <Settings size={13} />
                                    <span>{locale === "es" ? "Opciones" : "Options"}</span>
                                  </button>
                                )}
                                <button
                                  type="button"
                                  className="icon-btn danger"
                                  title={`Eliminar ${file.name} del disco`}
                                  onClick={() => void handleDeleteLocalModel(file)}
                                >
                                  <Trash2 size={13} />
                                </button>
                                <button
                                  type="button"
                                  className={isSelected ? "btn-mini active-select" : "btn-primary"}
                                  onClick={() => selectModel(file.path)}
                                >
                                  {isSelected ? (
                                    <>
                                      <Check size={13} />
                                      <span>Activo</span>
                                    </>
                                  ) : (
                                    <span>{locale === "es" ? "Seleccionar" : "Select"}</span>
                                  )}
                                </button>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                  })}
                </div>
              )}
            </div>
          ) : (
            <div className="hub-discover-view">
              <div className="hub-toolbar">
                <div className="hub-search-box">
                  <Search size={14} className="hub-search-icon" />
                  <input
                    type="text"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void runSearch(query);
                    }}
                    placeholder={
                      locale === "es"
                        ? "Buscar modelos GGUF en Hugging Face..."
                        : "Search GGUF models on Hugging Face..."
                    }
                  />
                </div>
                <button
                  type="button"
                  className="btn-primary"
                  disabled={searching}
                  onClick={() => void runSearch(query)}
                >
                  <Search size={14} />
                  <span>
                    {searching
                      ? locale === "es"
                        ? "Buscando…"
                        : "Searching…"
                      : locale === "es"
                        ? "Buscar en HF"
                        : "Search HF"}
                  </span>
                </button>
              </div>

              <div className="hub-filter-chips">
                {HF_SORT_OPTIONS.map((opt) => (
                  <button
                    key={opt.id}
                    type="button"
                    className={`chip ${sortBy === opt.id ? "active" : ""}`}
                    onClick={() => {
                      setSortBy(opt.id);
                      void runSearch(query, opt.id);
                    }}
                  >
                    {locale === "es" ? opt.labelEs : opt.labelEn}
                  </button>
                ))}
              </div>

              <div className="hf-split-pane">
                <div className="hf-repos-col">
                  <div className="hf-pane-title">
                    {locale === "es"
                      ? `Repositorios encontrados (${repos.length})`
                      : `Repositories found (${repos.length})`}
                  </div>
                  <div className="hf-repos-list">
                    {searching && (
                      <div className="hw-note">
                        {locale === "es"
                          ? "Consultando Hugging Face…"
                          : "Querying Hugging Face…"}
                      </div>
                    )}
                    {!searching && repos.length === 0 && (
                      <div className="hw-note">
                        {locale === "es"
                          ? "Busca arriba un modelo para ver sus cuantizaciones GGUF."
                          : "Search for a model above to inspect its GGUF quantizations."}
                      </div>
                    )}
                    {repos.map((r) => {
                      const [author, repoName] = r.id.includes("/")
                        ? r.id.split("/", 2)
                        : ["HF", r.id];
                      const meta = parseGgufMetadata(repoName);
                      const caps = detectModelModalities(repoName);
                      const active = selectedRepo === r.id;
                      const updatedDate = r.last_modified
                        ? r.last_modified.slice(0, 10)
                        : null;
                      return (
                        <button
                          key={r.id}
                          type="button"
                          className={`hf-repo-card ${active ? "active" : ""}`}
                          onClick={() => void openRepoFiles(r.id)}
                        >
                          <div className="hf-repo-top">
                            <span className="hf-author">{author}</span>
                            <span className="model-family-tag">{meta.family}</span>
                            {meta.params && (
                              <span className="model-param-tag">{meta.params}</span>
                            )}
                            {caps.vision && (
                              <span className="cap-badge cap-vision">Images</span>
                            )}
                            {caps.thinking && (
                              <span className="cap-badge cap-thinking">Thinking</span>
                            )}
                          </div>
                          <div className="hf-repo-name">{repoName}</div>
                          <div className="hf-repo-stats tabular-nums">
                            <span>↓ {formatCount(r.downloads)}</span>
                            <span>
                              <Heart size={10} style={{ verticalAlign: -1 }} />{" "}
                              {formatCount(r.likes)}
                            </span>
                            {updatedDate && (
                              <span style={{ marginLeft: "auto", opacity: 0.7 }}>
                                {updatedDate}
                              </span>
                            )}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div className="hf-quants-col">
                  <div className="hf-quants-head">
                    <div>
                      <div className="hf-pane-title">
                        {locale === "es"
                          ? "Cuantizaciones GGUF disponibles"
                          : "Available GGUF quantizations"}
                      </div>
                      {selectedRepo && (
                        <div className="hf-selected-repo-id">{selectedRepo}</div>
                      )}
                    </div>
                    {ggufFiles.length > 0 && (
                      <input
                        type="text"
                        className="hf-quant-filter"
                        placeholder={
                          locale === "es"
                            ? "Filtrar Q4_K_M, Q8_0..."
                            : "Filter Q4_K_M, Q8_0..."
                        }
                        value={quantFilter}
                        onChange={(e) => setQuantFilter(e.target.value)}
                      />
                    )}
                  </div>

                  <div className="hf-quants-list">
                    {!selectedRepo ? (
                      <div className="hw-note">
                        {locale === "es"
                          ? "Selecciona un repositorio a la izquierda para inspeccionar todas sus cuantizaciones y tamaños."
                          : "Select a repository on the left to inspect all its quantizations and sizes."}
                      </div>
                    ) : loadingFiles ? (
                      <div className="hw-note">
                        {locale === "es"
                          ? "Cargando árbol de cuantizaciones GGUF…"
                          : "Loading GGUF quantization tree…"}
                      </div>
                    ) : filteredRepoFiles.length === 0 ? (
                      <div className="hw-note">
                        {locale === "es"
                          ? "No se encontraron archivos `.gguf` con ese filtro en este repositorio."
                          : "No `.gguf` files matched that filter in this repository."}
                      </div>
                    ) : (
                      filteredRepoFiles.map((f) => {
                        const meta = parseGgufMetadata(f.filename, f.size_bytes);
                        const fit = getHardwareFit(meta.sizeGb, budgetGb, locale);
                        const localMatch = findLocalMatch(f.filename);
                        const dlKey = `${selectedRepo}::${f.filename}`;
                        const dlItem = activeDownloads[dlKey];
                        const isThisDownloading =
                          dlItem?.stage === "starting" || dlItem?.stage === "downloading";
                        const thisPct = dlItem?.percent;
                        const thisSpeed =
                          dlItem?.speed_bps && dlItem.speed_bps > 0
                            ? dlItem.speed_bps >= 1024 * 1024
                              ? `${(dlItem.speed_bps / (1024 * 1024)).toFixed(1)} MB/s`
                              : `${Math.round(dlItem.speed_bps / 1024)} KB/s`
                            : null;
                        return (
                          <div key={f.filename} className="quant-row">
                            <div className="quant-row-main">
                              <span className={`quant-pill ${meta.quantColor}`}>
                                {meta.quant}
                              </span>
                              <div className="quant-desc-col">
                                <div className="quant-quality-line" style={{ flexWrap: "wrap", rowGap: 2 }}>
                                  <span style={{ whiteSpace: "nowrap" }}>{meta.quantQuality}</span>
                                  {meta.recommended && (
                                    <span className="rec-badge" style={{ whiteSpace: "nowrap" }}>
                                      {locale === "es" ? "★ Recomendado" : "★ Recommended"}
                                    </span>
                                  )}
                                </div>
                                <div
                                  className="quant-path-sub truncate-text"
                                  title={f.filename}
                                >
                                  {f.filename}
                                </div>
                                {isThisDownloading && (
                                  <div className="quant-inline-dl">
                                    <div className="dl-progress-track">
                                      <div
                                        className="dl-progress-fill"
                                        style={{
                                          width: `${Math.max(2, Math.min(100, thisPct ?? 0))}%`,
                                        }}
                                      />
                                    </div>
                                    <span className="tabular-nums">
                                      {thisPct != null ? `${thisPct.toFixed(1)}%` : "…"}
                                      {thisSpeed ? ` · ${thisSpeed}` : ""}
                                    </span>
                                  </div>
                                )}
                              </div>
                            </div>

                            <div className="quant-row-actions">
                              <span className={`fit-badge ${fit.cls}`}>
                                {fit.label}
                              </span>
                              <span className="quant-size tabular-nums">
                                {formatBytes(f.size_bytes)}
                              </span>
                              {localMatch ? (
                                <button
                                  type="button"
                                  className={
                                    effectiveActivePath === localMatch.path
                                      ? "btn-mini active-select"
                                      : "btn-secondary"
                                  }
                                  onClick={() => selectModel(localMatch.path)}
                                >
                                  <Check size={13} />
                                  <span>
                                    {effectiveActivePath === localMatch.path
                                      ? locale === "es"
                                        ? "Activo"
                                        : "Active"
                                      : locale === "es"
                                        ? "Descargado · Usar"
                                        : "Downloaded · Use"}
                                  </span>
                                </button>
                              ) : isThisDownloading ? (
                                <button
                                  type="button"
                                  className="btn-secondary"
                                  title={locale === "es" ? "Cancelar descarga" : "Cancel download"}
                                  onClick={() =>
                                    void cancelModelDownload(selectedRepo, f.filename)
                                  }
                                >
                                  <X size={13} />
                                  <span>
                                    {locale === "es" ? "Cancelar" : "Cancel"}
                                  </span>
                                </button>
                              ) : (
                                <button
                                  type="button"
                                  className="btn-primary"
                                  onClick={() =>
                                    handleDownload(selectedRepo, f.filename, f.size_bytes)
                                  }
                                >
                                  <Download size={13} />
                                  <span>
                                    {locale === "es" ? "Descargar" : "Download"}
                                  </span>
                                </button>
                              )}
                            </div>
                          </div>
                        );
                      })
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}

          {error && <div className="hw-error">{error}</div>}
      </div>
    </>
  );

  if (embedded) {
    return (
      <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
        {content}
      </div>
    );
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal-card modal-hub"
        onClick={(e) => e.stopPropagation()}
      >
        {content}
      </div>
    </div>
  );
}
