import { NextRequest, NextResponse } from 'next/server';
import { checkCronAccess } from '@/lib/ingest';
import { localDay } from '@/lib/digest';
import { enqueueDigestRun, listUsersWithItemsForDay } from '@/lib/queries';

export const dynamic = 'force-dynamic';

// POST /api/digest/summarize
// Auth: Authorization: Bearer $CRON_SECRET (sent automatically by Vercel Cron).
// Backstop for the Apps Script trigger: enqueues a digest_runs row for every
// user with items on the target day. Generation happens on the box
// (scripts/digest-worker.mjs polls the queue) — this endpoint does no LLM
// work itself, so it's safe to run on Vercel's clock.
//
// Optional ?day=YYYY-MM-DD to backfill a specific day.
export async function POST(request: NextRequest) {
  if (!checkCronAccess(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const url = new URL(request.url);
  const dayParam = url.searchParams.get('day');
  const day = dayParam && /^\d{4}-\d{2}-\d{2}$/.test(dayParam) ? dayParam : localDay();

  const users = await listUsersWithItemsForDay(day);
  const runIds = await Promise.all(
    users.map((userId) => enqueueDigestRun(userId, day))
  );

  return NextResponse.json({ day, users: users.length, runIds });
}

// Vercel Cron triggers jobs with GET by default; support both verbs.
export const GET = POST;
