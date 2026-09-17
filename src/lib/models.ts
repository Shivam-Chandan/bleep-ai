export type ModelProvider = 'local' | 'openrouter';

export interface ChatModel {
  id: string;
  name: string;
  provider: ModelProvider;
  description?: string;
}

export const LOCAL_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:3b';

// Curated free models served by OpenRouter (no cost, subject to their
// free-tier rate limits). The `openrouter/free` router auto-picks from
// whatever free models are currently available, which keeps the list
// relevant even as specific `:free` models rotate in and out.
export const CLOUD_MODELS: ChatModel[] = [
  { id: 'openrouter/free', name: 'OpenRouter Free (auto)', provider: 'openrouter', description: 'Auto-picks among free models' },
  { id: 'nvidia/nemotron-3-ultra-550b-a55b:free', name: 'Nemotron 3 Ultra', provider: 'openrouter', description: '1M context, strong reasoning' },
  { id: 'openai/gpt-oss-20b:free', name: 'GPT-OSS 20B', provider: 'openrouter', description: 'Apache 2.0, 131K context' },
  { id: 'nvidia/nemotron-3-nano-30b-a3b:free', name: 'Nemotron 3 Nano 30B', provider: 'openrouter', description: '256K context, fast' },
  { id: 'poolside/laguna-m.1:free', name: 'Laguna M.1', provider: 'openrouter', description: 'Coding-focused agent model' },
  { id: 'cohere/north-mini-code:free', name: 'North Mini Code', provider: 'openrouter', description: 'Coding, 256K context' },
  { id: 'google/gemma-4-26b-a4b-it:free', name: 'Gemma 4 26B', provider: 'openrouter', description: '262K context' },
  { id: 'stepfun/step-3.7-flash:free', name: 'Step 3.7 Flash', provider: 'openrouter', description: '262K context, fast' },
  { id: 'inclusionai/ling-3.0-flash:free', name: 'Ling 3.0 Flash', provider: 'openrouter', description: '262K context' },
];

export const DEFAULT_MODEL = LOCAL_MODEL;

export function isCloudModel(modelId: string): boolean {
  return CLOUD_MODELS.some((m) => m.id === modelId);
}