import 'server-only';
import { OLLAMA_BASE_URL, ollamaAuthHeader } from './ollama';
import { openRouterChatUrl, openRouterHeaders } from './openrouter';
import { searchWeb, formatSearchContext, type SearchResult } from './search';
import { INTERRUPT_SUFFIX } from './types';

// ---------- Types ----------

export type AgentRole = 'system' | 'user' | 'assistant' | 'tool';

export interface AgentToolCall {
  name: string;
  args: Record<string, unknown>;
  id?: string;
}

export interface AgentMessage {
  role: AgentRole;
  content: string;
  name?: string;
  tool_call_id?: string;
  tool_calls?: AgentToolCall[];
}

export type VerbosityTier = 'terse' | 'balanced' | 'detailed';

export interface VerbosityPlan {
  tier: VerbosityTier;
  maxTokens: number;
  instruction: string;
}

interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

interface Decision {
  content: string;
  toolCalls: AgentToolCall[];
}

interface StreamDelta {
  content?: string;
  done?: boolean;
}

// ---------- Constants ----------

const WEB_SEARCH_TOOL: ToolDefinition = {
  type: 'function',
  function: {
    name: 'web_search',
    description:
      'Search the internet for up-to-date, real-world information (news, current events, ' +
      'prices, docs, facts). Use this when the user\'s question cannot be fully answered from ' +
      'your training knowledge alone.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'A concise, focused web search query.' },
      },
      required: ['query'],
    },
  },
};

// Hard cap on recent turns fed to the model, independent of the token budget.
const MAX_CONTEXT_TURNS = 12;

// Max model calls per user turn: 1 decision call + 1 grounded answer call.
const MAX_MODEL_CALLS = 2;

// Cap the pre-flight decision call. It runs before any bytes are streamed, so
// a hung/cold model must not hold the HTTP response open indefinitely.
const DECISION_TIMEOUT_MS = 30_000;

// Tokens reserved for the system prompt, tool schema, and protocol framing.
const SYSTEM_RESERVE_TOKENS = 512;

// Never ask for less than this many response tokens when the window is tight.
const MIN_RESPONSE_TOKENS = 128;

const DEFAULT_CONTEXT_WINDOW = 8192;

// Rough token estimate (~4 chars per token for English). Good enough to keep a
// conversation inside the model's window without shipping a tokenizer.
export function estimateTokens(text: string): number {
  return text ? Math.ceil(text.length / 4) : 0;
}


function currentDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function baseSystem(verbosity: VerbosityPlan): string {
  return (
    `You are Bleep AI, a helpful assistant. Today's date is ${currentDate()}. ` +
    `Respond using the model you are running on unless the conversation or web results indicate otherwise.\n\n` +
    verbosity.instruction
  );
}

function systemWithContext(context: string): string {
  return `You are Bleep AI, a helpful assistant. Today's date is ${currentDate()}.\n\n${context}`;
}

// ---------- History trimming ----------

// Keep the most recent turns that fit in the model's context window, leaving
// `reserveTokens` free for the system prompt and the response itself.
export function trimHistory(
  messages: AgentMessage[],
  contextWindow: number,
  reserveTokens: number
): AgentMessage[] {
  const budget = Math.max(MIN_RESPONSE_TOKENS, contextWindow - reserveTokens);
  const maxMessages = MAX_CONTEXT_TURNS * 2;
  const kept: AgentMessage[] = [];
  let used = 0;

  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    const cost = estimateTokens(message.content) + 4; // +4 for role framing
    const full = kept.length > 0 && (used + cost > budget || kept.length >= maxMessages);
    if (full) break;
    used += cost;
    kept.unshift(message);
  }

  // Start on a user turn so the model always has an explicit query in context.
  while (kept.length > 1 && kept[0].role !== 'user') kept.shift();
  return kept;
}

// ---------- Verbosity detection ----------

const DETAILED_HINTS = [
  /explain/i,
  /how (do|to|does)/i,
  /step[ -]?by[ -]?step/i,
  /compare/i,
  /difference/i,
  /\bwrite\b/i,
  /\bcode\b/i,
  /script/i,
  /tutorial/i,
  /why (do|does|is|are)/i,
  /summar/i,
  /list (all|every|the)/i,
  /example/i,
  /in depth/i,
  /analy/i,
  /implement/i,
  /design/i,
];

export function detectVerbosity(messages: AgentMessage[]): VerbosityPlan {
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  const q = lastUser?.content?.trim() ?? '';
  const words = q.split(/\s+/).filter(Boolean);

  if (q.length <= 24 && words.length <= 4) {
    return {
      tier: 'terse',
      maxTokens: 150,
      instruction:
        'Answer in at most 1-2 short sentences. No filler, no preamble, no bullet points unless required.',
    };
  }
  if (q.length > 240 || DETAILED_HINTS.some((re) => re.test(q)) || (q.includes('?') && words.length >= 10)) {
    return {
      tier: 'detailed',
      maxTokens: 2000,
      instruction:
        'Give a thorough, well-structured answer with clear sections, concrete examples, and steps where useful. ' +
        'Be complete but avoid fluff.',
    };
  }
  return {
    tier: 'balanced',
    maxTokens: 600,
    instruction:
      'Be concise and directly answer the question in short paragraphs. Add detail or examples only when the question clearly requires them.',
  };
}

// ---------- Model I/O ----------

interface ModelCallParams {
  isCloud: boolean;
  model: string;
  messages: AgentMessage[];
  stream: boolean;
  contextWindow: number;
  maxTokens?: number;
  tools?: ToolDefinition[];
  options?: Record<string, unknown>;
  signal?: AbortSignal;
}

async function callModel(params: ModelCallParams): Promise<Response> {
  const common: Record<string, unknown> = {
    model: params.model,
    messages: params.messages,
    stream: params.stream,
  };
  if (params.tools?.length) common.tools = params.tools;

  if (params.isCloud) {
    return fetch(openRouterChatUrl(), {
      method: 'POST',
      headers: openRouterHeaders(),
      body: JSON.stringify({
        ...common,
        ...(params.maxTokens ? { max_tokens: params.maxTokens } : {}),
      }),
      ...(params.signal ? { signal: params.signal } : {}),
    });
  }

  return fetch(`${OLLAMA_BASE_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...ollamaAuthHeader() },
    body: JSON.stringify({
      ...common,
      keep_alive: -1,
      options: {
        temperature: 0.7,
        top_p: 0.9,
        num_ctx: params.contextWindow,
        ...params.options,
        num_predict: params.maxTokens ?? 2048,
      },
    }),
    ...(params.signal ? { signal: params.signal } : {}),
  });
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === 'AbortError') ||
    (error instanceof Error && error.name === 'AbortError')
  );
}

function combineSignals(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function parseToolArgs(raw: unknown): Record<string, unknown> {
  if (typeof raw === 'object' && raw !== null) return raw as Record<string, unknown>;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }
  return {};
}

interface RawToolCall {
  id?: string;
  function?: { name?: string; arguments?: unknown };
}

async function parseDecision(isCloud: boolean, response: Response): Promise<Decision> {
  const data = await response.json();
  if (isCloud) {
    const msg = data.choices?.[0]?.message;
    const rawCalls = (msg?.tool_calls ?? []) as RawToolCall[];
    const toolCalls: AgentToolCall[] = rawCalls.map((c) => ({
      name: c?.function?.name ?? '',
      args: parseToolArgs(c?.function?.arguments),
      id: c?.id,
    }));
    return { content: msg?.content ?? '', toolCalls };
  }
  const msg = data.message ?? {};
  const rawCalls = (msg.tool_calls ?? []) as RawToolCall[];
  const toolCalls: AgentToolCall[] = rawCalls.map((c) => ({
    name: c?.function?.name ?? '',
    args: parseToolArgs(c?.function?.arguments),
  }));
  return { content: msg.content ?? '', toolCalls };
}

function toolResultMessage(isCloud: boolean, call: AgentToolCall, result: string): AgentMessage {
  if (isCloud) return { role: 'tool', content: result, tool_call_id: call.id ?? 'call_web_search' };
  return { role: 'tool', content: result, name: call.name };
}

function parseOllamaLine(line: string): StreamDelta | null {
  try {
    const data = JSON.parse(line);
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

type Emit = (event: Record<string, unknown>) => void;

interface StreamResult {
  content: string;
  interrupted: boolean;
}

async function pipeModelStream(
  response: Response,
  isCloud: boolean,
  emit: Emit,
  signal?: AbortSignal
): Promise<StreamResult> {
  const reader = response.body?.getReader();
  if (!reader) {
    emit({ type: 'done' });
    return { content: '', interrupted: false };
  }

  const decoder = new TextDecoder();
  const parse = isCloud ? parseOpenRouterLine : parseOllamaLine;
  let buffer = '';
  let content = '';
  let finished = false;
  let interrupted = false;

  try {
    while (!finished) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const delta = parse(line);
        if (!delta) continue;
        if (delta.done) {
          finished = true;
          break;
        }
        if (delta.content) {
          content += delta.content;
          emit({ type: 'content', content: delta.content });
        }
      }
    }
  } catch (error) {
    // A user stop (or client disconnect) arrives as an abort: keep whatever the
    // model already produced instead of discarding it.
    if (isAbortError(error) || signal?.aborted) {
      interrupted = true;
      await reader.cancel().catch(() => {});
    } else {
      throw error;
    }
  } finally {
    emit({ type: 'done' });
    reader.releaseLock();
  }
  return { content, interrupted };
}

// ---------- Agent orchestration ----------

export interface AgentResponseOptions {
  isCloud: boolean;
  model: string;
  messages: AgentMessage[];
  verbosity: VerbosityPlan;
  contextWindow: number;
  options?: Record<string, unknown>;
  signal?: AbortSignal;
  onAssistantContent: (content: string) => void | Promise<void>;
}

export interface PreparedResponse {
  stream: ReadableStream<Uint8Array>;
}

// Shrink the requested answer length when the remaining window is tight.
function fitVerbosity(
  verbosity: VerbosityPlan,
  contextWindow: number,
  history: AgentMessage[]
): VerbosityPlan {
  const desired = verbosity.maxTokens;
  const inputTokens = history.reduce((sum, m) => sum + estimateTokens(m.content) + 4, 0);
  const available = Math.max(
    MIN_RESPONSE_TOKENS,
    contextWindow - inputTokens - SYSTEM_RESERVE_TOKENS
  );
  const maxTokens = Math.min(desired, available);
  if (maxTokens >= desired) return verbosity;
  return {
    ...verbosity,
    maxTokens,
    instruction:
      verbosity.instruction +
      " The conversation is near the model's context limit, so keep the answer brief.",
  };
}

export async function prepareAgentResponse(opts: AgentResponseOptions): Promise<PreparedResponse> {
  const { isCloud, model, messages, verbosity, options } = opts;
  const contextWindow = opts.contextWindow || DEFAULT_CONTEXT_WINDOW;

  // Reserve room for the system prompt and the full response before trimming,
  // so the selected answer size always fits inside the window.
  const history = trimHistory(
    messages,
    contextWindow,
    SYSTEM_RESERVE_TOKENS + verbosity.maxTokens
  );
  const fitted = fitVerbosity(verbosity, contextWindow, history);

  // One signal that fires on user stop or client disconnect, used for every
  // upstream request so a cancelled turn releases the model immediately.
  const upstream = new AbortController();
  if (opts.signal) {
    if (opts.signal.aborted) upstream.abort();
    else opts.signal.addEventListener('abort', () => upstream.abort(), { once: true });
  }

  let sources: SearchResult[] = [];
  let mode: 'content' | 'tool' | 'fallback' = 'content';
  let decision: Decision = { content: '', toolCalls: [] };
  let streamable: Response | null = null;
  let fallbackError: unknown = null;

  for (let attempt = 0; attempt < MAX_MODEL_CALLS; attempt++) {
    try {
      if (attempt === 0) {
        // Decision call: tools enabled, non-streaming so tool calls arrive intact.
        const res = await callModel({
          isCloud,
          model,
          messages: [
            { role: 'system', content: `${baseSystem(fitted)}\n\n` +
              'Decide whether to use the web_search tool. Call it only when the answer needs ' +
              'current, real-world, or web-based information (news, recent events, prices, live data, ' +
              'external docs). Do NOT call it for greetings, simple math, general knowledge you are ' +
              'confident about, or short chit-chat.' },
            ...history,
          ],
          stream: false,
          contextWindow,
          maxTokens: fitted.maxTokens,
          tools: [WEB_SEARCH_TOOL],
          options,
          signal: combineSignals(upstream.signal, DECISION_TIMEOUT_MS),
        });
        if (!res.ok) throw new Error(`Model API error: ${res.status}`);

        decision = await parseDecision(isCloud, res);
        const searchCall = decision.toolCalls.find((c) => c.name === 'web_search');

        if (!searchCall) {
          mode = 'content';
          break;
        }

        // Model asked for a search.
        mode = 'tool';
        const query = String(searchCall.args?.query ?? '').trim() || lastUserContent(history);
        sources = await searchWeb(query).catch(() => []);

        const toolResult =
          sources.length > 0
            ? formatSearchContext(sources)
            : 'The web search returned no results. Ask the user for clarification or answer from knowledge.';

        streamable = await callModel({
          isCloud,
          model,
          messages: [
            { role: 'system', content: baseSystem(fitted) },
            ...history,
            { role: 'assistant', content: decision.content, tool_calls: decision.toolCalls },
            toolResultMessage(isCloud, searchCall, toolResult),
          ],
          stream: true,
          contextWindow,
          maxTokens: fitted.maxTokens,
          options,
          signal: upstream.signal,
        });
        if (!streamable.ok) throw new Error(`Model API error: ${streamable.status}`);
        break;
      }

      // Fallback (attempt 1): the decision call failed — likely the model does not
      // support tools. Degrade to always-on search-then-answer.
      mode = 'fallback';
      sources = await searchWeb(lastUserContent(history)).catch(() => []);
      streamable = await callModel({
        isCloud,
        model,
        messages: [
          { role: 'system', content: systemWithContext(formatSearchContext(sources)) },
          ...history,
        ],
        stream: true,
        contextWindow,
        maxTokens: fitted.maxTokens,
        options,
        signal: upstream.signal,
      });
      if (!streamable.ok) throw new Error(`Model API error: ${streamable.status}`);
    } catch (e) {
      fallbackError = e;
      if (attempt === 0 && !isAbortError(e)) continue;
      throw fallbackError;
    }
  }

  const encoder = new TextEncoder();
  const emitAs = (event: Record<string, unknown>) =>
    encoder.encode(JSON.stringify(event) + '\n');

  const stream = new ReadableStream({
    async start(controller) {
      // The consumer may disappear (user stop); swallow enqueues after that.
      const emit = (event: Record<string, unknown>) => {
        try {
          controller.enqueue(emitAs(event));
        } catch {
          // stream already cancelled — persistence below still runs
        }
      };
      let assistantContent = '';
      try {
        if (mode === 'content') {
          const content = decision.content ?? '';
          assistantContent = content;
          if (content) emit({ type: 'content', content });
          emit({ type: 'done' });
        } else {
          emit({ type: 'status', text: 'Searching the web…' });
          emit({
            type: 'sources',
            sources: sources.map((s) => ({ title: s.title, url: s.url })),
          });
          const result = await pipeModelStream(streamable!, isCloud, emit, upstream.signal);
          assistantContent = result.content;
          if (result.interrupted) {
            emit({ type: 'interrupted' });
            if (assistantContent) assistantContent += INTERRUPT_SUFFIX;
          }
        }
        await opts.onAssistantContent(assistantContent);
      } catch (e) {
        console.error('Agent stream error:', e);
        emit({ type: 'error', message: e instanceof Error ? e.message : 'Streaming error' });
        try {
          await opts.onAssistantContent(assistantContent);
        } catch {
          // ignore persistence failures while reporting the stream error
        }
      } finally {
        try {
          controller.close();
        } catch {
          // already closed by cancellation
        }
      }
    },
    cancel() {
      // Client went away — stop the model instead of generating into the void.
      upstream.abort();
    },
  });

  return { stream };
}

function lastUserContent(messages: AgentMessage[]): string {
  const last = [...messages].reverse().find((m) => m.role === 'user');
  return last?.content?.trim() ?? '';
}