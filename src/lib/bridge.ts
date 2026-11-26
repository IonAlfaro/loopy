import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen as tauriListen, type Event, type UnlistenFn } from "@tauri-apps/api/event";

const TOKEN_STORAGE_KEY = "loors_headless_token";

export function isTauriDesktop(): boolean {
  return (
    typeof window !== "undefined" &&
    ("__TAURI_INTERNALS__" in window || "__TAURI__" in window)
  );
}

// Capture ?token=... from URL on load and scrub it from browser history
function initTokenFromUrl() {
  if (typeof window === "undefined" || isTauriDesktop()) return;
  try {
    const url = new URL(window.location.href);
    const tok = url.searchParams.get("token");
    if (tok && tok.trim()) {
      window.sessionStorage.setItem(TOKEN_STORAGE_KEY, tok.trim());
      url.searchParams.delete("token");
      window.history.replaceState({}, "", url.toString());
    }
  } catch {
    // ignore URL parse errors
  }
}

initTokenFromUrl();

export function getServerToken(): string {
  if (typeof window === "undefined") return "";
  return window.sessionStorage.getItem(TOKEN_STORAGE_KEY) || "";
}

export function setServerToken(token: string) {
  if (typeof window === "undefined") return;
  const trimmed = token.trim();
  if (trimmed) {
    window.sessionStorage.setItem(TOKEN_STORAGE_KEY, trimmed);
  } else {
    window.sessionStorage.removeItem(TOKEN_STORAGE_KEY);
  }
  reconnectSse();
}

export async function checkHeadlessHealth(): Promise<{
  isHeadlessServer: boolean;
  authRequired: boolean;
  authenticated: boolean;
}> {
  if (isTauriDesktop()) {
    return { isHeadlessServer: false, authRequired: false, authenticated: true };
  }
  try {
    const resp = await fetch("/api/health");
    if (!resp.ok) {
      return { isHeadlessServer: false, authRequired: false, authenticated: true };
    }
    const data = await resp.json();
    if (!data?.ok || data?.mode !== "headless") {
      return { isHeadlessServer: false, authRequired: false, authenticated: true };
    }
    const authRequired = Boolean(data.authRequired);
    if (!authRequired) {
      return { isHeadlessServer: true, authRequired: false, authenticated: true };
    }
    const tok = getServerToken();
    if (!tok) {
      return { isHeadlessServer: true, authRequired: true, authenticated: false };
    }
    const vResp = await fetch("/api/auth/verify", {
      method: "POST",
      headers: { Authorization: `Bearer ${tok}` },
    });
    return { isHeadlessServer: true, authRequired: true, authenticated: vResp.ok };
  } catch {
    return { isHeadlessServer: false, authRequired: false, authenticated: true };
  }
}

export async function invoke<T>(
  cmd: string,
  args?: Record<string, unknown>
): Promise<T> {
  if (isTauriDesktop()) {
    return tauriInvoke<T>(cmd, args);
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  const tok = getServerToken();
  if (tok) {
    headers["Authorization"] = `Bearer ${tok}`;
  }

  const resp = await fetch(`/api/rpc/${encodeURIComponent(cmd)}`, {
    method: "POST",
    headers,
    body: JSON.stringify(args ?? {}),
  });

  if (resp.status === 401) {
    window.dispatchEvent(new CustomEvent("loors:auth-required"));
    throw new Error("Authentication required");
  }

  const json = await resp.json().catch(() => ({ ok: false, error: resp.statusText }));
  if (!resp.ok || !json.ok) {
    throw new Error(json?.error || `RPC error (${resp.status})`);
  }
  return json.data as T;
}

// Shared SSE connection for all web listeners
type WebListener = (ev: Event<unknown>) => void;
const listenersByEvent = new Map<string, Set<WebListener>>();
let sseSource: EventSource | null = null;
let sseReconnectTimer: number | null = null;

function ensureSseConnected() {
  if (typeof window === "undefined" || isTauriDesktop() || sseSource) return;
  if (listenersByEvent.size === 0) return;

  const tok = getServerToken();
  const qs = tok ? `?token=${encodeURIComponent(tok)}` : "";
  const es = new EventSource(`/api/events${qs}`);
  sseSource = es;

  es.onmessage = (msg) => {
    try {
      const parsed = JSON.parse(msg.data) as { event?: string; payload?: unknown };
      if (!parsed.event) return;
      const set = listenersByEvent.get(parsed.event);
      if (!set || set.size === 0) return;
      const synthetic: Event<unknown> = {
        event: parsed.event,
        id: 0,
        payload: parsed.payload,
      };
      for (const cb of set) {
        try {
          cb(synthetic);
        } catch {
          // ignore listener errors
        }
      }
    } catch {
      // ignore heartbeat / non-json
    }
  };

  es.onerror = () => {
    es.close();
    if (sseSource === es) sseSource = null;
    if (sseReconnectTimer) window.clearTimeout(sseReconnectTimer);
    if (listenersByEvent.size > 0) {
      sseReconnectTimer = window.setTimeout(() => {
        sseReconnectTimer = null;
        ensureSseConnected();
      }, 2500);
    }
  };
}

function reconnectSse() {
  if (sseSource) {
    sseSource.close();
    sseSource = null;
  }
  ensureSseConnected();
}

export async function listen<T>(
  event: string,
  handler: (event: Event<T>) => void
): Promise<UnlistenFn> {
  if (isTauriDesktop()) {
    return tauriListen<T>(event, handler);
  }

  let set = listenersByEvent.get(event);
  if (!set) {
    set = new Set();
    listenersByEvent.set(event, set);
  }
  const wrapped = handler as WebListener;
  set.add(wrapped);
  ensureSseConnected();

  return () => {
    const cur = listenersByEvent.get(event);
    if (cur) {
      cur.delete(wrapped);
      if (cur.size === 0) listenersByEvent.delete(event);
    }
    if (listenersByEvent.size === 0 && sseSource) {
      sseSource.close();
      sseSource = null;
    }
  };
}
