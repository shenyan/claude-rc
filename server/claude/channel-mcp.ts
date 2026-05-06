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

const DEBUG_LOG = `/tmp/claude-rc-channel-mcp-${process.pid}.log`;
function dbg(s: string) { try { appendFileSync(DEBUG_LOG, `[${new Date().toISOString()}] ${s}\n`); } catch {} }
dbg(`spawn pid=${process.pid} cwd=${process.cwd()}`);

const THREAD_ID = process.env.CLAUDE_RC_THREAD_ID;
const CP_PORT = Number(process.env.CLAUDE_RC_CP_PORT ?? 0);
const CP_TOKEN = process.env.CLAUDE_RC_CP_TOKEN ?? "";
dbg(`env THREAD_ID=${THREAD_ID} CP_PORT=${CP_PORT} TOKEN=${CP_TOKEN.slice(0,8)}...`);

/**
 * Two operating modes:
 *   1. Channel mode (default — env vars present): connect to control plane,
 *      forward reply blocks to bridge over TCP, accept push notifications.
 *   2. Stub mode (env vars missing): no control plane. Just expose the
 *      reply tool's strict schema so claude is forced to emit blocks.
 *      The oneshot bridge harvests blocks from stream-json's tool_use
 *      input directly — no socket needed.
 */
const STUB_MODE = !THREAD_ID || !CP_PORT || !CP_TOKEN;
if (STUB_MODE) {
  process.stderr.write(`[channel-mcp] starting in STUB mode (no control plane)\n`);
}

// ────────────────  control-plane connection  ────────────────
let cpSock: Awaited<ReturnType<typeof connect>> | null = null;
let cpBuf = "";
const cpDec = new TextDecoder();

async function cpConnect() {
  dbg(`connecting to control plane at 127.0.0.1:${CP_PORT}`);
  try {
    cpSock = await (connect as any)({
      hostname: "127.0.0.1",
      port: CP_PORT,
      socket: {
        open() { dbg("control plane: socket open"); },
        data(_: any, chunk: Uint8Array) {
          cpBuf += cpDec.decode(chunk);
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
const mcpDec = new TextDecoder();

stdin.on("data", (chunk: Buffer | string) => {
  const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
  mcpBuf += mcpDec.decode(bytes);
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
          "Send a reply to the user via the claude-rc channel. The user is on " +
          "phone/web — text outside this tool isn't surfaced. EVERY user-visible " +
          "answer goes through here.\n\n" +
          "Two modes:\n" +
          "1. Plain text: pass `text` (markdown supported).\n" +
          "2. Generative UI: pass `blocks` — an array of typed UI blocks the web " +
          "client renders as cards, maps, action buttons, etc. Use blocks when " +
          "structured output beats prose: places, products, multi-choice questions, " +
          "stats dashboards, code/diff suggestions, search-result lists.\n\n" +
          "Block types: text, card, cards_row, map, stats, actions, code. " +
          "See input schema for fields. Mix freely — e.g. text intro + cards_row " +
          "+ map + actions in one reply. For a question with discrete answers, " +
          "ALWAYS use an `actions` block (AskUserQuestion is blocked here).",
        inputSchema: {
          type: "object",
          properties: {
            text: {
              type: "string",
              description: "Markdown reply. Use this for plain prose answers.",
            },
            blocks: {
              type: "array",
              description: "Generative UI blocks rendered top-to-bottom.",
              items: {
                type: "object",
                description:
                  "One UI block. Required: `type`. Other fields depend on type:\n" +
                  "- text: { type:'text', markdown:string }\n" +
                  "- card: { type:'card', title, subtitle?, image?, imageAlt?, url?, rating?(0-5), badges?:string[], meta?:[{label,value}], actions?:[{label,payload?,url?,style?}] }\n" +
                  "- cards_row: { type:'cards_row', items:card[] } — horizontal scroller\n" +
                  "- map: { type:'map', lat:number, lng:number, zoom?(default 15), label?, caption? }\n" +
                  "- stats: { type:'stats', items:[{label,value,delta?,tone?:'good'|'bad'|'neutral'}] }\n" +
                  "- actions: { type:'actions', choices:[{label, payload?, style?:'primary'|'default'|'danger'}] }\n" +
                  "- code: { type:'code', language?, code:string, filename? }",
              },
            },
          },
        },
      }],
    });
  } else if (msg.method === "tools/call") {
    const params = msg.params ?? {};
    if (params.name === "reply") {
      const args = params.arguments ?? {};
      const text = typeof args.text === "string" ? args.text : "";
      const blocks = Array.isArray(args.blocks) ? args.blocks : null;
      // Forward blocks if present (richer rendering); else fall back to text.
      // The bridge can also receive both (text becomes a leading text block).
      if (blocks && blocks.length) {
        const finalBlocks = text
          ? [{ type: "text", markdown: text }, ...blocks]
          : blocks;
        cpSend({ type: "reply", blocks: finalBlocks });
      } else {
        cpSend({ type: "reply", text });
      }
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
if (!STUB_MODE) {
  cpConnect().catch((err) => {
    process.stderr.write(`[channel-mcp] could not connect to bridge ${CP_PORT}: ${err}\n`);
    process.exit(1);
  });
}
