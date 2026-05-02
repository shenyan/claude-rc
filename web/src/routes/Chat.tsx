import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { send, useStore } from "../lib/store";
import type { ChatItem } from "../../../shared/protocol";

const CommandTerminal = lazy(() => import("../components/CommandTerminal"));
const MarkdownText = lazy(() => import("../components/MarkdownText"));
const BlocksView = lazy(() => import("../components/Blocks").then((m) => ({ default: m.BlocksView })));

const EMPTY_ITEMS: ChatItem[] = [];

export default function Chat({ threadId }: { threadId: string }) {
  const thread = useStore((s) => s.threads.find((t) => t.id === threadId));
  const items = useStore((s) => s.itemsByThread[threadId] ?? EMPTY_ITEMS);
  const connected = useStore((s) => s.connected);
  const [text, setText] = useState("");

  useEffect(() => {
    if (!connected) return;
    send({ type: "open_thread", threadId });
  }, [threadId, connected]);

  const scrollRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [items.length, items[items.length - 1] && (items[items.length - 1] as any).text?.length]);

  function submit() {
    const t = text.trim();
    if (!t) return;
    send({ type: "send_text", threadId, text: t });
    setText("");
  }

  return (
    <div className="h-full flex flex-col">
      <header className="px-4 pt-[max(env(safe-area-inset-top),12px)] pb-3 border-b border-border flex items-center gap-3">
        <Link to="/" className="md:hidden text-emerald-400 text-sm" data-testid="back-btn">
          ← Back
        </Link>
        <div className="min-w-0 flex-1">
          <div className="font-semibold truncate">{thread?.title ?? "New chat"}</div>
          <div className="text-xs text-muted truncate">{thread?.cwd}</div>
          <div className="text-[10px] text-muted/60 font-mono truncate">
            tmux: claude-rc-ch-{threadId.slice(0, 8)}  ·  tmux attach -t claude-rc-ch-{threadId.slice(0, 8)}
          </div>
        </div>
        {thread?.status === "active" && (
          <button
            className="text-xs bg-red-500/20 text-red-300 rounded px-2 py-1"
            onClick={() => send({ type: "interrupt", threadId })}
          >
            Interrupt
          </button>
        )}
      </header>

      <div ref={scrollRef} className="flex-1 overflow-y-auto overflow-x-hidden px-4 py-4 space-y-4" data-testid="messages">
        {items.map((item) => <ItemView key={item.id} item={item} threadId={threadId} />)}
        {items.length === 0 && <div className="text-muted text-sm">No messages yet.</div>}
        {thread?.status === "active" && <TypingDots />}
      </div>

      <form
        className="border-t border-border p-3 pb-[max(env(safe-area-inset-bottom),12px)] flex gap-2"
        onSubmit={(e) => { e.preventDefault(); submit(); }}
      >
        <textarea
          data-testid="composer"
          rows={1}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); }
          }}
          placeholder="Send message…"
          className="flex-1 bg-panel rounded-lg px-3 py-2 text-base resize-none border border-border focus:outline-none focus:border-emerald-500/50 max-h-40"
        />
        <button
          data-testid="send-btn"
          type="submit"
          disabled={!text.trim()}
          className="bg-emerald-600 disabled:bg-zinc-700 text-white rounded-lg px-4 text-sm"
        >
          Send
        </button>
      </form>
    </div>
  );
}

// Compact tool_result: by default show only first ~6 lines / 400 chars
// of plain text. Click to expand into a full xterm view (lazy-loaded).
function ToolResultView({ item }: { item: Extract<ChatItem, { kind: "tool_result" }> }) {
  const [expanded, setExpanded] = useState(false);
  if (!item.output) {
    return (
      <div className="font-mono text-xs text-muted [overflow-wrap:anywhere]" data-testid="msg-tool-result">
        (no output){item.isError && <span className="text-red-400 ml-2">· error</span>}
      </div>
    );
  }
  const lines = item.output.split("\n");
  const truncated = lines.length > 6 || item.output.length > 400;
  if (!expanded && truncated) {
    const preview = lines.slice(0, 6).join("\n").slice(0, 400);
    return (
      <div className="font-mono text-xs" data-testid="msg-tool-result">
        <pre className="text-zinc-400 whitespace-pre-wrap [overflow-wrap:anywhere] p-2 bg-bg border border-border rounded">{preview}</pre>
        <button
          className="text-[11px] text-emerald-400 hover:underline mt-0.5"
          onClick={() => setExpanded(true)}
        >
          show full output ({lines.length} lines)
        </button>
        {item.isError && <span className="text-red-400 text-[10px] ml-2">· error</span>}
      </div>
    );
  }
  return (
    <div className="font-mono text-xs" data-testid="msg-tool-result">
      <Suspense fallback={<pre className="text-zinc-400 whitespace-pre-wrap p-2 bg-bg border border-border rounded">{item.output}</pre>}>
        <CommandTerminal output={item.output} />
      </Suspense>
      {item.isError && <div className="text-red-400 text-[10px] mt-1">tool error</div>}
    </div>
  );
}

function TypingDots() {
  return (
    <div className="flex" data-testid="typing">
      <div className="bg-panel border border-border rounded-2xl px-3 py-2 flex gap-1">
        <span className="h-2 w-2 rounded-full bg-muted animate-bounce [animation-delay:-0.3s]" />
        <span className="h-2 w-2 rounded-full bg-muted animate-bounce [animation-delay:-0.15s]" />
        <span className="h-2 w-2 rounded-full bg-muted animate-bounce" />
      </div>
    </div>
  );
}

function ItemView({ item, threadId }: { item: ChatItem; threadId: string }) {
  switch (item.kind) {
    case "user":
      return (
        <div className="flex justify-end" data-testid="msg-user">
          <div className="bg-emerald-600 text-white rounded-2xl px-3 py-2 max-w-[85%] whitespace-pre-wrap [overflow-wrap:anywhere]">
            {item.text}
          </div>
        </div>
      );
    case "agent":
      return (
        <div className="flex" data-testid="msg-agent">
          <div className="bg-panel border border-border rounded-2xl px-3 py-2 max-w-[85%] [overflow-wrap:anywhere]">
            <Suspense fallback={<div className="whitespace-pre-wrap">{item.text}{item.streaming && <span className="opacity-50 animate-pulse">▌</span>}</div>}>
              <MarkdownText text={item.text} streaming={item.streaming} />
            </Suspense>
          </div>
        </div>
      );
    case "blocks":
      return (
        <div data-testid="msg-blocks" className="w-full max-w-[95%]">
          <Suspense fallback={<div className="text-muted text-xs">rendering…</div>}>
            <BlocksView
              blocks={item.blocks}
              ctx={{ onAction: (payload: string) => send({ type: "send_text", threadId, text: payload }) }}
            />
          </Suspense>
        </div>
      );
    case "tool_use": {
      // Pretty-print common tools (Bash, Read, Edit, Write); fall back to JSON for the rest.
      const inp = item.input ?? {};
      let header = item.tool;
      let body: string | null = null;
      if (item.tool === "Bash" && typeof inp.command === "string") {
        header = "Bash";
        body = inp.command;
      } else if ((item.tool === "Read" || item.tool === "Edit" || item.tool === "Write") && typeof inp.file_path === "string") {
        header = `${item.tool} ${inp.file_path}`;
      } else {
        body = Object.keys(inp).length ? JSON.stringify(inp, null, 2) : null;
      }
      const dot = item.status === "running" ? "bg-amber-400 animate-pulse" : item.status === "errored" ? "bg-red-500" : "bg-emerald-500";
      return (
        <div className="font-mono text-xs space-y-1" data-testid="msg-tool-use">
          <div className="flex items-center gap-2">
            <span className={`inline-block h-2 w-2 rounded-full ${dot}`} />
            <span className="text-emerald-300">{header}</span>
          </div>
          {body ? (
            <pre className="text-zinc-300 whitespace-pre-wrap [overflow-wrap:anywhere] p-2 bg-bg border border-border rounded">{body}</pre>
          ) : null}
        </div>
      );
    }
    case "tool_result":
      return <ToolResultView item={item} />;
    case "system":
      return <div className="text-xs text-muted">{item.text}</div>;
    default:
      return <div className="text-xs text-muted">{(item as any).text ?? "(unknown item)"}</div>;
  }
}
