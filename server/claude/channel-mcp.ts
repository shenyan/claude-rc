#!/usr/bin/env bun
// MCP server that claude spawns once per `claude` session.
// Acts as the bridge between (claude ↔ via stdio MCP) and
// (claude-rc bridge daemon ↔ via TCP control plane).
//
// Required env (set by the bridge when starting tmux session):
//   CLAUDE_RC_THREAD_ID  — uuid of the thread this session is for
//   CLAUDE_RC_CP_PORT    — control-plane TCP port on 127.0.0.1
//   CLAUDE_RC_CP_TOKEN   — shared secret to authenticate to the bridge

import { connect } from "bun";
import { stdin, stdout } from "node:process";
import { appendFileSync } from "node:fs";

// Debug logs are opt-in: set CLAUDE_RC_DEBUG=1 to enable. Otherwise the
// dbg() calls are no-ops. The log path is under /tmp which is world-readable
// on multi-user systems, and we'd be writing token prefixes + bridge content
// there — only worth the privacy cost when actively troubleshooting.
const DEBUG_ENABLED = process.env.CLAUDE_RC_DEBUG === "1";
const DEBUG_LOG = `/tmp/claude-rc-channel-mcp-${process.pid}.log`;
function dbg(s: string) {
  if (!DEBUG_ENABLED) return;
  try { appendFileSync(DEBUG_LOG, `[${new Date().toISOString()}] ${s}\n`); } catch {}
}
dbg(`spawn pid=${process.pid} cwd=${process.cwd()}`);

const THREAD_ID = process.env.CLAUDE_RC_THREAD_ID;
const CP_PORT = Number(process.env.CLAUDE_RC_CP_PORT ?? 0);
const CP_TOKEN = process.env.CLAUDE_RC_CP_TOKEN ?? "";
dbg(`env THREAD_ID=${THREAD_ID} CP_PORT=${CP_PORT} TOKEN=${CP_TOKEN.slice(0,8)}...`);

if (!THREAD_ID || !CP_PORT || !CP_TOKEN) {
  process.stderr.write(
    `[channel-mcp] missing env. need CLAUDE_RC_THREAD_ID, CLAUDE_RC_CP_PORT, CLAUDE_RC_CP_TOKEN\n` +
    `(this MCP server is only meant to be spawned by claude-rc bridge)\n`,
  );
  process.exit(1);
}

// ────────────────  control-plane connection  ────────────────
let cpSock: Awaited<ReturnType<typeof connect>> | null = null;
let cpBuf = "";
// Streaming decoder — multibyte UTF-8 may span TCP chunks; without
// { stream: true } the trailing bytes corrupt the next JSON parse.
const cpDec = new TextDecoder("utf-8", { fatal: false });

async function cpConnect() {
  dbg(`connecting to control plane at 127.0.0.1:${CP_PORT}`);
  try {
    cpSock = await (connect as any)({
      hostname: "127.0.0.1",
      port: CP_PORT,
      socket: {
        open() { dbg("control plane: socket open"); },
        data(_: any, chunk: Uint8Array) {
          cpBuf += cpDec.decode(chunk, { stream: true });
          let nl: number;
          while ((nl = cpBuf.indexOf("\n")) >= 0) {
            const line = cpBuf.slice(0, nl).trim();
            cpBuf = cpBuf.slice(nl + 1);
            if (!line) continue;
            let m: any; try { m = JSON.parse(line); } catch { continue; }
            dbg(`<< ${line.slice(0, 200)}`);
            handleBridge(m);
          }
        },
        close() { dbg("control plane: closed"); },
        error(_: any, err: Error) { dbg(`control plane: error ${err}`); },
      },
    });
    dbg("control plane connected, sending register");
    cpSend({ type: "register", threadId: THREAD_ID, token: CP_TOKEN });
  } catch (err) {
    dbg(`cpConnect failed: ${err}`);
    throw err;
  }
}

function cpSend(msg: any) {
  if (!cpSock) { dbg("cpSend: no sock"); return; }
  try {
    cpSock.write(JSON.stringify(msg) + "\n");
    dbg(`>> ${JSON.stringify(msg).slice(0, 200)}`);
  } catch (err) { dbg(`cpSend error: ${err}`); }
}

function handleBridge(msg: any) {
  if (msg.type === "push") {
    sendNotification("notifications/claude/channel", {
      content: String(msg.content ?? ""),
      meta: stringifyMeta(msg.meta ?? {}),
    });
  } else if (msg.type === "shutdown") {
    process.exit(0);
  }
}

function stringifyMeta(raw: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v === undefined || v === null) continue;
    if (typeof v === "string") out[k] = v;
    else if (typeof v === "number" || typeof v === "boolean") out[k] = String(v);
    else if (v instanceof Date) out[k] = v.toISOString();
    else out[k] = JSON.stringify(v);
  }
  return out;
}

// ────────────────  MCP stdio  ────────────────

function mcpSend(msg: any) {
  stdout.write(JSON.stringify(msg) + "\n");
}

function mcpReply(id: number, result: any) {
  mcpSend({ jsonrpc: "2.0", id, result });
}

function sendNotification(method: string, params: any) {
  mcpSend({ jsonrpc: "2.0", method, params });
}

let mcpBuf = "";
const mcpDec = new TextDecoder("utf-8", { fatal: false });

stdin.on("data", (chunk: Buffer | string) => {
  const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
  mcpBuf += mcpDec.decode(bytes, { stream: true });
  let nl: number;
  while ((nl = mcpBuf.indexOf("\n")) >= 0) {
    const line = mcpBuf.slice(0, nl).trim();
    mcpBuf = mcpBuf.slice(nl + 1);
    if (!line) continue;
    let m: any; try { m = JSON.parse(line); } catch { continue; }
    handleMcp(m);
  }
});

function handleMcp(msg: any) {
  if (msg.method === "initialize") {
    mcpReply(msg.id, {
      protocolVersion: "2025-03-26",
      capabilities: {
        experimental: {
          "claude/channel": {},
          // claude/channel/permission: {} — TODO once we have remote approval
        },
        tools: {},
      },
      serverInfo: { name: "claude-rc-channel", version: "0.1.0" },
    });
  } else if (msg.method === "notifications/initialized") {
    // claude is ready. We can connect to the bridge now (already started
    // in bootstrap), and bridge will start sending pushes.
  } else if (msg.method === "tools/list") {
    mcpReply(msg.id, {
      tools: [{
        name: "reply",
        description:
          "Send a reply back to the user via the claude-rc channel. The user " +
          "is on the phone — text outside this tool isn't surfaced. Treat " +
          "this like the SendUserMessage / Brief tool: every user-visible " +
          "answer goes through here. Markdown is rendered.",
        inputSchema: {
          type: "object",
          properties: {
            text: {
              type: "string",
              description: "The reply text. Markdown supported.",
            },
          },
          required: ["text"],
        },
      }],
    });
  } else if (msg.method === "tools/call") {
    const params = msg.params ?? {};
    if (params.name === "reply") {
      const text = String(params.arguments?.text ?? "");
      cpSend({ type: "reply", text });
      mcpReply(msg.id, { content: [{ type: "text", text: "delivered" }] });
    } else {
      mcpSend({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "unknown tool: " + params.name } });
    }
  } else if (msg.method === "ping") {
    mcpReply(msg.id, {});
  } else if (msg.method && msg.id !== undefined) {
    mcpSend({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found: " + msg.method } });
  }
}

// ────────────────  bootstrap  ────────────────
cpConnect().catch((err) => {
  process.stderr.write(`[channel-mcp] could not connect to bridge ${CP_PORT}: ${err}\n`);
  process.exit(1);
});
