import { NextRequest, NextResponse } from 'next/server';
import type { OllamaRequest } from '@/lib/types';
import {
  CLOUD_MODELS,
  DEFAULT_MODEL,
  LOCAL_CONTEXT_WINDOW,
  LOCAL_MODEL,
  getContextWindow,
  isCloudModel,
  type ChatModel,
} from '@/lib/models';
import { openRouterConfigured } from '@/lib/openrouter';
import { requireSession } from '@/lib/auth';
import { addMessage, listMessages, updateChatTitle, userOwnsChat } from '@/lib/queries';
import {
  prepareAgentResponse,
  detectVerbosity,
  type AgentMessage,
} from '@/lib/agent';
import { OLLAMA_BASE_URL, ollamaAuthHeader } from '@/lib/ollama';

// Do NOT set a low maxDuration here. Vercel counts streamed response time
// against the function's max duration; the platform default (300s with Fluid
// Compute) is required so long local-model generations are not killed
// mid-stream. Setting 60 here previously truncated responses.
export const maxDuration = 300;

function generateTitle(firstMessage: string): string {
  const words = firstMessage.trim().split(/\s+/);
  return words.slice(0, 6).join(' ') + (words.length > 6 ? '...' : '');
}

interface CollectedResponse {
  content: string;
  sources: { title: string; url: string }[];
}

async function collectResponse(stream: ReadableStream<Uint8Array>): Promise<CollectedResponse> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let content = '';
  const sources: { title: string; url: string }[] = [];
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          if (event.type === 'content') content += event.content ?? '';
          if (event.type === 'sources' && Array.isArray(event.sources)) {
            sources.push(...event.sources);
          }
        } catch {
          // ignore malformed lines
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
  return { content, sources };
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

    const agentMessages: AgentMessage[] = messages.map((msg) => ({
      role: msg.role as AgentMessage['role'],
      content: String(msg.content ?? ''),
    }));
    const verbosity = detectVerbosity(agentMessages);

    const { stream: readable } = await prepareAgentResponse({
      isCloud,
      model,
      messages: agentMessages,
      verbosity,
      contextWindow: getContextWindow(model),
      options: options as Record<string, unknown> | undefined,
      signal: request.signal,
      onAssistantContent: async (content) => {
        if (chatId && content) {
          await addMessage(chatId, 'assistant', content);
        }
      },
    });

    if (stream) {
      return new NextResponse(readable, {
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'Transfer-Encoding': 'chunked',
          // Prevent intermediaries (Cloudflare tunnel, proxies) from buffering
          // the stream, which would make tokens arrive late or stall.
          'Cache-Control': 'no-cache, no-transform',
          'X-Accel-Buffering': 'no',
        },
      });
    }

    return NextResponse.json(await collectResponse(readable));
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
            contextWindow: LOCAL_CONTEXT_WINDOW,
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
      localModels.push({
        id: LOCAL_MODEL,
        name: LOCAL_MODEL,
        provider: 'local',
        contextWindow: LOCAL_CONTEXT_WINDOW,
      });
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