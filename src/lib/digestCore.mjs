/**
 * Pure digest logic shared between the Next.js app and the standalone
 * box-side worker (scripts/digest-worker.mjs). Deliberately has NO
 * `server-only` import and NO Next.js imports so a plain `node` process can
 * `import` it directly with no build step — see scripts/digest-worker.mjs.
 *
 * Keep this file framework-agnostic. Anything Next-specific (routes, auth,
 * the DB driver abstraction) belongs in src/lib/digest.ts instead.
 */

// Moderate context expansion (safe now that Tailscale removes the 100s tunnel
// cap). Kept within the model's context window: at 8192 num_ctx we budget
// ~7000 tokens (~28K chars) for the prompt and ~1024 for the reply.
export const MAX_ITEMS_PER_SOURCE = 20;
export const SNIPPET_CHARS = 400; // email/slack body kept per item
// Zoom items are the AI Companion's own meeting summary (from the emailed
// recap) — the richest cross-day context, so give it the most room.
export const ZOOM_SUMMARY_CHARS = 1500;
// Output length is intentionally NOT capped down for speed — quality over
// latency. The box-side worker has no wall-clock deadline, so a slow model
// finishing a full-length briefing is fine.
export const OUTPUT_TOKENS = 1536;
export const CONTEXT_WINDOW = Number(process.env.DIGEST_CONTEXT_WINDOW) || 8192;
// Physical cores, not logical — same reasoning as src/lib/ollama.ts (the box
// is 2C/4T and 4 auto-detected threads saturate the CPU during generation).
export const NUM_THREAD = Number(process.env.OLLAMA_NUM_THREAD) || 2;
// Hard char ceiling on the raw-data block so we never overflow the window even
// with many long items (~4 chars/token; leave headroom for output + prompt).
export const MAX_PROMPT_CHARS = 26_000;

// The calendar day used to bucket items and name summaries. Sources send their
// own `day`, but the cron job / worker needs to know "today" in the user's
// timezone. Configurable via DIGEST_TZ (IANA name); defaults to the host
// timezone. Both the Next app and the worker read this same env var, so keep
// it in sync between Vercel and the box's .env.local.
const DIGEST_TZ = process.env.DIGEST_TZ || undefined;

export function localDay(date = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: DIGEST_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return fmt.format(date); // en-CA yields YYYY-MM-DD
}

function safeParse(json) {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function renderSource(rows, source) {
  const slice = rows.slice(0, MAX_ITEMS_PER_SOURCE);
  const lines = slice.map((r) => {
    const p = safeParse(r.payload) ?? {};
    if (source === 'gmail') {
      const from = (p.from ?? '?').replace(/\s*<[^>]+>/, '').trim(); // drop <addr>
      const subject = (p.subject ?? '(no subject)').slice(0, 200);
      const snippet = (p.snippet ?? '').slice(0, SNIPPET_CHARS);
      return `- ${from}: ${subject}${snippet ? ` — ${snippet}` : ''}`.trim();
    }
    if (source === 'calendar') {
      // Show HH:MM only; full ISO timestamps waste tokens and confuse the model.
      const hhmm = (iso) => (iso ? iso.slice(11, 16) : '');
      const when = [hhmm(p.start), hhmm(p.end)].filter(Boolean).join('–');
      const count = Array.isArray(p.guests) ? p.guests.length : p.guests ?? 0;
      const who = count ? ` (${count} guests)` : '';
      return `- ${when} ${p.title ?? '(untitled)'}${p.location ? ` @ ${p.location}` : ''}${who}`.trim();
    }
    if (source === 'zoom') {
      const actions = p.actionItems?.length
        ? `\n  Action items: ${p.actionItems.slice(0, 8).join('; ')}`
        : '';
      return `- ${p.title ?? 'Meeting'}: ${(p.summary ?? '').slice(0, ZOOM_SUMMARY_CHARS)}${actions}`.trim();
    }
    // slack
    return `- #${p.channel ?? '?'} ${p.user ?? ''}: ${(p.text ?? '').slice(0, SNIPPET_CHARS)}`.trim();
  });
  return lines.join('\n');
}

export function buildDigestPrompt(day, rows) {
  const bySource = new Map();
  for (const r of rows) {
    const arr = bySource.get(r.source) ?? [];
    arr.push(r);
    bySource.set(r.source, arr);
  }

  const sections = [];
  for (const source of ['zoom', 'calendar', 'gmail', 'slack']) {
    const rowsForSource = bySource.get(source);
    if (rowsForSource?.length) {
      sections.push(
        `## ${source.toUpperCase()} (${rowsForSource.length})\n${renderSource(rowsForSource, source)}`
      );
    }
  }

  let rawData = sections.join('\n\n') || '(no items today)';
  // Final safety clamp so a pathological day can't overflow the context window.
  if (rawData.length > MAX_PROMPT_CHARS) {
    rawData = rawData.slice(0, MAX_PROMPT_CHARS) + '\n…(truncated)';
  }

  return [
    `You are my chief of staff writing my daily briefing for ${day} in markdown.`,
    `Write it decisively: state facts plainly, never hedge ("I think", "maybe",`,
    `"apparently", "it seems"), and add no preamble before the first heading and`,
    `no sign-off at the end — the briefing IS the final output.`,
    ``,
    `Ground rules:`,
    `- Every claim in the briefing must be present in the RAW INPUTS below. If a`,
    `  fact (a name, time, date, meeting, or a connection between items) is not in`,
    `  the data, do not include it.`,
    `- NEVER invent meeting times, senders, subjects, or items.`,
    `- If the data underpinning a section is missing, say so in one short line`,
    `  (e.g. "Nothing on your calendar today.") rather than omitting the section`,
    `  or fabricating content.`,
    ``,
    `About the inputs:`,
    `- ZOOM entries are Zoom AI Companion meeting summaries (recaps of calls I`,
    `  attended). Treat them as authoritative; pull out decisions, action items,`,
    `  and owners embedded in the summary text.`,
    `- CALENDAR entries are today's meetings. GMAIL is my inbox. SLACK entries are`,
    `  mentions/DMs sent to me. A source absent from the RAW INPUTS means no data`,
    `  arrived from it for this day.`,
    ``,
    `Write all five sections in this order:`,
    `1. **Follow-ups from meetings** — decisions, action items, and owners drawn`,
    `   ONLY from the ZOOM summary text. Extract them concretely with the owners`,
    `   named in the summary; never restate the recap email's subject line (e.g.`,
    `   "Meeting assets ... are ready!") as if it were a follow-up. If there are`,
    `   no ZOOM entries, write "No meeting follow-ups today."`,
    `2. **Today's schedule** — built ONLY from the CALENDAR rows in the RAW`,
    `   INPUTS (they are already bucketed to ${day}). If there is no CALENDAR`,
    `   section, write "Nothing on your calendar today." Gmail invitations,`,
    `   Slack messages, and Zoom meeting recaps must never appear here — even`,
    `   for a real meeting — they belong in Worth knowing or Follow-ups. Keep`,
    `   each meeting's stated time; never guess times.`,
    `3. **Needs my reply** — emails and Slack mentions/DMs awaiting a response,`,
    `   most important first, each with a one-line "why it matters". If nothing`,
    `   calls for a reply, write "Nothing awaiting your reply."`,
    `4. **Worth knowing** — brief FYIs (announcements, releases, status, and`,
    `   meeting changes — including meetings on other dates or invitations with`,
    `   no date). Group them, not one-by-one. If there is nothing notable,`,
    `   write "Nothing notable today."`,
    `5. **Top priorities today** — 3-5 concrete actions informed by the sections`,
    `   above. If nothing genuinely needs doing, write "Nothing that requires`,
    `   your action today."`,
    ``,
    `Be specific: use real names, times, and subjects exactly as they appear.`,
    `Group related items rather than repeating them. Do not connect two items`,
    `unless the data supports the connection. Skip pure noise. Keep it scannable.`,
    ``,
    `--- RAW INPUTS ---`,
    ``,
    rawData,
  ].join('\n');
}

// Models sometimes wrap the whole reply in a ```markdown … ``` fence, which
// would render as a literal code block. Strip a single outer fence so the
// stored content is raw markdown (rendered by MarkdownMessage exactly like a
// chat bubble). Inner/legitimate code blocks are untouched.
export function stripOuterCodeFence(text) {
  const fence = /^```[a-zA-Z]*\n([\s\S]*?)\n```$/;
  const m = text.match(fence);
  return m ? m[1].trim() : text;
}

// Stream the generation so the connection produces bytes continuously. We
// accumulate the chunks and return the full text once done. `num_ctx` must be
// set explicitly — Ollama defaults small (often 2048/4096) and would silently
// truncate our richer prompt, or force a model reload if it differs from
// whatever context size the box currently has the model pinned at.
//
// No AbortSignal deadline here by design: the caller (the box-side worker)
// has no wall-clock budget to protect. `timeoutMs` is crash/hang protection
// only, not a quality/latency tradeoff — keep it generous.
export async function callDigestModel({
  baseUrl,
  model,
  authHeader = {},
  prompt,
  contextWindow = CONTEXT_WINDOW,
  outputTokens = OUTPUT_TOKENS,
  numThread = NUM_THREAD,
  timeoutMs = 30 * 60_000,
}) {
  const res = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeader },
    body: JSON.stringify({
      model,
      stream: true,
      messages: [{ role: 'user', content: prompt }],
      keep_alive: -1,
      options: {
        temperature: 0.4,
        num_ctx: contextWindow,
        num_predict: outputTokens,
        num_thread: numThread,
      },
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '');
    throw new Error(`model responded ${res.status}${text ? `: ${text.slice(0, 300)}` : ''}`);
  }

  // Ollama streams newline-delimited JSON objects, each with a partial
  // message.content; the final object has done=true.
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      // Only malformed JSON (keep-alive noise) is swallowed here. A genuine
      // `{"error": "..."}` line from Ollama must propagate, not be treated
      // the same as unparseable input — otherwise a mid-stream model error
      // silently yields an empty/truncated "success".
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      if (obj.error) throw new Error(obj.error);
      if (obj.message?.content) content += obj.message.content;
    }
  }
  return stripOuterCodeFence(content.trim());
}
