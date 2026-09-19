'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useChatStore } from '@/lib/store';
import { formatDistanceToNow } from 'date-fns';

interface ChatSidebarProps {
  onNavigate?: () => void;
  username?: string;
  onLogout?: () => void;
}

export function ChatSidebar({ onNavigate, username, onLogout }: ChatSidebarProps) {
  const { chats, currentChatId, createChat, deleteChat, setCurrentChat } = useChatStore();
  const [hoveredChatId, setHoveredChatId] = useState<string | null>(null);
  const router = useRouter();

  const handleOpenAccount = () => {
    router.push('/account');
    onNavigate?.();
  };

  const handleNewChat = () => {
    createChat().catch(() => {});
    onNavigate?.();
  };

  const handleOpenDigest = () => {
    router.push('/digest');
    onNavigate?.();
  };

  const handleSelectChat = (id: string) => {
    setCurrentChat(id);
    onNavigate?.();
  };

  const handleDeleteChat = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!window.confirm('Delete this chat and all its messages?')) return;
    try {
      await deleteChat(id);
    } catch {
      window.alert('Failed to delete the chat. Please try again.');
    }
  };

  const formatDate = (date: Date | string) => {
    const d = new Date(date);
    return formatDistanceToNow(d, { addSuffix: true });
  };

  return (
    <div className="flex flex-col h-full w-full border-r bg-background">
      <div className="p-4 border-b">
        <div className="flex items-center gap-2">
          <svg className="w-6 h-6 text-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
          </svg>
          <h1 className="text-xl font-bold">Bleep AI</h1>
        </div>
      </div>

      <div className="p-4 border-b space-y-2">
        <button
          onClick={handleNewChat}
          className="w-full flex items-center gap-3 px-3 py-2.5 bg-primary text-primary-foreground rounded-xl hover:bg-primary/90 active:bg-primary/80 transition-colors"
        >
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          <span className="font-medium">New Chat</span>
        </button>

        <button
          onClick={handleOpenDigest}
          className="w-full flex items-center gap-3 px-3 py-2.5 border border-border text-foreground rounded-xl hover:bg-muted active:bg-muted transition-colors"
        >
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
          </svg>
          <span className="font-medium">Daily Digest</span>
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-2">
        {chats.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground">
            <p className="text-sm">No conversations yet</p>
            <p className="text-xs mt-1">Start a new chat to begin</p>
          </div>
        ) : (
          <ul className="space-y-1" role="list" aria-label="Chat history">
            {chats.map((chat) => (
              <li key={chat.id}>
                <div
                  className={`w-full flex items-center gap-2 px-3 py-3 sm:py-2.5 rounded-xl transition-colors text-left cursor-pointer ${
                    currentChatId === chat.id
                      ? 'bg-primary/10 text-primary'
                      : 'text-muted-foreground hover:bg-muted active:bg-muted'
                  }`}
                  onClick={() => handleSelectChat(chat.id)}
                  onMouseEnter={() => setHoveredChatId(chat.id)}
                  onMouseLeave={() => setHoveredChatId(null)}
                >
                  <svg className="w-5 h-5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                  </svg>
                  <span className="flex-1 truncate font-medium">{chat.title}</span>
                  <span className="text-xs text-muted-foreground hidden sm:block">{formatDate(chat.updatedAt)}</span>
                  <button
                    onClick={(e) => handleDeleteChat(chat.id, e)}
                    className={`p-1.5 rounded-lg hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors ${
                      hoveredChatId === chat.id ? 'lg:opacity-100' : 'lg:opacity-0'
                    }`}
                    aria-label="Delete chat"
                  >
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                    </svg>
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="p-4 border-t pb-safe space-y-3">
{username && (
          <div className="flex items-center justify-between gap-2">
            <button
              onClick={handleOpenAccount}
              className="flex items-center gap-2 min-w-0 group flex-1 text-left rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              aria-label="Open account settings"
              title="Account settings"
            >
              <div className="w-8 h-8 flex-shrink-0 rounded-full bg-primary/10 text-primary flex items-center justify-center font-semibold uppercase">
                {username.charAt(0)}
              </div>
              <span className="truncate text-sm font-medium group-hover:text-primary transition-colors">
                {username}
              </span>
            </button>
            <button
              onClick={onLogout}
              className="p-2 rounded-lg text-muted-foreground hover:bg-muted hover:text-destructive transition-colors"
              aria-label="Sign out"
              title="Sign out"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
              </svg>
            </button>
          </div>
        )}
        <div className="text-xs text-center text-muted-foreground">
          Powered by Ollama + free OpenRouter models
        </div>
      </div>
    </div>
  );
}