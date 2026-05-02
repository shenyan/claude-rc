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

/**
 * Generative-UI blocks. The model emits these via the `reply` MCP tool's
 * `blocks` argument instead of a flat markdown string. Web UI dispatches
 * each block type to a dedicated React component.
 *
 * Order in the array = vertical render order. Use `cards_row` to lay
 * multiple cards horizontally.
 */
export type Block =
  /** Plain markdown paragraph. Same as a text-only reply. */
  | { type: "text"; markdown: string }
  /** A single rich card (place, restaurant, product, repo, person, etc.). */
  | {
      type: "card";
      title: string;
      subtitle?: string;
      /** Cover image URL. Used as a 16:9 hero by default. */
      image?: string;
      imageAlt?: string;
      /** If set, the whole card becomes a clickable link. */
      url?: string;
      /** Star rating 0–5 (decimals OK). */
      rating?: number;
      /** Small pill labels (e.g. "Italian", "$$", "Open now"). */
      badges?: string[];
      /** Extra key/value rows shown under the title. */
      meta?: { label: string; value: string }[];
      /** Optional action buttons attached to this card. */
      actions?: { label: string; payload?: string; url?: string; style?: "primary" | "default" | "danger" }[];
    }
  /** Horizontal scroller of small cards (search results). Same card schema. */
  | { type: "cards_row"; items: Extract<Block, { type: "card" }>[] }
  /** Static map embed (OSM, no API key). Click → opens full map in new tab. */
  | {
      type: "map";
      lat: number;
      lng: number;
      /** OSM zoom 1–19. Default 15. */
      zoom?: number;
      /** Marker label / pin tooltip. */
      label?: string;
      /** Optional caption under the map. */
      caption?: string;
    }
  /** Row of metric tiles (price, stars, win rate, etc.). */
  | {
      type: "stats";
      items: { label: string; value: string; delta?: string; tone?: "good" | "bad" | "neutral" }[];
    }
  /**
   * Choice buttons. Click sends the payload (or label) back as a normal
   * user message. Use this *instead of* AskUserQuestion (which is blocked).
   */
  | {
      type: "actions";
      choices: { label: string; payload?: string; style?: "primary" | "default" | "danger" }[];
    }
  /** Code/diff snippet, syntax-highlighted. */
  | { type: "code"; language?: string; code: string; filename?: string };

export type ChatItem =
  | { kind: "user"; id: string; text: string; createdAt: number }
  | { kind: "agent"; id: string; text: string; createdAt: number; streaming?: boolean }
  | { kind: "blocks"; id: string; blocks: Block[]; createdAt: number }
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
