'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { useChatStore } from '@/lib/store';
import { INTERRUPT_SUFFIX, type Message } from '@/lib/types';
import { MarkdownMessage } from './MarkdownMessage';

interface ChatWindowProps {
  className?: string;
}

// If no bytes arrive for this long, abort the request. Vercel terminates a
// function at its max duration (default 300s), which can close the stream
// without our `done` event — this watchdog guarantees the UI recovers.
const STREAM_STALL_MS = 150_000;

export function ChatWindow({ className = '' }: ChatWindowProps) {
  const { currentChatId, getCurrentChat, addMessage, updateMessage, updateMessageSources, setLoading, setError, models, modelsLoading, getModelForChat, setChatModel, streamingChats, chatStatus, setChatStreaming, setChatStatus } = useChatStore();
  const [inputValue, setInputValue] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Abort handle for the in-flight request, plus a flag that distinguishes a
  // user stop from a network failure so we never auto-retry a stopped answer.
  const abortRef = useRef<AbortController | null>(null);
  const userStoppedRef = useRef(false);

  const chat = getCurrentChat();
  const messages = chat?.messages || [];
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

    addMessage(chatId, { role: 'user', content: userMessage });

    // Build the request from history *before* adding the empty assistant
    // placeholder, so the server sees the user message as the last turn.
    const chatHistory = getCurrentChat()?.messages || [];
    const formattedMessages = chatHistory.map((msg) => ({
      role: msg.role,
      content: msg.content,
    }));

    const assistantMessage = addMessage(chatId, { role: 'assistant', content: '' });

    userStoppedRef.current = false;
    // Streamed text lives here so the stop handler can persist the partial answer.
    let fullContent = '';

    const streamResponse = async () => {
      fullContent = '';
      const body: Record<string, unknown> = {
        messages: formattedMessages,
        stream: true,
        chatId,
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

      let finished = false;
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
                updateMessageSources(chatId, assistantMessage.id, parsed.sources);
                continue;
              }
              if (parsed.type === 'error') {
                const error = new Error(parsed.message || 'The agent encountered an error') as Error & { status?: number };
                error.status = 400;
                throw error;
              }
              if (parsed.type === 'content' && parsed.content) {
                fullContent += parsed.content;
                updateMessage(chatId, assistantMessage.id, fullContent);
                setChatStatus(chatId, null);
                continue;
              }
              if (parsed.type === 'interrupted') {
                finished = true;
                if (fullContent) {
                  fullContent += INTERRUPT_SUFFIX;
                  updateMessage(chatId, assistantMessage.id, fullContent);
                }
                setChatStreaming(chatId, false);
                setLoading(false);
                setChatStatus(chatId, null);
                continue;
              }
              if (parsed.type === 'done') {
                finished = true;
                setChatStreaming(chatId, false);
                setLoading(false);
                setChatStatus(chatId, null);
              }
            }
          }
        }

        // The stream ended without a `done` event (serverless timeout, dropped
        // connection, or a hung proxy). Surface it instead of freezing the UI.
        if (!finished) {
          const error = new Error(
            'The response was cut off before it finished. Please try again.'
          ) as Error & { status?: number };
          error.status = 408;
          throw error;
        }
      } finally {
        if (stallTimer) clearTimeout(stallTimer);
      }
    };

    const maxAttempts = 3;
    try {
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        // The user may have stopped while we were waiting to retry.
        if (userStoppedRef.current) break;
        try {
          await streamResponse();
          setError(null);
          break;
        } catch (error) {
          // A user stop is intentional — keep the partial answer, never retry.
          if (userStoppedRef.current) break;

          const status = (error as { status?: number }).status;
          const retryable =
            status === undefined || status === 408 || status === 502 || status === 503 || status === 504;

          if (retryable && attempt < maxAttempts) {
            setChatStatus(chatId, 'Waking the model, this can take up to a minute…');
            await new Promise((resolve) => setTimeout(resolve, 3000));
            continue;
          }

          throw error;
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
      if (userStoppedRef.current) {
        updateMessage(
          chatId,
          assistantMessage.id,
          fullContent ? fullContent + INTERRUPT_SUFFIX : INTERRUPT_SUFFIX.trim()
        );
        userStoppedRef.current = false;
      }
      abortRef.current = null;
      setChatStreaming(chatId, false);
      setLoading(false);
      setChatStatus(chatId, null);
    }
  };

  const handleStop = () => {
    if (!abortRef.current) return;
    userStoppedRef.current = true;
    abortRef.current.abort();
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
            <MessageBubble key={message.id} message={message} isStreaming={isStreaming && message.id === messages[messages.length - 1]?.id} />
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
              ? statusText
              : `Generating response${selectedModel ? ` with ${selectedModel}` : ''}...`}
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

function MessageBubble({ message, isStreaming }: { message: Message; isStreaming?: boolean }) {
  return (
    <div className={`flex gap-3 ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[88%] sm:max-w-[80%] rounded-2xl px-4 py-3 ${
          message.role === 'user'
            ? 'bg-primary text-primary-foreground rounded-br-md'
            : 'bg-muted rounded-bl-md'
        }`}
      >
        {message.role === 'assistant' ? (
          <MarkdownMessage content={message.content} />
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
        {isStreaming && (
          <span className="inline-block w-2 h-2 bg-current opacity-50 animate-pulse ml-1" />
        )}
      </div>
    </div>
  );
}