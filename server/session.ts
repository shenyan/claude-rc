// State hub: owns the thread map, spawns one ClaudeProcess per thread,
// translates claude stream-json frames into ServerMsg envelope.
//
// Persistence: thread list (id/sessionId/title/cwd/...) is mirrored to
// ~/.claude-rc/threads.json so a daemon restart can reload the list.
// Per-thread item history is rebuilt by re-spawning claude with
// --resume <sessionId>; claude itself replays the rollout from its
// internal session log.

import { ClaudeProcess, type ClaudeFrame } from "./claude/process";
import { TmuxMirror } from "./tmux-mirror";
import type {
  ChatItem,
  ClientMsg,
  ServerMsg,
  ThreadStatus,
  ThreadSummary,
} from "../shared/protocol";
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

type Subscriber = (msg: ServerMsg) => void;

interface ThreadState {
  summary: ThreadSummary;
  items: ChatItem[];
  proc: ClaudeProcess | null;
  mirror: TmuxMirror | null;
  /** True while claude is mid-turn — used to gate concurrent send_text. */
  busy: boolean;
}

const STORAGE_DIR = join(homedir(), ".claude-rc");
const THREADS_FILE = join(STORAGE_DIR, "threads.json");

export class Session {
  private threads = new Map<string, ThreadState>();
  private subscribers = new Set<Subscriber>();
  readonly defaultCwd: string;

  constructor(opts: { defaultCwd: string }) {
    this.defaultCwd = opts.defaultCwd;
    this.loadPersisted();
  }

  ready() { return Promise.resolve(); }

  subscribe(s: Subscriber): () => void {
    this.subscribers.add(s);
    return () => this.subscribers.delete(s);
  }

  private broadcast(m: ServerMsg) {
    for (const s of this.subscribers) {
      try { s(m); } catch (err) { console.error("subscriber:", err); }
    }
  }

  // ────────────────  client commands  ────────────────

  async handleClientMsg(msg: ClientMsg, reply: Subscriber): Promise<void> {
    switch (msg.type) {
      case "hello":
        reply(this.snapshot());
        break;
      case "create_thread":
        await this.createThread(msg.cwd ?? this.defaultCwd);
        break;
      case "open_thread":
        await this.openThread(msg.threadId, reply);
        break;
      case "send_text":
        await this.sendText(msg.threadId, msg.text, reply);
        break;
      case "interrupt": {
        const t = this.threads.get(msg.threadId);
        // claude --print stream-json doesn't expose a clean "interrupt this
        // turn" signal — closing stdin terminates the whole process. For
        // now: just kill the proc and re-spawn fresh on next message.
        if (t?.proc) {
          await t.proc.close().catch(() => {});
          t.proc = null;
          t.busy = false;
          this.updateSummary(t, { status: "idle" });
        }
        break;
      }
      case "delete_thread": {
        const t = this.threads.get(msg.threadId);
        if (t?.proc) await t.proc.close().catch(() => {});
        t?.mirror?.close();
        this.threads.delete(msg.threadId);
        this.persist();
        this.broadcast({ type: "thread_deleted", threadId: msg.threadId });
        break;
      }
    }
  }

  snapshot(): ServerMsg {
    return {
      type: "snapshot",
      threads: [...this.threads.values()].map((t) => t.summary),
      defaultCwd: this.defaultCwd,
    };
  }

  // ────────────────  thread lifecycle  ────────────────

  private async createThread(cwd: string) {
    const id = randomUUID();
    const sessionId = randomUUID();
    const summary: ThreadSummary = {
      id,
      sessionId,
      title: null,
      cwd,
      status: "idle",
      lastActiveAt: Date.now(),
      preview: "",
    };
    this.threads.set(id, { summary, items: [], proc: null, mirror: null, busy: false });
    this.persist();
    this.broadcast({ type: "thread_created", thread: summary });
  }

  private async openThread(threadId: string, reply: Subscriber): Promise<void> {
    const t = this.threads.get(threadId);
    if (!t) {
      reply({ type: "error", message: `unknown thread ${threadId}` });
      return;
    }
    reply({ type: "thread_history", threadId: t.summary.id, items: t.items });
  }

  private async sendText(threadId: string, text: string, reply: Subscriber): Promise<void> {
    const t = this.threads.get(threadId);
    if (!t) { reply({ type: "error", message: `unknown thread ${threadId}` }); return; }
    if (t.busy) { reply({ type: "error", message: "thread is busy; wait for current turn to complete" }); return; }

    if (!t.proc) {
      // First message in this thread (or restart after close) — spawn now.
      // Resume if the session has a rollout (any prior items means it does).
      const resume = t.items.length > 0;
      t.proc = new ClaudeProcess({
        cwd: t.summary.cwd,
        sessionId: t.summary.sessionId,
        resume,
      });
      t.proc.onFrame((f) => this.handleFrame(t, f));
      t.proc.onExit((code) => this.handleExit(t, code));
    }
    if (!t.mirror) {
      t.mirror = new TmuxMirror({
        threadId: t.summary.id,
        title: `claude-rc · ${t.summary.title ?? "new chat"} · ${t.summary.cwd}`,
      });
    }

    // Add the user item locally + broadcast immediately so phone shows
    // the message before claude even starts streaming back.
    const userItem: ChatItem = {
      kind: "user",
      id: randomUUID(),
      text,
      createdAt: Date.now(),
    };
    t.items.push(userItem);
    this.broadcast({ type: "item_appended", threadId: t.summary.id, item: userItem });
    this.updateSummary(t, {
      title: t.summary.title ?? text.slice(0, 40),
      preview: text.slice(0, 80),
      lastActiveAt: Date.now(),
      status: "active",
    });
    t.mirror?.user(text);

    t.busy = true;
    t.proc.sendUser(text);
  }

  // ────────────────  claude → ServerMsg  ────────────────

  private handleFrame(t: ThreadState, f: ClaudeFrame) {
    switch (f.type) {
      case "system":
        // {subtype: "init" | "status" | ...}
        // We don't surface these to the UI in v1.
        break;

      case "stream_event":
        this.handleStreamEvent(t, f);
        break;

      case "assistant":
        this.markAgentItemsDone(t);
        t.mirror?.assistantEnd();
        break;

      case "user":
        // Tool result message — claude echoes tool outputs back as user
        // messages with tool_result content blocks.
        this.handleToolResult(t, f);
        break;

      case "result":
        t.busy = false;
        this.markAgentItemsDone(t);
        this.updateSummary(t, {
          status: f.is_error ? "errored" : "idle",
          lastActiveAt: Date.now(),
          preview: this.previewFromLastAgent(t),
        });
        t.mirror?.turnEnd({
          duration_ms: f.duration_ms,
          result: f.result,
          is_error: f.is_error,
        });
        break;

      case "rate_limit_event":
        // Not surfaced to UI yet — could be a banner later.
        break;

      default:
        break;
    }
  }

  private handleStreamEvent(t: ThreadState, f: ClaudeFrame) {
    const ev = f.event;
    if (!ev?.type) return;
    const msgId: string | undefined = ev.message?.id;
    switch (ev.type) {
      case "message_start": {
        // Begin a new agent message. Claude's API ids are stable so we use them.
        if (!msgId) return;
        const item: ChatItem = {
          kind: "agent",
          id: msgId,
          text: "",
          createdAt: Date.now(),
          streaming: true,
        };
        t.items.push(item);
        this.broadcast({ type: "item_appended", threadId: t.summary.id, item });
        break;
      }
      case "content_block_start": {
        // Tool use block begins — claude is about to call a tool.
        const cb = ev.content_block;
        if (cb?.type === "tool_use" && cb.id) {
          const item: ChatItem = {
            kind: "tool_use",
            id: cb.id,
            tool: cb.name ?? "?",
            input: cb.input ?? {},
            createdAt: Date.now(),
            status: "running",
          };
          t.items.push(item);
          this.broadcast({ type: "item_appended", threadId: t.summary.id, item });
          t.mirror?.toolCall(cb.name ?? "?", "");
        }
        break;
      }
      case "content_block_delta": {
        // Most-streamed: text deltas into the current agent message.
        const delta = ev.delta;
        if (!delta) return;
        if (delta.type === "text_delta") {
          const dtxt = delta.text ?? "";
          t.mirror?.assistantDelta(dtxt);
          // Find the most recent streaming agent item and append.
          for (let i = t.items.length - 1; i >= 0; i--) {
            const it = t.items[i];
            if (it.kind === "agent" && it.streaming) {
              (it as any).text += dtxt;
              this.broadcast({ type: "item_updated", threadId: t.summary.id, item: it });
              return;
            }
          }
        } else if (delta.type === "input_json_delta") {
          // Tool input is streamed as JSON deltas — rebuild incrementally
          // for the most-recent running tool_use item.
          for (let i = t.items.length - 1; i >= 0; i--) {
            const it = t.items[i];
            if (it.kind === "tool_use" && it.status === "running") {
              const partial = (it as any)._inputPartial ?? "";
              const next = partial + (delta.partial_json ?? "");
              (it as any)._inputPartial = next;
              try {
                (it as any).input = JSON.parse(next);
                this.broadcast({ type: "item_updated", threadId: t.summary.id, item: it });
              } catch { /* incomplete JSON, wait for more */ }
              return;
            }
          }
        }
        break;
      }
      case "content_block_stop":
      case "message_delta":
      case "message_stop":
        // No-op — handled at the assistant / result frame level.
        break;
    }
  }

  private handleToolResult(t: ThreadState, f: ClaudeFrame) {
    const content = f.message?.content ?? [];
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (block?.type !== "tool_result") continue;
      const toolUseId: string | undefined = block.tool_use_id;
      // Mark the matching tool_use as completed
      const useItem = t.items.find((x) => x.kind === "tool_use" && x.id === toolUseId);
      if (useItem && useItem.kind === "tool_use") {
        useItem.status = block.is_error ? "errored" : "completed";
        this.broadcast({ type: "item_updated", threadId: t.summary.id, item: useItem });
      }
      // Append the result item separately so the UI can show output below the call
      const text = Array.isArray(block.content)
        ? block.content.map((c: any) => c?.text ?? "").join("")
        : (block.content ?? "");
      const resultItem: ChatItem = {
        kind: "tool_result",
        id: randomUUID(),
        toolUseId: toolUseId ?? "",
        output: text,
        createdAt: Date.now(),
        isError: !!block.is_error,
      };
      t.items.push(resultItem);
      this.broadcast({ type: "item_appended", threadId: t.summary.id, item: resultItem });
      t.mirror?.toolResult(text, !!block.is_error);
    }
  }

  private markAgentItemsDone(t: ThreadState) {
    for (const it of t.items) {
      if (it.kind === "agent" && it.streaming) {
        (it as any).streaming = false;
        this.broadcast({ type: "item_updated", threadId: t.summary.id, item: it });
      }
    }
  }

  private previewFromLastAgent(t: ThreadState): string {
    for (let i = t.items.length - 1; i >= 0; i--) {
      const it = t.items[i];
      if (it.kind === "agent" && (it as any).text) {
        return (it as any).text.slice(0, 80);
      }
    }
    return t.summary.preview;
  }

  private updateSummary(t: ThreadState, patch: Partial<ThreadSummary>) {
    t.summary = { ...t.summary, ...patch };
    this.broadcast({ type: "thread_updated", thread: t.summary });
    this.persist();
  }

  private handleExit(t: ThreadState, code: number | null) {
    t.proc = null;
    t.busy = false;
    if (code !== 0 && code !== null) {
      this.updateSummary(t, { status: "errored" });
    } else {
      this.updateSummary(t, { status: "idle" });
    }
  }

  // ────────────────  persistence  ────────────────

  private loadPersisted() {
    if (!existsSync(THREADS_FILE)) return;
    try {
      const raw = readFileSync(THREADS_FILE, "utf8");
      const arr: ThreadSummary[] = JSON.parse(raw);
      for (const s of arr) {
        this.threads.set(s.id, {
          summary: { ...s, status: "idle" },
          items: [],
          proc: null,
          mirror: null,
          busy: false,
        });
      }
      console.log(`[claude-rc] loaded ${arr.length} threads from ${THREADS_FILE}`);
    } catch (err) {
      console.error("[claude-rc] failed to load thread list:", err);
    }
  }

  private persist() {
    if (!existsSync(STORAGE_DIR)) mkdirSync(STORAGE_DIR, { recursive: true });
    const arr = [...this.threads.values()].map((t) => t.summary);
    try {
      writeFileSync(THREADS_FILE, JSON.stringify(arr, null, 2), { mode: 0o600 });
    } catch (err) {
      console.error("[claude-rc] persist failed:", err);
    }
  }
}
