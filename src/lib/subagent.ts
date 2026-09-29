import 'server-only';
import { OLLAMA_BASE_URL, ollamaAuthHeader } from './ollama';
import { modelFetch } from './modelErrors';

/**
 * Sub-agent scheduler.
 *
 * The sub-agent is a tiny, RAM-only companion model (qwen2.5:0.5b-sub) that the
 * resident 7B can delegate small self-contained tasks to (titles, extraction,
 * one-shot lookups, trivial math) via its `subagent` tool.
 *
 * Scheduling rule (measured, not guessed — see docs/BENCHMARKING.md):
 *   - Both models can stay resident together ONLY if the sub-agent runs with
 *     num_gpu 0 (RAM only) and a small context (1024). The tag qwen2.5:0.5b-sub
 *     pins both, so callers don't need to pass them.
 *   - The sub-agent runs at full speed (~20-23 tok/s) whenever the 7B is NOT
 *     streaming. That is exactly the state of affairs during a *blocking* tool
 *     call: the 7B has paused to wait for the tool result, so it is idle by
 *     definition. Therefore "serialise" is the efficient default — no queue,
 *     no contention, just run it now.
 *   - *Parallel* (background) execution is offered for fire-and-forget side
 *     work whose result is NOT woven into the 7B's reply. The 7B keeps
 *     streaming while the sub-agent works; both share the DDR3 bus, so the
 *     sub-agent drops to ~9-10 tok/s and the 7B loses ~3-4% while they
 *     overlap. That is the price of parallelism on this box and callers
 *     accept it explicitly by choosing mode "background".
 */

export const SUBAGENT_MODEL = process.env.OLLAMA_SUBAGENT_MODEL || 'qwen2.5:0.5b-sub';
export const SUBAGENT_CTX = Number(process.env.OLLAMA_SUBAGENT_CTX) || 1024;
export const SUBAGENT_MAX_TOKENS = Number(process.env.OLLAMA_SUBAGENT_MAX_TOKENS) || 512;

// Smallest deterministic system prompt: the sub-agent's whole job is to do
// exactly what the task says and nothing else. No chit-chat, no framing.
const SUBAGENT_SYSTEM =
  'You are a precise sub-agent. Complete exactly the task you are given and return ONLY the result ' +
  ': no preamble, no commentary, no sign-off, no markdown unless the task asks for it. ' +
  'The caller is waiting — keep the output as short as the task allows.';

export interface SubagentOptions {
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
}

/** Run the sub-agent once and return the raw completion text (trimmed). */
export async function runSubagent(task: string, opts: SubagentOptions = {}): Promise<string> {
  const res = await modelFetch(`${OLLAMA_BASE_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...ollamaAuthHeader() },
    body: JSON.stringify({
      model: SUBAGENT_MODEL,
      messages: [
        { role: 'system', content: SUBAGENT_SYSTEM },
        { role: 'user', content: task },
      ],
      stream: false,
      keep_alive: -1,
      options: {
        num_ctx: SUBAGENT_CTX,
        num_predict: opts.maxTokens ?? SUBAGENT_MAX_TOKENS,
        temperature: opts.temperature ?? 0.4,
        // RAM only — see header comment. Also pinned by the model tag.
        num_gpu: 0,
      },
    }),
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  const data = (await res.json()) as { message?: { content?: unknown } };
  const text = String(data?.message?.content ?? '').trim();
  if (!text) throw new Error('Sub-agent returned an empty result');
  return text;
}

/**
 * Fire-and-forget wrapper. Deliberately does NOT swallow errors: attach a
 * rejection handler (e.g. `void run...().catch(...)`) at the call site.
 */
export function runSubagentBackground(task: string, opts: SubagentOptions = {}): Promise<string> {
  return runSubagent(task, opts);
}