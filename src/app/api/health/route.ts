import { NextRequest, NextResponse } from 'next/server';
import { OLLAMA_BASE_URL, OLLAMA_MODEL, ollamaAuthHeader } from '@/lib/ollama';
import { checkHealthAccess } from '@/lib/auth';

const DEFAULT_MODEL = OLLAMA_MODEL;

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const started = Date.now();

  if (!checkHealthAccess(request)) {
    return NextResponse.json(
      { status: 'unauthorized', error: 'Unauthorized', latencyMs: Date.now() - started },
      { status: 401 }
    );
  }

  try {
    const response = await fetch(`${OLLAMA_BASE_URL}/api/tags`, {
      cache: 'no-store',
      headers: { ...ollamaAuthHeader() },
    });
    const latencyMs = Date.now() - started;

    if (!response.ok) {
      return NextResponse.json(
        { status: 'error', ollama: false, model: DEFAULT_MODEL, latencyMs },
        { status: 503 }
      );
    }

    const data = await response.json();
    const models: string[] = (data.models || []).map((m: { name: string }) => m.name);
    const modelAvailable = models.some(
      (name) => name === DEFAULT_MODEL || name.split(':')[0] === DEFAULT_MODEL.split(':')[0]
    );

    return NextResponse.json({
      status: modelAvailable ? 'ok' : 'degraded',
      ollama: true,
      model: DEFAULT_MODEL,
      modelAvailable,
      models,
      latencyMs,
    });
  } catch {
    return NextResponse.json(
      { status: 'error', ollama: false, model: DEFAULT_MODEL, latencyMs: Date.now() - started },
      { status: 503 }
    );
  }
}
