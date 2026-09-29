'use client';

import { create } from 'zustand';
import type { Attachment, Chat, Message, Source } from '@/lib/types';
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
  // Files uploaded for each chat, newest last. Entries with no messageId are
  // still waiting to be sent and show up as chips in the composer; the rest
  // belong to a turn already in the thread.
  chatAttachments: Record<string, Attachment[]>;
  // Optimistic "New Chat": a temp chat shows instantly while the POST is in
  // flight. This maps the temp id to a promise that resolves to the real id.
  pendingCreates: Record<string, Promise<string>>;
  loadChats: () => Promise<void>;
  loadMessages: (chatId: string) => Promise<void>;
  loadAttachments: (chatId: string) => Promise<void>;
  loadModels: () => Promise<void>;
  createChat: () => Promise<string>;
  resolveChatId: (chatId: string) => Promise<string>;
  deleteChat: (id: string) => Promise<void>;
  setCurrentChat: (id: string) => void;
  getModelForChat: (chatId: string) => string | undefined;
  setChatModel: (chatId: string, modelId: string) => void;
  setChatStreaming: (chatId: string, streaming: boolean) => void;
  setChatStatus: (chatId: string, status: string | null) => void;
  setChatTitle: (chatId: string, title: string) => void;
  addMessage: (chatId: string, message: Omit<Message, 'id' | 'timestamp'>) => Message;
  updateMessage: (chatId: string, messageId: string, content: string) => void;
  updateMessageSources: (chatId: string, messageId: string, sources: Source[]) => void;
  addAttachment: (chatId: string, attachment: Attachment) => void;
  removeAttachment: (chatId: string, attachmentId: string) => void;
  // Mirror the server binding a freshly-sent turn to the files that were still
  // unbound, so the chips leave the composer and land on the message bubble.
  bindAttachments: (chatId: string, messageId: string) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null, code?: string | null) => void;
  dismissError: () => void;
  getCurrentChat: () => Chat | undefined;
}

// JSON always carries ISO strings; the client-facing types use Date.
type WireAttachment = Omit<Attachment, 'createdAt'> & { createdAt: string };

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
    attachments?: WireAttachment[];
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
      ...(m.attachments && m.attachments.length > 0
        ? { attachments: m.attachments.map((a) => ({ ...a, createdAt: new Date(a.createdAt) })) }
        : {}),
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
  chatAttachments: {},
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
    // Files are a separate list: the thread response only carries the ones
    // already bound to a message, but the composer also needs files that were
    // uploaded and not yet sent (a reload mid-compose).
    void get().loadAttachments(chatId);
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

  loadAttachments: async (chatId: string) => {
    try {
      const res = await fetch(`/api/attachments?chatId=${encodeURIComponent(chatId)}`);
      if (!res.ok) return;
      const data = await res.json();
      const attachments: Attachment[] = (
        (data.attachments ?? []) as WireAttachment[]
      ).map((a) => ({ ...a, createdAt: new Date(a.createdAt) }));
      set((state) => ({
        chatAttachments: { ...state.chatAttachments, [chatId]: attachments },
      }));
    } catch {
      // Attachment list is supplementary — a failure here must not break the
      // conversation, so leave whatever is already in state.
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
          chatAttachments: remap(state.chatAttachments),
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
    const dropLocal = (state: ChatStore) => ({
      chats: state.chats.filter((chat) => chat.id !== chatId && chat.id !== id),
      currentChatId:
        state.currentChatId === chatId || state.currentChatId === id
          ? null
          : state.currentChatId,
      chatAttachments: { ...state.chatAttachments, [chatId]: [] },
    });
    if (get().pendingCreates[id] === undefined && id.startsWith('temp-')) {
      set(dropLocal);
      return;
    }
    const res = await fetch(`/api/chats/${chatId}`, { method: 'DELETE' });
    if (!res.ok) throw new Error('Failed to delete chat');
    // The server removes the chats' messages and attachments with it.
    set(dropLocal);
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

  // The real title arrives from the server as a `title` SSE event (or the
  // resume snapshot). Only the title is touched — messages, updatedAt and the
  // sidebar sort order stay put.
  setChatTitle: (chatId: string, title: string) =>
    set((state) => ({
      chats: state.chats.map((chat) =>
        chat.id === chatId && chat.title !== title ? { ...chat, title } : chat
      ),
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
              // No placeholder title: the title is decided server-side on the
              // first user message, so the UI keeps "New Chat" until the
              // sub-agent title arrives and setChatTitle applies it.
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

  addAttachment: (chatId: string, attachment: Attachment) =>
    set((state) => {
      const list = state.chatAttachments[chatId] ?? [];
      // Re-uploading the same file (a retry) must not duplicate the chip.
      if (list.some((a) => a.id === attachment.id)) return state;
      return {
        chatAttachments: { ...state.chatAttachments, [chatId]: [...list, attachment] },
      };
    }),

  removeAttachment: (chatId: string, attachmentId: string) =>
    set((state) => ({
      chatAttachments: {
        ...state.chatAttachments,
        [chatId]: (state.chatAttachments[chatId] ?? []).filter(
          (a) => a.id !== attachmentId
        ),
      },
    })),

  bindAttachments: (chatId: string, messageId: string) =>
    set((state) => {
      const list = state.chatAttachments[chatId];
      if (!list?.some((a) => !a.messageId)) return state;
      return {
        chatAttachments: {
          ...state.chatAttachments,
          [chatId]: list.map((a) => (a.messageId ? a : { ...a, messageId })),
        },
      };
    }),

  setLoading: (loading: boolean) => set({ isLoading: loading }),
  setError: (error: string | null, code?: string | null) =>
    set({ error, errorCode: error ? (code ?? null) : null }),
  dismissError: () => set({ error: null, errorCode: null }),

  getCurrentChat: () => {
    const { chats, currentChatId } = get();
    return chats.find((chat) => chat.id === currentChatId);
  },
}));