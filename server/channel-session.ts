// State hub for CHANNEL mode (claude in tmux + MCP channel server).
//
// Per-thread lifecycle:
//   1. createThread        — assigns id, persisted to threads.json
//   2. sendText             — if no ChannelProcess, spawn one (tmux + claude
//                             with --dangerously-load-development-channels).
//                             User text is buffered as pendingPush until the
//                             MCP child registers on the control plane; then
//                             we inject it into the tmux session via
//                             send-keys (NOT via notifications/claude/channel
//                             — the welcome/setup screens drop pushes).
//   3. claude calls reply  — control plane forwards; we append agent item

import { ChannelProcess } from "./claude/channel-process";
import { ControlPlane, type ChildToBridgeMsg } from "./control-plane";
import type {
  Block,
  ChatItem,
  ClientMsg,
  ServerMsg,
  ThreadSummary,
} from "../shared/protocol";
import { mkdirSync, existsSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

type Subscriber = (msg: ServerMsg) => void;

interface ThreadState {
  summary: ThreadSummary;
  items: ChatItem[];
  proc: ChannelProcess | null;
  /** Pending user text pushed before the channel handler was ready. */
  pendingPush: string | null;
}

const STORAGE_DIR = join(homedir(), ".claude-rc");
const THREADS_FILE = join(STORAGE_DIR, "threads-channel.json");

/**
 * Read claude's own session transcript and project it into our ChatItem
 * shape. This is the source of truth for thread history across bridge
 * restarts — we don't persist items ourselves; claude already does.
 *
 * File layout: ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl
 * where encoded-cwd replaces `/` and `.` with `-`.
 *
 * We surface only what the user cares about:
 *   - real user prompts (string content, not tool_result wrappers)
 *   - the channel reply tool's text argument as agent messages
 *   - other tool_use / tool_result entries
 * Skipped: permission/snapshot lines, plain TUI assistant text/thinking,
 * TodoWrite, ToolSearch, and our own MCP plumbing tools.
 */
function hydrateFromTranscript(sessionId: string, cwd: string): ChatItem[] {
  const encoded = cwd.replace(/[/.]/g, "-");
  const path = join(homedir(), ".claude", "projects", encoded, `${sessionId}.jsonl`);
  if (!existsSync(path)) return [];

  let raw: string;
  try { raw = readFileSync(path, "utf8"); }
  catch { return []; }

  const items: ChatItem[] = [];
  const NOISE_TOOLS = new Set(["TodoWrite", "ToolSearch"]);
  const isOwnPlumbing = (n: string) => n.startsWith("mcp__claude-rc-channel__");
  // Track tool_use_ids whose tool_result we should suppress in the UI:
  // anything we'd hide live (noise tools, channel plumbing including
  // reply's "delivered" ack).
  const suppressResultIds = new Set<string>();

  for (const line of raw.split("\n")) {
    if (!line) continue;
    let evt: any;
    try { evt = JSON.parse(line); } catch { continue; }
    const parsedTs = evt.timestamp ? Date.parse(evt.timestamp) : Date.now();
    const ts = Number.isFinite(parsedTs) ? parsedTs : Date.now();

    if (evt.type === "user") {
      const content = evt.message?.content;
      if (typeof content === "string") {
        items.push({ kind: "user", id: evt.uuid ?? randomUUID(), text: content, createdAt: ts });
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (block?.type !== "tool_result") continue;
          const tuid = String(block.tool_use_id ?? "");
          if (suppressResultIds.has(tuid)) continue;
          const out = stringifyToolResultContent(block.content) || stringifyToolResultContent(evt.toolUseResult);
          items.push({
            kind: "tool_result",
            id: randomUUID(),
            toolUseId: tuid,
            output: out,
            createdAt: ts,
            isError: !!block.is_error,
          });
        }
      }
    } else if (evt.type === "assistant") {
      const blocks = evt.message?.content;
      if (!Array.isArray(blocks)) continue;
      for (const b of blocks) {
        if (b?.type !== "tool_use") continue;
        const name = String(b.name ?? "");
        const tuid = String(b.id ?? "");
        if (name === "mcp__claude-rc-channel__reply") {
          const text = typeof b.input?.text === "string" ? b.input.text : "";
          const blocks = Array.isArray(b.input?.blocks) ? (b.input.blocks as Block[]) : null;
          if (blocks && blocks.length) {
            const finalBlocks: Block[] = text
              ? [{ type: "text", markdown: text }, ...blocks]
              : blocks;
            items.push({ kind: "blocks", id: b.id ?? randomUUID(), blocks: finalBlocks, createdAt: ts });
          } else if (text) {
            items.push({ kind: "agent", id: b.id ?? randomUUID(), text, createdAt: ts });
          }
          if (tuid) suppressResultIds.add(tuid); // hide reply's "delivered" ack
        } else if (NOISE_TOOLS.has(name) || isOwnPlumbing(name)) {
          if (tuid) suppressResultIds.add(tuid);
        } else {
          items.push({
            kind: "tool_use",
            id: b.id ?? randomUUID(),
            tool: name || "?",
            input: b.input ?? {},
            createdAt: ts,
            status: "completed",
          });
        }
      }
    }
  }
  return items;
}

function previewFromReply(msg: any): string {
  if (typeof msg?.text === "string" && msg.text) return msg.text.slice(0, 80);
  if (Array.isArray(msg?.blocks)) {
    for (const b of msg.blocks) {
      if (b?.type === "text" && typeof b.markdown === "string") return b.markdown.slice(0, 80);
      if (b?.type === "card" && typeof b.title === "string") return b.title.slice(0, 80);
      if (b?.type === "cards_row" && Array.isArray(b.items) && b.items[0]?.title) return String(b.items[0].title).slice(0, 80);
      if (b?.type === "actions") return "(choose an option)";
      // Sensible fallbacks for blocks that don't carry obvious prose —
      // otherwise threads in the list look blank.
      if (b?.type === "code") return b.filename ? `(code: ${b.filename})` : "(code)";
      if (b?.type === "map") return b.label ? `(map: ${b.label})` : "(map)";
      if (b?.type === "stats" && Array.isArray(b.items) && b.items[0]) {
        const s = b.items[0];
        return `${s.label ?? ""}: ${s.value ?? ""}`.slice(0, 80) || "(stats)";
      }
    }
  }
  return "";
}

function stringifyToolResultContent(c: unknown): string {
  if (c == null) return "";
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c.map((b: any) => {
      if (typeof b === "string") return b;
      if (typeof b?.text === "string") return b.text;
      return "";
    }).join("");
  }
  if (typeof c === "object") {
    const obj = c as any;
    if (typeof obj.output === "string") return obj.output;
    if (typeof obj.stdout === "string") return obj.stdout;
    return JSON.stringify(c);
  }
  return String(c);
}

export class ChannelSession {
  private threads = new Map<string, ThreadState>();
  private subscribers = new Set<Subscriber>();
  readonly defaultCwd: string;
  readonly instanceSuffix: string;
  private cp: ControlPlane;
  private cpPort = 0;

  constructor(opts: { defaultCwd: string; instanceSuffix?: string }) {
    this.defaultCwd = opts.defaultCwd;
    this.instanceSuffix = opts.instanceSuffix ?? "";
    this.cp = new ControlPlane({
      authToken: ControlPlane.randomToken(),
      onMessage: (threadId, msg) => this.handleChildMsg(threadId, msg),
      onConnect: (threadId) => {
        const t = this.threads.get(threadId);
        if (t?.proc) {
          t.proc.markReady();
          // Flush any pending user prompt that arrived while claude was
          // still loading. Inject via send-keys (channel push doesn't work
          // before claude enters chat mode).
          if (t.pendingPush) {
            // small delay so claude finishes drawing the TUI prompt
            const pending = t.pendingPush;
            t.pendingPush = null;
            setTimeout(() => t.proc?.injectUserPrompt(pending), 1500);
          }
        }
      },
      onDisconnect: (threadId) => {
        const t = this.threads.get(threadId);
        if (t) this.updateSummary(t, { status: "idle" });
      },
    });
    this.loadPersisted();
  }

  async ready() {
    this.cpPort = await this.cp.start();
    console.log(`[claude-rc-ch] control plane on 127.0.0.1:${this.cpPort}`);
  }

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
        this.createThread(msg.cwd ?? this.defaultCwd);
        break;
      case "open_thread": {
        const t = this.threads.get(msg.threadId);
        if (!t) { reply({ type: "error", message: `unknown thread ${msg.threadId}` }); return; }
        // Lazy-hydrate from claude's own JSONL transcript on first open
        // after bridge restart (in-memory items are empty at that point).
        if (t.items.length === 0) {
          const hydrated = hydrateFromTranscript(t.summary.sessionId, t.summary.cwd);
          if (hydrated.length) t.items = hydrated;
        }
        reply({ type: "thread_history", threadId: t.summary.id, items: t.items });
        break;
      }
      case "send_text":
        this.sendText(msg.threadId, msg.text, reply);
        break;
      case "interrupt": {
        const t = this.threads.get(msg.threadId);
        t?.proc?.close();
        if (t) {
          t.proc = null;
          this.updateSummary(t, { status: "idle" });
        }
        break;
      }
      case "delete_thread": {
        const t = this.threads.get(msg.threadId);
        t?.proc?.close();
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

  private createThread(cwd: string) {
    const id = randomUUID();
    const summary: ThreadSummary = {
      id,
      sessionId: id,    // channel mode: thread id == session-ish (no real claude session)
      title: null,
      cwd,
      status: "idle",
      lastActiveAt: Date.now(),
      preview: "",
    };
    this.threads.set(id, { summary, items: [], proc: null, pendingPush: null });
    this.persist();
    this.broadcast({ type: "thread_created", thread: summary });
  }

  private sendText(threadId: string, text: string, reply: Subscriber) {
    const t = this.threads.get(threadId);
    if (!t) { reply({ type: "error", message: `unknown thread ${threadId}` }); return; }

    // Append user item locally + broadcast immediately.
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

    const tid = t.summary.id;

    // Spawn claude if not already running for this thread. The first
    // prompt is buffered as pendingPush and flushed when the MCP child
    // registers (onConnect) — that's the only way to know claude has
    // finished booting and the TUI prompt is ready to accept keystrokes.
    if (!t.proc) {
      const proc = new ChannelProcess({
        threadId: tid,
        cwd: t.summary.cwd,
        controlPort: this.cpPort,
        controlToken: this.cp.token,
        instanceSuffix: this.instanceSuffix,
      });
      // Surface spawn failure: mark thread errored and drop the proc so
      // the next send_text retries from scratch (otherwise we'd hold a
      // dead handle and silently fail every subsequent message).
      if (!proc.isSpawned()) {
        const err = proc.lastError()?.message ?? "tmux spawn failed";
        this.updateSummary(t, { status: "errored", lastActiveAt: Date.now() });
        reply({ type: "error", message: `claude couldn't start: ${err}` });
        return;
      }
      t.proc = proc;
      t.pendingPush = text;
      return;
    }

    // claude already running — inject via tmux send-keys directly.
    // We deliberately do NOT gate on cp.isConnected: send-keys is
    // independent of the MCP control-plane TCP socket (which can go
    // half-open between turns). The MCP socket is only needed for
    // OUTPUT (reply / tool_call forwarding); input always works as
    // long as the tmux session is alive.
    t.proc.injectUserPrompt(text);
  }

  // ────────────────  control plane → us  ────────────────

  private handleChildMsg(threadId: string, msg: any) {
    const t = this.threads.get(threadId);
    if (!t) return;
    switch (msg.type) {
      case "reply": {
        // Two flavors: plain text, or structured blocks. Build the
        // matching ChatItem and a textual preview either way.
        const blocks = Array.isArray(msg.blocks) ? msg.blocks : null;
        const item: ChatItem = blocks
          ? { kind: "blocks", id: randomUUID(), blocks, createdAt: Date.now() }
          : { kind: "agent", id: randomUUID(), text: String(msg.text ?? ""), createdAt: Date.now(), streaming: false };
        t.items.push(item);
        this.broadcast({ type: "item_appended", threadId: t.summary.id, item });
        // If the reply yields no usable preview (rare edge case), keep
        // the prior preview rather than blanking the row in the list.
        const derived = previewFromReply(msg);
        const preview = derived || t.summary.preview;
        this.updateSummary(t, {
          status: "idle",
          lastActiveAt: Date.now(),
          preview,
        });
        break;
      }
      case "tool_call": {
        // Use the hook's tool_use_id as the ChatItem id so tool_result can
        // correlate by id (not by tool name, which collides for concurrent
        // calls of the same tool). Fall back to a UUID if the hook didn't
        // send one (older payloads).
        const item: ChatItem = {
          kind: "tool_use",
          id: String(msg.tool_use_id ?? randomUUID()),
          tool: String(msg.tool ?? "?"),
          input: msg.input ?? {},
          createdAt: Date.now(),
          status: "running",
        };
        t.items.push(item);
        this.broadcast({ type: "item_appended", threadId: t.summary.id, item });
        break;
      }
      case "tool_result": {
        // Match the corresponding tool_use by id (preferred) — only fall
        // back to name-matching when the id is missing.
        const tuid = String(msg.tool_use_id ?? "");
        let matched = false;
        if (tuid) {
          for (let i = t.items.length - 1; i >= 0; i--) {
            const it = t.items[i];
            if (it.kind === "tool_use" && it.id === tuid) {
              it.status = msg.is_error ? "errored" : "completed";
              this.broadcast({ type: "item_updated", threadId: t.summary.id, item: it });
              matched = true;
              break;
            }
          }
        }
        if (!matched) {
          for (let i = t.items.length - 1; i >= 0; i--) {
            const it = t.items[i];
            if (it.kind === "tool_use" && it.status === "running" && (!msg.tool || it.tool === msg.tool)) {
              it.status = msg.is_error ? "errored" : "completed";
              this.broadcast({ type: "item_updated", threadId: t.summary.id, item: it });
              break;
            }
          }
        }
        const out = String(msg.output ?? "");
        if (out) {
          const result: ChatItem = {
            kind: "tool_result",
            id: randomUUID(),
            toolUseId: String(msg.tool_use_id ?? ""),
            output: out,
            createdAt: Date.now(),
            isError: !!msg.is_error,
          };
          t.items.push(result);
          this.broadcast({ type: "item_appended", threadId: t.summary.id, item: result });
        }
        break;
      }
      case "user_prompt": {
        // Dedup: if bridge already appended a user item for this text in
        // the last 5 seconds (sendText path), don't double-show. Only
        // surface prompts that originated from a direct tmux attach.
        const text = String(msg.text ?? "");
        if (!text) break;
        const now = Date.now();
        const last = [...t.items].reverse().find((it) => it.kind === "user");
        if (last && last.kind === "user" && last.text === text && now - last.createdAt < 5000) {
          break;
        }
        const item: ChatItem = {
          kind: "user",
          id: randomUUID(),
          text,
          createdAt: now,
        };
        t.items.push(item);
        this.broadcast({ type: "item_appended", threadId: t.summary.id, item });
        this.updateSummary(t, {
          title: t.summary.title ?? text.slice(0, 40),
          preview: text.slice(0, 80),
          lastActiveAt: now,
          status: "active",
        });
        break;
      }
      case "log":
        console.log(`[ch:${threadId.slice(0, 6)}] ${msg.level}: ${msg.msg}`);
        break;
      default:
        break;
    }
  }

  private updateSummary(t: ThreadState, patch: Partial<ThreadSummary>) {
    t.summary = { ...t.summary, ...patch };
    this.broadcast({ type: "thread_updated", thread: t.summary });
    this.persist();
  }

  // ────────────────  persistence  ────────────────

  private loadPersisted() {
    if (!existsSync(THREADS_FILE)) return;
    try {
      const arr: ThreadSummary[] = JSON.parse(readFileSync(THREADS_FILE, "utf8"));
      for (const s of arr) {
        this.threads.set(s.id, {
          summary: { ...s, status: "idle" },
          items: [],
          proc: null,
          pendingPush: null,
        });
      }
      console.log(`[claude-rc-ch] loaded ${arr.length} threads from ${THREADS_FILE}`);
      this.migrateSessionIds();
    } catch (err) {
      console.error("[claude-rc-ch] load failed:", err);
    }
  }

  /**
   * One-time migration for legacy threads created before we pinned
   * `--session-id`: their summary.sessionId equals our threadId, but
   * claude generated its own UUID at runtime, so the JSONL filename
   * doesn't match. Scan project dirs and match each legacy thread to
   * a JSONL by (cwd, first user message starts with our preview).
   */
  private migrateSessionIds() {
    let updates = 0;
    for (const t of this.threads.values()) {
      const cwd = t.summary.cwd;
      const encoded = cwd.replace(/[/.]/g, "-");
      const dir = join(homedir(), ".claude", "projects", encoded);
      // If the JSONL with the current sessionId already exists, no work.
      if (existsSync(join(dir, `${t.summary.sessionId}.jsonl`))) continue;
      if (!existsSync(dir)) continue;

      let files: string[];
      try { files = readdirSync(dir).filter((f) => f.endsWith(".jsonl")); }
      catch { continue; }

      const wantPreview = (t.summary.preview ?? "").trim();
      const wantTitle = (t.summary.title ?? "").trim();
      if (!wantPreview && !wantTitle) continue;

      for (const f of files) {
        try {
          const raw = readFileSync(join(dir, f), "utf8");
          for (const line of raw.split("\n")) {
            if (!line) continue;
            let evt: any;
            try { evt = JSON.parse(line); } catch { continue; }
            if (evt.type !== "user") continue;
            const c = evt.message?.content;
            const text = typeof c === "string" ? c : "";
            if (!text) continue;
            // Match by either preview or title prefix — both are slices of the
            // same first user prompt.
            if ((wantPreview && text.startsWith(wantPreview)) ||
                (wantTitle && text.startsWith(wantTitle))) {
              const sid = f.replace(/\.jsonl$/, "");
              t.summary = { ...t.summary, sessionId: sid };
              updates++;
            }
            break; // only inspect first user line of this file
          }
        } catch {}
        if (t.summary.sessionId !== t.summary.id) break; // matched
      }
    }
    if (updates > 0) {
      this.persist();
      console.log(`[claude-rc-ch] migrated ${updates} thread sessionId(s)`);
    }
  }

  private persist() {
    if (!existsSync(STORAGE_DIR)) mkdirSync(STORAGE_DIR, { recursive: true });
    try {
      writeFileSync(
        THREADS_FILE,
        JSON.stringify([...this.threads.values()].map((t) => t.summary), null, 2),
        { mode: 0o600 },
      );
    } catch (err) {
      console.error("[claude-rc-ch] persist failed:", err);
    }
  }
}
