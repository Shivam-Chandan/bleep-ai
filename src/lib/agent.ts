import 'server-only';
import { OLLAMA_BASE_URL, OLLAMA_NUM_THREAD, ollamaAuthHeader } from './ollama';
import { openRouterChatUrl, openRouterHeaders } from './openrouter';
import { searchWeb, formatSearchContext, type SearchResult } from './search';
import { INTERRUPT_SUFFIX } from './types';
import { ModelError, isAbortError, isModelError, modelFetch, type ModelErrorCode } from './modelErrors';
import { sseEncode, SSE_HEARTBEAT } from './sse';

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

// The decision call is non-streaming (it needs intact tool_calls), but it must
// NOT be allowed to write the whole answer: if the model declines to search, we
// re-generate the reply as a real stream so the user sees token-by-token output
// instead of one block. Cap it to little more than a tool call needs.
const DECISION_MAX_TOKENS = 256;

// Tokens reserved for the system prompt, tool schema, and protocol framing.
const SYSTEM_RESERVE_TOKENS = 512;

// Never ask for less than this many response tokens when the window is tight.
const MIN_RESPONSE_TOKENS = 128;

const DEFAULT_CONTEXT_WINDOW = 8192;

// Local models run on CPU at ~1.5 tok/s, where a 2000-token "detailed" reply can
// take 20+ minutes. Cap local answers so a single turn stays usable. Tunable via
// OLLAMA_MAX_TOKENS.
const LOCAL_MAX_ANSWER_TOKENS = Math.max(
  64,
  Number(process.env.OLLAMA_MAX_TOKENS) || 512
);

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
    `You are Bleep AI, a friendly, down-to-earth assistant. Today's date is ${currentDate()}.\n\n` +
    `Voice: write the way a smart friend texts you back — warm, plain, direct, no corporate polish. ` +
    `Use contractions and everyday words, keep sentences short, and match the user's language and energy. ` +
    `Answer from your own knowledge, using web results when they're provided. Write in flowing prose; use ` +
    `markdown (headings, bullets, code blocks) ONLY when it genuinely helps (steps, lists, code, comparisons). ` +
    `Never open with canned phrases like "As an AI assistant" and never sign off.\n\n` +
    verbosity.instruction
  );
}

function systemWithContext(context: string, userName?: string): string {
  return (
    `You are Bleep AI, a friendly, down-to-earth assistant. Today's date is ${currentDate()}.\n\n` +
    `Voice: write the way a smart friend texts you back — warm, plain, direct, no corporate polish. ` +
    `Use contractions and everyday words, keep sentences short, and match the user's language and energy. ` +
    `Write in flowing prose; use markdown ONLY when it genuinely helps. Never open with canned phrases ` +
    `like "As an AI assistant" and never sign off.\n\n${context}${userIntro(userName)}`
  );
}

// Give the model the caller's name as a personal touch. Deliberately framed as
// "occasionally" so the model addresses the user by name sometimes — not in
// every message, which reads as canned/corporate.
function userIntro(userName?: string): string {
  const name = userName?.trim();
  if (!name) return '';
  return (
    `\n\nThe person you are talking to goes by the name ${name}. Weave their name in occasionally ` +
    `for a personal touch — now and then, not in every reply, and only where it feels natural, ` +
    `the way a friend would.`
  );
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
        'Aim for a crisp, conversational reply of 1-2 short sentences. Sound like a person, not a memo: no bullet points, no headings, no sign-off.',
    };
  }
  if (q.length > 240 || DETAILED_HINTS.some((re) => re.test(q)) || (q.includes('?') && words.length >= 10)) {
    return {
      tier: 'detailed',
      maxTokens: 2000,
      instruction:
        'Give a thorough, well-organised answer with a natural, friendly tone. Use headings or bullets only where they genuinely aid clarity (steps, comparisons, code); otherwise write in clear flowing prose.',
    };
  }
  return {
    tier: 'balanced',
    maxTokens: 600,
    instruction:
      'Give a natural, conversational answer in a short paragraph or two. Sound like a helpful friend, not a support doc: short sentences and only as much formatting as the question really needs.',
  };
}

// ---------- Web-search gating ----------

// Signals that a question depends on fresh, real-world, or web-only information.
// Used to skip the model's tool-decision round trip on slow local models: every
// avoided model call saves tens of seconds at CPU speeds.
const SEARCH_SIGNALS = [
  /https?:\/\//i,
  /\b(latest|newest|current|currently|recent|recently|today|tonight|tomorrow|yesterday|breaking|live)\b/i,
  /\b(news|headline|headlines|weather|forecast|score|scores|standings|schedule|stock|price|prices|cost|worth|exchange rate|election|poll|release|released|changelog|version|update|updated)\b/i,
  /\b(who won|who is winning|when (is|was|did|does|will)|where (is|can)|how much (is|are|does|did)|how many)\b/i,
  /\b20(2[4-9]|3\d)\b/,
  /\b(search|google|look ?up|browse|find (online|out)|on the web)\b/i,
];

export function shouldSearchWeb(message: string): boolean {
  const q = message.trim();
  if (!q) return false;
  return SEARCH_SIGNALS.some((re) => re.test(q));
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
    return modelFetch(openRouterChatUrl(), {
      method: 'POST',
      headers: openRouterHeaders(),
      body: JSON.stringify({
        ...common,
        ...(params.maxTokens ? { max_tokens: params.maxTokens } : {}),
      }),
      ...(params.signal ? { signal: params.signal } : {}),
    });
  }

  return modelFetch(`${OLLAMA_BASE_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...ollamaAuthHeader() },
    body: JSON.stringify({
      ...common,
      keep_alive: -1,
      options: {
        temperature: 0.9,
        top_p: 0.9,
        repeat_penalty: 1.1,
        num_ctx: params.contextWindow,
        // Fill GPU VRAM first, spill remaining layers to CPU RAM. Auto (-1) is
        // overly conservative on this 2GB 840M and only placed 5/36 layers
        // (~1GB of VRAM left idle). Measured on this box: 24 layers fills
        // ~1887MiB (70% GPU) and loads stably; 28+ fails with CUDA OOM.
        num_gpu: 24,
        // Physical cores, not logical (see src/lib/ollama.ts) — keeps the
        // 2C/4T box responsive during long generations.
        num_thread: OLLAMA_NUM_THREAD,
        ...params.options,
        num_predict: params.maxTokens ?? 2048,
      },
    }),
    ...(params.signal ? { signal: params.signal } : {}),
  });
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
        let delta: StreamDelta | null;
        try {
          delta = parse(line);
        } catch (e) {
          // The stream reported an error (e.g. OpenRouter sent {"error": …}).
          throw new ModelError(
            'upstream_error',
            e instanceof Error ? e.message : 'Model stream error',
            502
          );
        }
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
    } else if (isModelError(error)) {
      throw error;
    } else {
      // The connection to the model server dropped mid-stream.
      throw new ModelError(
        'connection_failed',
        'Connection to the model server was lost mid-stream.',
        502
      );
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
  // The logged-in user's name, woven into the system prompt occasionally so
  // replies can feel personal without sounding like a mail-merge template.
  userName?: string;
  onAssistantContent: (content: string) => void | Promise<void>;
  // Called with the full accumulated answer after every streamed chunk so the
  // caller can persist the partial response incrementally.
  onAssistantChunk?: (content: string) => void | Promise<void>;
  // Called when the model call fails mid-stream so the caller can finalise
  // (e.g. notify reconnected listeners) instead of leaving it running.
  onError?: (message: string, code?: ModelErrorCode) => void | Promise<void>;
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

// Local answers are capped hard; cloud models are fast enough to honour the
// full verbosity tier.
function capVerbosity(verbosity: VerbosityPlan, maxTokens: number): VerbosityPlan {
  if (verbosity.maxTokens <= maxTokens) return verbosity;
  return {
    ...verbosity,
    maxTokens,
    instruction:
      verbosity.instruction + ' Keep the answer focused and prioritise the most important points.',
  };
}

export async function prepareAgentResponse(opts: AgentResponseOptions): Promise<PreparedResponse> {
  const { isCloud, model, messages, options, userName } = opts;
  const contextWindow = opts.contextWindow || DEFAULT_CONTEXT_WINDOW;

  const effective = isCloud ? opts.verbosity : capVerbosity(opts.verbosity, LOCAL_MAX_ANSWER_TOKENS);

  // Reserve room for the system prompt and the full response before trimming,
  // so the selected answer size always fits inside the window.
  const history = trimHistory(
    messages,
    contextWindow,
    SYSTEM_RESERVE_TOKENS + effective.maxTokens
  );
  const fitted = fitVerbosity(effective, contextWindow, history);

  // One signal that fires on user stop or client disconnect, used for every
  // upstream request so a cancelled turn releases the model immediately.
  const upstream = new AbortController();
  if (opts.signal) {
    if (opts.signal.aborted) upstream.abort();
    else opts.signal.addEventListener('abort', () => upstream.abort(), { once: true });
  }

  let sources: SearchResult[] = [];
  let mode: 'direct' | 'grounded' | 'tool' | 'fallback' = 'direct';
  let decision: Decision = { content: '', toolCalls: [] };
  let streamable: Response | null = null;

  if (!isCloud) {
    // Fast local path. A CPU-only model runs at ~1.5 tok/s, so every extra model
    // call costs tens of seconds. Skip the tool-decision round trip entirely: a
    // cheap keyword heuristic gates search and the answer is always streamed.
    const lastUser = lastUserContent(history);
    if (shouldSearchWeb(lastUser)) {
      mode = 'grounded';
      sources = await searchWeb(lastUser).catch(() => []);
      streamable = await callModel({
        isCloud,
        model,
        messages: [
          {
            role: 'system',
            content: `${baseSystem(fitted)}${userIntro(userName)}\n\n${formatSearchContext(sources)}`,
          },
          ...history,
        ],
        stream: true,
        contextWindow,
        maxTokens: fitted.maxTokens,
        options,
        signal: upstream.signal,
      });
    } else {
      mode = 'direct';
      streamable = await callModel({
        isCloud,
        model,
        messages: [
          { role: 'system', content: `${baseSystem(fitted)}${userIntro(userName)}` },
          ...history,
        ],
        stream: true,
        contextWindow,
        maxTokens: fitted.maxTokens,
        options,
        signal: upstream.signal,
      });
    }
  } else {
    // Cloud path: tool calling is near-instant, so let the model decide whether a
    // search is warranted, falling back to search-then-answer if tools are unsupported.
    let fallbackError: unknown = null;
    for (let attempt = 0; attempt < MAX_MODEL_CALLS; attempt++) {
      try {
        if (attempt === 0) {
          // Decision call: tools enabled, non-streaming so tool calls arrive intact.
          const res = await callModel({
            isCloud,
            model,
            messages: [
              { role: 'system', content: `${baseSystem(fitted)}${userIntro(userName)}\n\n` +
                'Decide whether to use the web_search tool. Call it only when the answer needs ' +
                'current, real-world, or web-based information (news, recent events, prices, live data, ' +
                'external docs). Do NOT call it for greetings, simple math, general knowledge you are ' +
                'confident about, or short chit-chat.' },
              ...history,
            ],
            stream: false,
            contextWindow,
            maxTokens: DECISION_MAX_TOKENS,
            tools: [WEB_SEARCH_TOOL],
            options,
            signal: combineSignals(upstream.signal, DECISION_TIMEOUT_MS),
          });

          decision = await parseDecision(isCloud, res);
          const searchCall = decision.toolCalls.find((c) => c.name === 'web_search');

          if (!searchCall) {
            // The model chose to answer directly. Re-issue it as a streamed call
            // so the client renders tokens as they arrive; emit the non-streamed
            // decision text would deliver the entire answer in a single block.
            mode = 'direct';
            streamable = await callModel({
              isCloud,
              model,
              messages: [
                { role: 'system', content: `${baseSystem(fitted)}${userIntro(userName)}` },
                ...history,
              ],
              stream: true,
              contextWindow,
              maxTokens: fitted.maxTokens,
              options,
              signal: upstream.signal,
            });
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
              { role: 'system', content: `${baseSystem(fitted)}${userIntro(userName)}` },
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
            { role: 'system', content: systemWithContext(formatSearchContext(sources), userName) },
            ...history,
          ],
          stream: true,
          contextWindow,
          maxTokens: fitted.maxTokens,
          options,
          signal: upstream.signal,
        });
      } catch (e) {
        fallbackError = e;
        if (attempt === 0 && !isAbortError(e)) continue;
        throw fallbackError;
      }
    }
  }

  const encoder = new TextEncoder();
  const emitAs = (event: Record<string, unknown>) => encoder.encode(sseEncode(event));

  const stream = new ReadableStream({
    async start(controller) {
      // Flush an SSE comment before the (possibly slow) first model call so the
      // client and every proxy see an open stream immediately rather than
      // waiting for the first token.
      try {
        controller.enqueue(encoder.encode(SSE_HEARTBEAT));
      } catch {
        // consumer already gone; nothing to stream to
      }
      // The consumer may disappear (user stop, closed tab, internet blip).
      // Once the first enqueue fails we stop pushing to the client, but we
      // deliberately KEEP generating: every chunk is persisted via
      // onAssistantChunk (and published to any reconnected listener), so a
      // dropped connection never loses or halts the response.
      let clientGone = false;
      let assistantContent = '';
      // Serialise chunk persistence so writes never interleave out of order.
      let persistChain: Promise<void> = Promise.resolve();
      const persist = (fn: () => void | Promise<void>) => {
        persistChain = persistChain.then(fn).catch((e) => {
          console.error('Agent chunk persist error:', e);
        });
      };
      // The per-chunk DB write is the expensive part (a remote round-trip per
      // snapshot on Turso). Throttle it to at most once per interval: the live
      // browser stream already gets every token via the enqueue below, and the
      // final onAssistantContent always persists the complete answer, so a
      // reconnect mid-generation is only ever ~1s behind.
      const CHUNK_FLUSH_INTERVAL_MS = 1000;
      let flushedAt = 0;
      const flushSnapshot = () => {
        if (!assistantContent) return;
        const now = Date.now();
        if (now - flushedAt < CHUNK_FLUSH_INTERVAL_MS) return;
        flushedAt = now;
        const snapshot = assistantContent;
        persist(() => opts.onAssistantChunk?.(snapshot));
      };
      const emit = (event: Record<string, unknown>) => {
        if (event.type === 'content' && typeof event.content === 'string') {
          assistantContent += event.content;
          flushSnapshot();
        }
        if (clientGone) return;
        try {
          controller.enqueue(emitAs(event));
        } catch {
          clientGone = true;
        }
      };
      try {
        if (mode !== 'direct') {
          emit({ type: 'status', text: 'Searching the web…' });
          emit({
            type: 'sources',
            sources: sources.map((s) => ({ title: s.title, url: s.url })),
          });
        }
        const result = await pipeModelStream(streamable!, isCloud, emit, upstream.signal);
        assistantContent = result.content;
        if (result.interrupted) {
          emit({ type: 'interrupted' });
          // Always record the stop, even if no token made it out yet.
          assistantContent = assistantContent
            ? assistantContent + INTERRUPT_SUFFIX
            : INTERRUPT_SUFFIX.trim();
        }
        await persistChain;
        await opts.onAssistantContent(assistantContent);
      } catch (e) {
        console.error('Agent stream error:', e);
        const message = e instanceof Error ? e.message : 'Streaming error';
        const code = isModelError(e) ? e.code : isAbortError(e) ? 'timeout' : undefined;
        emit({ type: 'error', message, ...(code ? { code } : {}) });
        await opts.onError?.(message, code);
        try {
          await persistChain;
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
      // Client went away. We intentionally DO NOT abort the model: generation
      // continues server-side and each chunk is persisted, so a blip or reload
      // can re-sync (GET /api/chats/:id/events) and never loses the answer.
      // A deliberate stop goes through POST /api/chat/stop instead.
    },
  });

  return { stream };
}

function lastUserContent(messages: AgentMessage[]): string {
  const last = [...messages].reverse().find((m) => m.role === 'user');
  return last?.content?.trim() ?? '';
}