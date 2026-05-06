// State hub for ONESHOT mode — each user turn spawns a fresh `claude -p`
// subprocess that exits when the turn is done. No tmux, no MCP, no
// long-lived process. UX experiment: how does "API-call-per-turn" feel
// vs. the persistent print/channel modes?
//
// Per-thread lifecycle:
//   1. createThread     — assigns id + sessionId, persisted to threads.json
//   2. send_text        — spawn `claude -p --resume <sid> "<text>"` (or
//                          --session-id <sid> on the first turn). Parse the
//                          stream-json output frame-by-frame. Process exits
//                          naturally when the turn finishes; we mark idle.
//
// Tools surface natively via stream-json's content_block_start /
// content_block_delta / tool_result events — no hooks needed. History
// across bridge restarts hydrates from claude's own JSONL transcript at
// ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl (same trick as channel mode).

import { spawn } from "bun";
import type {
  Block,
  ChatItem,
  ClientMsg,
  ServerMsg,
  ThreadSummary,
} from "../shared/protocol";

/**
 * System prompt appended for every oneshot turn. Same shape as channel
 * mode — relies on the `mcp__claude-rc-channel__reply` MCP tool (registered
 * at user scope, runs in stub mode here) to enforce a strict schema. We
 * harvest reply tool calls from claude's stream-json output. The fenced
 * ```ui markdown block is kept as a fallback in case claude skips the tool.
 */
const ONESHOT_SYSTEM_PROMPT = `You are running inside claude-rc (oneshot mode). The user reads your answer on a phone/web UI.

## Reply through the \`mcp__claude-rc-channel__reply\` tool

EVERY user-visible answer goes through that tool. Plain text outside it still appears in the UI as fallback prose, but the tool is the proper channel and lets you emit rich generative UI.

Two ways to call it:
- \`reply({text: "markdown..."})\` — plain text answer.
- \`reply({blocks: [...]})\` — structured UI cards. Use when recommending, comparing, asking for choice, summarizing metrics, sharing code.

Block schema (use these exact \`type\` values):
- text, card, cards_row, map, stats, actions, code

See the tool's input schema for fields. Mix freely — a typical recommendation reply is \`[text intro, cards_row, actions]\`. Use \`actions\` to ask the user to pick (replacement for AskUserQuestion).

## Fallback (if you can't call the tool)

If for some reason the reply tool is unavailable, emit a fenced \`\`\`ui code block whose body is a JSON ARRAY of block objects (same schema). The bridge parses it.

Use blocks only when they help. A simple Q gets a plain text reply.`;
import { mkdirSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

type Subscriber = (msg: ServerMsg) => void;

interface ThreadState {
  summary: ThreadSummary;
  items: ChatItem[];
  /** Bun subprocess for the current turn, if any. */
  proc: ReturnType<typeof spawn> | null;
  busy: boolean;
  /** tool_use_ids of reply()/noise tools whose tool_result we should swallow. */
  suppressResultIds: Set<string>;
  /** Active reply tool_use being streamed: id → accumulating partial JSON. */
  pendingReply: { id: string; partial: string } | null;
}

const REPLY_TOOL_NAME = "mcp__claude-rc-channel__reply";
const NOISE_TOOLS = new Set(["TodoWrite", "ToolSearch"]);

const STORAGE_DIR = join(homedir(), ".claude-rc");
const THREADS_FILE = join(STORAGE_DIR, "threads-oneshot.json");

export class OneshotSession {
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
        this.createThread(msg.cwd ?? this.defaultCwd);
        break;
      case "open_thread": {
        const t = this.threads.get(msg.threadId);
        if (!t) { reply({ type: "error", message: `unknown thread ${msg.threadId}` }); return; }
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
        if (t?.proc) {
          try { t.proc.kill(); } catch {}
          t.proc = null;
          t.busy = false;
          this.updateSummary(t, { status: "idle" });
        }
        break;
      }
      case "delete_thread": {
        const t = this.threads.get(msg.threadId);
        if (t?.proc) { try { t.proc.kill(); } catch {} }
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
      sessionId: id, // pin: claude --session-id will use this; JSONL filename matches
      title: null,
      cwd,
      status: "idle",
      lastActiveAt: Date.now(),
      preview: "",
    };
    this.threads.set(id, { summary, items: [], proc: null, busy: false, suppressResultIds: new Set(), pendingReply: null });
    this.persist();
    this.broadcast({ type: "thread_created", thread: summary });
  }

  private sendText(threadId: string, text: string, reply: Subscriber) {
    const t = this.threads.get(threadId);
    if (!t) { reply({ type: "error", message: `unknown thread ${threadId}` }); return; }
    if (t.busy) { reply({ type: "error", message: "thread is busy; wait for current turn" }); return; }

    // Append user item locally + broadcast.
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

    // Build claude command. First turn pins session-id; resumes use --resume.
    const isResume = t.items.filter((it) => it.kind === "user").length > 1
      || existsSync(transcriptPath(t.summary.sessionId, t.summary.cwd));
    const cmd: string[] = [
      "claude", "--print", "--verbose",
      "--output-format", "stream-json",
      "--include-partial-messages",
      "--dangerously-skip-permissions",
      "--append-system-prompt", ONESHOT_SYSTEM_PROMPT,
    ];
    if (isResume) cmd.push("--resume", t.summary.sessionId);
    else cmd.push("--session-id", t.summary.sessionId);
    cmd.push(text);

    // Reset per-turn live-processing state.
    t.suppressResultIds.clear();
    t.pendingReply = null;

    t.busy = true;
    const proc = spawn({
      cmd,
      cwd: t.summary.cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    t.proc = proc;
    console.log(`[os:${t.summary.id.slice(0,8)}] spawn claude pid=${proc.pid} resume=${isResume}`);

    this.pumpStdout(t, proc);
    this.pumpStderr(t, proc);
    this.watchExit(t, proc);
  }

  // ────────────────  claude → ServerMsg  ────────────────

  private async pumpStdout(t: ThreadState, proc: ReturnType<typeof spawn>) {
    const reader = proc.stdout.getReader();
    const dec = new TextDecoder();
    let buf = "";
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          if (buf.trim()) this.handleFrameLine(t, buf.trim());
          break;
        }
        buf += dec.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (line) this.handleFrameLine(t, line);
        }
      }
    } catch {}
  }

  private async pumpStderr(t: ThreadState, proc: ReturnType<typeof spawn>) {
    const reader = proc.stderr.getReader();
    const dec = new TextDecoder();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        process.stderr.write(`[os:${t.summary.id.slice(0,6)}] ${dec.decode(value, { stream: true })}`);
      }
    } catch {}
  }

  private async watchExit(t: ThreadState, proc: ReturnType<typeof spawn>) {
    const code = await proc.exited;
    if (t.proc === proc) t.proc = null;
    t.busy = false;
    // Finalize any still-streaming agent items, and post-process to
    // extract any ```ui fenced blocks into a separate `blocks` ChatItem.
    for (let i = 0; i < t.items.length; i++) {
      const it = t.items[i];
      if (it.kind !== "agent" || !it.streaming) continue;
      it.streaming = false;
      const split = extractUiBlocks(it.text);
      if (split) {
        // Replace the agent item's text with the prose-only portion
        // (might be empty), and splice in a `blocks` ChatItem right after.
        it.text = split.before;
        this.broadcast({ type: "item_updated", threadId: t.summary.id, item: it });
        const blocksItem: ChatItem = {
          kind: "blocks",
          id: randomUUID(),
          blocks: split.blocks,
          createdAt: Date.now(),
        };
        const insertAt = i + 1;
        t.items.splice(insertAt, 0, blocksItem);
        this.broadcast({ type: "item_appended", threadId: t.summary.id, item: blocksItem });
        if (split.after) {
          const afterItem: ChatItem = {
            kind: "agent",
            id: randomUUID(),
            text: split.after,
            createdAt: Date.now(),
            streaming: false,
          };
          t.items.splice(insertAt + 1, 0, afterItem);
          this.broadcast({ type: "item_appended", threadId: t.summary.id, item: afterItem });
        }
      } else {
        this.broadcast({ type: "item_updated", threadId: t.summary.id, item: it });
      }
    }
    this.updateSummary(t, {
      status: code === 0 ? "idle" : "errored",
      lastActiveAt: Date.now(),
      preview: previewFromLastAgent(t),
    });
    console.log(`[os:${t.summary.id.slice(0,8)}] exit code=${code}`);
  }

  private handleFrameLine(t: ThreadState, line: string) {
    let f: any;
    try { f = JSON.parse(line); } catch { return; }
    switch (f.type) {
      case "system":
        // {subtype:"init"|"status"|...} — capture session_id if claude
        // generated a new one (shouldn't happen since we pin it, but defensive).
        if (f.subtype === "init" && f.session_id && f.session_id !== t.summary.sessionId) {
          this.updateSummary(t, { sessionId: f.session_id });
        }
        break;
      case "stream_event":
        this.handleStreamEvent(t, f.event);
        break;
      case "user":
        // Tool result message — claude echoes tool outputs back.
        this.handleToolResult(t, f);
        break;
      case "result":
        // turn ended
        break;
      default:
        break;
    }
  }

  private handleStreamEvent(t: ThreadState, ev: any) {
    if (!ev?.type) return;
    const msgId: string | undefined = ev.message?.id;
    switch (ev.type) {
      case "message_start": {
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
        const cb = ev.content_block;
        if (cb?.type === "tool_use" && cb.id) {
          const name = String(cb.name ?? "");
          // The reply tool is our generative-UI carrier. Don't render it
          // as a tool_use card; capture its input and emit a blocks/agent
          // ChatItem on content_block_stop instead.
          if (name === REPLY_TOOL_NAME) {
            t.pendingReply = { id: cb.id, partial: "" };
            t.suppressResultIds.add(cb.id);
            return;
          }
          // Filter noise tools (TodoWrite, ToolSearch) from the live UI too.
          if (NOISE_TOOLS.has(name)) {
            t.suppressResultIds.add(cb.id);
            return;
          }
          const item: ChatItem = {
            kind: "tool_use",
            id: cb.id,
            tool: name || "?",
            input: cb.input ?? {},
            createdAt: Date.now(),
            status: "running",
          };
          t.items.push(item);
          this.broadcast({ type: "item_appended", threadId: t.summary.id, item });
        }
        break;
      }
      case "content_block_delta": {
        const delta = ev.delta;
        if (!delta) return;
        if (delta.type === "text_delta") {
          const dtxt = delta.text ?? "";
          for (let i = t.items.length - 1; i >= 0; i--) {
            const it = t.items[i];
            if (it.kind === "agent" && it.streaming) {
              it.text += dtxt;
              this.broadcast({ type: "item_updated", threadId: t.summary.id, item: it });
              return;
            }
          }
        } else if (delta.type === "input_json_delta") {
          // Reply tool: accumulate, don't broadcast — we'll emit at stop.
          if (t.pendingReply) {
            t.pendingReply.partial += delta.partial_json ?? "";
            return;
          }
          for (let i = t.items.length - 1; i >= 0; i--) {
            const it = t.items[i];
            if (it.kind === "tool_use" && it.status === "running") {
              const partial = (it as any)._inputPartial ?? "";
              const next = partial + (delta.partial_json ?? "");
              (it as any)._inputPartial = next;
              try {
                it.input = JSON.parse(next);
                this.broadcast({ type: "item_updated", threadId: t.summary.id, item: it });
              } catch { /* incomplete JSON */ }
              return;
            }
          }
        }
        break;
      }
      case "content_block_stop": {
        // Finalize a reply tool call: parse its accumulated input and
        // splice in the corresponding ChatItem.
        if (t.pendingReply) {
          const { partial } = t.pendingReply;
          t.pendingReply = null;
          let input: any;
          try { input = JSON.parse(partial); } catch { return; }
          const text = typeof input?.text === "string" ? input.text : "";
          const blocks = Array.isArray(input?.blocks) ? input.blocks as Block[] : null;
          if (blocks && blocks.length) {
            const finalBlocks: Block[] = text
              ? [{ type: "text", markdown: text }, ...blocks]
              : blocks;
            const item: ChatItem = {
              kind: "blocks",
              id: randomUUID(),
              blocks: finalBlocks,
              createdAt: Date.now(),
            };
            t.items.push(item);
            this.broadcast({ type: "item_appended", threadId: t.summary.id, item });
          } else if (text) {
            const item: ChatItem = {
              kind: "agent",
              id: randomUUID(),
              text,
              createdAt: Date.now(),
              streaming: false,
            };
            t.items.push(item);
            this.broadcast({ type: "item_appended", threadId: t.summary.id, item });
          }
        }
        break;
      }
    }
  }

  private handleToolResult(t: ThreadState, f: any) {
    const content = f.message?.content ?? [];
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (block?.type !== "tool_result") continue;
      const tuid: string = block.tool_use_id ?? "";
      // Skip results for tools we suppressed at PreToolUse (reply, noise).
      if (t.suppressResultIds.has(tuid)) continue;
      const useItem = t.items.find((x) => x.kind === "tool_use" && x.id === tuid);
      if (useItem && useItem.kind === "tool_use") {
        useItem.status = block.is_error ? "errored" : "completed";
        this.broadcast({ type: "item_updated", threadId: t.summary.id, item: useItem });
      }
      const text = Array.isArray(block.content)
        ? block.content.map((c: any) => c?.text ?? "").join("")
        : (block.content ?? "");
      const result: ChatItem = {
        kind: "tool_result",
        id: randomUUID(),
        toolUseId: tuid,
        output: text,
        createdAt: Date.now(),
        isError: !!block.is_error,
      };
      t.items.push(result);
      this.broadcast({ type: "item_appended", threadId: t.summary.id, item: result });
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
          busy: false,
          suppressResultIds: new Set(),
          pendingReply: null,
        });
      }
      console.log(`[claude-rc-os] loaded ${arr.length} threads from ${THREADS_FILE}`);
    } catch (err) {
      console.error("[claude-rc-os] load failed:", err);
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
      console.error("[claude-rc-os] persist failed:", err);
    }
  }
}

// ────────────────  helpers  ────────────────

function transcriptPath(sessionId: string, cwd: string): string {
  const encoded = cwd.replace(/[/.]/g, "-");
  return join(homedir(), ".claude", "projects", encoded, `${sessionId}.jsonl`);
}

/**
 * Find a fenced ```ui code block in agent text and split into
 * { before, blocks, after }. Returns null if no parseable ui block found.
 * Only the first ```ui block is processed — multi-block replies are rare.
 */
function extractUiBlocks(text: string): { before: string; blocks: Block[]; after: string } | null {
  const re = /```ui\s*\n([\s\S]*?)\n```/;
  const m = re.exec(text);
  if (!m) return null;
  let parsed: any;
  try { parsed = JSON.parse(m[1]); }
  catch { return null; }
  // Be ultra-tolerant: find any array-of-objects-with-`type` anywhere in the
  // parsed structure (claude tends to invent wrappers like `components`,
  // `cards`, `blocks`, `items`). Also accept a single object with `type`.
  const blocks = harvestBlocks(parsed);
  if (!blocks.length) return null;
  const before = text.slice(0, m.index).trim();
  const after = text.slice(m.index + m[0].length).trim();
  return { before, blocks, after };
}

/**
 * Walk an arbitrary parsed JSON value and collect every object that has a
 * recognized block `type`. This makes the parser resilient to claude
 * wrapping the blocks in invented containers (`components`, `cards`, etc.)
 * or shipping a single block as a bare object.
 */
function harvestBlocks(node: any): Block[] {
  const KNOWN = new Set(["text", "card", "cards_row", "map", "stats", "actions", "code"]);
  const out: Block[] = [];
  const visit = (n: any) => {
    if (!n) return;
    if (Array.isArray(n)) {
      for (const x of n) visit(x);
      return;
    }
    if (typeof n === "object") {
      if (typeof n.type === "string" && KNOWN.has(n.type)) {
        out.push(n as Block);
        // Don't recurse into recognized block — its children belong to it.
        return;
      }
      // Otherwise descend into all values; helps when claude wraps in
      // { components:[...] } / { blocks:[...] } / {data:{cards:[...]}}.
      for (const v of Object.values(n)) visit(v);
    }
  };
  visit(node);
  return out;
}

function previewFromLastAgent(t: ThreadState): string {
  for (let i = t.items.length - 1; i >= 0; i--) {
    const it = t.items[i];
    if (it.kind === "agent" && it.text) return it.text.slice(0, 80);
  }
  return t.summary.preview;
}

/**
 * Same JSONL hydrator we use in channel mode — read claude's own
 * transcript and project into ChatItem[]. Filters TodoWrite/ToolSearch
 * noise; surfaces tool_use + tool_result + assistant text.
 */
function hydrateFromTranscript(sessionId: string, cwd: string): ChatItem[] {
  const path = transcriptPath(sessionId, cwd);
  if (!existsSync(path)) return [];
  let raw: string;
  try { raw = readFileSync(path, "utf8"); }
  catch { return []; }

  const items: ChatItem[] = [];
  const NOISE_TOOLS = new Set(["TodoWrite", "ToolSearch"]);
  const suppressResultIds = new Set<string>();

  for (const line of raw.split("\n")) {
    if (!line) continue;
    let evt: any;
    try { evt = JSON.parse(line); } catch { continue; }
    const ts = evt.timestamp ? Date.parse(evt.timestamp) : Date.now();

    if (evt.type === "user") {
      const c = evt.message?.content;
      if (typeof c === "string") {
        items.push({ kind: "user", id: evt.uuid ?? randomUUID(), text: c, createdAt: ts });
      } else if (Array.isArray(c)) {
        for (const b of c) {
          if (b?.type !== "tool_result") continue;
          const tuid = String(b.tool_use_id ?? "");
          if (suppressResultIds.has(tuid)) continue;
          const out = stringifyToolResultContent(b.content) || stringifyToolResultContent(evt.toolUseResult);
          items.push({
            kind: "tool_result",
            id: randomUUID(),
            toolUseId: tuid,
            output: out,
            createdAt: ts,
            isError: !!b.is_error,
          });
        }
      }
    } else if (evt.type === "assistant") {
      const blocks = evt.message?.content;
      if (!Array.isArray(blocks)) continue;
      let textBuf = "";
      for (const b of blocks) {
        if (b?.type === "text" && typeof b.text === "string") {
          textBuf += b.text;
        } else if (b?.type === "tool_use") {
          const name = String(b.name ?? "");
          const tuid = String(b.id ?? "");
          if (NOISE_TOOLS.has(name)) {
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
      if (textBuf) {
        items.push({
          kind: "agent",
          id: evt.message?.id ?? randomUUID(),
          text: textBuf,
          createdAt: ts,
          streaming: false,
        });
      }
    }
  }
  return items;
}

function stringifyToolResultContent(c: unknown): string {
  if (c == null) return "";
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c.map((b: any) => typeof b === "string" ? b : (typeof b?.text === "string" ? b.text : "")).join("");
  }
  if (typeof c === "object") {
    const obj = c as any;
    if (typeof obj.output === "string") return obj.output;
    if (typeof obj.stdout === "string") return obj.stdout;
    return JSON.stringify(c);
  }
  return String(c);
}
