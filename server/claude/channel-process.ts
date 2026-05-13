// Bridge-side per-thread handler for channel mode.
//
// One ChannelProcess per thread:
//   - spawns `claude` interactively in a tmux session
//   - dismisses the dev-channels confirmation dialog (sends Enter)
//   - waits for the matching channel-mcp child to register on the
//     control plane, then is ready to push/reply.

import { spawnSync } from "bun";
import { ControlPlane } from "../control-plane";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHANNEL_MCP_PATH = fileURLToPath(new URL("./channel-mcp.ts", import.meta.url));
const HOOK_EMIT_PATH = fileURLToPath(new URL("./hook-emit.ts", import.meta.url));

function buildHookSettings(): string {
  // Pre/Post tool hooks fire `bun run hook-emit.ts <kind>` with the
  // claude event JSON on stdin. Env vars CLAUDE_RC_THREAD_ID etc. are
  // inherited from the tmux session.
  const cmd = (kind: string) => `bun run ${HOOK_EMIT_PATH} ${kind}`;
  return JSON.stringify({
    hooks: {
      PreToolUse: [{ matcher: ".*", hooks: [{ type: "command", command: cmd("pre") }] }],
      PostToolUse: [{ matcher: ".*", hooks: [{ type: "command", command: cmd("post") }] }],
      PostToolUseFailure: [{ matcher: ".*", hooks: [{ type: "command", command: cmd("post_failure") }] }],
      UserPromptSubmit: [{ hooks: [{ type: "command", command: cmd("user_prompt") }] }],
    },
    // Reliability tweaks for phone/web-driven sessions where there's no
    // way to dismiss a TUI dialog. See https://code.claude.com/docs/en/settings.
    // - feedbackSurveyRate=0: suppress random session-feedback popups
    // - permissions.defaultMode: belt-and-suspenders alongside --dangerously-skip-permissions
    // - enableAllProjectMcpServers: auto-trust project .mcp.json without prompting
    // - skipWebFetchPreflight: skip api.anthropic.com safety check on WebFetch
    feedbackSurveyRate: 0,
    permissions: { defaultMode: "bypassPermissions" },
    enableAllProjectMcpServers: true,
    skipWebFetchPreflight: true,
  });
}

export interface ChannelProcessOptions {
  threadId: string;
  cwd: string;
  controlPort: number;
  controlToken: string;
  /**
   * Optional suffix for the tmux session name so multiple bridge instances
   * on the same host don't collide. Defaults to "" (bare session name).
   */
  instanceSuffix?: string;
  /** override: don't actually spawn (useful for tests). */
  noSpawn?: boolean;
}

export type ReplyHandler = (text: string) => void;
export type ToolCallHandler = (tool: string, input: any) => void;
export type ReadyHandler = () => void;

export class ChannelProcess {
  readonly threadId: string;
  readonly tmuxSession: string;
  private cwd: string;
  private controlPort: number;
  private controlToken: string;
  private replyHandlers: ReplyHandler[] = [];
  private readyHandlers: ReadyHandler[] = [];
  private isReady = false;
  /** Per-thread settings dir; cleaned up on close(). */
  private settingsDir: string | null = null;
  /** True once tmux session is alive. */
  private spawned = false;
  /** Captured spawn error, if any — surfaced via lastError(). */
  private spawnError: Error | null = null;

  constructor(opts: ChannelProcessOptions) {
    this.threadId = opts.threadId;
    this.cwd = opts.cwd;
    this.controlPort = opts.controlPort;
    this.controlToken = opts.controlToken;
    const suffix = opts.instanceSuffix ?? "";
    this.tmuxSession = `claude-rc-ch-${opts.threadId.slice(0, 8)}${suffix}`;
    if (!opts.noSpawn) this.spawn();
  }

  /** Whether spawn() succeeded. */
  isSpawned(): boolean { return this.spawned; }
  /** Most recent spawn failure (null if none). */
  lastError(): Error | null { return this.spawnError; }

  onReply(cb: ReplyHandler) { this.replyHandlers.push(cb); }
  onReady(cb: ReadyHandler) {
    this.readyHandlers.push(cb);
    if (this.isReady) cb();
  }

  /** Called by the bridge when the control-plane sees our child connect. */
  markReady() {
    if (this.isReady) return;
    this.isReady = true;
    for (const h of this.readyHandlers) { try { h(); } catch {} }
  }

  /** Called by the bridge when control-plane forwards a reply tool call. */
  emitReply(text: string) {
    for (const h of this.replyHandlers) { try { h(text); } catch {} }
  }

  close() {
    try {
      spawnSync({
        cmd: ["tmux", "kill-session", "-t", this.tmuxSession],
        stdout: "ignore", stderr: "ignore",
      });
    } catch {}
    if (this.settingsDir) {
      try { rmSync(this.settingsDir, { recursive: true, force: true }); }
      catch {}
      this.settingsDir = null;
    }
  }

  // ────────────────  internals  ────────────────

  private spawn() {
    // tmux passes `-e KEY=VAL` env vars to the launched command, which
    // claude inherits, which the MCP server (spawned by claude) inherits.
    // That's how the MCP server learns its threadId / control plane port.
    // Write hook settings to a per-thread file. claude reads `--settings`
    // either as a path or inline JSON; a path is cleaner since the JSON
    // contains shell metachars.
    const settingsDir = mkdtempSync(join(tmpdir(), "claude-rc-ch-"));
    this.settingsDir = settingsDir;
    const settingsPath = join(settingsDir, "hooks.json");
    writeFileSync(settingsPath, buildHookSettings(), { mode: 0o600 });

    const cmd = [
      "tmux", "new-session", "-d",
      "-s", this.tmuxSession,
      "-x", "200", "-y", "50",
      "-e", `CLAUDE_RC_THREAD_ID=${this.threadId}`,
      "-e", `CLAUDE_RC_CP_PORT=${this.controlPort}`,
      "-e", `CLAUDE_RC_CP_TOKEN=${this.controlToken}`,
      // Working directory.
      "-c", this.cwd,
      // The actual command. dev-channels flag makes the channel server
      // bypass the allowlist; --dangerously-skip-permissions because
      // YOLO is the design (phone-driven, owner-driven).
      "claude",
      "--dangerously-load-development-channels", "server:claude-rc-channel",
      "--dangerously-skip-permissions",
      "--settings", settingsPath,
      // Pin claude's session-id to our threadId so the JSONL transcript
      // filename is predictable. We hydrate UI history from that file
      // after a bridge restart (see channel-session.ts hydrateFromTranscript).
      "--session-id", this.threadId,
      // System prompt tail: claude routes all user-visible answers through
      // the channel's reply tool, otherwise the phone never sees them.
      // Telegram/Discord channel plugins do this via a skills/ markdown
      // file; we do it inline since we don't ship as a plugin.
      "--append-system-prompt",
      "You are running inside claude-rc, a phone-driven remote-control bridge. " +
      "The user is reading your messages on a phone or web UI — text printed outside the " +
      "`mcp__claude-rc-channel__reply` tool is invisible to them. " +
      "**Every user-visible answer must go through that tool.** " +
      "Even short acknowledgements (\"on it\", \"done\"), error messages, and status updates. " +
      "Plain TUI text is fine for your own scratch / planning, but the answer the user " +
      "actually reads goes through reply(). Markdown is supported.",
    ];
    const r = spawnSync({ cmd, stdout: "ignore", stderr: "pipe" });
    if (r.exitCode !== 0) {
      const stderr = r.stderr.toString();
      const msg = `tmux spawn failed for ${this.tmuxSession}: ${stderr.trim()}`;
      console.error(`[channel-process] ${msg}`);
      this.spawnError = new Error(msg);
      // Clean up the temp settings dir we just made — caller (bridge) is
      // expected to drop this instance after seeing isSpawned()===false.
      if (this.settingsDir) {
        try { rmSync(this.settingsDir, { recursive: true, force: true }); }
        catch {}
        this.settingsDir = null;
      }
      return;
    }
    this.spawned = true;

    // Dismiss the "WARNING: Loading development channels" dialog with
    // Enter. We send the keystroke a couple of times spaced out — the
    // dialog isn't always painted before the first keystroke arrives,
    // and stray Enters are no-ops in the empty TUI prompt.
    setTimeout(() => this.sendKey("Enter"), 1500);
    setTimeout(() => this.sendKey("Enter"), 3000);
  }

  private sendKey(key: string) {
    spawnSync({
      cmd: ["tmux", "send-keys", "-t", this.tmuxSession, key],
      stdout: "ignore", stderr: "ignore",
    });
  }

  /**
   * Inject a user message via tmux send-keys.
   *
   * Why not channel push? Claude's `notifications/claude/channel` queue
   * is only flushed during active chat — empty welcome screens or
   * setup states drop pushes silently. send-keys mimics actual user
   * typing into the prompt, which always puts claude into a turn
   * regardless of UI state. Output (reply) still flows through the
   * channel, which gives us structured text without ANSI scraping.
   */
  injectUserPrompt(text: string) {
    // Type the text literally (`-l` = literal, no key-name interpretation).
    // We chunk by line so embedded newlines arrive as Shift+Enter (multi-line
    // input mode) rather than submitting the prompt early.
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (lines[i]) {
        spawnSync({
          cmd: ["tmux", "send-keys", "-t", this.tmuxSession, "-l", lines[i]],
          stdout: "ignore", stderr: "ignore",
        });
      }
      if (i < lines.length - 1) {
        spawnSync({
          cmd: ["tmux", "send-keys", "-t", this.tmuxSession, "S-Enter"],
          stdout: "ignore", stderr: "ignore",
        });
      }
    }
    // Submit.
    setTimeout(() => this.sendKey("Enter"), 100);
  }

  static channelMcpPath(): string {
    return CHANNEL_MCP_PATH;
  }
}
