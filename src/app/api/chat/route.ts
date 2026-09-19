import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import type { OllamaRequest } from '@/lib/types';
import {
  CLOUD_MODELS,
  DEFAULT_MODEL,
  LOCAL_CONTEXT_WINDOW,
  LOCAL_MODELS,
  getContextWindow,
  isCloudModel,
  type ChatModel,
} from '@/lib/models';
import { openRouterConfigured } from '@/lib/openrouter';
import { requireSession } from '@/lib/auth';
import {
  addAssistantChunk,
  getOwnedChatMeta,
  saveUserTurn,
  type ChatMessageMeta,
} from '@/lib/queries';
import {
  beginGeneration,
  consumeStopped,
  publish,
  registerStop,
  type GenerationEvent,
} from '@/lib/generation';
import {
  prepareAgentResponse,
  detectVerbosity,
  type AgentMessage,
} from '@/lib/agent';
import { OLLAMA_BASE_URL, ollamaAuthHeader } from '@/lib/ollama';
import { parseSseLine, SSE_CONTENT_TYPE } from '@/lib/sse';
import {
  ModelError,
  isAbortError,
  statusForCode,
} from '@/lib/modelErrors';

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
        const event = parseSseLine<{
          type?: string;
          content?: string;
          sources?: { title: string; url: string }[];
        }>(line);
        if (!event) continue;
        if (event.type === 'content') content += event.content ?? '';
        if (event.type === 'sources' && Array.isArray(event.sources)) {
          sources.push(...event.sources);
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
      assistantMessageId,
    } = body as OllamaRequest & { chatId?: string; assistantMessageId?: string };

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return NextResponse.json({ error: 'Messages are required' }, { status: 400 });
    }

    // Ownership check and message stats in a single query. A null result means
    // the chat does not exist or is not owned by this user.
    let meta: ChatMessageMeta | null = null;
    if (chatId) {
      meta = await getOwnedChatMeta(auth.userId, chatId);
      if (!meta) {
        return NextResponse.json({ error: 'Chat not found' }, { status: 404 });
      }
    }

    // Persist the latest user message before calling the model. Look for the
    // last user turn (the client may append an empty assistant placeholder),
    // and skip if it was already saved — the client retries on 502/503/504.
    if (chatId && meta) {
      const lastUser = [...messages]
        .reverse()
        .find((m) => m.role === 'user' && m.content?.trim());
      if (lastUser && meta.lastUserContent !== lastUser.content) {
        // Message insert + recency (and title, on the first turn) in one batch.
        await saveUserTurn(
          chatId,
          randomUUID(),
          lastUser.content,
          meta.count === 0 ? generateTitle(lastUser.content) : undefined
        );
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

    // The client-suggested placeholder id ties the live answer in the browser
    // to the persisted copy, so reconnect/resume addresses the same message.
    const answerId =
      typeof assistantMessageId === 'string' && assistantMessageId.trim()
        ? assistantMessageId.trim()
        : randomUUID();

    // Generation is decoupled from the HTTP connection: it keeps running and
    // accumulating into the DB even if the browser drops away. The only way to
    // stop it is an explicit POST /api/chat/stop from the client.
    const genController = new AbortController();
    const endGeneration = chatId ? beginGeneration(chatId) : () => {};
    if (chatId) registerStop(chatId, () => genController.abort());
    let finalized = false;
    const finalize = (event: GenerationEvent) => {
      if (finalized || !chatId) return;
      finalized = true;
      publish(chatId, event);
      endGeneration();
    };

    let prepared;
    try {
      prepared = await prepareAgentResponse({
        isCloud,
        model,
        messages: agentMessages,
        verbosity,
        contextWindow: getContextWindow(model),
        options: options as Record<string, unknown> | undefined,
        signal: genController.signal,
        // Persist + broadcast the partial answer on every streamed chunk so a
        // disconnected client can re-sync at any moment.
        onAssistantChunk: async (content) => {
          if (!chatId || !content) return;
          await addAssistantChunk(chatId, answerId, content);
          publish(chatId, {
            type: 'content',
            messageId: answerId,
            content,
          });
        },
        onAssistantContent: async (content) => {
          if (!chatId) return;
          if (content) await addAssistantChunk(chatId, answerId, content);
          const interrupted = consumeStopped(chatId);
          finalize(
            interrupted
              ? { type: 'interrupted', messageId: answerId, content }
              : { type: 'done', messageId: answerId, content }
          );
        },
        onError: async (message, code) => {
          finalize({
            type: 'error',
            message,
            ...(code ? { code } : {}),
            messageId: answerId,
          });
        },
      });
    } catch (error) {
      // The model call failed before any stream was produced. Tell any
      // reconnected listener the generation is over, then reply with a coded
      // error the UI can categorize (connection vs model load, etc.).
      const code =
        error instanceof ModelError ? error.code : isAbortError(error) ? 'timeout' : 'internal';
      const message =
        error instanceof Error ? error.message : 'Generation failed';
      if (chatId) {
        publish(chatId, {
          type: 'error',
          message,
          ...(code ? { code } : {}),
          messageId: answerId,
        });
        endGeneration();
      }
      return NextResponse.json({ error: message, code }, { status: statusForCode(code) });
    }

    if (stream) {
      return new NextResponse(prepared.stream, {
        headers: {
          // text/event-stream is not compressed by Vercel/CDNs. A compressible
          // type (text/plain) gets gzipped, and gzip buffers the body — which
          // is what made tokens arrive in one burst instead of streaming.
          'Content-Type': SSE_CONTENT_TYPE,
          // Do not set Transfer-Encoding: HTTP/2 (Vercel) forbids it and the
          // platform chunks the stream itself.
          'Cache-Control': 'no-cache, no-transform',
          'X-Accel-Buffering': 'no',
        },
      });
    }

    return NextResponse.json(await collectResponse(prepared.stream));
  } catch (error) {
    console.error('Chat API error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// Ollama's model list rarely changes, and the tunnel can be slow. Cache it
// briefly so repeated page loads / mounts don't each pay the latency (and never
// hang the picker when Ollama is unreachable).
const MODELS_CACHE_TTL_MS = 60_000;
const OLLAMA_TAGS_TIMEOUT_MS = 2_500;

interface ModelsPayload {
  defaultModel: string;
  models: ChatModel[];
  localStatus: 'ok' | 'unreachable';
}

let modelsCache: { data: ModelsPayload; expires: number } | null = null;

export async function GET() {
  const auth = await requireSession();
  if (auth instanceof NextResponse) return auth;

  try {
    if (modelsCache && modelsCache.expires > Date.now()) {
      return NextResponse.json(modelsCache.data);
    }

    // Expose the configured local models (OLLAMA_MODELS, or OLLAMA_MODEL), even
    // though Ollama may have several other models pulled on the same server.
    const localModels: ChatModel[] = [];
    const configured = new Set(LOCAL_MODELS);
    let localStatus: 'ok' | 'unreachable' = 'unreachable';
    try {
      const response = await fetch(`${OLLAMA_BASE_URL}/api/tags`, {
        headers: { ...ollamaAuthHeader() },
        signal: AbortSignal.timeout(OLLAMA_TAGS_TIMEOUT_MS),
      });
      if (response.ok) {
        localStatus = 'ok';
        const data = await response.json();
        for (const model of data.models || []) {
          if (!configured.has(model.name)) continue;
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
      for (const name of LOCAL_MODELS) {
        localModels.push({
          id: name,
          name,
          provider: 'local',
          contextWindow: LOCAL_CONTEXT_WINDOW,
        });
      }
    }

    const models = [
      ...localModels,
      ...(openRouterConfigured() ? CLOUD_MODELS : []),
    ];

    const payload: ModelsPayload = {
      defaultModel: DEFAULT_MODEL,
      models,
      localStatus,
    };
    // Hold a healthy list longer; retry an unreachable Ollama quickly.
    modelsCache = {
      data: payload,
      expires: Date.now() + (localStatus === 'ok' ? MODELS_CACHE_TTL_MS : 5_000),
    };
    return NextResponse.json(payload);
  } catch (error) {
    console.error('Models fetch error:', error);
    return NextResponse.json({ error: 'Failed to load models' }, { status: 500 });
  }
}