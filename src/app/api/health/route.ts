import { NextRequest, NextResponse } from 'next/server';
import { OLLAMA_BASE_URL, OLLAMA_MODEL, ollamaAuthHeader } from '@/lib/ollama';
import { checkHealthAccess } from '@/lib/auth';
import { pingDb } from '@/lib/db';

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

  let ollama = false;
  let modelAvailable = false;
  let models: string[] = [];
  try {
    const response = await fetch(`${OLLAMA_BASE_URL}/api/tags`, {
      cache: 'no-store',
      headers: { ...ollamaAuthHeader() },
    });
    if (response.ok) {
      const data = await response.json();
      models = (data.models || []).map((m: { name: string }) => m.name);
      modelAvailable = models.some(
        (name) => name === DEFAULT_MODEL || name.split(':')[0] === DEFAULT_MODEL.split(':')[0]
      );
      ollama = true;
    }
  } catch {
    ollama = false;
  }

  let db = false;
  try {
    await pingDb();
    db = true;
  } catch (error) {
    console.error('Health: database unreachable:', error);
  }

  const latencyMs = Date.now() - started;

  // 503 only when the app cannot work at all (Ollama or the DB is down). A
  // missing configured model is "degraded": the app still serves other models.
  const status = ollama && db && modelAvailable ? 'ok' : ollama && db ? 'degraded' : 'error';

  return NextResponse.json(
    { status, ollama, db, model: DEFAULT_MODEL, modelAvailable, models, latencyMs },
    { status: status === 'ok' || status === 'degraded' ? 200 : 503 }
  );
}
