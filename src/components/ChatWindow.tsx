'use client';

import { useState, useRef, useEffect, useCallback, useMemo, memo } from 'react';
import { useChatStore } from '@/lib/store';
import { INTERRUPT_SUFFIX, type Message } from '@/lib/types';
import { ApiError, extractCode, hintFor } from '@/lib/chatError';
import { parseSseLine } from '@/lib/sse';
import { MarkdownMessage } from './MarkdownMessage';
import { MessageSkeleton } from './Skeleton';

interface ChatWindowProps {
  className?: string;
}

// If no bytes arrive for this long, give up waiting on the current connection
// and switch to the resume stream (the server keeps generating regardless, so
// nothing is lost — we just follow it over the reconnect endpoint instead).
const STREAM_STALL_MS = 150_000;
// Cap the automatic reconnects to the resume stream before showing an error.
const MAX_FOLLOW_ATTEMPTS = 12;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const backoffMs = (attempt: number) => Math.min(30_000, 1000 * 2 ** (attempt - 1));

// Resumed-generation marker so after a real page reload we know to re-attach
// to a generation that may still be running server-side.
const RESUME_FLAG_KEY = 'bleep_resume_chat';

function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}.${Math.floor((ms % 1000) / 100)}s`;
}

function setResumeFlag(chatId: string | null) {
  try {
    if (chatId) localStorage.setItem(RESUME_FLAG_KEY, chatId);
    else localStorage.removeItem(RESUME_FLAG_KEY);
  } catch {
    // storage unavailable — resume-on-reload is best-effort
  }
}

export function ChatWindow({ className = '' }: ChatWindowProps) {
  const currentChatId = useChatStore((s) => s.currentChatId);
  const addMessage = useChatStore((s) => s.addMessage);
  const updateMessage = useChatStore((s) => s.updateMessage);
  const updateMessageSources = useChatStore((s) => s.updateMessageSources);
  const setLoading = useChatStore((s) => s.setLoading);
  const setError = useChatStore((s) => s.setError);
  const dismissError = useChatStore((s) => s.dismissError);
  const resolveChatId = useChatStore((s) => s.resolveChatId);
  const error = useChatStore((s) => s.error);
  const errorCode = useChatStore((s) => s.errorCode);
  const localStatus = useChatStore((s) => s.localStatus);
  const models = useChatStore((s) => s.models);
  const modelsLoading = useChatStore((s) => s.modelsLoading);
  const getModelForChat = useChatStore((s) => s.getModelForChat);
  const setChatModel = useChatStore((s) => s.setChatModel);
  const streamingChats = useChatStore((s) => s.streamingChats);
  const chatStatus = useChatStore((s) => s.chatStatus);
  const setChatStreaming = useChatStore((s) => s.setChatStreaming);
  const setChatStatus = useChatStore((s) => s.setChatStatus);
  const messagesLoading = useChatStore((s) => s.messagesLoading);
  const [inputValue, setInputValue] = useState('');
  const [liveElapsed, setLiveElapsed] = useState(0);
  const [messageDurations, setMessageDurations] = useState<Record<string, number>>({});
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Abort handle for the in-flight request, plus a flag that distinguishes a
  // user stop from a network failure so we never auto-retry a stopped answer.
  const abortRef = useRef<AbortController | null>(null);
  const userStoppedRef = useRef(false);
  const startTimeRef = useRef<number | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Subscribe REACTIVELY to the current chat so a re-render fires on every
  // token during streaming. (A non-reactive getCurrentChat() read here would
  // mutate state without repainting, making the answer appear all at once.)
  const chat = useChatStore((s) =>
    s.chats.find((c) => c.id === s.currentChatId)
  );
  const messages = useMemo(() => chat?.messages || [], [chat]);
  const selectedModel = currentChatId ? getModelForChat(currentChatId) : undefined;
  // Streaming is tracked per chat, so an in-flight answer in one chat never
  // blocks sending in another.
  const isStreaming = currentChatId ? Boolean(streamingChats[currentChatId]) : false;
  const statusText = currentChatId ? chatStatus[currentChatId] ?? null : null;
  // A chat with no messages yet may still be fetching its thread from the server.
  const isMessagesLoading = currentChatId
    ? Boolean(messagesLoading[currentChatId]) && messages.length === 0
    : false;

  const selectedModelInfo = models.find((m) => m.id === selectedModel);
  const contextWindow = selectedModelInfo?.contextWindow ?? 8192;
  const usedTokens = messages.reduce(
    (sum, m) => sum + Math.ceil(m.content.length / 4) + 4,
    0
  );

  const localModels = models.filter((m) => m.provider === 'local');
  const cloudModels = models.filter((m) => m.provider === 'openrouter');

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  const startTimer = useCallback(() => {
    startTimeRef.current = Date.now();
    setLiveElapsed(0);
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = setInterval(() => {
      if (startTimeRef.current) setLiveElapsed(Date.now() - startTimeRef.current);
    }, 200);
  }, []);

  const stopTimer = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
    const duration = startTimeRef.current ? Date.now() - startTimeRef.current : 0;
    startTimeRef.current = null;
    setLiveElapsed(0);
    return duration;
  }, []);

  // Re-attach to a generation that may still be running server-side (internet
  // blip, or a reload during generation). Reads /api/chats/:id/events which
  // first reports whether the generation is active, then replays live chunks.
  const followGeneration = useCallback(
    async (chatId: string, answerId: string, onContent: (content: string) => void): Promise<boolean> => {
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        for (let attempt = 1; attempt <= MAX_FOLLOW_ATTEMPTS; attempt++) {
          if (userStoppedRef.current) return false;
          try {
            const res = await fetch(`/api/chats/${chatId}/events`, { signal: controller.signal });
            if (!res.ok) {
              const err = new Error(`Failed to reconnect (${res.status})`) as Error & { status?: number };
              err.status = res.status;
              throw err;
            }
            const reader = res.body?.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            if (reader) {
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';
                for (const line of lines) {
                  const parsed = parseSseLine<{
                    type?: string;
                    active?: boolean;
                    content?: string;
                    text?: string;
                    message?: string;
                    messageId?: string;
                    code?: string;
                  }>(line);
                  if (!parsed) continue;
                  const targetId = parsed.messageId || answerId;
                  if (parsed.type === 'resume') {
                    if (parsed.active) {
                      setChatStreaming(chatId, true);
                      setChatStatus(chatId, 'Reconnected — the response is still generating');
                    }
                    if (parsed.content) {
                      onContent(parsed.content);
                      updateMessage(chatId, targetId, parsed.content);
                    }
                    continue;
                  }
                  if (parsed.type === 'content' && parsed.content) {
                    onContent(parsed.content);
                    updateMessage(chatId, targetId, parsed.content);
                    continue;
                  }
                  if (parsed.type === 'interrupted') {
                    const content = parsed.content ?? '';
                    if (content) {
                      onContent(content);
                      updateMessage(chatId, targetId, content);
                    }
                    return true;
                  }
                  if (parsed.type === 'done') {
                    if (parsed.content) {
                      onContent(parsed.content);
                      updateMessage(chatId, targetId, parsed.content);
                    }
                    return true;
                  }
                  if (parsed.type === 'error') {
                    const err = new ApiError(
                      parsed.message || 'The generation failed',
                      parsed.code || 'upstream_error',
                      400
                    );
                    throw err;
                  }
                }
              }
              return true;
            }
            return true;
          } catch (error) {
            if (userStoppedRef.current) return false;
            // A genuine app error (400/404…) is not a blip — surface it.
            const status = (error as { status?: number }).status;
            const networkish =
              status === undefined ||
              status === 408 ||
              status === 502 ||
              status === 503 ||
              status === 504 ||
              error instanceof TypeError;
            if (!networkish) {
              setError(
                error instanceof Error ? error.message : 'The generation failed',
                extractCode(error, 'internal')
              );
              return false;
            }
            if (attempt < MAX_FOLLOW_ATTEMPTS) {
              setChatStatus(chatId, `Reconnecting to the response (attempt ${attempt})…`);
              await sleep(backoffMs(attempt));
            }
          }
        }
      } finally {
        controller.abort();
      }
      setChatStatus(chatId, 'The server is still saving this response — you can reload the page to see it.');
      return false;
    },
    [setChatStatus, setError, setChatStreaming, updateMessage]
  );

  // Probe once for a possibly-still-running generation when this chat loads
  // (only if the previous session flagged it as interrupted mid-generation).
  useEffect(() => {
    let cancelled = false;
    const chatId = currentChatId;
    let flagValue: string | null = null;
    try {
      flagValue = localStorage.getItem(RESUME_FLAG_KEY);
    } catch {
      flagValue = null;
    }
    if (!chatId || flagValue !== chatId) return;
    (async () => {
      await followGeneration(chatId, '', () => {});
      if (!cancelled) setResumeFlag(null);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentChatId]);

  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputValue.trim() || !currentChatId || isStreaming) return;

    const rawChatId = currentChatId;
    const userMessage = inputValue.trim();
    setInputValue('');
    setChatStreaming(rawChatId, true);
    setChatStatus(rawChatId, null);
    setLoading(true);
    setError(null);
    setResumeFlag(rawChatId);

    addMessage(rawChatId, { role: 'user', content: userMessage });

    // A brand-new chat is created optimistically; wait for its real server id
    // before talking to the API. Existing chats resolve instantly.
    const chatId = await resolveChatId(rawChatId);
    setResumeFlag(chatId);

    // Build the request from history *before* adding the empty assistant
    // placeholder, so the server sees the user message as the last turn.
    const chatHistory =
      useChatStore.getState().chats.find((c) => c.id === chatId)?.messages || [];
    const formattedMessages = chatHistory.map((msg) => ({
      role: msg.role,
      content: msg.content,
    }));

    const assistantMessage = addMessage(chatId, { role: 'assistant', content: '' });
    const answerId = assistantMessage.id;

    userStoppedRef.current = false;
    startTimer();
    // Streamed text lives here so the stop handler can persist the partial answer.
    let fullContent = '';
    // True once a terminal event (done/interrupted/error) has been seen.
    let terminal = false;
    // True once the server replied 200 and a stream *started*. Only after this
    // point does a lost connection mean the generation is worth following on the
    // resume endpoint — a failure before the stream started is the real error
    // (e.g. model did not load) and must be shown as-is, never masked by a retry.
    let responseStarted = false;

    // Run the live generation request; on any mid-stream failure it throws so
    // the caller can fall back to the resume stream.
    const streamRequest = async () => {
      const body: Record<string, unknown> = {
        messages: formattedMessages,
        stream: true,
        chatId,
        assistantMessageId: answerId,
      };
      if (selectedModel) body.model = selectedModel;

      const controller = new AbortController();
      abortRef.current = controller;
      let stallTimer: ReturnType<typeof setTimeout> | undefined;
      const armStallWatchdog = () => {
        if (stallTimer) clearTimeout(stallTimer);
        stallTimer = setTimeout(() => controller.abort(), STREAM_STALL_MS);
      };
      armStallWatchdog();

      try {
        const response = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        if (!response.ok) {
          let message = `API error: ${response.status}`;
          let code: string | undefined;
          try {
            const data = await response.json();
            if (data?.error) message = data.error;
            if (data?.code) code = data.code;
          } catch {
            // response body is not JSON (proxy/tunnel error) — fall through
          }
          throw new ApiError(
            message,
            code || (response.status === 504 || response.status === 408 ? 'timeout' : 'upstream_error'),
            response.status
          );
        }
        // A stream is now guaranteed to start server-side; from here on a
        // failure is a mid-stream loss that the resume endpoint can recover.
        responseStarted = true;

        const reader = response.body?.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        if (reader) {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            // Any data means the stream is alive — reset the watchdog.
            armStallWatchdog();

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
              const parsed = parseSseLine<{
                type?: string;
                content?: string;
                text?: string;
                message?: string;
                code?: string;
                sources?: { title: string; url: string }[];
              }>(line);
              if (!parsed) continue;

              if (parsed.type === 'status' && parsed.text) {
                setChatStatus(chatId, parsed.text);
                continue;
              }
              if (parsed.type === 'sources' && parsed.sources) {
                updateMessageSources(chatId, answerId, parsed.sources);
                continue;
              }
              if (parsed.type === 'error') {
                const error = new ApiError(
                  parsed.message || 'The agent encountered an error',
                  parsed.code || 'upstream_error',
                  502
                );
                throw error;
              }
              if (parsed.type === 'content' && parsed.content) {
                fullContent += parsed.content;
                updateMessage(chatId, answerId, fullContent);
                setChatStatus(chatId, null);
                continue;
              }
              if (parsed.type === 'interrupted') {
                terminal = true;
                if (fullContent) {
                  fullContent += INTERRUPT_SUFFIX;
                  updateMessage(chatId, answerId, fullContent);
                }
                setChatStreaming(chatId, false);
                setLoading(false);
                setChatStatus(chatId, null);
                continue;
              }
              if (parsed.type === 'done') {
                terminal = true;
                setChatStreaming(chatId, false);
                setLoading(false);
                setChatStatus(chatId, null);
              }
            }
          }
        }

        // The stream ended without a terminal event. With the keep-alive
        // generation this normally means the connection died — switch to the
        // resume stream so the response is never lost.
        if (!terminal) {
          const error = new Error(
            'The response was cut off. Reconnecting to continue it…'
          ) as Error & { status?: number };
          error.status = 408;
          throw error;
        }
      } finally {
        if (stallTimer) clearTimeout(stallTimer);
      }
    };

    try {
      try {
        await streamRequest();
        setError(null);
        terminal = true;
      } catch (error) {
        if (userStoppedRef.current) throw error;

        const status = (error as { status?: number }).status;
        const retryable =
          status === undefined || status === 408 || status === 502 || status === 503 || status === 504;

        // Mid-stream loss is worth following on the resume endpoint. But a
        // failure before the stream ever started (e.g. the model failed to
        // load) must be surfaced as-is — jumping into followGeneration would
        // mask the real error and read as an endless "reconnecting" loop.
        if (!retryable || !responseStarted) throw error;

        // The server keeps generating and saving even though we lost the
        // connection — follow the persisted state instead of restarting.
        const abortedError = error instanceof DOMException && error.name === 'AbortError';
        if (!abortedError) {
          setChatStatus(chatId, 'Connection lost — reconnecting…');
        }
        const followed = await followGeneration(chatId, answerId, (content) => {
          fullContent = content;
        });
        if (!followed && !userStoppedRef.current) {
          setError(
            'Lost connection to the server. The response is being saved — reload to view it.',
            'connection_failed'
          );
        } else {
          terminal = true;
        }
      }
    } catch (error) {
      if (!userStoppedRef.current) {
        console.error('Send message error:', error);
        const aborted = error instanceof DOMException && error.name === 'AbortError';
        if (aborted) {
          setError('The response stalled and was stopped. Please try again.', 'timeout');
        } else {
          const status = (error as { status?: number }).status;
          const code = extractCode(
            error,
            error instanceof TypeError
              ? 'connection_failed'
              : status === 504 || status === 408
                ? 'timeout'
                : 'connection_failed'
          );
          setError(error instanceof Error ? error.message : 'Failed to send message', code);
        }
      }
    } finally {
      const durationMs = stopTimer();
      // Non-reactive read of the freshest streamed content from the store.
      const liveMessages = () =>
        useChatStore.getState().chats.find((c) => c.id === chatId)?.messages ?? [];
      if (userStoppedRef.current) {
        const current = liveMessages().find((m) => m.id === answerId)?.content ?? fullContent;
        const content = current || fullContent;
        const final = content.includes(INTERRUPT_SUFFIX)
          ? content
          : content
            ? content + INTERRUPT_SUFFIX
            : INTERRUPT_SUFFIX.trim();
        updateMessage(chatId, answerId, final);
        userStoppedRef.current = false;
      }
      const finalMessage = liveMessages().find((m) => m.id === answerId);
      if (finalMessage && finalMessage.content.trim()) {
        setMessageDurations((d) => ({ ...d, [answerId]: durationMs }));
      }
      if (terminal) setResumeFlag(null);
      abortRef.current = null;
      setChatStreaming(chatId, false);
      setLoading(false);
      setChatStatus(chatId, null);
    }
  };

  const handleStop = () => {
    if (!currentChatId) return;
    userStoppedRef.current = true;
    // The server only stops on an explicit signal — tell it to halt generation.
    fetch('/api/chat/stop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatId: currentChatId }),
    }).catch(() => {});
    abortRef.current?.abort();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage(e);
    }
  };

  const adjustHeight = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const textarea = e.target;
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`;
  };

  if (!currentChatId) {
    return (
      <div className={`flex flex-col h-full ${className}`}>
        <div className="flex-1 flex items-center justify-center text-muted-foreground p-6">
          <div className="text-center space-y-4">
            <svg className="mx-auto h-16 w-16 text-muted-foreground/50" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
            </svg>
            <div>
              <h2 className="text-xl font-semibold">Welcome to Bleep AI</h2>
              <p className="text-sm mt-1">Start a new conversation to begin chatting</p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={`flex flex-col h-full min-h-0 ${className}`}>
      <div className="flex-1 overflow-y-auto px-3 py-4 sm:px-4 space-y-4 sm:space-y-6">
        <div className="max-w-3xl mx-auto w-full space-y-4 sm:space-y-6">
          {error && (
            <div
              role="alert"
              className="w-full rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-3 flex items-start gap-3"
            >
              <svg className="w-5 h-5 mt-0.5 text-destructive shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
              </svg>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-destructive">{hintFor(errorCode).title}</p>
                <p className="text-sm text-foreground/90 mt-0.5">{error}</p>
                <p className="text-xs text-muted-foreground mt-0.5">{hintFor(errorCode).hint}</p>
              </div>
              <button
                type="button"
                onClick={dismissError}
                className="shrink-0 text-muted-foreground hover:text-foreground p-1 -m-1"
                aria-label="Dismiss error"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          )}
          {isMessagesLoading && (
            <div role="status" aria-live="polite" className="space-y-4" aria-label="Loading conversation">
              <MessageSkeleton align="end" />
              <MessageSkeleton align="start" />
              <MessageSkeleton align="start" />
              <span className="sr-only">Loading conversation…</span>
            </div>
          )}
          <div
            key={currentChatId}
            className="max-w-3xl mx-auto w-full space-y-4 sm:space-y-6 animate-chat-thread"
          >
            {messages.map((message) => {
              const isLast = message.id === messages[messages.length - 1]?.id;
              return (
                <MessageBubble
                  key={message.id}
                  message={message}
                  durationMs={messageDurations[message.id]}
                  isStreaming={isStreaming && isLast}
                  statusText={isStreaming && isLast ? statusText : null}
                />
              );
            })}
          </div>
        </div>
        <div ref={messagesEndRef} />
      </div>

      <form onSubmit={handleSendMessage} className="border-t px-3 py-3 sm:p-4 pb-safe bg-background">
        <div className="max-w-3xl mx-auto mb-2 flex items-center gap-2">
          <label htmlFor="model-picker" className="text-xs text-muted-foreground shrink-0">
            Model
          </label>
          <select
            id="model-picker"
            value={selectedModel ?? ''}
            onChange={(e) => {
              if (currentChatId && e.target.value) setChatModel(currentChatId, e.target.value);
            }}
            disabled={isStreaming || modelsLoading}
            className="flex-1 min-w-0 h-8 px-2 text-xs sm:text-sm bg-background border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent disabled:opacity-50"
          >
            {selectedModel == null && <option value="">{modelsLoading ? 'Loading…' : 'Default'}</option>}
            {localModels.length > 0 && (
              <optgroup label="Local (Ollama)">
                {localModels.map((m) => (
                  <option key={m.id} value={m.id}>{m.name}</option>
                ))}
              </optgroup>
            )}
            {cloudModels.length > 0 && (
              <optgroup label="Free (OpenRouter)">
                {cloudModels.map((m) => (
                  <option key={m.id} value={m.id}>{m.name}{m.description ? ` — ${m.description}` : ''}</option>
                ))}
              </optgroup>
            )}
          </select>
          <ContextMeter used={usedTokens} total={contextWindow} />
        </div>
        {localStatus === 'unreachable' && selectedModel && localModels.some((m) => m.id === selectedModel) && (
          <div className="max-w-3xl mx-auto mb-2 flex items-center gap-2 text-xs text-amber-600">
            <svg className="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
            </svg>
            <span>Ollama is unreachable right now — local models may fail to respond. Try again in a minute or switch to a cloud model.</span>
          </div>
        )}
        <div className="flex items-end gap-2 max-w-3xl mx-auto">
          <textarea
            ref={textareaRef}
            value={inputValue}
            onChange={(e) => {
              setInputValue(e.target.value);
              adjustHeight(e);
            }}
            onKeyDown={handleKeyDown}
            placeholder="Type a message..."
            disabled={isStreaming}
            className="flex-1 min-h-[48px] max-h-[160px] sm:max-h-[200px] px-4 py-3 text-base bg-background border rounded-2xl resize-none focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent"
            rows={1}
          />
          {isStreaming ? (
            <button
              type="button"
              onClick={handleStop}
              className="flex-shrink-0 h-12 w-12 flex items-center justify-center bg-foreground text-background rounded-2xl hover:bg-foreground/90 active:bg-foreground/80 transition-colors"
              aria-label="Stop generating"
              title="Stop generating"
            >
              <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
                <rect x="7" y="7" width="10" height="10" rx="1.5" />
              </svg>
            </button>
          ) : (
            <button
              type="submit"
              disabled={!inputValue.trim()}
              className="flex-shrink-0 h-12 w-12 flex items-center justify-center bg-primary text-primary-foreground rounded-2xl hover:bg-primary/90 active:bg-primary/80 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              aria-label="Send message"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
              </svg>
            </button>
          )}
        </div>
        {isStreaming && (
          <p className="text-xs text-muted-foreground text-center mt-2">
            {statusText
              ? `${statusText} · ${formatDuration(liveElapsed)}`
              : `Generating response${selectedModel ? ` with ${selectedModel}` : ''}... · ${formatDuration(liveElapsed)}`}
          </p>
        )}
      </form>
    </div>
  );
}

function ContextMeter({ used, total }: { used: number; total: number }) {
  const ratio = total > 0 ? Math.min(1, used / total) : 0;
  const percent = Math.round(ratio * 100);
  const radius = 9;
  const circumference = 2 * Math.PI * radius;
  const color =
    ratio < 0.5 ? 'text-emerald-500' : ratio < 0.8 ? 'text-amber-500' : 'text-red-500';

  return (
    <div
      className="relative shrink-0 h-6 w-6"
      title={`Context: ~${used.toLocaleString()} / ${total.toLocaleString()} tokens (${percent}%)`}
      aria-label={`Context window ${percent}% used`}
      role="img"
    >
      <svg viewBox="0 0 24 24" className="h-6 w-6 -rotate-90">
        <circle cx="12" cy="12" r={radius} fill="none" strokeWidth="3" className="stroke-muted-foreground/25" />
        <circle
          cx="12"
          cy="12"
          r={radius}
          fill="none"
          strokeWidth="3"
          strokeLinecap="round"
          strokeDasharray={`${circumference * ratio} ${circumference}`}
          className={color}
          stroke="currentColor"
        />
      </svg>
      <span className="absolute inset-0 flex items-center justify-center text-[8px] font-semibold text-muted-foreground">
        {percent}
      </span>
    </div>
  );
}

// Loading indicator shown inside the assistant bubble while the model is
// busy (decision / web search / first token) but nothing has been streamed yet.
function ThinkingIndicator({ statusText }: { statusText: string | null }) {
  return (
    <div role="status" aria-live="polite" className="flex items-center gap-2 text-muted-foreground">
      <span className="flex items-center gap-1">
        {[0, 150, 300].map((delay) => (
          <span
            key={delay}
            className="w-1.5 h-1.5 rounded-full bg-current animate-bounce"
            style={{ animationDelay: `${delay}ms` }}
          />
        ))}
      </span>
      <span className="text-sm">{statusText ?? 'Thinking…'}</span>
    </div>
  );
}

// Memoized so that during streaming only the message whose content changed
// repaints — the rest of the conversation stays cached (cheap for long chats).
const MessageBubble = memo(function MessageBubble({
  message,
  isStreaming,
  durationMs,
  statusText,
}: {
  message: Message;
  isStreaming?: boolean;
  durationMs?: number;
  statusText?: string | null;
}) {
  // Before the first token lands the answer doesn't exist yet; surface a
  // loading state ("Searching the web…" when the prompt hit web search,
  // otherwise "Thinking…") instead of an empty bubble.
  const thinking = isStreaming && message.content.trim() === '';
  // While tokens are landing, let the bubble grow smoothly instead of
  // snapping on every chunk.
  const growing = isStreaming && !thinking;
  return (
    <div className={`flex gap-3 animate-message-in ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[88%] sm:max-w-[80%] rounded-2xl px-4 py-3 ${
          growing ? 'streaming-grow' : ''
        } ${
          message.role === 'user'
            ? 'bg-primary text-primary-foreground rounded-br-md'
            : 'bg-muted rounded-bl-md'
        }`}
      >
        {message.role === 'assistant' ? (
          thinking ? (
            <ThinkingIndicator statusText={statusText ?? null} />
          ) : (
            <MarkdownMessage
              key={isStreaming ? 'streaming' : 'done'}
              content={message.content}
              reveal={isStreaming}
            />
          )
        ) : (
          <div className="whitespace-pre-wrap break-words text-[15px] sm:text-base leading-relaxed">{message.content}</div>
        )}
        {message.sources && message.sources.length > 0 && (
          <div className="mt-3 pt-2 border-t border-current/20 space-y-1">
            <p className="flex items-center gap-1.5 text-xs font-semibold opacity-70">
              <svg className="w-3.5 h-3.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-4.35-4.35m1.35-5.15a6.5 6.5 0 11-13 0 6.5 6.5 0 0113 0z" />
              </svg>
              Web search · {message.sources.length} {message.sources.length === 1 ? 'source' : 'sources'}
            </p>
            {message.sources.map((source, index) => (
              <a
                key={`${source.url}-${index}`}
                href={source.url}
                target="_blank"
                rel="noopener noreferrer"
                className="block text-xs underline underline-offset-2 opacity-80 hover:opacity-100 truncate"
              >
                [{index + 1}] {source.title || source.url}
              </a>
            ))}
          </div>
        )}
        <div className="flex items-center gap-2 mt-2">
          {durationMs != null && message.role === 'assistant' && (
            <span className="text-[10px] text-muted-foreground/70 font-medium">
              took {formatDuration(durationMs)}
            </span>
          )}
          {isStreaming && !thinking && (
            <span className="inline-block w-2 h-2 bg-current opacity-50 animate-pulse" />
          )}
        </div>
      </div>
    </div>
  );
});