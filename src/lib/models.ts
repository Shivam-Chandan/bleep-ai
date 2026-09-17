export type ModelProvider = 'local' | 'openrouter';

export interface ChatModel {
  id: string;
  name: string;
  provider: ModelProvider;
  description?: string;
}

export const LOCAL_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:3b';

// Curated free models served by OpenRouter (no cost, subject to their
// free-tier rate limits). `openrouter/free` is the smart router: it
// auto-picks among whatever free models are currently available, which
// keeps the single option relevant even as specific `:free` models
// rotate in and out.
export const CLOUD_MODELS: ChatModel[] = [
  { id: 'openrouter/free', name: 'Smart Router', provider: 'openrouter', description: 'Auto-picks the best available free model' },
];

export const DEFAULT_MODEL = LOCAL_MODEL;

export function isCloudModel(modelId: string): boolean {
  return CLOUD_MODELS.some((m) => m.id === modelId);
}