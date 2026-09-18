'use client';

import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { useChatStore } from '@/lib/store';
import { INTERRUPT_SUFFIX, type Message } from '@/lib/types';
import { MarkdownMessage } from './MarkdownMessage';

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
  const { currentChatId, getCurrentChat, addMessage, updateMessage, updateMessageSources, setLoading, setError, models, modelsLoading, getModelForChat, setChatModel, streamingChats, chatStatus, setChatStreaming, setChatStatus } = useChatStore();
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

  const chat = getCurrentChat();
  const messages = useMemo(() => chat?.messages || [], [chat]);
  const selectedModel = currentChatId ? getModelForChat(currentChatId) : undefined;
  // Streaming is tracked per chat, so an in-flight answer in one chat never
  // blocks sending in another.
  const isStreaming = currentChatId ? Boolean(streamingChats[currentChatId]) : false;
  const statusText = currentChatId ? chatStatus[currentChatId] ?? null : null;

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
                  if (!line.trim()) continue;
                  let parsed: {
                    type?: string;
                    active?: boolean;
                    content?: string;
                    text?: string;
                    message?: string;
                    messageId?: string;
                  };
                  try {
                    parsed = JSON.parse(line);
                  } catch {
                    continue;
                  }
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
                    const err = new Error(parsed.message || 'The generation failed') as Error & { status?: number };
                    err.status = 400;
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
              if (error instanceof Error) setError(error.message);
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

    const chatId = currentChatId;
    const userMessage = inputValue.trim();
    setInputValue('');
    setChatStreaming(chatId, true);
    setChatStatus(chatId, null);
    setLoading(true);
    setError(null);
    setResumeFlag(chatId);

    addMessage(chatId, { role: 'user', content: userMessage });

    // Build the request from history *before* adding the empty assistant
    // placeholder, so the server sees the user message as the last turn.
    const chatHistory = getCurrentChat()?.messages || [];
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
          const error = new Error(`API error: ${response.status}`) as Error & { status?: number };
          error.status = response.status;
          throw error;
        }

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
              if (!line.trim()) continue;

              let parsed: {
                type?: string;
                content?: string;
                text?: string;
                message?: string;
                sources?: { title: string; url: string }[];
              };
              try {
                parsed = JSON.parse(line);
              } catch (e) {
                console.error('Parse error:', e);
                continue;
              }

              if (parsed.type === 'status' && parsed.text) {
                setChatStatus(chatId, parsed.text);
                continue;
              }
              if (parsed.type === 'sources' && parsed.sources) {
                updateMessageSources(chatId, answerId, parsed.sources);
                continue;
              }
              if (parsed.type === 'error') {
                const error = new Error(parsed.message || 'The agent encountered an error') as Error & { status?: number };
                error.status = 400;
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

        if (!retryable) throw error;

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
          setError('Lost connection to the server. The response is being saved — reload to view it.');
        } else {
          terminal = true;
        }
      }
    } catch (error) {
      if (!userStoppedRef.current) {
        console.error('Send message error:', error);
        const status = (error as { status?: number }).status;
        const aborted = error instanceof DOMException && error.name === 'AbortError';
        setError(
          aborted
            ? 'The response stalled and was stopped. Please try again.'
            : status === 504
              ? 'The model took too long to respond. Please try again.'
              : error instanceof Error
                ? error.message
                : 'Failed to send message'
        );
      }
    } finally {
      const durationMs = stopTimer();
      if (userStoppedRef.current) {
        const current = getCurrentChat()?.messages.find((m) => m.id === answerId)?.content ?? fullContent;
        const content = current || fullContent;
        const final = content.includes(INTERRUPT_SUFFIX)
          ? content
          : content
            ? content + INTERRUPT_SUFFIX
            : INTERRUPT_SUFFIX.trim();
        updateMessage(chatId, answerId, final);
        userStoppedRef.current = false;
      }
      const finalMessage = getCurrentChat()?.messages.find((m) => m.id === answerId);
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
          {messages.map((message) => (
            <MessageBubble
              key={message.id}
              message={message}
              durationMs={messageDurations[message.id]}
              isStreaming={isStreaming && message.id === messages[messages.length - 1]?.id}
            />
          ))}
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

function MessageBubble({ message, isStreaming, durationMs }: { message: Message; isStreaming?: boolean; durationMs?: number }) {
  return (
    <div className={`flex gap-3 animate-message-in ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[88%] sm:max-w-[80%] rounded-2xl px-4 py-3 ${
          message.role === 'user'
            ? 'bg-primary text-primary-foreground rounded-br-md'
            : 'bg-muted rounded-bl-md'
        }`}
      >
        {message.role === 'assistant' ? (
          <MarkdownMessage content={message.content} reveal={isStreaming} />
        ) : (
          <div className="whitespace-pre-wrap break-words text-[15px] sm:text-base leading-relaxed">{message.content}</div>
        )}
        {message.sources && message.sources.length > 0 && (
          <div className="mt-3 pt-2 border-t border-current/20 space-y-1">
            <p className="text-xs font-semibold opacity-70">Sources</p>
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
          {isStreaming && (
            <span className="inline-block w-2 h-2 bg-current opacity-50 animate-pulse" />
          )}
        </div>
      </div>
    </div>
  );
}