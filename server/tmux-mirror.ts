// Read-only tmux mirror.
//
// One tmux session per thread (named `claude-rc-<short-thread-id>`).
// claude-rc pushes a human-readable rendering of the live conversation
// into that pane via `tmux send-keys` to a small `cat`-style sink we
// run inside the pane. Pane is read-only by convention — typing into
// it doesn't send anything back to claude. ssh + `tmux attach -t
// claude-rc-<id>` lets you scroll, copy, see what's happening.
//
// Why this and not just `tee` to a file? tmux gives us:
//  - scroll-back history (copy-mode)
//  - real ANSI rendering with proper terminal width
//  - the muscle-memory ssh-to-laptop-and-attach flow
//
// Implementation: each thread spawns `tmux new-session -d -s <name>`
// once, then writes ANSI text via `tmux send-keys -t <name> -l <text>`
// to "type" into the pane. The pane has no shell prompt — we run a
// captive `cat` so the bytes display verbatim and any user keystrokes
// disappear into cat's stdin (effectively read-only).

import { spawnSync, spawn } from "bun";

export interface TmuxMirrorOptions {
  threadId: string;
  /** Banner shown at the top of the pane, e.g. "claude-rc · sam · cwd". */
  title?: string;
}

const SESSION_PREFIX = "claude-rc-";

export class TmuxMirror {
  readonly sessionName: string;
  private alive = false;

  constructor(opts: TmuxMirrorOptions) {
    // Short, readable session name. tmux session names can't contain "."
    // and must be unique on the local server.
    const short = opts.threadId.replace(/-/g, "").slice(0, 8);
    this.sessionName = `${SESSION_PREFIX}${short}`;
    if (!hasTmux()) return;
    this.ensureSession(opts.title);
  }

  /** Append plain text (with optional ANSI codes) to the pane. */
  write(text: string) {
    if (!this.alive) return;
    // tmux send-keys -l means "literal" — bytes are inserted as-is,
    // including \r \n and ANSI escapes.
    spawnSync({
      cmd: ["tmux", "send-keys", "-t", this.sessionName, "-l", text],
      stdout: "ignore",
      stderr: "ignore",
    });
  }

  writeln(text: string) {
    this.write(text + "\r\n");
  }

  /** Section header — bold + dim hr above for visual separation. */
  section(label: string) {
    this.writeln("");
    this.writeln(`\x1b[2m──── \x1b[1m${label}\x1b[0m\x1b[2m ────────────────────────────\x1b[0m`);
  }

  /** Helper: render a user prompt block. */
  user(text: string) {
    this.section("user");
    this.writeln(text);
  }

  /** Helper: assistant streaming text — appended without a fresh section. */
  assistantDelta(text: string) {
    if (!this.lastWasAssistant) {
      this.section("assistant");
      this.lastWasAssistant = true;
    }
    this.write(text);
  }

  assistantEnd() {
    if (this.lastWasAssistant) {
      this.write("\r\n");
      this.lastWasAssistant = false;
    }
  }
  private lastWasAssistant = false;

  /** Helper: tool call header. */
  toolCall(name: string, summary: string) {
    this.assistantEnd();
    this.section(`tool · ${name}`);
    if (summary) this.writeln(`\x1b[36m${summary}\x1b[0m`);
  }

  /** Helper: tool result. Output written verbatim with its own ANSI. */
  toolResult(output: string, isError = false) {
    this.assistantEnd();
    if (isError) {
      this.writeln(`\x1b[31m[tool error]\x1b[0m`);
    }
    if (output) this.writeln(output);
  }

  /** Final result of a turn — tag with cost / duration if available. */
  turnEnd(meta: { duration_ms?: number; result?: string; is_error?: boolean }) {
    this.assistantEnd();
    const status = meta.is_error ? "\x1b[31merrored\x1b[0m" : "\x1b[32mdone\x1b[0m";
    const dur = meta.duration_ms ? ` · ${(meta.duration_ms / 1000).toFixed(1)}s` : "";
    this.writeln(`\x1b[2m─── turn ${status}${dur} ───\x1b[0m`);
  }

  close() {
    if (!this.alive) return;
    this.alive = false;
    spawnSync({
      cmd: ["tmux", "kill-session", "-t", this.sessionName],
      stdout: "ignore",
      stderr: "ignore",
    });
  }

  // ────────────────  internals  ────────────────

  private ensureSession(title?: string) {
    // If the session already exists from a previous run, reuse it.
    const has = spawnSync({
      cmd: ["tmux", "has-session", "-t", this.sessionName],
      stdout: "ignore",
      stderr: "ignore",
    });
    if (has.exitCode === 0) {
      this.alive = true;
      return;
    }

    // Run a captive `cat >/dev/null` inside the pane so the pane has no
    // interactive shell. Anything we send via send-keys -l shows up;
    // anything the user types goes into cat's stdin and does nothing.
    const r = spawnSync({
      cmd: [
        "tmux", "new-session", "-d",
        "-s", this.sessionName,
        "-x", "200", "-y", "50",
        "sh", "-c", "stty -echo 2>/dev/null; cat >/dev/null",
      ],
      stdout: "pipe",
      stderr: "pipe",
    });
    if (r.exitCode !== 0) {
      console.error(`[tmux-mirror] failed to create session ${this.sessionName}: ${r.stderr.toString()}`);
      return;
    }
    this.alive = true;
    if (title) this.writeln(`\x1b[1m${title}\x1b[0m`);
    this.writeln(`\x1b[2m(read-only mirror — typing here goes nowhere; use the web UI to drive)\x1b[0m`);
  }
}

function hasTmux(): boolean {
  const r = spawnSync({ cmd: ["which", "tmux"], stdout: "pipe", stderr: "ignore" });
  return r.exitCode === 0;
}
