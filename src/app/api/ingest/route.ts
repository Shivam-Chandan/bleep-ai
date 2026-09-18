import { NextRequest, NextResponse } from 'next/server';
import { resolveIngestUser } from '@/lib/ingest';
import {
  addDigestItems,
  type DigestItemInput,
  type DigestSource,
} from '@/lib/queries';

export const dynamic = 'force-dynamic';

const VALID_SOURCES: DigestSource[] = ['gmail', 'calendar', 'slack', 'zoom'];
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_ITEMS = 500;

interface IngestBody {
  source?: string;
  items?: Array<{
    externalId?: string | null;
    day?: string;
    payload?: unknown;
  }>;
}

// POST /api/ingest
// Auth: Authorization: Bearer <ingest token>  (or X-Ingest-Token header)
// Body: { source: 'gmail'|'calendar'|'slack'|'zoom', items: [{ externalId, day, payload }] }
export async function POST(request: NextRequest) {
  const userId = await resolveIngestUser(request);
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: IngestBody;
  try {
    body = (await request.json()) as IngestBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const source = body.source as DigestSource;
  if (!VALID_SOURCES.includes(source)) {
    return NextResponse.json(
      { error: `source must be one of ${VALID_SOURCES.join(', ')}` },
      { status: 400 }
    );
  }

  const rawItems = Array.isArray(body.items) ? body.items : [];
  if (rawItems.length === 0) {
    return NextResponse.json({ stored: 0, received: 0 });
  }
  if (rawItems.length > MAX_ITEMS) {
    return NextResponse.json(
      { error: `too many items (max ${MAX_ITEMS})` },
      { status: 413 }
    );
  }

  const items: DigestItemInput[] = [];
  for (const it of rawItems) {
    const day = typeof it.day === 'string' && DAY_RE.test(it.day) ? it.day : '';
    if (!day) {
      return NextResponse.json(
        { error: 'each item needs a day in YYYY-MM-DD format' },
        { status: 400 }
      );
    }
    items.push({
      source,
      day,
      externalId: it.externalId ?? null,
      payload: it.payload ?? null,
    });
  }

  const stored = await addDigestItems(userId, items);
  return NextResponse.json({ received: items.length, stored });
}
