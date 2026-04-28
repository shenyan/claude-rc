import { useNavigate, useParams } from "react-router-dom";
import { send, useStore } from "../lib/store";

function tmuxName(threadId: string) {
  return `claude-rc-ch-${threadId.slice(0, 8)}`;
}

export default function ChatList() {
  const threads = useStore((s) => s.threads);
  const connected = useStore((s) => s.connected);
  const defaultCwd = useStore((s) => s.defaultCwd);
  const { threadId: activeId } = useParams<{ threadId: string }>();
  const nav = useNavigate();

  return (
    <div className="flex flex-col h-full">
      <header className="px-4 pt-[max(env(safe-area-inset-top),12px)] pb-3 border-b border-border flex items-center justify-between">
        <div>
          <div className="font-semibold">claude-rc</div>
          <div className="text-xs text-muted truncate" title={defaultCwd}>
            {connected ? defaultCwd : "connecting…"}
          </div>
        </div>
        <button
          data-testid="new-chat-btn"
          className="text-sm bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg px-3 py-1.5"
          onClick={() => send({ type: "create_thread" })}
        >
          + New
        </button>
      </header>

      <ul className="flex-1 overflow-y-auto" data-testid="thread-list">
        {threads.length === 0 && (
          <li className="p-6 text-muted text-sm">No chats yet. Tap + New.</li>
        )}
        {threads.map((t) => {
          const active = t.id === activeId;
          return (
            <li key={t.id} className="relative border-b border-border/60">
              <button
                data-testid="thread-row"
                className={
                  "w-full text-left px-4 py-3 pr-12 active:bg-panel " +
                  (active ? "bg-panel" : "hover:bg-panel/60")
                }
                onClick={() => nav(`/c/${t.id}`)}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate font-medium">{t.title ?? "New chat"}</span>
                  <StatusDot status={t.status} />
                </div>
                <div className="text-xs text-muted truncate">{t.preview || t.cwd}</div>
                <div className="text-[10px] text-muted/60 font-mono mt-0.5 truncate">
                  tmux: {tmuxName(t.id)}
                </div>
              </button>
              <button
                data-testid="thread-delete"
                title="Delete chat (kills tmux session)"
                className="absolute top-2 right-2 text-muted hover:text-red-400 px-2 py-1 text-sm"
                onClick={(e) => {
                  e.stopPropagation();
                  if (!confirm(`Delete chat "${t.title ?? "New chat"}"?\n\nThis kills tmux session ${tmuxName(t.id)} and the claude process inside it.`)) return;
                  if (active) nav("/");
                  send({ type: "delete_thread", threadId: t.id });
                }}
              >
                ✕
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function StatusDot({ status }: { status: string }) {
  let cls = "bg-muted/40";
  if (status === "active") cls = "bg-emerald-400 animate-pulse";
  else if (status === "errored") cls = "bg-red-500";
  return <span className={"inline-block h-2 w-2 rounded-full shrink-0 " + cls} />;
}
