'use client';

import { useEffect } from 'react';
import { useChatStore } from '@/lib/store';
import { ChatWindow } from './ChatWindow';
import { MobileSidebar } from './MobileSidebarToggle';

export function ChatLayout() {
  const { chats, createChat } = useChatStore();

  useEffect(() => {
    if (chats.length === 0) {
      createChat();
    }
  }, [chats.length, createChat]);

  return (
    <div className="flex h-screen bg-background relative">
      <MobileSidebar />
      <main className="flex-1 flex flex-col min-w-0 lg:ml-0">
        <ChatWindow />
      </main>
    </div>
  );
}