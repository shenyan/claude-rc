// claude-rc entrypoint: serve static + WS, dispatch to print or channel
// session backend based on CLAUDE_RC_MODE.
//
// Default mode: "print"  → port 9896, claude --print stream-json
// Channel mode: "channel" → port 9897 (with INSTANCE=ch by convention),
//                            claude in tmux + dev-channels MCP

import { Session as PrintSession } from "./session";
import { ChannelSession } from "./channel-session";
import { OneshotSession } from "./oneshot-session";
import { ChannelProcess } from "./claude/channel-process";
import type { ClientMsg, ServerMsg } from "../shared/protocol";
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawnSync } from "bun";

const MODE = (process.env.CLAUDE_RC_MODE ?? "print").toLowerCase();
const INSTANCE = (process.env.CLAUDE_RC_INSTANCE ?? "").trim();
const INSTANCE_SUFFIX = INSTANCE ? `-${INSTANCE.replace(/[^A-Za-z0-9_-]/g, "_")}` : "";

const PORT = Number(process.env.CLAUDE_RC_PORT ?? (
  MODE === "channel" ? 9897 :
  MODE === "oneshot" ? 9898 :
  9896
));
const HOST = process.env.CLAUDE_RC_HOST ?? "0.0.0.0";
const DEFAULT_CWD = process.env.CLAUDE_RC_CWD ?? process.cwd();
const DIST_DIR = fileURLToPath(new URL("../dist/", import.meta.url));
const TOKEN_DIR = join(homedir(), ".arche");
const TOKEN_FILE = join(TOKEN_DIR, `claude-rc${INSTANCE_SUFFIX}.token`);

function loadOrCreateToken(): string {
  if (!existsSync(TOKEN_DIR)) mkdirSync(TOKEN_DIR, { recursive: true });
  if (existsSync(TOKEN_FILE)) {
    const t = readFileSync(TOKEN_FILE, "utf8").trim();
    if (t) return t;
  }
  const t = randomBytes(24).toString("base64url");
  writeFileSync(TOKEN_FILE, t + "\n", { mode: 0o600 });
  return t;
}

const TOKEN = process.env.CLAUDE_RC_TOKEN ?? loadOrCreateToken();
const COOKIE_NAME = `claude_rc_token${INSTANCE_SUFFIX}`;

function isAuthed(req: Request): boolean {
  const url = new URL(req.url);
  const q = url.searchParams.get("t");
  if (q && q === TOKEN) return true;
  const cookie = req.headers.get("cookie") ?? "";
  for (const part of cookie.split(/;\s*/)) {
    const [k, v] = part.split("=");
    if (k === COOKIE_NAME && decodeURIComponent(v ?? "") === TOKEN) return true;
  }
  return false;
}

// In channel mode, kill any orphan tmux sessions left over from a
// previous bridge run. Their MCP children registered with the old
// control plane (different port + token), so they can never reconnect
// to us — the channel-process spawn would fail with "duplicate session"
// and the thread would be permanently stuck.
if (MODE === "channel") {
  const ls = spawnSync({
    cmd: ["tmux", "ls", "-F", "#{session_name}"],
    stdout: "pipe", stderr: "ignore",
  });
  const orphans = (ls.stdout?.toString() ?? "")
    .split("\n")
    .filter((s) => s.startsWith("claude-rc-ch-"));
  for (const s of orphans) {
    spawnSync({
      cmd: ["tmux", "kill-session", "-t", s],
      stdout: "ignore", stderr: "ignore",
    });
  }
  if (orphans.length) {
    console.log(`[claude-rc-ch] killed ${orphans.length} orphan tmux session(s)`);
  }
}

// In channel mode, ensure the MCP channel server is registered at user
// scope so claude can find it. Idempotent — re-running is safe.
if (MODE === "channel") {
  const want = ChannelProcess.channelMcpPath();
  const r = spawnSync({
    cmd: ["claude", "mcp", "list"],
    stdout: "pipe", stderr: "pipe",
  });
  const hasIt = (r.stdout?.toString() ?? "").includes("claude-rc-channel");
  if (!hasIt) {
    const add = spawnSync({
      cmd: ["claude", "mcp", "add", "claude-rc-channel", "-s", "user",
            "--", "bun", "run", want],
      stdout: "pipe", stderr: "pipe",
    });
    if (add.exitCode === 0) {
      console.log("[claude-rc] registered MCP server claude-rc-channel at user scope");
    } else {
      console.error("[claude-rc] failed to register MCP server:", add.stderr.toString());
      process.exit(1);
    }
  }
}

interface SessionLike {
  ready(): Promise<unknown>;
  subscribe(s: (m: ServerMsg) => void): () => void;
  snapshot(): ServerMsg;
  handleClientMsg(msg: ClientMsg, reply: (m: ServerMsg) => void): Promise<void>;
}

const session: SessionLike = MODE === "channel"
  ? new ChannelSession({ defaultCwd: DEFAULT_CWD })
  : MODE === "oneshot"
  ? new OneshotSession({ defaultCwd: DEFAULT_CWD })
  : new PrintSession({ defaultCwd: DEFAULT_CWD });
await session.ready();

type WsData = { send: (m: ServerMsg) => void; unsubscribe: () => void };

const server = Bun.serve<WsData, never>({
  port: PORT,
  hostname: HOST,
  development: false,
  async fetch(req, server) {
    const url = new URL(req.url);
    if (url.pathname === "/healthz") return new Response("ok");
    if (url.pathname === "/ws") {
      if (!isAuthed(req)) return new Response("unauthorized", { status: 401 });
      const ok = server.upgrade(req, { data: {} as WsData });
      return ok ? undefined : new Response("upgrade failed", { status: 500 });
    }
    if (url.searchParams.has("t")) {
      if (!isAuthed(req)) return new Response("unauthorized", { status: 401 });
      const cleaned = new URL(url);
      cleaned.searchParams.delete("t");
      const headers = new Headers({ Location: cleaned.pathname + cleaned.search });
      headers.append(
        "Set-Cookie",
        `${COOKIE_NAME}=${encodeURIComponent(TOKEN)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 365}`,
      );
      return new Response(null, { status: 302, headers });
    }
    if (!isAuthed(req)) return new Response("unauthorized", { status: 401 });

    const path = url.pathname === "/" ? "/index.html" : url.pathname;
    const file = Bun.file(DIST_DIR + path.replace(/^\//, ""));
    if (await file.exists()) return new Response(file);
    const fallback = Bun.file(DIST_DIR + "index.html");
    if (await fallback.exists()) return new Response(fallback, { headers: { "content-type": "text/html" } });
    return new Response("not found (run `bun run build`)", { status: 404 });
  },
  websocket: {
    open(ws) {
      const send = (m: ServerMsg) => ws.send(JSON.stringify(m));
      const unsubscribe = session.subscribe(send);
      ws.data = { send, unsubscribe };
      send(session.snapshot());
    },
    async message(ws, raw) {
      let msg: ClientMsg;
      try { msg = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw)); }
      catch { return; }
      try { await session.handleClientMsg(msg, ws.data.send); }
      catch (err) { ws.data.send({ type: "error", message: String(err) }); }
    },
    close(ws) { ws.data?.unsubscribe?.(); },
  },
});

const tailscaleHost = await detectTailscaleHost();
const url = `http://${tailscaleHost ?? "localhost"}:${PORT}/?t=${TOKEN}`;
const label = INSTANCE ? `claude-rc[${INSTANCE}]` : "claude-rc";
console.log("");
console.log("┌──────────────────────────────────────────────");
console.log(`│  ${label} listening (mode=${MODE})`);
console.log("│  open on phone/desktop:");
console.log("│  " + url);
console.log("│  cwd: " + DEFAULT_CWD);
console.log("└──────────────────────────────────────────────");

async function detectTailscaleHost(): Promise<string | null> {
  try {
    const proc = Bun.spawn({ cmd: ["tailscale", "status", "--json"], stdout: "pipe", stderr: "ignore" });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    const j = JSON.parse(out);
    const fqdn: string | undefined = j?.Self?.DNSName;
    if (fqdn) return fqdn.replace(/\.$/, "");
  } catch {}
  return null;
}
