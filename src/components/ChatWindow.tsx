'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { useChatStore } from '@/lib/store';
import type { Message } from '@/lib/types';

interface ChatWindowProps {
  className?: string;
}

export function ChatWindow({ className = '' }: ChatWindowProps) {
  const { currentChatId, getCurrentChat, addMessage, updateMessage, setLoading, setError } = useChatStore();
  const [inputValue, setInputValue] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const chat = getCurrentChat();
  const messages = chat?.messages || [];

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputValue.trim() || !currentChatId || isStreaming) return;

    const userMessage = inputValue.trim();
    setInputValue('');
    setIsStreaming(true);
    setLoading(true);
    setError(null);

    addMessage(currentChatId, { role: 'user', content: userMessage });
    const assistantMessage = addMessage(currentChatId, { role: 'assistant', content: '' });

    const chatHistory = getCurrentChat()?.messages || [];
    const formattedMessages = chatHistory.map((msg) => ({
      role: msg.role,
      content: msg.content,
    }));

    const streamResponse = async () => {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: formattedMessages, stream: true, chatId: currentChatId }),
      });

      if (!response.ok) {
        const error = new Error(`API error: ${response.status}`) as Error & { status?: number };
        error.status = response.status;
        throw error;
      }

      const reader = response.body?.getReader();
      const decoder = new TextDecoder();
      let fullContent = '';

      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const chunk = decoder.decode(value, { stream: true });
          const lines = chunk.split('\n');

          for (const line of lines) {
            if (line.trim()) {
              try {
                const parsed = JSON.parse(line);
                fullContent += parsed.content;
                updateMessage(currentChatId, assistantMessage.id, fullContent);
                if (parsed.done) {
                  setIsStreaming(false);
                  setLoading(false);
                }
              } catch (e) {
                console.error('Parse error:', e);
              }
            }
          }
        }
      }
    };

    const maxAttempts = 3;
    try {
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          await streamResponse();
          setError(null);
          break;
        } catch (error) {
          const status = (error as { status?: number }).status;
          const retryable = status === undefined || status === 502 || status === 503 || status === 504;

          if (retryable && attempt < maxAttempts) {
            setError('Waking the local model, this can take up to a minute…');
            await new Promise((resolve) => setTimeout(resolve, 3000));
            continue;
          }

          throw error;
        }
      }
    } catch (error) {
      console.error('Send message error:', error);
      const status = (error as { status?: number }).status;
      setError(
        status === 504
          ? 'The local model took too long to wake up. Please try again.'
          : error instanceof Error
            ? error.message
            : 'Failed to send message'
      );
      setIsStreaming(false);
      setLoading(false);
    }
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
          <button
            type="submit"
            disabled={!inputValue.trim() || isStreaming}
            className="flex-shrink-0 h-12 w-12 flex items-center justify-center bg-primary text-primary-foreground rounded-2xl hover:bg-primary/90 active:bg-primary/80 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            aria-label="Send message"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
            </svg>
          </button>
        </div>
        {isStreaming && (
          <p className="text-xs text-muted-foreground text-center mt-2">Generating response...</p>
        )}
      </form>
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
        <div className="whitespace-pre-wrap break-words text-[15px] sm:text-base leading-relaxed">{message.content}</div>
        {isStreaming && (
          <span className="inline-block w-2 h-2 bg-current opacity-50 animate-pulse ml-1" />
        )}
      </div>
    </div>
  );
}