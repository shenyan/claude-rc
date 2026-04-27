import { useEffect } from "react";
import { Navigate, Route, Routes, useParams } from "react-router-dom";
import { startConnection } from "./lib/store";
import ChatList from "./routes/ChatList";
import Chat from "./routes/Chat";

export default function App() {
  useEffect(() => { startConnection(); }, []);

  return (
    <div className="h-[100dvh] flex flex-col">
      <Routes>
        <Route path="/" element={<HomeLayout />} />
        <Route path="/c/:threadId" element={<ChatLayout />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </div>
  );
}

// Mobile: list only. Tablet+: list + empty pane.
function HomeLayout() {
  return (
    <div className="flex h-full">
      <aside className="w-full md:w-[320px] md:border-r md:border-border h-full">
        <ChatList />
      </aside>
      <main className="hidden md:flex flex-1 items-center justify-center text-muted">
        Pick or create a chat
      </main>
    </div>
  );
}

// Mobile: detail only (back button takes you to list). Tablet+: split.
function ChatLayout() {
  const { threadId } = useParams<{ threadId: string }>();
  return (
    <div className="flex h-full">
      <aside className="hidden md:block md:w-[320px] md:border-r md:border-border h-full">
        <ChatList />
      </aside>
      <main className="flex-1 h-full min-w-0">
        {threadId ? <Chat threadId={threadId} /> : null}
      </main>
    </div>
  );
}
