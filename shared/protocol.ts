// Wire protocol between claude-rc server and web client.
// Claude-side stream-json is parsed in server/session.ts; the browser
// only sees the envelope below.

export type ThreadStatus = "idle" | "active" | "errored";

export interface ThreadSummary {
  id: string;
  /** claude session id (UUID), used for --session-id / --resume. */
  sessionId: string;
  title: string | null;
  cwd: string;
  status: ThreadStatus;
  lastActiveAt: number;
  preview: string;
}

export type ChatItem =
  | { kind: "user"; id: string; text: string; createdAt: number }
  | { kind: "agent"; id: string; text: string; createdAt: number; streaming?: boolean }
  | { kind: "tool_use"; id: string; tool: string; input: any; createdAt: number; status: "running" | "completed" | "errored" }
  | { kind: "tool_result"; id: string; toolUseId: string; output: string; createdAt: number; isError?: boolean }
  | { kind: "system"; id: string; text: string; createdAt: number };

export type ClientMsg =
  | { type: "hello" }
  | { type: "create_thread"; cwd?: string }
  | { type: "open_thread"; threadId: string }
  | { type: "send_text"; threadId: string; text: string }
  | { type: "interrupt"; threadId: string }
  | { type: "delete_thread"; threadId: string };

export type ServerMsg =
  | { type: "snapshot"; threads: ThreadSummary[]; defaultCwd: string }
  | { type: "thread_created"; thread: ThreadSummary }
  | { type: "thread_updated"; thread: ThreadSummary }
  | { type: "thread_deleted"; threadId: string }
  | { type: "thread_history"; threadId: string; items: ChatItem[] }
  | { type: "item_appended"; threadId: string; item: ChatItem }
  | { type: "item_updated"; threadId: string; item: ChatItem }
  | { type: "error"; message: string };
