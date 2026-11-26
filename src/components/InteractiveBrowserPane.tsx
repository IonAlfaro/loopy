import { useCallback, useEffect, useRef, useState } from "react";
import { invoke, listen } from "../lib/bridge";
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

interface BrowserScreencastEvent {
  sessionId: string;
  frameBase64: string;
  viewportWidth: number;
  viewportHeight: number;
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
  sessionId: string;
  agentFrame: BrowserFrameEvent | null;
  agentBusy?: boolean;
  expanded: boolean;
  onToggleExpand: () => void;
  onClosePane: () => void;
}

export function InteractiveBrowserPane({
  sessionId,
  agentFrame,
  agentBusy = false,
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
  const [hasFrame, setHasFrame] = useState(false);
  const [viewportSize, setViewportSize] = useState({ width: 960, height: 720 });
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [copiedUrl, setCopiedUrl] = useState(false);
  const [viewportFocused, setViewportFocused] = useState(false);

  const viewportRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const decoderImgRef = useRef<HTMLImageElement | null>(null);
  const decodingRef = useRef(false);
  const latestFrameUrlRef = useRef<string | null>(null);
  const hasFrameRef = useRef(false);
  const postClickSyncRef = useRef<number | null>(null);
  const lastScreencastTsRef = useRef<number>(0);
  const viewportSizeRef = useRef({ width: 960, height: 720 });
  const omniboxInputRef = useRef<HTMLInputElement | null>(null);
  const inFlightRef = useRef(false);
  const wheelTimerRef = useRef<number | null>(null);
  const pendingWheelRef = useRef<{ x: number; y: number; dx: number; dy: number } | null>(null);
  const pendingTextRef = useRef<string>("");
  const textTimerRef = useRef<number | null>(null);
  const resizeTimerRef = useRef<number | null>(null);
  const measuredRef = useRef({ width: 960, height: 720 });
  const dismissedAgentFrameRef = useRef<BrowserFrameEvent | null>(null);

  const drawFrameToCanvas = useCallback((dataUrl: string) => {
    if (!hasFrameRef.current) {
      hasFrameRef.current = true;
      setHasFrame(true);
    }
    if (decodingRef.current) {
      // Always keep only the newest frame so we never accumulate lag or abort in-flight decodes
      latestFrameUrlRef.current = dataUrl;
      return;
    }
    if (!decoderImgRef.current) {
      decoderImgRef.current = new Image();
    }
    const img = decoderImgRef.current;
    decodingRef.current = true;
    const finish = () => {
      decodingRef.current = false;
      const queued = latestFrameUrlRef.current;
      if (queued) {
        latestFrameUrlRef.current = null;
        drawFrameToCanvas(queued);
      }
    };
    img.onload = () => {
      const canvas = canvasRef.current;
      if (canvas && img.naturalWidth > 0 && img.naturalHeight > 0) {
        if (canvas.width !== img.naturalWidth || canvas.height !== img.naturalHeight) {
          canvas.width = img.naturalWidth;
          canvas.height = img.naturalHeight;
        }
        const ctx = canvas.getContext("2d");
        if (ctx) {
          ctx.drawImage(img, 0, 0);
        }
      }
      finish();
    };
    img.onerror = finish;
    img.src = dataUrl;
  }, []);

  const clearCanvas = useCallback(() => {
    hasFrameRef.current = false;
    latestFrameUrlRef.current = null;
    setHasFrame(false);
    const canvas = canvasRef.current;
    if (canvas) {
      const ctx = canvas.getContext("2d");
      ctx?.clearRect(0, 0, canvas.width, canvas.height);
    }
  }, []);

  // Subscribe to continuous push CDP Page.startScreencast frames (~30-60 FPS) straight to <canvas>
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let disposed = false;
    listen<BrowserScreencastEvent>("loopy://browser-screencast", (event) => {
      const ev = event.payload;
      if (!ev || !ev.frameBase64) return;
      if (ev.sessionId && ev.sessionId !== sessionId) return;
      lastScreencastTsRef.current = Date.now();
      setActive(true);
      if (ev.viewportWidth >= 200 && ev.viewportHeight >= 200) {
        if (
          viewportSizeRef.current.width !== ev.viewportWidth ||
          viewportSizeRef.current.height !== ev.viewportHeight
        ) {
          viewportSizeRef.current = { width: ev.viewportWidth, height: ev.viewportHeight };
          setViewportSize({ width: ev.viewportWidth, height: ev.viewportHeight });
        }
      }
      drawFrameToCanvas(`data:image/jpeg;base64,${ev.frameBase64}`);
    })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch(() => {});
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [sessionId, drawFrameToCanvas]);

  const applyResponse = useCallback(
    (res: BrowserInteractResponse, actionName?: string) => {
      const isCloseAction = actionName === "close_tab";
      if (!res.active && !isCloseAction && agentBusy && agentFrame?.frame_base64 && agentFrame !== dismissedAgentFrameRef.current) {
        // Keep displaying the live agent frame while agent is actively driving
        return;
      }
      if (isCloseAction && !res.active) {
        dismissedAgentFrameRef.current = agentFrame;
      }
      setActive(res.active);
      const isLightInput = actionName === "wheel" || actionName === "text" || actionName === "key";
      if (!isLightInput) {
        setCanGoBack(res.canGoBack);
        setCanGoForward(res.canGoForward);
        setTabs(res.tabs ?? []);
      } else if (!res.active) {
        setTabs([]);
      }
      if (res.viewportWidth && res.viewportHeight) {
        viewportSizeRef.current = { width: res.viewportWidth, height: res.viewportHeight };
        setViewportSize({ width: res.viewportWidth, height: res.viewportHeight });
      }
      if (res.url && res.url !== "about:blank") {
        setUrl(res.url);
        if (!omniboxFocused) setOmnibox(res.url);
      } else {
        setUrl(res.url === "about:blank" ? "about:blank" : "");
        if (!omniboxFocused) setOmnibox("");
      }
      if (res.frameBase64 && res.url !== "about:blank") {
        drawFrameToCanvas(`data:${res.frameMime || "image/jpeg"};base64,${res.frameBase64}`);
      } else if (!res.active || res.url === "about:blank") {
        clearCanvas();
      }
      setErrorMsg(null);
    },
    [omniboxFocused, agentFrame, agentBusy, drawFrameToCanvas, clearCanvas]
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
        const dpr = Math.min(1.25, Math.max(1, window.devicePixelRatio || 1));
        const res = await invoke<BrowserInteractResponse>("browser_interact", {
          request: {
            sessionId,
            width: measuredRef.current.width,
            height: measuredRef.current.height,
            deviceScaleFactor: dpr,
            ...payload,
          },
        });
        applyResponse(res, typeof payload.action === "string" ? payload.action : undefined);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!opts?.silent && !msg.includes("__BROWSER_BUSY__")) {
          setErrorMsg(msg);
        }
      } finally {
        inFlightRef.current = false;
        if (showSpinner) setLoading(false);
        // Immediately pipeline any accumulated wheel/text burst without waiting for another timer tick
        if (pendingWheelRef.current && !wheelTimerRef.current) {
          const p = pendingWheelRef.current;
          pendingWheelRef.current = null;
          void callBrowser(
            { action: "wheel", x: p.x, y: p.y, deltaX: p.dx, deltaY: p.dy },
            { silent: true }
          );
        } else if (pendingTextRef.current && !textTimerRef.current) {
          const txt = pendingTextRef.current;
          pendingTextRef.current = "";
          void callBrowser({ action: "text", text: txt }, { silent: true });
        }
      }
    },
    [applyResponse, sessionId]
  );

  // Measure actual pane dimensions immediately on mount so the first status call seeds preferred viewport
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const { width: w, height: h } = computeLogicalViewport(el.clientWidth, el.clientHeight);
    measuredRef.current = { width: w, height: h };
    setViewportSize({ width: w, height: h });
  }, []);

  // When switching conversations, immediately reset UI to the new conversation's own tabs
  useEffect(() => {
    dismissedAgentFrameRef.current = agentFrame;
    lastScreencastTsRef.current = 0;
    setActive(false);
    setUrl("");
    setOmnibox("");
    setTabs([]);
    clearCanvas();
    setCanGoBack(false);
    setCanGoForward(false);
    setErrorMsg(null);
    if (!agentBusy) {
      const el = viewportRef.current;
      if (el) {
        measuredRef.current = computeLogicalViewport(el.clientWidth, el.clientHeight);
      }
      void callBrowser({ action: "status" }, { silent: true });
    }
  }, [sessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Sync live frames pushed by the AI agent's browser_action tool without colliding on CDP
  useEffect(() => {
    if (!agentFrame || agentFrame === dismissedAgentFrameRef.current) return;
    setActive(true);
    setViewportSize((prev) => {
      const next =
        measuredRef.current.width > 0 && measuredRef.current.height > 0
          ? { width: measuredRef.current.width, height: measuredRef.current.height }
          : prev;
      viewportSizeRef.current = next;
      return next;
    });
    if (agentFrame.url) {
      setUrl(agentFrame.url);
      if (!omniboxFocused) setOmnibox(agentFrame.url);
      setTabs((prev) =>
        prev.length > 0
          ? prev.map((t) =>
              t.active ? { ...t, url: agentFrame.url, title: agentFrame.title || agentFrame.url } : t
            )
          : [{ id: "agent-active", title: agentFrame.title || agentFrame.url, url: agentFrame.url, active: true }]
      );
    }
    if (agentFrame.frame_base64) {
      const isJpeg = agentFrame.frame_base64.startsWith("/9j/");
      drawFrameToCanvas(`data:${isJpeg ? "image/jpeg" : "image/png"};base64,${agentFrame.frame_base64}`);
    }
  }, [agentFrame, omniboxFocused, drawFrameToCanvas]);

  // Initial status sync on mount (only when agent isn't actively driving)
  useEffect(() => {
    if (!agentBusy && !agentFrame) {
      void callBrowser({ action: "status" }, { silent: true });
    }
  }, [callBrowser, agentBusy, agentFrame]);

  const computeLogicalViewport = (clientW: number, clientH: number) => {
    const rawW = Math.max(360, Math.round(clientW));
    const rawH = Math.max(300, Math.round(clientH));
    // Ensure a comfortable minimum desktop width (820px) so popups/modals don't clip on narrow splits
    if (rawW < 820) {
      const ratio = rawH / rawW;
      return { width: 820, height: Math.max(480, Math.round(820 * ratio)) };
    }
    return { width: rawW, height: rawH };
  };

  // Keep Chromium viewport synced to the visible right pane proportions
  useEffect(() => {
    const el = viewportRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (!rect) return;
      const { width: w, height: h } = computeLogicalViewport(rect.width, rect.height);
      if (Math.abs(w - measuredRef.current.width) < 6 && Math.abs(h - measuredRef.current.height) < 6) {
        return;
      }
      measuredRef.current = { width: w, height: h };
      if (resizeTimerRef.current) window.clearTimeout(resizeTimerRef.current);
      resizeTimerRef.current = window.setTimeout(() => {
        if (active && !agentBusy && !inFlightRef.current) {
          void callBrowser({ action: "resize", width: w, height: h }, { silent: true });
        }
      }, 240);
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      if (resizeTimerRef.current) window.clearTimeout(resizeTimerRef.current);
    };
  }, [active, agentBusy, callBrowser]);

  // When the agent finishes/pauses and hands control to the user, fit Chromium cleanly to the pane
  useEffect(() => {
    if (!active || agentBusy) return;
    const el = viewportRef.current;
    if (!el) return;
    const { width: w, height: h } = computeLogicalViewport(el.clientWidth, el.clientHeight);
    measuredRef.current = { width: w, height: h };
    if (!inFlightRef.current) {
      void callBrowser({ action: "resize", width: w, height: h }, { silent: true });
    }
  }, [active, agentBusy, callBrowser]);

  // Gentle metadata/URL sync (screencast already pushes live frames at 30-60 FPS without polling!)
  useEffect(() => {
    if (!active || agentBusy) return;
    const id = window.setInterval(() => {
      if (!inFlightRef.current && document.visibilityState === "visible") {
        // Only poll fast if screencast hasn't delivered a frame recently; otherwise sync URL/tabs every 4s
        const screencastLive = Date.now() - lastScreencastTsRef.current < 5000;
        if (!screencastLive) {
          void callBrowser({ action: "refresh" }, { silent: true });
        }
      }
    }, 3500);
    return () => window.clearInterval(id);
  }, [active, agentBusy, callBrowser]);

  const handleNavigate = (targetUrl?: string) => {
    const next = (targetUrl ?? omnibox).trim();
    if (!next) return;
    setOmnibox(next);
    setOmniboxFocused(false);
    void callBrowser({ action: "navigate", url: next }, { showSpinner: true });
  };

  const mapPointerCoords = (clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    const vw = viewportSizeRef.current.width || viewportSize.width;
    const vh = viewportSizeRef.current.height || viewportSize.height;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    const natW = canvas.width || vw || Math.max(1, rect.width);
    const natH = canvas.height || vh || Math.max(1, rect.height);
    // Matches `object-fit: contain; object-position: top left;`
    const scale = Math.min(rect.width / natW, rect.height / natH);
    const renderedW = Math.max(1, natW * scale);
    const renderedH = Math.max(1, natH * scale);
    const relX = Math.max(0, Math.min(renderedW, clientX - rect.left));
    const relY = Math.max(0, Math.min(renderedH, clientY - rect.top));
    // Map rendered canvas ratio -> CSS logical viewport coordinates expected by CDP Input.dispatchMouseEvent
    return {
      x: Math.round((relX / renderedW) * vw),
      y: Math.round((relY / renderedH) * vh),
    };
  };

  const handleViewportMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (agentBusy) return;
    e.preventDefault();
    viewportRef.current?.focus();
    setViewportFocused(true);
    const { x, y } = mapPointerCoords(e.clientX, e.clientY);
    const button = e.button === 2 ? "right" : e.button === 1 ? "middle" : "left";
    void callBrowser({
      action: "click",
      x,
      y,
      button,
      clickCount: e.detail >= 2 ? 2 : 1,
    });
    // Sync omnibox URL & tab title shortly after clicking in case the click triggered a navigation
    if (postClickSyncRef.current) window.clearTimeout(postClickSyncRef.current);
    postClickSyncRef.current = window.setTimeout(() => {
      postClickSyncRef.current = null;
      if (!inFlightRef.current && !agentBusy) {
        void callBrowser({ action: "status" }, { silent: true });
      }
    }, 900);
  };

  const handleViewportWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    if (!active || agentBusy) return;
    const { x, y } = mapPointerCoords(e.clientX, e.clientY);
    if (pendingWheelRef.current) {
      pendingWheelRef.current.dx += e.deltaX;
      pendingWheelRef.current.dy += e.deltaY;
    } else {
      pendingWheelRef.current = { x, y, dx: e.deltaX, dy: e.deltaY };
    }
    if (!wheelTimerRef.current) {
      wheelTimerRef.current = window.setTimeout(() => {
        wheelTimerRef.current = null;
        if (inFlightRef.current) return; // Will flush immediately in finally()
        const p = pendingWheelRef.current;
        pendingWheelRef.current = null;
        if (p) {
          void callBrowser({ action: "wheel", x: p.x, y: p.y, deltaX: p.dx, deltaY: p.dy }, { silent: true });
        }
      }, 16);
    }
  };

  const handleViewportKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!active || agentBusy) return;
    // Allow paste to be handled by onPaste
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "v") {
      return;
    }
    e.preventDefault();
    e.stopPropagation();

    const modifiers =
      (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);

    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      pendingTextRef.current += e.key;
      if (!textTimerRef.current) {
        textTimerRef.current = window.setTimeout(() => {
          textTimerRef.current = null;
          if (inFlightRef.current) return; // Will flush immediately in finally()
          const txt = pendingTextRef.current;
          pendingTextRef.current = "";
          if (txt) {
            void callBrowser({ action: "text", text: txt }, { silent: true });
          }
        }, 24);
      }
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
    if (!active || agentBusy) return;
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
                  if (!tab.active && !agentBusy) {
                    void callBrowser({ action: "switch_tab", tabId: tab.id }, { showSpinner: true });
                  }
                }}
              >
                <Globe size={12} className="embedded-browser-tab-icon" />
                <span className="truncate-text">{tab.title || L("New Tab", "Nueva pestaña")}</span>
                <button
                  type="button"
                  className="embedded-browser-tab-close"
                  disabled={agentBusy}
                  title={L("Close tab", "Cerrar pestaña")}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (!agentBusy) {
                      void callBrowser({ action: "close_tab", tabId: tab.id }, { showSpinner: true });
                    }
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
            disabled={agentBusy}
            title={L("New tab", "Nueva pestaña")}
            onClick={() => {
              if (agentBusy) return;
              setOmnibox("");
              void callBrowser({ action: "new_tab", url: "about:blank" }, { showSpinner: true });
              window.setTimeout(() => omniboxInputRef.current?.focus(), 60);
            }}
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
            disabled={!canGoBack || agentBusy}
            title={L("Back", "Atrás")}
            onClick={() => void callBrowser({ action: "back" }, { showSpinner: true })}
          >
            <ArrowLeft size={14} />
          </button>
          <button
            type="button"
            className="embedded-browser-icon-btn"
            disabled={!canGoForward || agentBusy}
            title={L("Forward", "Adelante")}
            onClick={() => void callBrowser({ action: "forward" }, { showSpinner: true })}
          >
            <ArrowRight size={14} />
          </button>
          <button
            type="button"
            className="embedded-browser-icon-btn"
            disabled={!active || agentBusy}
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
            if (!agentBusy) handleNavigate();
          }}
        >
          {isSecure ? (
            <Lock size={12} className="embedded-browser-lock secure" />
          ) : (
            <Globe size={12} className="embedded-browser-lock" />
          )}
          <input
            ref={omniboxInputRef}
            type="text"
            disabled={agentBusy}
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

        <canvas
          ref={canvasRef}
          className="embedded-browser-surface"
          style={{ display: active && hasFrame ? "block" : "none" }}
          onMouseDown={handleViewportMouseDown}
        />

        {!(active && hasFrame) && (
          <div className="embedded-browser-start">
            <Globe size={24} style={{ color: "var(--muted)", opacity: 0.55 }} />
            <span style={{ fontSize: 12.5, color: "var(--muted)" }}>
              {L("Enter a URL above to browse", "Escribe una URL arriba para navegar")}
            </span>
          </div>
        )}

        {agentBusy && (
          <div
            className="embedded-browser-agent-lock"
            onMouseDown={(e) => e.preventDefault()}
            onWheel={(e) => e.stopPropagation()}
          >
            <div className="embedded-browser-agent-pill">
              <span className="embedded-browser-agent-dot" />
              <span>
                {L("Agent is controlling the browser…", "El agente está controlando el navegador…")}
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
