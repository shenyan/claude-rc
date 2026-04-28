#!/usr/bin/env bun
// Tiny hook emitter. Configured as a PreToolUse / PostToolUse hook in
// claude's --settings JSON; claude pipes a JSON event to our stdin.
// We forward to the bridge's control plane so the phone UI can render
// the in-flight tool calls.
//
// Connection-per-invocation: hooks fire once per event, the script
// connects, sends, exits. Cheap and stateless.
//
// Required env (inherited from the tmux session that started claude):
//   CLAUDE_RC_THREAD_ID, CLAUDE_RC_CP_PORT, CLAUDE_RC_CP_TOKEN
//
// Required arg: the event kind, "pre" | "post" | "post_failure".

import { connect } from "bun";
import { stdin } from "node:process";
import { appendFileSync } from "node:fs";

const KIND = process.argv[2] ?? "pre";
const THREAD_ID = process.env.CLAUDE_RC_THREAD_ID;
const CP_PORT = Number(process.env.CLAUDE_RC_CP_PORT ?? 0);
const CP_TOKEN = process.env.CLAUDE_RC_CP_TOKEN ?? "";
const DBG = `/tmp/claude-rc-hook-${process.pid}.log`;
function dbg(s: string) { try { appendFileSync(DBG, `[${new Date().toISOString()}] ${s}\n`); } catch {} }

if (!THREAD_ID || !CP_PORT || !CP_TOKEN) {
  // Hook fired outside claude-rc context — silently no-op so we don't
  // pollute the user's other claude sessions.
  process.exit(0);
}

// Read claude's hook payload from stdin.
let payload = "";
stdin.setEncoding("utf8");
stdin.on("data", (c: string | Buffer) => { payload += String(c); });
stdin.on("end", async () => {
  let evt: any = {};
  try { evt = JSON.parse(payload); } catch {}
  dbg(`kind=${KIND} payload=${payload.slice(0, 240)}`);

  const toolName = String(evt.tool_name ?? "");
  // Don't surface our own reply-tool plumbing — claude's actual reply text
  // already arrives as an agent item via the channel-mcp.ts forwarder.
  // Showing reply() as a tool call would render the same text twice plus
  // a useless "delivered" tool_result.
  if (toolName.startsWith("mcp__claude-rc-channel__")) {
    process.exit(0);
  }
  // TodoWrite / ToolSearch are bookkeeping noise — most users don't want
  // to see every todo update or claude's internal tool-name lookups in
  // the conversation flow.
  if (toolName === "TodoWrite" || toolName === "ToolSearch") {
    process.exit(0);
  }

  // Connect, register, send, exit.
  let cpSock: any = null;
  try {
    cpSock = await (connect as any)({
      hostname: "127.0.0.1",
      port: CP_PORT,
      socket: {
        open() { dbg("cp open"); },
        data() {},
        close() { process.exit(0); },
        error(_: any, err: Error) { dbg(`cp err ${err}`); process.exit(0); },
      },
    });
  } catch (err) {
    dbg(`connect failed ${err}`);
    process.exit(0);
  }

  const send = (m: any) => {
    try { cpSock.write(JSON.stringify(m) + "\n"); } catch {}
  };
  send({ type: "register", threadId: THREAD_ID, token: CP_TOKEN });

  // Hook payload shape (from claude source: PreToolUse | PostToolUse):
  //   tool_name: string
  //   tool_input: object
  //   tool_response: object  (PostToolUse only)
  //   tool_use_id: string
  // UserPromptSubmit payload:
  //   prompt: string
  if (KIND === "pre") {
    send({
      type: "tool_call",
      tool: String(evt.tool_name ?? "?"),
      input: evt.tool_input ?? {},
    });
  } else if (KIND === "user_prompt") {
    const text = String(evt.prompt ?? "");
    if (text) send({ type: "user_prompt", text });
  } else {
    send({
      type: "tool_result",
      tool: String(evt.tool_name ?? "?"),
      tool_use_id: String(evt.tool_use_id ?? ""),
      output: stringifyToolResponse(evt.tool_response),
      is_error: KIND === "post_failure",
    });
  }
  // Give the socket a moment to flush, then exit.
  setTimeout(() => process.exit(0), 200);
});

function stringifyToolResponse(r: unknown): string {
  if (r === undefined || r === null) return "";
  if (typeof r === "string") return r;
  // Most tool responses include a `output` or `content` string.
  if (typeof r === "object") {
    const obj = r as any;
    if (typeof obj.output === "string") return obj.output;
    if (typeof obj.stdout === "string") return obj.stdout + (obj.stderr ? "\n--- stderr ---\n" + obj.stderr : "");
    if (Array.isArray(obj.content)) {
      return obj.content.map((c: any) => c?.text ?? "").join("");
    }
    return JSON.stringify(r, null, 2);
  }
  return String(r);
}
