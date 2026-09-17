import { NextRequest, NextResponse } from 'next/server';
import type { OllamaRequest, OllamaResponse } from '@/lib/types';
import { OLLAMA_BASE_URL, ollamaAuthHeader } from '@/lib/ollama';
import { CLOUD_MODELS, DEFAULT_MODEL, LOCAL_MODEL, isCloudModel, type ChatModel } from '@/lib/models';
import { openRouterChatUrl, openRouterConfigured, openRouterHeaders } from '@/lib/openrouter';
import { requireSession } from '@/lib/auth';
import { addMessage, listMessages, updateChatTitle, userOwnsChat } from '@/lib/queries';

function generateTitle(firstMessage: string): string {
  const words = firstMessage.trim().split(/\s+/);
  return words.slice(0, 6).join(' ') + (words.length > 6 ? '...' : '');
}

interface StreamDelta {
  content?: string;
  done?: boolean;
}

function parseOllamaLine(line: string): StreamDelta | null {
  try {
    const data: OllamaResponse = JSON.parse(line);
    const delta: StreamDelta = { done: data.done };
    if (data.message?.content) delta.content = data.message.content;
    return delta;
  } catch {
    return null;
  }
}

function parseOpenRouterLine(raw: string): StreamDelta | null {
  const line = raw.trim();
  if (!line || !line.startsWith('data:')) return null;
  const payload = line.slice(5).trim();
  if (payload === '[DONE]') return { done: true };
  try {
    const data = JSON.parse(payload);
    if (data.error) throw new Error(data.error.message || 'OpenRouter stream error');
    const content = data.choices?.[0]?.delta?.content;
    const done = data.choices?.[0]?.finish_reason === 'stop';
    const delta: StreamDelta = {};
    if (typeof content === 'string' && content) delta.content = content;
    if (done) delta.done = true;
    return Object.keys(delta).length ? delta : null;
  } catch {
    return null;
  }
}

function createStream(
  response: Response,
  parse: (line: string) => StreamDelta | null,
  onComplete: (content: string) => void | Promise<void>
) {
  const encoder = new TextEncoder();
  return new ReadableStream({
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
            const delta = parse(line);
            if (!delta) continue;

            if (delta.done) {
              controller.enqueue(
                encoder.encode(JSON.stringify({ content: '', done: true }) + '\n')
              );
              break;
            }
            if (delta.content) {
              assistantContent += delta.content;
              controller.enqueue(
                encoder.encode(JSON.stringify({ content: delta.content, done: false }) + '\n')
              );
            }
          }
        }
      } catch (error) {
        console.error('Stream reading error:', error);
      } finally {
        try {
          await onComplete(assistantContent);
        } catch (e) {
          console.error('Failed to save assistant message:', e);
        }
        controller.close();
        reader.releaseLock();
      }
    },
  });
}

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
    if (chatId && !(await userOwnsChat(auth.userId, chatId))) {
      return NextResponse.json({ error: 'Chat not found' }, { status: 404 });
    }

    // Persist the latest user message before calling the model. Look for the
    // last user turn (the client may append an empty assistant placeholder),
    // and skip if it was already saved — the client retries on 502/503/504.
    if (chatId) {
      const lastUser = [...messages]
        .reverse()
        .find((m) => m.role === 'user' && m.content?.trim());
      if (lastUser) {
        const existing = await listMessages(chatId);
        const lastSavedUser = [...existing]
          .reverse()
          .find((m) => m.role === 'user');
        const alreadySaved = lastSavedUser?.content === lastUser.content;
        if (!alreadySaved) {
          await addMessage(chatId, 'user', lastUser.content);
          // Title the chat from its first message if it has none yet.
          if (existing.length === 0) {
            await updateChatTitle(auth.userId, chatId, generateTitle(lastUser.content));
          }
        }
      }
    }

    const isCloud = isCloudModel(model);

    if (isCloud && !openRouterConfigured()) {
      return NextResponse.json(
        { error: 'OpenRouter is not configured (missing OPENROUTER_API_KEY)' },
        { status: 503 }
      );
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

    const response = isCloud
      ? await fetch(openRouterChatUrl(), {
          method: 'POST',
          headers: openRouterHeaders(),
          body: JSON.stringify({
            model,
            messages: messages.map((msg) => ({ role: msg.role, content: msg.content })),
            stream,
          }),
        })
      : await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...ollamaAuthHeader(),
          },
          body: JSON.stringify(ollamaRequest),
        });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Model API error:', response.status, errorText);
      return NextResponse.json(
        { error: `Model API error: ${response.status} ${errorText}` },
        { status: response.status }
      );
    }

    const parse = isCloud ? parseOpenRouterLine : parseOllamaLine;

    if (stream) {
      const readable = createStream(response, parse, async (assistantContent) => {
        if (chatId && assistantContent) {
          await addMessage(chatId, 'assistant', assistantContent);
        }
      });
      return new NextResponse(readable, {
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'Transfer-Encoding': 'chunked',
        },
      });
    } else {
      const data = await response.json();
      const content = isCloud
        ? (data.choices?.[0]?.message?.content as string | undefined)
        : (data.message?.content as string | undefined);
      if (chatId && content) {
        await addMessage(chatId, 'assistant', content);
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
    // Only expose the configured local model (OLLAMA_MODEL) in the picker,
    // even though Ollama may have several models pulled.
    const localModels: ChatModel[] = [];
    try {
      const response = await fetch(`${OLLAMA_BASE_URL}/api/tags`, {
        headers: { ...ollamaAuthHeader() },
      });
      if (response.ok) {
        const data = await response.json();
        for (const model of data.models || []) {
          if (model.name !== LOCAL_MODEL) continue;
          localModels.push({
            id: model.name,
            name: model.name,
            provider: 'local',
            description: [model.details?.parameter_size, model.details?.quantization_level]
              .filter(Boolean)
              .join(' · '),
          });
        }
      }
    } catch {
      // Ollama unreachable — still return the cloud catalog below.
    }

    if (localModels.length === 0) {
      localModels.push({ id: LOCAL_MODEL, name: LOCAL_MODEL, provider: 'local' });
    }

    const models = [
      ...localModels,
      ...(openRouterConfigured() ? CLOUD_MODELS : []),
    ];

    return NextResponse.json({ defaultModel: DEFAULT_MODEL, models });
  } catch (error) {
    console.error('Models fetch error:', error);
    return NextResponse.json({ error: 'Failed to load models' }, { status: 500 });
  }
}