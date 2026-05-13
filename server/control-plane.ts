// Control plane for channel mode.
//
// claude spawns one MCP server child per thread (via `claude mcp add`).
// Each child needs to talk back to the bridge daemon to:
//   - register with its threadId (passed via env CLAUDE_RC_THREAD_ID)
//   - receive "push this content as a channel notification" from the
//     bridge when the phone sends a user message
//   - send "claude called reply(text)" up to the bridge
//
// Implementation: a tiny line-delimited JSON server on localhost. The
// child connects on startup, announces its threadId; we route by that.

import { randomBytes } from "node:crypto";

export type ChildToBridgeMsg =
  | { type: "register"; threadId: string; token: string }
  // `reply` may carry plain text, structured blocks, or both. The bridge
  // builds an `agent` or `blocks` ChatItem depending on which is set. Block
  // typing stays loose here so control-plane.ts has no shared/protocol.ts
  // import (it's reused by oneshot/stub paths too).
  | { type: "reply"; text?: string; blocks?: unknown[] }
  | { type: "tool_call"; tool: string; input: any; tool_use_id?: string }
  | { type: "tool_result"; tool?: string; tool_use_id: string; output: string; is_error?: boolean }
  | { type: "user_prompt"; text: string }
  | { type: "log"; level: "info" | "warn" | "error"; msg: string };

export type BridgeToChildMsg =
  | { type: "push"; content: string; meta?: Record<string, string> }
  | { type: "shutdown" };

interface ChildHandle {
  threadId: string;
  send(msg: BridgeToChildMsg): void;
}

export interface ControlPlaneOptions {
  port?: number;            // 0 = OS-assigned
  authToken: string;        // shared secret with children (env-passed)
  onMessage: (threadId: string, msg: ChildToBridgeMsg) => void;
  onConnect?: (threadId: string) => void;
  onDisconnect?: (threadId: string) => void;
}

export class ControlPlane {
  private server: any = null;
  private children = new Map<string, ChildHandle>();   // threadId → handle
  readonly token: string;
  private opts: ControlPlaneOptions;
  private port = 0;

  constructor(opts: ControlPlaneOptions) {
    this.opts = opts;
    this.token = opts.authToken;
  }

  async start(): Promise<number> {
    const self = this;

    this.server = (Bun.listen as any)({
      hostname: "127.0.0.1",
      port: this.opts.port ?? 0,
      socket: {
        open(sock: any) {
          // Use a per-socket streaming decoder so multibyte UTF-8 split
          // across TCP chunks doesn't corrupt JSON. Each socket needs its
          // own decoder because stream state is per-stream.
          sock.data = { buf: "", threadId: null, handle: null, dec: new TextDecoder("utf-8", { fatal: false }) };
        },
        data(sock: any, chunk: Uint8Array) {
          const data = sock.data;
          data.buf += data.dec.decode(chunk, { stream: true });
          let nl: number;
          while ((nl = data.buf.indexOf("\n")) >= 0) {
            const line = data.buf.slice(0, nl).trim();
            data.buf = data.buf.slice(nl + 1);
            if (!line) continue;
            let m: any;
            try { m = JSON.parse(line); } catch { continue; }
            if (m.type === "register") {
              if (m.token !== self.token) {
                sock.end();
                return;
              }
              // If another socket previously registered the same threadId,
              // close it so its `close` handler can't later delete our
              // newer entry (and vice-versa: tie `delete` to our handle).
              const prior = self.children.get(m.threadId);
              if (prior && (prior as any).sock !== sock) {
                try { (prior as any).sock?.end(); } catch {}
              }
              const handle: ChildHandle = {
                threadId: m.threadId,
                send: (msg) => { try { sock.write(JSON.stringify(msg) + "\n"); } catch {} },
              };
              (handle as any).sock = sock;
              data.handle = handle;
              data.threadId = m.threadId;
              self.children.set(m.threadId, handle);
              self.opts.onConnect?.(m.threadId);
              continue;
            }
            if (data.threadId) {
              self.opts.onMessage(data.threadId, m as ChildToBridgeMsg);
            }
          }
        },
        close(sock: any) {
          const data = sock.data;
          if (data?.threadId) {
            // Only remove if the currently-registered handle is ours.
            // Otherwise a duplicate register replaced us already.
            const cur = self.children.get(data.threadId);
            if (cur === data.handle) {
              self.children.delete(data.threadId);
              self.opts.onDisconnect?.(data.threadId);
            }
          }
        },
        error(_: any, err: Error) {
          console.error("[control-plane] socket error:", err);
        },
      },
    });
    this.port = (this.server as any).port;
    return this.port;
  }

  /** Send a push to a connected child. */
  send(threadId: string, msg: BridgeToChildMsg): boolean {
    const c = this.children.get(threadId);
    if (!c) return false;
    c.send(msg);
    return true;
  }

  isConnected(threadId: string): boolean {
    return this.children.has(threadId);
  }

  async stop() {
    (this.server as any)?.stop();
    this.server = null;
  }

  static randomToken(): string {
    return randomBytes(16).toString("hex");
  }
}
