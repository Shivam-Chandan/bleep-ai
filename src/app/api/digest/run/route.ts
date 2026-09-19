import { NextRequest, NextResponse } from 'next/server';
import { resolveIngestUser } from '@/lib/ingest';
import { localDay } from '@/lib/digest';
import { enqueueDigestRun } from '@/lib/queries';

export const dynamic = 'force-dynamic';

// POST /api/digest/run
// Auth: Authorization: Bearer <ingest token>  (same token the scraper uses)
// Enqueues a digest_runs row and returns immediately. Generation happens on
// the box (scripts/digest-worker.mjs polls this queue), NOT in this function
// — a realistic day's briefing on the local model takes minutes, far past
// what a Vercel function can hold open. Apps Script never waits on it either
// way; this is just "how fast do we tell it we're done" (now: instant).
//
// Optional ?day=YYYY-MM-DD to target a specific day (defaults to today).
export async function POST(request: NextRequest) {
  const userId = await resolveIngestUser(request);
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const url = new URL(request.url);
  const dayParam = url.searchParams.get('day');
  const day =
    dayParam && /^\d{4}-\d{2}-\d{2}$/.test(dayParam) ? dayParam : localDay();

  const runId = await enqueueDigestRun(userId, day);

  // 202 Accepted: work queued, not finished. The summary appears on /digest
  // once the box-side worker picks it up and generates it (next poll tick,
  // typically within a few minutes).
  return NextResponse.json({ accepted: true, runId, userId, day }, { status: 202 });
}
