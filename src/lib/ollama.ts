export const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
export const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:3b';

// How many CPU threads Ollama may use for inference. Defaults to the physical
// core count: on this box (2C/4T Haswell) the auto-detected 4 logical threads
// saturate the CPU and hyperthreading slightly slows llama.cpp anyway, so 2
// threads keeps the rest of the system responsive. Tune via OLLAMA_NUM_THREAD.
export const OLLAMA_NUM_THREAD = Number(process.env.OLLAMA_NUM_THREAD) || 2;

const OLLAMA_AUTH_TOKEN = process.env.OLLAMA_AUTH_TOKEN;

export function ollamaAuthHeader(): Record<string, string> {
  return OLLAMA_AUTH_TOKEN ? { Authorization: `Bearer ${OLLAMA_AUTH_TOKEN}` } : {};
}
