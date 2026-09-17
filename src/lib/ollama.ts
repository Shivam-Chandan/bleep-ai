export const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
export const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:3b';

const OLLAMA_AUTH_TOKEN = process.env.OLLAMA_AUTH_TOKEN;

export function ollamaAuthHeader(): Record<string, string> {
  return OLLAMA_AUTH_TOKEN ? { Authorization: `Bearer ${OLLAMA_AUTH_TOKEN}` } : {};
}
