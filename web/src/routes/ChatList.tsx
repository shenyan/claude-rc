import { useNavigate, useParams } from "react-router-dom";
import { send, useStore } from "../lib/store";

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
            <li key={t.id}>
              <button
                data-testid="thread-row"
                className={
                  "w-full text-left px-4 py-3 border-b border-border/60 active:bg-panel " +
                  (active ? "bg-panel" : "hover:bg-panel/60")
                }
                onClick={() => nav(`/c/${t.id}`)}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate font-medium">{t.title ?? "New chat"}</span>
                  <StatusDot status={t.status} />
                </div>
                <div className="text-xs text-muted truncate">{t.preview || t.cwd}</div>
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
