'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useChatStore } from '@/lib/store';
import { ChatWindow } from './ChatWindow';
import { ChatSidebar } from './ChatSidebar';
import { AppSkeleton } from './Skeleton';

export function ChatLayout({ username }: { username?: string }) {
  const chats = useChatStore((s) => s.chats);
  const isHydrated = useChatStore((s) => s.isHydrated);
  const loadChats = useChatStore((s) => s.loadChats);
  const loadModels = useChatStore((s) => s.loadModels);
  const createChat = useChatStore((s) => s.createChat);
  const getCurrentChat = useChatStore((s) => s.getCurrentChat);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const router = useRouter();

  // Load this user's chats from the database once.
  useEffect(() => {
    loadChats();
  }, [loadChats]);

  useEffect(() => {
    loadModels();
  }, [loadModels]);

  // After hydration, ensure there is at least one chat to show.
  useEffect(() => {
    if (isHydrated && chats.length === 0) {
      createChat().catch(() => {});
    }
  }, [isHydrated, chats.length, createChat]);

  const handleLogout = async () => {
    await fetch('/api/auth/logout', { method: 'POST' });
    router.push('/login', { transitionTypes: ['nav-back'] });
    router.refresh();
  };

  const currentChat = getCurrentChat();
  const title = currentChat?.title || 'Bleep AI';

  // Show a fidelity skeleton until the user's chats have been loaded from the
  // server, then fade the real shell in over it.
  if (!isHydrated) {
    return <AppSkeleton />;
  }

  return (
    <div className="flex h-dvh bg-background overflow-hidden animate-app-in">
      {/* Desktop sidebar (always visible) */}
      <aside className="hidden lg:flex w-72 flex-shrink-0">
        <ChatSidebar username={username} onLogout={handleLogout} />
      </aside>

      {/* Mobile sidebar (slide-over drawer) */}
      <div
        className={`lg:hidden fixed inset-0 z-50 transition-opacity duration-200 ${
          isSidebarOpen ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'
        }`}
      >
        <div
          onClick={() => setIsSidebarOpen(false)}
          className="absolute inset-0 bg-black/50"
          aria-hidden="true"
        />
        <div
          className={`absolute left-0 top-0 h-full w-[85%] max-w-xs bg-background shadow-xl transition-transform duration-200 pl-safe pt-safe pb-safe ${
            isSidebarOpen ? 'translate-x-0' : '-translate-x-full'
          }`}
        >
          <ChatSidebar username={username} onLogout={handleLogout} onNavigate={() => setIsSidebarOpen(false)} />
        </div>
      </div>

      {/* Main content */}
      <main className="flex-1 flex flex-col min-w-0">
        {/* Mobile header */}
        <header className="lg:hidden flex items-center gap-3 h-14 px-3 border-b bg-background pt-safe flex-shrink-0">
          <button
            onClick={() => setIsSidebarOpen(true)}
            className="p-2 -ml-1 rounded-lg hover:bg-muted active:bg-muted transition-colors"
            aria-label="Open chat history"
          >
            <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
          <h1 className="flex-1 truncate font-semibold text-base">{title}</h1>
          <button
            onClick={() => createChat().catch(() => {})}
            className="p-2 -mr-1 rounded-lg text-primary hover:bg-muted active:bg-muted transition-colors"
            aria-label="New chat"
          >
            <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
          </button>
        </header>

        <ChatWindow />
      </main>
    </div>
  );
}