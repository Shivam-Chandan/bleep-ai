// Server-Sent Events framing for the streaming endpoints.
//
// Why SSE instead of newline-delimited JSON: Vercel (and most CDNs/proxies)
// gzip-compress text responses, and compression buffers the body before
// emitting bytes — which makes a token stream arrive all at once. Responses
// typed `text/event-stream` are explicitly excluded from compression, so
// tokens flush as the model produces them.
export const SSE_CONTENT_TYPE = 'text/event-stream; charset=utf-8';

// A comment line. SSE comments are ignored by clients but force the server and
// every intermediary to flush headers and establish the stream immediately,
// before the (possibly slow) first model token exists.
export const SSE_HEARTBEAT = ': connected\n\n';

export function sseEncode(event: unknown): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

// Extracts the JSON payload from one line of a text/event-stream response.
// Returns null for blank lines, SSE comments (": keep-alive"), and anything
// that is not valid JSON. Bare newline-delimited JSON is accepted too, so the
// same parser reads both old and new framing.
export function parseSseLine<T = unknown>(line: string): T | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith(':')) return null;
  const payload = trimmed.startsWith('data:') ? trimmed.slice(5).trim() : trimmed;
  if (!payload) return null;
  try {
    return JSON.parse(payload) as T;
  } catch {
    return null;
  }
}
