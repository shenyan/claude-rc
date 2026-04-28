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
  | { type: "reply"; text: string }
  | { type: "tool_call"; tool: string; input: any }      // optional: surface internal tools
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
    const dec = new TextDecoder();
    const self = this;

    this.server = (Bun.listen as any)({
      hostname: "127.0.0.1",
      port: this.opts.port ?? 0,
      socket: {
        open(sock: any) {
          sock.data = { buf: "", threadId: null };
        },
        data(sock: any, chunk: Uint8Array) {
          const data = sock.data;
          data.buf += dec.decode(chunk);
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
              data.threadId = m.threadId;
              self.children.set(m.threadId, {
                threadId: m.threadId,
                send: (msg) => {
                  try { sock.write(JSON.stringify(msg) + "\n"); } catch {}
                },
              });
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
            self.children.delete(data.threadId);
            self.opts.onDisconnect?.(data.threadId);
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
