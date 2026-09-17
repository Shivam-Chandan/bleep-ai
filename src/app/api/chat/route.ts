import { NextRequest, NextResponse } from 'next/server';
import type { OllamaRequest, OllamaResponse } from '@/lib/types';
import { OLLAMA_BASE_URL, OLLAMA_MODEL, ollamaAuthHeader } from '@/lib/ollama';
import { requireSession } from '@/lib/auth';
import { addMessage, userOwnsChat } from '@/lib/queries';

const DEFAULT_MODEL = OLLAMA_MODEL;

export async function POST(request: NextRequest) {
  const auth = await requireSession();
  if (auth instanceof NextResponse) return auth;

  try {
    const body = await request.json();
    const {
      messages,
      model = DEFAULT_MODEL,
      stream = true,
      options,
      chatId,
    } = body as OllamaRequest & { chatId?: string };

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return NextResponse.json({ error: 'Messages are required' }, { status: 400 });
    }

    // If a chatId is supplied, it must belong to the logged-in user.
    if (chatId && !userOwnsChat(auth.userId, chatId)) {
      return NextResponse.json({ error: 'Chat not found' }, { status: 404 });
    }

    // Persist the latest user message before calling the model.
    if (chatId) {
      const last = messages[messages.length - 1];
      if (last?.role === 'user') {
        addMessage(chatId, 'user', last.content);
      }
    }

    const ollamaRequest: OllamaRequest = {
      model,
      messages: messages.map((msg) => ({ role: msg.role, content: msg.content })),
      stream,
      keep_alive: -1,
      options: {
        temperature: 0.7,
        top_p: 0.9,
        num_predict: 2048,
        ...options,
      },
    };

    const response = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...ollamaAuthHeader(),
      },
      body: JSON.stringify(ollamaRequest),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Ollama API error:', response.status, errorText);
      return NextResponse.json(
        { error: `Ollama API error: ${response.status} ${errorText}` },
        { status: response.status }
      );
    }

    if (stream) {
      const encoder = new TextEncoder();
      const readable = new ReadableStream({
        async start(controller) {
          const reader = response.body?.getReader();
          if (!reader) {
            controller.close();
            return;
          }

          const decoder = new TextDecoder();
          let buffer = '';
          let assistantContent = '';

          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;

              buffer += decoder.decode(value, { stream: true });
              const lines = buffer.split('\n');
              buffer = lines.pop() || '';

              for (const line of lines) {
                if (line.trim()) {
                  try {
                    const data: OllamaResponse = JSON.parse(line);
                    assistantContent += data.message.content;
                    const chunk =
                      JSON.stringify({
                        content: data.message.content,
                        done: data.done,
                      }) + '\n';
                    controller.enqueue(encoder.encode(chunk));
                  } catch {
                    console.error('Failed to parse Ollama stream chunk:', line);
                  }
                }
              }
            }
          } catch (error) {
            console.error('Stream reading error:', error);
          } finally {
            // Persist the full assistant reply once streaming completes.
            if (chatId && assistantContent) {
              try {
                addMessage(chatId, 'assistant', assistantContent);
              } catch (e) {
                console.error('Failed to save assistant message:', e);
              }
            }
            controller.close();
            reader.releaseLock();
          }
        },
      });

      return new NextResponse(readable, {
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'Transfer-Encoding': 'chunked',
        },
      });
    } else {
      const data: OllamaResponse = await response.json();
      if (chatId && data.message?.content) {
        addMessage(chatId, 'assistant', data.message.content);
      }
      return NextResponse.json(data);
    }
  } catch (error) {
    console.error('Chat API error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function GET() {
  const auth = await requireSession();
  if (auth instanceof NextResponse) return auth;

  try {
    const response = await fetch(`${OLLAMA_BASE_URL}/api/tags`, {
      headers: { ...ollamaAuthHeader() },
    });
    if (!response.ok) {
      return NextResponse.json({ error: 'Failed to fetch models' }, { status: 500 });
    }
    const data = await response.json();
    return NextResponse.json(data);
  } catch (error) {
    console.error('Models fetch error:', error);
    return NextResponse.json({ error: 'Failed to connect to Ollama' }, { status: 500 });
  }
}