import 'server-only';
import { OLLAMA_BASE_URL, OLLAMA_MODEL, ollamaAuthHeader } from './ollama';
import {
  listDigestItems,
  upsertDigestSummary,
  type DigestItemRow,
} from './queries';

// Builds a compact, source-grouped text block from a user's raw items for one
// day, then asks the local model for a structured daily briefing (markdown).

// Moderate context expansion (safe now that Tailscale removes the 100s tunnel
// cap). Kept within the model's context window: at 8192 num_ctx we budget
// ~7000 tokens (~28K chars) for the prompt and ~1024 for the reply.
const MAX_ITEMS_PER_SOURCE = 20;
const SNIPPET_CHARS = 400; // email/slack body kept per item
// Zoom items are the AI Companion's own meeting summary (from the emailed
// recap) — the richest cross-day context, so give it the most room.
const ZOOM_SUMMARY_CHARS = 1500;
const OUTPUT_TOKENS = 1536;
const CONTEXT_WINDOW = Number(process.env.DIGEST_CONTEXT_WINDOW) || 8192;
// Hard char ceiling on the raw-data block so we never overflow the window even
// with many long items (~4 chars/token; leave headroom for output + prompt).
const MAX_PROMPT_CHARS = 26_000;

// The calendar day used to bucket items and name summaries. Sources send their
// own `day`, but the cron job needs to know "today" in the user's timezone.
// Configurable via DIGEST_TZ (IANA name); defaults to the host timezone.
const DIGEST_TZ = process.env.DIGEST_TZ || undefined;

export function localDay(date: Date = new Date()): string {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: DIGEST_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return fmt.format(date); // en-CA yields YYYY-MM-DD
}

interface GmailPayload {
  from?: string;
  subject?: string;
  snippet?: string;
  time?: string;
}
interface CalendarPayload {
  title?: string;
  start?: string;
  end?: string;
  location?: string;
  guests?: number | string[]; // now a count from Apps Script; array for legacy
}
interface SlackPayload {
  channel?: string;
  user?: string;
  text?: string;
  time?: string;
}
interface ZoomPayload {
  title?: string; // meeting topic (from the AI summary email subject)
  summary?: string; // Zoom AI Companion's meeting summary (from the recap email)
  actionItems?: string[]; // optional; usually embedded in the summary text
}

function safeParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function renderSource(rows: DigestItemRow[], source: string): string {
  const slice = rows.slice(0, MAX_ITEMS_PER_SOURCE);
  const lines = slice.map((r) => {
    const p = safeParse(r.payload) ?? {};
    if (source === 'gmail') {
      const g = p as GmailPayload;
      const from = (g.from ?? '?').replace(/\s*<[^>]+>/, '').trim(); // drop <addr>
      const subject = (g.subject ?? '(no subject)').slice(0, 200);
      const snippet = (g.snippet ?? '').slice(0, SNIPPET_CHARS);
      return `- ${from}: ${subject}${snippet ? ` — ${snippet}` : ''}`.trim();
    }
    if (source === 'calendar') {
      const c = p as CalendarPayload;
      // Show HH:MM only; full ISO timestamps waste tokens and confuse the model.
      const hhmm = (iso?: string) => (iso ? iso.slice(11, 16) : '');
      const when = [hhmm(c.start), hhmm(c.end)].filter(Boolean).join('–');
      const count = Array.isArray(c.guests) ? c.guests.length : c.guests ?? 0;
      const who = count ? ` (${count} guests)` : '';
      return `- ${when} ${c.title ?? '(untitled)'}${c.location ? ` @ ${c.location}` : ''}${who}`.trim();
    }
    if (source === 'zoom') {
      const z = p as ZoomPayload;
      const actions = z.actionItems?.length
        ? `\n  Action items: ${z.actionItems.slice(0, 8).join('; ')}`
        : '';
      return `- ${z.title ?? 'Meeting'}: ${(z.summary ?? '').slice(0, ZOOM_SUMMARY_CHARS)}${actions}`.trim();
    }
    // slack
    const s = p as SlackPayload;
    return `- #${s.channel ?? '?'} ${s.user ?? ''}: ${(s.text ?? '').slice(0, SNIPPET_CHARS)}`.trim();
  });
  return lines.join('\n');
}

export function buildDigestPrompt(day: string, rows: DigestItemRow[]): string {
  const bySource = new Map<string, DigestItemRow[]>();
  for (const r of rows) {
    const arr = bySource.get(r.source) ?? [];
    arr.push(r);
    bySource.set(r.source, arr);
  }

  const sections: string[] = [];
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
    `You are my chief of staff. Read today's raw inputs below and write my daily`,
    `briefing for ${day} in markdown. Think about what actually matters: what needs`,
    `my action, what's time-sensitive, and how items connect (e.g. an email about a`,
    `meeting on my calendar, or a Slack mention following up a decision).`,
    ``,
    `About the inputs:`,
    `- ZOOM entries are Zoom AI Companion meeting summaries (recaps of calls I`,
    `  attended). Treat them as authoritative; pull out decisions, action items,`,
    `  and owners embedded in the summary text.`,
    `- SLACK entries are mentions/DMs sent to me (from Slack notification emails).`,
    `- GMAIL is my inbox; CALENDAR is today's meetings.`,
    ``,
    `Write these sections, omitting any that have nothing real to say:`,
    `- **Follow-ups from meetings** — carry-over tasks, decisions, and action items`,
    `  drawn from the ZOOM summaries. Attribute owners where the summary names them.`,
    `- **Today's schedule** — meetings in chronological order, with the one or two`,
    `  that need prep called out.`,
    `- **Needs my reply** — emails and Slack mentions/DMs awaiting a response from`,
    `  me, most important first, each with a one-line "why it matters".`,
    `- **Worth knowing** — brief FYIs (announcements, releases, status) grouped, not`,
    `  listed one-by-one.`,
    `- **Top priorities today** — 3-5 concrete things I should get done, informed by`,
    `  everything above.`,
    ``,
    `Be specific and use real names, times, and subjects. Group related items rather`,
    `than repeating them. Only list a follow-up drawn from a meeting that actually`,
    `appears in the ZOOM section. Do not invent anything not present in the data.`,
    `Skip pure noise. Keep it scannable.`,
    ``,
    `--- RAW INPUTS ---`,
    ``,
    rawData,
  ].join('\n');
}

const SUMMARY_TIMEOUT_MS = 280_000;

// Stream the generation so the connection produces bytes continuously. We
// accumulate the chunks and return the full text once done. `num_ctx` must be
// set explicitly — Ollama defaults small (often 2048) and would silently
// truncate our richer prompt.
async function callModelOnce(prompt: string): Promise<string> {
  const res = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...ollamaAuthHeader() },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      stream: true,
      messages: [{ role: 'user', content: prompt }],
      keep_alive: -1,
      options: {
        temperature: 0.4,
        num_ctx: CONTEXT_WINDOW,
        num_predict: OUTPUT_TOKENS,
      },
    }),
    signal: AbortSignal.timeout(SUMMARY_TIMEOUT_MS),
  });
  if (!res.ok || !res.body) {
    throw new Error(`model responded ${res.status}`);
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
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      try {
        const obj = JSON.parse(line) as {
          message?: { content?: string };
          error?: string;
        };
        if (obj.error) throw new Error(obj.error);
        if (obj.message?.content) content += obj.message.content;
      } catch {
        // ignore non-JSON keep-alive lines
      }
    }
  }
  return stripOuterCodeFence(content.trim());
}

// Models sometimes wrap the whole reply in a ```markdown … ``` fence, which
// would render as a literal code block. Strip a single outer fence so the
// stored content is raw markdown (rendered by MarkdownMessage exactly like a
// chat bubble). Inner/legitimate code blocks are untouched.
function stripOuterCodeFence(text: string): string {
  const fence = /^```[a-zA-Z]*\n([\s\S]*?)\n```$/;
  const m = text.match(fence);
  return m ? m[1].trim() : text;
}

// A tiny call that forces Ollama to load the model into memory (pinned by
// keep_alive: -1). Cold start can be ~45s; doing it as a separate small request
// keeps the subsequent large generation from blowing the tunnel's ~100s window.
async function warmModel(): Promise<void> {
  try {
    await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...ollamaAuthHeader() },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        stream: false,
        keep_alive: -1,
        messages: [{ role: 'user', content: 'ok' }],
        options: { num_predict: 1 },
      }),
      signal: AbortSignal.timeout(90_000),
    });
  } catch {
    // best effort; the real call will still try
  }
}

// Generate and persist a summary for one user/day. Returns the markdown, or
// null when there were no items to summarize.
export async function summarizeDay(
  userId: string,
  day: string
): Promise<string | null> {
  const rows = await listDigestItems(userId, day);
  if (rows.length === 0) return null;
  await warmModel(); // load the model first so the big call starts warm
  const prompt = buildDigestPrompt(day, rows);
  const content = await callModelOnce(prompt);
  if (!content) return null;
  await upsertDigestSummary(userId, day, content);
  return content;
}
