/**
 * Deterministic sub-agent delegation trigger (local path only).
 *
 * The resident 7B produces ~2 tok/s, and measured on this box the full Bleep
 * persona prompt all but switches OFF qwen2.5's tool-calling — with the app's
 * system prompt it never emits a `subagent` call on its own, and even
 * `tool_choice: "required"` is unreliable against the long persona text. The
 * feature was effectively unreachable.
 *
 * So instead of trusting the 7B's flaky free choice, a small whitelist
 * classifier decides WHEN a turn is a delegation-appropriate microtask (a
 * title/label, naming, extracting a fact, one-line/one-word output, or trivial
 * arithmetic). When it fires, the orchestrator swaps in a short tool-focused
 * system prompt and forces `tool_choice: "required"` — which together make the
 * 7B reliably emit the call (verified ~10/10 against the live model). When it
 * does not fire, the tools block is omitted entirely: zero tool overhead and no
 * risk of a stray call on judgment/reasoning turns.
 *
 * The whitelist is deliberately conservative — a miss just means the 7B answers
 * itself (current behaviour); a hit must never capture a judgment/reasoning task.
 */

const TITLE_RE =
  /(?:give|assign|write|create|come up with|think of|suggest|pick|choose)\b[^.\n]{0,50}\b(?:title|label|heading)\b/i;
const CHAT_TITLE_RE =
  /\b(?:title|label|heading)\b[^.\n]{0,40}\b(?:this chat|this thread|this conversation|the chat)\b/i;
const NAME_RE =
  /(?:what should|what'?s a (?:good|better)|suggest|come up with|think of|pick|choose)\b[^.\n]{0,40}\b(?:name|nickname)\b/i;
const EXTRACT_RE =
  /(?:extract|pull out|pick out)\b[^.\n]{0,60}\b(?:names?|facts?|items?|numbers?|companies?|words?|details?|dates?|titles?)\b/i;
const AS_LIST_RE =
  /\b(?:names?|companies?|items?|numbers?|dates?|words?|titles?|facts?)\b[^.\n]{0,20}\b(?:as a list|comma[- ]separated)\b/i;
const ONE_LINE_RE = /\b(?:one[- ]line|one[- ]word|single[- ]word|in one line|in one word|short[- ]title)\b/i;
const SUMMARIZE_RE = /\bsummariz\w*\b[^.\n]{0,40}\b(?:one line|one sentence)\b/i;
const ARITH_RE =
  /\b(?:what'?s|what is|calculate|compute|how much is)\b[^.\n]{0,30}\b\d{1,4}\s*[+×x*\-÷/]\s*\d{1,4}\b/i;

const PATTERNS = [
  TITLE_RE,
  CHAT_TITLE_RE,
  NAME_RE,
  EXTRACT_RE,
  AS_LIST_RE,
  ONE_LINE_RE,
  SUMMARIZE_RE,
  ARITH_RE,
];

export function shouldDelegate(message: string): boolean {
  const text = String(message ?? '').trim();
  if (!text || text.length > 400) return false; // long prompts are judgment tasks
  return PATTERNS.some((re) => re.test(text));
}

/**
 * Short, tool-focused system prompt used ONLY on a delegated turn. The full
 * persona makes the 7B flaky at tool-calling; for a microtask (answer in a word
 * or two) the persona adds nothing, and this compact licence fires the call
 * reliably. The continuation round keeps the same system so the closing reply
 * matches.
 */
export const DELEGATE_SYSTEM =
  `You may call the "subagent" tool for genuinely small self-contained tasks. ` +
  `Delegate only what a one-shot small model can nail. When you call it, use mode ` +
  `"blocking" and weave the result into your reply; use mode "background" only for ` +
  `fire-and-forget side tasks. A tool call alone is never a reply: you must still ` +
  `answer the user.`;