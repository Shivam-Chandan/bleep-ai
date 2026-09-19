'use client';

import { create } from 'zustand';
import type { Chat, Message, Source } from '@/lib/types';
import type { ChatModel } from '@/lib/models';
import { v4 as uuidv4 } from 'uuid';

interface ChatStore {
  chats: Chat[];
  currentChatId: string | null;
  isLoading: boolean;
  isHydrated: boolean;
  error: string | null;
  errorCode: string | null;
  localStatus: 'ok' | 'unreachable' | 'unknown';
  models: ChatModel[];
  modelsLoading: boolean;
  defaultModel: string | null;
  chatModels: Record<string, string>;
  // Per-chat generation state so multiple chats can stream concurrently.
  streamingChats: Record<string, boolean>;
  chatStatus: Record<string, string | null>;
  // Threads are fetched lazily: the sidebar loads headers only, then the open
  // chat fetches its messages. These track that per-chat progress.
  messagesLoaded: Record<string, boolean>;
  messagesLoading: Record<string, boolean>;
  // Optimistic "New Chat": a temp chat shows instantly while the POST is in
  // flight. This maps the temp id to a promise that resolves to the real id.
  pendingCreates: Record<string, Promise<string>>;
  loadChats: () => Promise<void>;
  loadMessages: (chatId: string) => Promise<void>;
  loadModels: () => Promise<void>;
  createChat: () => Promise<string>;
  resolveChatId: (chatId: string) => Promise<string>;
  deleteChat: (id: string) => Promise<void>;
  setCurrentChat: (id: string) => void;
  getModelForChat: (chatId: string) => string | undefined;
  setChatModel: (chatId: string, modelId: string) => void;
  setChatStreaming: (chatId: string, streaming: boolean) => void;
  setChatStatus: (chatId: string, status: string | null) => void;
  addMessage: (chatId: string, message: Omit<Message, 'id' | 'timestamp'>) => Message;
  updateMessage: (chatId: string, messageId: string, content: string) => void;
  updateMessageSources: (chatId: string, messageId: string, sources: Source[]) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null, code?: string | null) => void;
  dismissError: () => void;
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
  messages: {
    id: string;
    role: 'user' | 'assistant';
    content: string;
    timestamp: string;
    sources?: { title: string; url: string }[];
  }[];
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
      ...(m.sources ? { sources: m.sources } : {}),
    })),
  };
}

// The list endpoint returns headers only; messages arrive from GET /api/chats/:id.
function reviveChatSummary(raw: {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}): Chat {
  return {
    id: raw.id,
    title: raw.title,
    createdAt: new Date(raw.createdAt),
    updatedAt: new Date(raw.updatedAt),
    messages: [],
  };
}

export const useChatStore = create<ChatStore>()((set, get) => ({
  chats: [],
  currentChatId: null,
  isLoading: false,
  isHydrated: false,
  error: null,
  errorCode: null,
  localStatus: 'unknown',
  models: [],
  modelsLoading: false,
  defaultModel: null,
  chatModels: {},
  streamingChats: {},
  chatStatus: {},
  messagesLoaded: {},
  messagesLoading: {},
  pendingCreates: {},

  loadModels: async () => {
    set({ modelsLoading: true });
    try {
      const res = await fetch('/api/chat');
      if (!res.ok) throw new Error('Failed to load models');
      const data = await res.json();
      set({
        models: data.models || [],
        defaultModel: data.defaultModel || null,
        localStatus: data.localStatus === 'ok' ? 'ok' : 'unreachable',
        modelsLoading: false,
      });
    } catch (e) {
      set({
        modelsLoading: false,
        localStatus: 'unknown',
        error: e instanceof Error ? e.message : 'Failed to load models',
        errorCode: 'connection_failed',
      });
    }
  },

  loadChats: async () => {
    try {
      const res = await fetch('/api/chats');
      if (!res.ok) throw new Error('Failed to load chats');
      const data = await res.json();
      const chats: Chat[] = (data.chats || []).map(reviveChatSummary);
      const currentChatId = get().currentChatId ?? chats[0]?.id ?? null;
      set({ chats, isHydrated: true, currentChatId });
      // Open the first chat immediately, fetching only its thread.
      if (currentChatId) void get().loadMessages(currentChatId);
    } catch (e) {
      set({ error: e instanceof Error ? e.message : 'Failed to load chats', isHydrated: true });
    }
  },

  loadMessages: async (chatId: string) => {
    const { messagesLoaded, messagesLoading, pendingCreates } = get();
    // Temp (not-yet-persisted) chats have no server thread to fetch.
    if (
      messagesLoaded[chatId] ||
      messagesLoading[chatId] ||
      chatId in pendingCreates
    ) {
      return;
    }
    set((state) => ({
      messagesLoading: { ...state.messagesLoading, [chatId]: true },
    }));
    try {
      const res = await fetch(`/api/chats/${chatId}`);
      if (!res.ok) throw new Error('Failed to load chat');
      const raw = await res.json();
      const loaded = reviveChat(raw);
      set((state) => ({
        chats: state.chats.map((chat) =>
          chat.id === chatId
            ? {
                ...chat,
                title: loaded.title,
                createdAt: loaded.createdAt,
                updatedAt: loaded.updatedAt,
                messages: loaded.messages,
              }
            : chat
        ),
        messagesLoaded: { ...state.messagesLoaded, [chatId]: true },
        messagesLoading: { ...state.messagesLoading, [chatId]: false },
      }));
    } catch {
      set((state) => ({
        messagesLoading: { ...state.messagesLoading, [chatId]: false },
      }));
    }
  },

  createChat: async () => {
    // Show the new chat instantly; reconcile with the server in the background.
    const tempId = `temp-${uuidv4()}`;
    const now = new Date();
    const optimistic: Chat = {
      id: tempId,
      title: 'New Chat',
      createdAt: now,
      updatedAt: now,
      messages: [],
    };
    set((state) => ({
      chats: [optimistic, ...state.chats],
      currentChatId: tempId,
      messagesLoaded: { ...state.messagesLoaded, [tempId]: true },
    }));

    const promise = (async () => {
      const res = await fetch('/api/chats', { method: 'POST' });
      if (!res.ok) throw new Error('Failed to create chat');
      const raw = await res.json();
      const real = reviveChat({ ...raw, messages: raw.messages ?? [] });
      set((state) => {
        const remap = <T>(map: Record<string, T>): Record<string, T> => {
          if (!(tempId in map)) return map;
          const { [tempId]: value, ...rest } = map;
          return { ...rest, [real.id]: value };
        };
        return {
          chats: state.chats.map((chat) =>
            // Preserve any messages sent while the create was in flight.
            chat.id === tempId
              ? { ...real, title: chat.title, messages: chat.messages }
              : chat
          ),
          currentChatId: state.currentChatId === tempId ? real.id : state.currentChatId,
          messagesLoaded: remap(state.messagesLoaded),
          messagesLoading: remap(state.messagesLoading),
          chatModels: remap(state.chatModels),
          chatStatus: remap(state.chatStatus),
          streamingChats: remap(state.streamingChats),
          pendingCreates: remap(state.pendingCreates),
        };
      });
      return real.id;
    })();

    set((state) => ({
      pendingCreates: { ...state.pendingCreates, [tempId]: promise },
    }));

    try {
      return await promise;
    } catch (e) {
      set((state) => {
        const chats = state.chats.filter((chat) => chat.id !== tempId);
        const pendingCreates = { ...state.pendingCreates };
        delete pendingCreates[tempId];
        return {
          chats,
          currentChatId:
            state.currentChatId === tempId ? chats[0]?.id ?? null : state.currentChatId,
          pendingCreates,
        };
      });
      throw e;
    }
  },

  resolveChatId: (chatId: string) => {
    const pending = get().pendingCreates[chatId];
    return pending ?? Promise.resolve(chatId);
  },

  deleteChat: async (id: string) => {
    // A temp chat that hasn't been persisted yet: just drop it locally.
    const chatId = await get().resolveChatId(id).catch(() => id);
    if (get().pendingCreates[id] === undefined && id.startsWith('temp-')) {
      set((state) => ({
        chats: state.chats.filter((chat) => chat.id !== id),
        currentChatId: state.currentChatId === id ? null : state.currentChatId,
      }));
      return;
    }
    const res = await fetch(`/api/chats/${chatId}`, { method: 'DELETE' });
    if (!res.ok) throw new Error('Failed to delete chat');
    set((state) => ({
      chats: state.chats.filter((chat) => chat.id !== chatId && chat.id !== id),
      currentChatId:
        state.currentChatId === chatId || state.currentChatId === id
          ? null
          : state.currentChatId,
    }));
  },

  setCurrentChat: (id: string) => {
    set({ currentChatId: id });
    void get().loadMessages(id);
  },

  getModelForChat: (chatId: string) => {
    const { chatModels, defaultModel } = get();
    return chatModels[chatId] ?? defaultModel ?? undefined;
  },

  setChatModel: (chatId: string, modelId: string) =>
    set((state) => ({
      chatModels: { ...state.chatModels, [chatId]: modelId },
    })),

  setChatStreaming: (chatId: string, streaming: boolean) =>
    set((state) => ({
      streamingChats: { ...state.streamingChats, [chatId]: streaming },
    })),

  setChatStatus: (chatId: string, status: string | null) =>
    set((state) => ({
      chatStatus: { ...state.chatStatus, [chatId]: status },
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
    // Called on every streamed chunk. Only rebuild the affected chat and do not
    // touch updatedAt, so the sidebar/list doesn't re-render per token.
    set((state) => ({
      chats: state.chats.map((chat) =>
        chat.id === chatId
          ? {
              ...chat,
              messages: chat.messages.map((msg) =>
                msg.id === messageId ? { ...msg, content } : msg
              ),
            }
          : chat
      ),
    }));
  },

  updateMessageSources: (chatId: string, messageId: string, sources: Source[]) => {
    set((state) => ({
      chats: state.chats.map((chat) =>
        chat.id === chatId
          ? {
              ...chat,
              messages: chat.messages.map((msg) =>
                msg.id === messageId ? { ...msg, sources } : msg
              ),
            }
          : chat
      ),
    }));
  },

  setLoading: (loading: boolean) => set({ isLoading: loading }),
  setError: (error: string | null, code?: string | null) =>
    set({ error, errorCode: error ? (code ?? null) : null }),
  dismissError: () => set({ error: null, errorCode: null }),

  getCurrentChat: () => {
    const { chats, currentChatId } = get();
    return chats.find((chat) => chat.id === currentChatId);
  },
}));