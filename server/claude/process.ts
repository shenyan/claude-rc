// Persistent `claude --print stream-json` subprocess wrapper.
//
// One instance = one thread = one long-lived claude session. We pipe
// user messages in as NDJSON and parse the rich event stream back
// (system / stream_event / assistant / user / result / rate_limit_event).
//
// Each cycle (one user message → one assistant turn) is bracketed by:
//   system{subtype:"init"}    ← claude is ready for input
//   ...
//   stream_event{message_start} → ...content_block_delta... → message_stop
//   assistant{...full message...}
//   result{subtype:"success"|"error", ...}    ← turn finished, ready for next

import { spawn, type Subprocess } from "bun";
import { randomUUID } from "node:crypto";

export interface ClaudeProcessOptions {
  cwd: string;
  sessionId?: string;       // omit to generate a fresh one
  resume?: boolean;          // true if sessionId points at an existing rollout
  model?: string;
  bin?: string;
  /** Defaults to true — phone-driven sessions trust the user. */
  dangerouslySkipPermissions?: boolean;
  /** Extra `--add-dir` paths. */
  addDirs?: string[];
}

export type ClaudeFrame =
  | { type: "system"; subtype: string; [k: string]: any }
  | { type: "assistant"; message: any; [k: string]: any }
  | { type: "user"; message: any; [k: string]: any }
  | { type: "stream_event"; event: any; [k: string]: any }
  | { type: "result"; subtype: string; [k: string]: any }
  | { type: "rate_limit_event"; rate_limit_info: any; [k: string]: any }
  | { type: string; [k: string]: any };

export type FrameHandler = (f: ClaudeFrame) => void;
export type ExitHandler = (code: number | null) => void;

export class ClaudeProcess {
  readonly sessionId: string;
  private proc: Subprocess<"pipe", "pipe", "pipe">;
  private buf = "";
  private dec = new TextDecoder();
  private frameHandlers: FrameHandler[] = [];
  private exitHandlers: ExitHandler[] = [];
  private closed = false;

  constructor(opts: ClaudeProcessOptions) {
    this.sessionId = opts.sessionId ?? randomUUID();
    const cmd: string[] = [
      opts.bin ?? "claude",
      "--print", "--verbose",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--include-partial-messages",
    ];
    if (opts.resume) {
      // Resuming an existing session: --resume picks up the rollout.
      // --session-id is rejected here ("can only be used with --continue
      // or --resume if --fork-session is also specified").
      cmd.push("--resume", this.sessionId);
    } else {
      // Fresh session: assign the id we generated so we can resume later.
      cmd.push("--session-id", this.sessionId);
    }
    if (opts.dangerouslySkipPermissions ?? true) {
      cmd.push("--dangerously-skip-permissions");
    }
    if (opts.model) cmd.push("--model", opts.model);
    for (const d of opts.addDirs ?? []) {
      cmd.push("--add-dir", d);
    }

    this.proc = spawn({
      cmd,
      cwd: opts.cwd,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    this.pumpStdout();
    this.pumpStderr();
    this.watchExit();
  }

  /** Pipe a user prompt into the running session. */
  sendUser(text: string, parentToolUseId: string | null = null) {
    if (this.closed) throw new Error("claude process is closed");
    const msg = {
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: parentToolUseId,
      session_id: this.sessionId,
    };
    this.proc.stdin.write(JSON.stringify(msg) + "\n");
    this.proc.stdin.flush?.();
  }

  onFrame(cb: FrameHandler) { this.frameHandlers.push(cb); }
  onExit(cb: ExitHandler) { this.exitHandlers.push(cb); }

  async close() {
    if (this.closed) return;
    this.closed = true;
    try { this.proc.stdin.end(); } catch {}
    await Promise.race([this.proc.exited, Bun.sleep(2000)]);
  }

  // ────────────────  internals  ────────────────

  private async pumpStdout() {
    const reader = this.proc.stdout.getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          this.buf += this.dec.decode();
          if (this.buf.trim().length) this.dispatch(this.buf.trim());
          this.buf = "";
          break;
        }
        this.buf += this.dec.decode(value, { stream: true });
        let nl: number;
        while ((nl = this.buf.indexOf("\n")) >= 0) {
          const line = this.buf.slice(0, nl).trim();
          this.buf = this.buf.slice(nl + 1);
          if (line) this.dispatch(line);
        }
      }
    } catch {}
  }

  private dispatch(line: string) {
    let frame: ClaudeFrame;
    try { frame = JSON.parse(line) as ClaudeFrame; }
    catch { console.error("[claude] bad JSON:", line.slice(0, 200)); return; }
    for (const h of this.frameHandlers) {
      try { h(frame); } catch (err) { console.error("[claude] frame handler:", err); }
    }
  }

  private async pumpStderr() {
    const reader = this.proc.stderr.getReader();
    const dec = new TextDecoder();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          const tail = dec.decode();
          if (tail) process.stderr.write("[claude] " + tail);
          break;
        }
        process.stderr.write("[claude] " + dec.decode(value, { stream: true }));
      }
    } catch {}
  }

  private async watchExit() {
    const code = await this.proc.exited;
    this.closed = true;
    for (const h of this.exitHandlers) {
      try { h(code); } catch {}
    }
  }
}
