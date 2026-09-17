import 'server-only';

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_BASE_URL = process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1';
const OPENROUTER_SITE_URL = process.env.OPENROUTER_SITE_URL;
const OPENROUTER_SITE_NAME = process.env.OPENROUTER_SITE_NAME || 'Bleep AI';

export function openRouterConfigured(): boolean {
  return Boolean(OPENROUTER_API_KEY);
}

export function openRouterHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${OPENROUTER_API_KEY}`,
    'X-Title': OPENROUTER_SITE_NAME,
  };
  if (OPENROUTER_SITE_URL) headers['HTTP-Referer'] = OPENROUTER_SITE_URL;
  return headers;
}

export function openRouterChatUrl(): string {
  return `${OPENROUTER_BASE_URL}/chat/completions`;
}