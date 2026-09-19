import { NextRequest, NextResponse } from 'next/server';
import { OLLAMA_BASE_URL, OLLAMA_MODEL, OLLAMA_NUM_THREAD, ollamaAuthHeader } from '@/lib/ollama';
import { checkHealthAccess } from '@/lib/auth';

const DEFAULT_MODEL = OLLAMA_MODEL;

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  if (!checkHealthAccess(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const contextWindow = Number(process.env.OLLAMA_CONTEXT_WINDOW) || 4096;
    const response = await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...ollamaAuthHeader() },
      body: JSON.stringify({
        model: DEFAULT_MODEL,
        prompt: '',
        stream: false,
        keep_alive: -1,
        options: { num_predict: 1, num_ctx: contextWindow, num_gpu: 24, num_thread: OLLAMA_NUM_THREAD },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      return NextResponse.json(
        { ok: false, error: `Ollama API error: ${response.status} ${errorText}` },
        { status: response.status }
      );
    }

    const data = await response.json();
    return NextResponse.json({ ok: true, model: DEFAULT_MODEL, done_reason: data.done_reason });
  } catch (error) {
    console.error('Warm-up error:', error);
    return NextResponse.json({ ok: false, error: 'Failed to connect to Ollama' }, { status: 500 });
  }
}
