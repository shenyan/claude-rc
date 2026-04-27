// claude-rc entrypoint: serve static + WS, spawn claude per thread on demand.
// Default port 9896 (codex-rc occupies 9876 / 9886).

import { Session } from "./session";
import type { ClientMsg, ServerMsg } from "../shared/protocol";
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.CLAUDE_RC_PORT ?? 9896);
const HOST = process.env.CLAUDE_RC_HOST ?? "0.0.0.0";
const DEFAULT_CWD = process.env.CLAUDE_RC_CWD ?? process.cwd();
const DIST_DIR = fileURLToPath(new URL("../dist/", import.meta.url));
const TOKEN_DIR = join(homedir(), ".arche");
const TOKEN_FILE = join(TOKEN_DIR, "claude-rc.token");

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
const COOKIE_NAME = "claude_rc_token";

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

const session = new Session({ defaultCwd: DEFAULT_CWD });
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
console.log("");
console.log("┌──────────────────────────────────────────────");
console.log("│  claude-rc listening");
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
