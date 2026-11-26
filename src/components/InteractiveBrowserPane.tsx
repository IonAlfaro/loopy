import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "../lib/bridge";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Copy,
  ExternalLink,
  Globe,
  Lock,
  Maximize2,
  Minimize2,
  Plus,
  RotateCw,
  X,
} from "lucide-react";
import type { BrowserFrameEvent } from "../types/graph";
import { useI18n } from "../i18n";

export interface BrowserTabInfo {
  id: string;
  title: string;
  url: string;
  active: boolean;
}

interface BrowserInteractResponse {
  active: boolean;
  url: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
  viewportWidth: number;
  viewportHeight: number;
  frameBase64: string | null;
  frameMime: string;
  tabs: BrowserTabInfo[];
}

interface InteractiveBrowserPaneProps {
  agentFrame: BrowserFrameEvent | null;
  expanded: boolean;
  onToggleExpand: () => void;
  onClosePane: () => void;
}

export function InteractiveBrowserPane({
  agentFrame,
  expanded,
  onToggleExpand,
  onClosePane,
}: InteractiveBrowserPaneProps) {
  const { locale } = useI18n();
  const L = (en: string, es: string) => (locale === "es" ? es : en);

  const [active, setActive] = useState(false);
  const [url, setUrl] = useState("");
  const [omnibox, setOmnibox] = useState("");
  const [omniboxFocused, setOmniboxFocused] = useState(false);
  const [tabs, setTabs] = useState<BrowserTabInfo[]>([]);
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const [frameSrc, setFrameSrc] = useState<string | null>(null);
  const [viewportSize, setViewportSize] = useState({ width: 960, height: 720 });
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [copiedUrl, setCopiedUrl] = useState(false);
  const [viewportFocused, setViewportFocused] = useState(false);

  const viewportRef = useRef<HTMLDivElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const inFlightRef = useRef(false);
  const wheelTimerRef = useRef<number | null>(null);
  const pendingWheelRef = useRef<{ x: number; y: number; dx: number; dy: number } | null>(null);
  const resizeTimerRef = useRef<number | null>(null);
  const measuredRef = useRef({ width: 960, height: 720 });

  const applyResponse = useCallback(
    (res: BrowserInteractResponse) => {
      setActive(res.active);
      setCanGoBack(res.canGoBack);
      setCanGoForward(res.canGoForward);
      setTabs(res.tabs || []);
      if (res.viewportWidth && res.viewportHeight) {
        setViewportSize({ width: res.viewportWidth, height: res.viewportHeight });
      }
      if (res.url) {
        setUrl(res.url);
        if (!omniboxFocused) setOmnibox(res.url);
      } else if (!res.active) {
        setUrl("");
        if (!omniboxFocused) setOmnibox("");
      }
      if (res.frameBase64) {
        setFrameSrc(`data:${res.frameMime || "image/jpeg"};base64,${res.frameBase64}`);
      } else if (!res.active) {
        setFrameSrc(null);
      }
      setErrorMsg(null);
    },
    [omniboxFocused]
  );

  const callBrowser = useCallback(
    async (
      payload: Record<string, unknown>,
      opts?: { showSpinner?: boolean; silent?: boolean }
    ) => {
      const showSpinner = opts?.showSpinner ?? false;
      if (showSpinner) setLoading(true);
      inFlightRef.current = true;
      try {
        const res = await invoke<BrowserInteractResponse>("browser_interact", {
          request: {
            width: measuredRef.current.width,
            height: measuredRef.current.height,
            ...payload,
          },
        });
        applyResponse(res);
      } catch (err) {
        if (!opts?.silent) {
          setErrorMsg(err instanceof Error ? err.message : String(err));
        }
      } finally {
        inFlightRef.current = false;
        if (showSpinner) setLoading(false);
      }
    },
    [applyResponse]
  );

  // Sync live frames pushed by the AI agent's browser_action tool
  useEffect(() => {
    if (!agentFrame) return;
    setActive(true);
    if (agentFrame.url) {
      setUrl(agentFrame.url);
      if (!omniboxFocused) setOmnibox(agentFrame.url);
    }
    if (agentFrame.frame_base64) {
      setFrameSrc(`data:image/png;base64,${agentFrame.frame_base64}`);
    }
    // Refresh tab list & back/forward state quietly
    void callBrowser({ action: "status" }, { silent: true });
  }, [agentFrame, omniboxFocused, callBrowser]);

  // Initial status sync on mount
  useEffect(() => {
    void callBrowser({ action: "status" }, { silent: true });
  }, [callBrowser]);

  // Keep Chromium viewport synced 1:1 with the visible right pane dimensions
  useEffect(() => {
    const el = viewportRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (!rect) return;
      const w = Math.max(360, Math.round(rect.width));
      const h = Math.max(300, Math.round(rect.height));
      if (Math.abs(w - measuredRef.current.width) < 6 && Math.abs(h - measuredRef.current.height) < 6) {
        return;
      }
      measuredRef.current = { width: w, height: h };
      if (resizeTimerRef.current) window.clearTimeout(resizeTimerRef.current);
      resizeTimerRef.current = window.setTimeout(() => {
        if (active && !inFlightRef.current) {
          void callBrowser({ action: "resize", width: w, height: h }, { silent: true });
        }
      }, 240);
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      if (resizeTimerRef.current) window.clearTimeout(resizeTimerRef.current);
    };
  }, [active, callBrowser]);

  // Lightweight live refresh so dynamic SPAs / OAuth redirects update smoothly
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => {
      if (!inFlightRef.current && document.visibilityState === "visible") {
        void callBrowser({ action: "refresh" }, { silent: true });
      }
    }, 2200);
    return () => window.clearInterval(id);
  }, [active, callBrowser]);

  const handleNavigate = (targetUrl?: string) => {
    const next = (targetUrl ?? omnibox).trim();
    if (!next) return;
    setOmnibox(next);
    setOmniboxFocused(false);
    void callBrowser({ action: "navigate", url: next }, { showSpinner: true });
  };

  const mapPointerCoords = (e: React.MouseEvent<HTMLImageElement>) => {
    const img = imgRef.current;
    if (!img) return { x: 0, y: 0 };
    const rect = img.getBoundingClientRect();
    const scaleX = viewportSize.width / Math.max(1, rect.width);
    const scaleY = viewportSize.height / Math.max(1, rect.height);
    return {
      x: Math.round((e.clientX - rect.left) * scaleX),
      y: Math.round((e.clientY - rect.top) * scaleY),
    };
  };

  const handleViewportMouseDown = (e: React.MouseEvent<HTMLImageElement>) => {
    e.preventDefault();
    viewportRef.current?.focus();
    setViewportFocused(true);
    const { x, y } = mapPointerCoords(e);
    const button = e.button === 2 ? "right" : e.button === 1 ? "middle" : "left";
    void callBrowser({
      action: "click",
      x,
      y,
      button,
      clickCount: e.detail >= 2 ? 2 : 1,
    });
  };

  const handleViewportWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    if (!active) return;
    const rect = imgRef.current?.getBoundingClientRect();
    const x = rect ? Math.round(((e.clientX - rect.left) / Math.max(1, rect.width)) * viewportSize.width) : Math.round(viewportSize.width / 2);
    const y = rect ? Math.round(((e.clientY - rect.top) / Math.max(1, rect.height)) * viewportSize.height) : Math.round(viewportSize.height / 2);
    if (pendingWheelRef.current) {
      pendingWheelRef.current.dx += e.deltaX;
      pendingWheelRef.current.dy += e.deltaY;
    } else {
      pendingWheelRef.current = { x, y, dx: e.deltaX, dy: e.deltaY };
    }
    if (!wheelTimerRef.current) {
      wheelTimerRef.current = window.setTimeout(() => {
        const p = pendingWheelRef.current;
        pendingWheelRef.current = null;
        wheelTimerRef.current = null;
        if (p) {
          void callBrowser({ action: "wheel", x: p.x, y: p.y, deltaX: p.dx, deltaY: p.dy }, { silent: true });
        }
      }, 90);
    }
  };

  const handleViewportKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!active) return;
    // Allow paste to be handled by onPaste
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "v") {
      return;
    }
    e.preventDefault();
    e.stopPropagation();

    const modifiers =
      (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);

    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      void callBrowser({ action: "text", text: e.key }, { silent: true });
      return;
    }

    void callBrowser(
      {
        action: "key",
        key: e.key,
        code: e.code,
        modifiers,
      },
      { silent: true }
    );
  };

  const handleViewportPaste = (e: React.ClipboardEvent<HTMLDivElement>) => {
    if (!active) return;
    const text = e.clipboardData.getData("text");
    if (text) {
      e.preventDefault();
      void callBrowser({ action: "text", text }, { silent: true });
    }
  };

  const handleCopyUrl = () => {
    if (!url) return;
    navigator.clipboard?.writeText(url).catch(() => {});
    setCopiedUrl(true);
    window.setTimeout(() => setCopiedUrl(false), 1400);
  };

  const isSecure = url.startsWith("https://");

  return (
    <div className="embedded-browser">
      {/* Row 1: Chrome-style tab strip */}
      <div className="embedded-browser-tabbar">
        <div className="embedded-browser-tabs">
          {tabs.length > 0 ? (
            tabs.map((tab) => (
              <div
                key={tab.id}
                className={`embedded-browser-tab ${tab.active ? "active" : ""}`}
                title={tab.url || tab.title}
                onClick={() => {
                  if (!tab.active) {
                    void callBrowser({ action: "switch_tab", tabId: tab.id }, { showSpinner: true });
                  }
                }}
              >
                <Globe size={12} className="embedded-browser-tab-icon" />
                <span className="truncate-text">{tab.title || L("New Tab", "Nueva pestaña")}</span>
                <button
                  type="button"
                  className="embedded-browser-tab-close"
                  title={L("Close tab", "Cerrar pestaña")}
                  onClick={(e) => {
                    e.stopPropagation();
                    void callBrowser({ action: "close_tab", tabId: tab.id }, { showSpinner: true });
                  }}
                >
                  <X size={11} />
                </button>
              </div>
            ))
          ) : (
            <div className="embedded-browser-tab active">
              <Globe size={12} className="embedded-browser-tab-icon" />
              <span className="truncate-text">{L("New Tab", "Inicio")}</span>
            </div>
          )}
          <button
            type="button"
            className="embedded-browser-icon-btn"
            title={L("New tab", "Nueva pestaña")}
            onClick={() => void callBrowser({ action: "new_tab", url: "https://www.google.com" }, { showSpinner: true })}
          >
            <Plus size={13} />
          </button>
        </div>
        <div className="embedded-browser-tabbar-actions">
          <button
            type="button"
            className="embedded-browser-icon-btn"
            title={expanded ? L("Restore width", "Restaurar ancho") : L("Expand browser pane", "Expandir panel del navegador")}
            onClick={onToggleExpand}
          >
            {expanded ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
          </button>
          <button
            type="button"
            className="embedded-browser-icon-btn"
            title={L("Close panel", "Cerrar panel")}
            onClick={onClosePane}
          >
            <X size={13} />
          </button>
        </div>
      </div>

      {/* Row 2: Navigation + Editable Omnibox */}
      <div className="embedded-browser-navbar">
        <div className="embedded-browser-nav-btns">
          <button
            type="button"
            className="embedded-browser-icon-btn"
            disabled={!canGoBack}
            title={L("Back", "Atrás")}
            onClick={() => void callBrowser({ action: "back" }, { showSpinner: true })}
          >
            <ArrowLeft size={14} />
          </button>
          <button
            type="button"
            className="embedded-browser-icon-btn"
            disabled={!canGoForward}
            title={L("Forward", "Adelante")}
            onClick={() => void callBrowser({ action: "forward" }, { showSpinner: true })}
          >
            <ArrowRight size={14} />
          </button>
          <button
            type="button"
            className="embedded-browser-icon-btn"
            disabled={!active}
            title={L("Reload", "Recargar")}
            onClick={() => void callBrowser({ action: "reload" }, { showSpinner: true })}
          >
            <RotateCw size={13} className={loading ? "spin" : ""} />
          </button>
        </div>

        <form
          className="embedded-browser-omnibox"
          onSubmit={(e) => {
            e.preventDefault();
            handleNavigate();
          }}
        >
          {isSecure ? (
            <Lock size={12} className="embedded-browser-lock secure" />
          ) : (
            <Globe size={12} className="embedded-browser-lock" />
          )}
          <input
            type="text"
            value={omnibox}
            placeholder={L("Enter URL or search...", "Escribe una URL o busca en la web...")}
            onFocus={(e) => {
              setOmniboxFocused(true);
              e.currentTarget.select();
            }}
            onBlur={() => setOmniboxFocused(false)}
            onChange={(e) => setOmnibox(e.target.value)}
          />
        </form>

        <div className="embedded-browser-nav-btns">
          <button
            type="button"
            className="embedded-browser-icon-btn"
            disabled={!url}
            title={copiedUrl ? L("Copied!", "¡Copiado!") : L("Copy URL", "Copiar URL")}
            onClick={handleCopyUrl}
          >
            {copiedUrl ? <Check size={13} /> : <Copy size={13} />}
          </button>
          <button
            type="button"
            className="embedded-browser-icon-btn"
            disabled={!url}
            title={L("Open in external browser", "Abrir en navegador externo")}
            onClick={() => void callBrowser({ action: "open_external", url }, { silent: true })}
          >
            <ExternalLink size={13} />
          </button>
        </div>
      </div>

      {/* Row 3: Full-bleed live interactive viewport */}
      <div
        ref={viewportRef}
        tabIndex={0}
        className={`embedded-browser-viewport ${viewportFocused ? "focused" : ""}`}
        onWheel={handleViewportWheel}
        onKeyDown={handleViewportKeyDown}
        onPaste={handleViewportPaste}
        onFocus={() => setViewportFocused(true)}
        onBlur={() => setViewportFocused(false)}
        onContextMenu={(e) => {
          if (active) e.preventDefault();
        }}
      >
        {loading && <div className="embedded-browser-progress" />}

        {errorMsg && (
          <div className="embedded-browser-toast">
            <span>{errorMsg}</span>
            <button type="button" onClick={() => setErrorMsg(null)}>
              <X size={12} />
            </button>
          </div>
        )}

        {active && frameSrc ? (
          <img
            ref={imgRef}
            className="embedded-browser-surface"
            src={frameSrc}
            alt={url || "Embedded Browser"}
            draggable={false}
            onMouseDown={handleViewportMouseDown}
          />
        ) : (
          <div className="embedded-browser-start">
            <Globe size={24} style={{ color: "var(--muted)", opacity: 0.55 }} />
            <span style={{ fontSize: 12.5, color: "var(--muted)" }}>
              {L("Enter a URL above to browse", "Escribe una URL arriba para navegar")}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
