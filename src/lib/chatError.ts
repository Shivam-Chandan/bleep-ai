import type { ModelErrorCode } from './modelErrors';

/**
 * Client-safe counterpart to the server's coded ModelErrors. Maps the code to a
 * friendly pair (headline + hint) so the UI can distinguish "connection broke"
 * from "the model failed to load" instead of showing a generic error.
 */

export const ERROR_HINTS: Record<ModelErrorCode, { title: string; hint: string }> = {
  connection_failed: {
    title: 'Local AI is unreachable',
    hint: 'Ollama or its tunnel dropped the connection. Wait a moment and try again.',
  },
  timeout: {
    title: 'The model took too long',
    hint: 'Loading a local model can take a couple of minutes on this machine. Try again, or switch to a cloud model.',
  },
  unauthorized: {
    title: 'Access was rejected',
    hint: 'The model server refused our credentials. Check the Ollama auth token or OpenRouter key.',
  },
  model_not_found: {
    title: 'Model not installed',
    hint: 'The selected model is not on the server — pick a different model or pull it first.',
  },
  model_load_failed: {
    title: 'Model failed to load',
    hint: 'The model could not load (often an out-of-memory or CUDA error). Try again or use a smaller model.',
  },
  upstream_error: {
    title: 'The model server returned an error',
    hint: 'An unexpected error happened on the model server. Try again.',
  },
  internal: {
    title: 'Something went wrong',
    hint: 'An unexpected error occurred. Try again.',
  },
};

export function isKnownErrorCode(code: string | undefined): code is ModelErrorCode {
  return !!code && code in ERROR_HINTS;
}

export function hintFor(
  code: string | null | undefined
): { title: string; hint: string } {
  const key: ModelErrorCode = isKnownErrorCode(code ?? undefined)
    ? (code as ModelErrorCode)
    : 'internal';
  return ERROR_HINTS[key];
}

/** Error carrying a coded reason so the UI can render the right banner. */
export class ApiError extends Error {
  code: string;
  status?: number;

  constructor(message: string, code = 'internal', status?: number) {
    super(message);
    this.name = 'ApiError';
    this.code = code in ERROR_HINTS ? code : 'internal';
    this.status = status;
  }
}

/** Pulls the code off any thrown value, defaulting to a sensible guess. */
export function extractCode(
  error: unknown,
  fallback: ModelErrorCode
): ModelErrorCode {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (isKnownErrorCode(typeof code === 'string' ? code : undefined)) return code as ModelErrorCode;
  }
  return fallback;
}