import 'server-only';

/**
 * Coded model-layer errors. The code travels to the frontend (in stream events
 * and JSON error responses) so the UI can tell apart "model is down / tunnel
 * broke / model failed to load / model not installed" instead of showing a
 * generic "Internal server error".
 */

export type ModelErrorCode =
  | 'connection_failed' // could not reach Ollama / OpenRouter (fetch threw)
  | 'timeout' // llm reply took too long (HTTP 408/504 or aborted by client)
  | 'unauthorized' // llm server rejected our credentials (401/403)
  | 'model_not_found' // selected model is not installed on the server (404)
  | 'model_load_failed' // model exists but failed to load (bad blob, OOM, CUDA)
  | 'upstream_error' // other non-2xx from the model server
  | 'internal'; // anything unexpected

export class ModelError extends Error {
  code: ModelErrorCode;
  status?: number;
  detail?: string;

  constructor(code: ModelErrorCode, message: string, status?: number, detail?: string) {
    super(message);
    this.name = 'ModelError';
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}

export function isModelError(error: unknown): error is ModelError {
  return error instanceof ModelError;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function classifyStatus(status: number, body: string): ModelErrorCode {
  const lower = body.toLowerCase();
  if (status === 401 || status === 403) return 'unauthorized';
  if (status === 408 || status === 504) return 'timeout';
  if (status === 404 && /model/.test(lower)) return 'model_not_found';
  if (
    /load\b|load fail|failed to load|llama-server|cudart|cuda error|nacl|no backend|timed out waiting|memory pressure|out of memory|cannot allocate/.test(
      lower
    )
  ) {
    return 'model_load_failed';
  }
  return 'upstream_error';
}

export async function modelErrorFromResponse(response: Response): Promise<ModelError> {
  let body = '';
  try {
    body = (await response.text()).slice(0, 800);
  } catch {
    // body unreadable — fall through with empty detail
  }
  const code = classifyStatus(response.status, body);
  // Try to pull Ollama's own error message out of the body.
  const parsed = safeParse(body) as { error?: string } | null;
  const detail = parsed?.error || body || undefined;
  const message =
    detail && detail.length > 0
      ? detail.slice(0, 300)
      : `Model server returned HTTP ${response.status}`;
  return new ModelError(code, message, response.status, detail);
}

function safeParse(text: string): unknown {
  const start = text.indexOf('{');
  if (start === -1) return null;
  try {
    return JSON.parse(text.slice(start));
  } catch {
    return null;
  }
}

/**
 * Wrapper around fetch that turns transport failures and non-2xx responses into
 * coded ModelError instances. AbortErrors are re-thrown unchanged so callers can
 * still tell a user stop / timeout apart from a real failure.
 */
export async function modelFetch(url: string, init?: RequestInit): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw new ModelError(
      'connection_failed',
      `Could not reach the model server at ${hostOf(url)}. Check that Ollama and its tunnel are running.`
    );
  }
  if (response.ok) return response;
  throw await modelErrorFromResponse(response);
}

export function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === 'AbortError') ||
    (error instanceof Error && error.name === 'AbortError') ||
    (error instanceof Error && error.name === 'TimeoutError')
  );
}

/** Maps a coded model error to a user-facing HTTP status. */
export function statusForCode(code: ModelErrorCode): number {
  switch (code) {
    case 'model_not_found':
      return 404;
    case 'unauthorized':
      return 502;
    case 'timeout':
      return 504;
    case 'connection_failed':
    case 'upstream_error':
      return 502;
    case 'model_load_failed':
      return 503;
    default:
      return 500;
  }
}