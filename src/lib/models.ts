export type ModelProvider = 'local' | 'openrouter';

export interface ChatModel {
  id: string;
  name: string;
  provider: ModelProvider;
  description?: string;
  // Total tokens the model can hold (prompt + completion).
  contextWindow: number;
}

export const LOCAL_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:3b';

// Ollama defaults to a 2048-token context unless told otherwise, which silently
// truncates longer chats. We request a larger window and reserve the remainder
// for history. Override per deployment if the machine has different memory.
export const LOCAL_CONTEXT_WINDOW =
  Number(process.env.OLLAMA_CONTEXT_WINDOW) || 8192;

// `openrouter/free` routes to whichever free model is available; those vary, so
// we assume a conservative floor that all common free models satisfy.
export const CLOUD_CONTEXT_WINDOW =
  Number(process.env.OPENROUTER_CONTEXT_WINDOW) || 32768;

// Curated free models served by OpenRouter (no cost, subject to their
// free-tier rate limits). `openrouter/free` is the smart router: it
// auto-picks among whatever free models are currently available, which
// keeps the single option relevant even as specific `:free` models
// rotate in and out.
export const CLOUD_MODELS: ChatModel[] = [
  {
    id: 'openrouter/free',
    name: 'Smart Router',
    provider: 'openrouter',
    description: 'Auto-picks the best available free model',
    contextWindow: CLOUD_CONTEXT_WINDOW,
  },
];

export const DEFAULT_MODEL = LOCAL_MODEL;

export function isCloudModel(modelId: string): boolean {
  return CLOUD_MODELS.some((m) => m.id === modelId);
}

export function getContextWindow(modelId: string): number {
  return isCloudModel(modelId) ? CLOUD_CONTEXT_WINDOW : LOCAL_CONTEXT_WINDOW;
}
