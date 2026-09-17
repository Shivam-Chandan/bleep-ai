'use client';

import { create } from 'zustand';
import type { Chat, Message } from '@/lib/types';
import type { ChatModel } from '@/lib/models';
import { v4 as uuidv4 } from 'uuid';

interface ChatStore {
  chats: Chat[];
  currentChatId: string | null;
  isLoading: boolean;
  isHydrated: boolean;
  error: string | null;
  models: ChatModel[];
  modelsLoading: boolean;
  defaultModel: string | null;
  chatModels: Record<string, string>;
  loadChats: () => Promise<void>;
  loadModels: () => Promise<void>;
  createChat: () => Promise<string>;
  deleteChat: (id: string) => Promise<void>;
  setCurrentChat: (id: string) => void;
  getModelForChat: (chatId: string) => string | undefined;
  setChatModel: (chatId: string, modelId: string) => void;
  addMessage: (chatId: string, message: Omit<Message, 'id' | 'timestamp'>) => Message;
  updateMessage: (chatId: string, messageId: string, content: string) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  getCurrentChat: () => Chat | undefined;
}

const generateTitle = (firstMessage: string): string => {
  const words = firstMessage.trim().split(/\s+/);
  return words.slice(0, 6).join(' ') + (words.length > 6 ? '...' : '');
};

// Normalize API date strings into Date objects.
function reviveChat(raw: {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: { id: string; role: 'user' | 'assistant'; content: string; timestamp: string }[];
}): Chat {
  return {
    id: raw.id,
    title: raw.title,
    createdAt: new Date(raw.createdAt),
    updatedAt: new Date(raw.updatedAt),
    messages: raw.messages.map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      timestamp: new Date(m.timestamp),
    })),
  };
}

export const useChatStore = create<ChatStore>()((set, get) => ({
  chats: [],
  currentChatId: null,
  isLoading: false,
  isHydrated: false,
  error: null,
  models: [],
  modelsLoading: false,
  defaultModel: null,
  chatModels: {},

  loadModels: async () => {
    set({ modelsLoading: true });
    try {
      const res = await fetch('/api/chat');
      if (!res.ok) throw new Error('Failed to load models');
      const data = await res.json();
      set({
        models: data.models || [],
        defaultModel: data.defaultModel || null,
        modelsLoading: false,
      });
    } catch (e) {
      set({
        modelsLoading: false,
        error: e instanceof Error ? e.message : 'Failed to load models',
      });
    }
  },

  loadChats: async () => {
    try {
      const res = await fetch('/api/chats');
      if (!res.ok) throw new Error('Failed to load chats');
      const data = await res.json();
      const chats: Chat[] = (data.chats || []).map(reviveChat);
      set((state) => ({
        chats,
        isHydrated: true,
        currentChatId: state.currentChatId ?? chats[0]?.id ?? null,
      }));
    } catch (e) {
      set({ error: e instanceof Error ? e.message : 'Failed to load chats', isHydrated: true });
    }
  },

  createChat: async () => {
    const res = await fetch('/api/chats', { method: 'POST' });
    if (!res.ok) throw new Error('Failed to create chat');
    const raw = await res.json();
    const newChat = reviveChat(raw);
    set((state) => ({
      chats: [newChat, ...state.chats],
      currentChatId: newChat.id,
    }));
    return newChat.id;
  },

  deleteChat: async (id: string) => {
    const res = await fetch(`/api/chats/${id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error('Failed to delete chat');
    set((state) => ({
      chats: state.chats.filter((chat) => chat.id !== id),
      currentChatId: state.currentChatId === id ? null : state.currentChatId,
    }));
  },

  setCurrentChat: (id: string) => set({ currentChatId: id }),

  getModelForChat: (chatId: string) => {
    const { chatModels, defaultModel } = get();
    return chatModels[chatId] ?? defaultModel ?? undefined;
  },

  setChatModel: (chatId: string, modelId: string) =>
    set((state) => ({
      chatModels: { ...state.chatModels, [chatId]: modelId },
    })),

  addMessage: (chatId: string, message) => {
    const newMessage: Message = {
      ...message,
      id: uuidv4(),
      timestamp: new Date(),
    };
    set((state) => ({
      chats: state.chats.map((chat) =>
        chat.id === chatId
          ? {
              ...chat,
              messages: [...chat.messages, newMessage],
              updatedAt: new Date(),
              title:
                chat.messages.length === 0 && message.role === 'user'
                  ? generateTitle(message.content)
                  : chat.title,
            }
          : chat
      ),
    }));
    return newMessage;
  },

  updateMessage: (chatId: string, messageId: string, content: string) => {
    set((state) => ({
      chats: state.chats.map((chat) =>
        chat.id === chatId
          ? {
              ...chat,
              messages: chat.messages.map((msg) =>
                msg.id === messageId ? { ...msg, content } : msg
              ),
              updatedAt: new Date(),
            }
          : chat
      ),
    }));
  },

  setLoading: (loading: boolean) => set({ isLoading: loading }),
  setError: (error: string | null) => set({ error }),

  getCurrentChat: () => {
    const { chats, currentChatId } = get();
    return chats.find((chat) => chat.id === currentChatId);
  },
}));