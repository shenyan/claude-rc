// Tiny WS-backed store. No external dep; useSyncExternalStore subscription.

import { useSyncExternalStore } from "react";
import type {
  ChatItem,
  ClientMsg,
  ServerMsg,
  ThreadSummary,
} from "../../../shared/protocol";

interface State {
  connected: boolean;
  defaultCwd: string;
  threads: ThreadSummary[];
  itemsByThread: Record<string, ChatItem[]>;
  error: string | null;
}

let state: State = {
  connected: false,
  defaultCwd: "",
  threads: [],
  itemsByThread: {},
  error: null,
};

const listeners = new Set<() => void>();
function emit() { for (const l of listeners) l(); }
function set(patch: Partial<State> | ((s: State) => Partial<State>)) {
  const next = typeof patch === "function" ? patch(state) : patch;
  state = { ...state, ...next };
  emit();
}

let ws: WebSocket | null = null;
let reconnectTimer: number | null = null;

function connect() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(`${proto}//${location.host}/ws`);
  ws.onopen = () => {
    set({ connected: true, error: null });
    send({ type: "hello" });
  };
  ws.onclose = () => {
    set({ connected: false });
    if (reconnectTimer) window.clearTimeout(reconnectTimer);
    reconnectTimer = window.setTimeout(connect, 1500);
  };
  ws.onerror = () => set({ error: "WebSocket error" });
  ws.onmessage = (e) => {
    let msg: ServerMsg;
    try { msg = JSON.parse(e.data); } catch { return; }
    handle(msg);
  };
}

function handle(msg: ServerMsg) {
  switch (msg.type) {
    case "snapshot":
      set({ defaultCwd: msg.defaultCwd, threads: sortThreads(msg.threads) });
      break;
    case "thread_created":
    case "thread_updated":
      set((s) => {
        const others = s.threads.filter((t) => t.id !== msg.thread.id);
        return { threads: sortThreads([...others, msg.thread]) };
      });
      break;
    case "thread_deleted":
      set((s) => ({
        threads: s.threads.filter((t) => t.id !== msg.threadId),
        itemsByThread: Object.fromEntries(Object.entries(s.itemsByThread).filter(([k]) => k !== msg.threadId)),
      }));
      break;
    case "thread_history":
      set((s) => ({ itemsByThread: { ...s.itemsByThread, [msg.threadId]: msg.items } }));
      break;
    case "item_appended":
      set((s) => {
        const cur = s.itemsByThread[msg.threadId] ?? [];
        return { itemsByThread: { ...s.itemsByThread, [msg.threadId]: [...cur, msg.item] } };
      });
      break;
    case "item_updated":
      set((s) => {
        const cur = s.itemsByThread[msg.threadId] ?? [];
        const idx = cur.findIndex((x) => x.id === msg.item.id);
        const next = idx >= 0 ? [...cur.slice(0, idx), msg.item, ...cur.slice(idx + 1)] : [...cur, msg.item];
        return { itemsByThread: { ...s.itemsByThread, [msg.threadId]: next } };
      });
      break;
    case "error":
      set({ error: msg.message });
      break;
  }
}

function sortThreads(ts: ThreadSummary[]): ThreadSummary[] {
  return [...ts].sort((a, b) => b.lastActiveAt - a.lastActiveAt);
}

export function send(msg: ClientMsg) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

export function startConnection() {
  if (ws) return;
  connect();
}

export function useStore<T>(selector: (s: State) => T): T {
  return useSyncExternalStore(
    (l) => { listeners.add(l); return () => listeners.delete(l); },
    () => selector(state),
    () => selector(state),
  );
}
