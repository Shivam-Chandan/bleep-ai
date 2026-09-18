import { NextRequest, NextResponse } from 'next/server';
import { checkCronAccess } from '@/lib/ingest';
import { localDay, summarizeDay } from '@/lib/digest';
import { listUsersWithItemsForDay } from '@/lib/queries';

export const dynamic = 'force-dynamic';

// POST /api/digest/summarize
// Auth: Authorization: Bearer $CRON_SECRET (sent automatically by Vercel Cron).
// Iterates every user with items for the target day and generates one summary
// each. Optional ?day=YYYY-MM-DD to backfill a specific day.
export async function POST(request: NextRequest) {
  if (!checkCronAccess(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const url = new URL(request.url);
  const dayParam = url.searchParams.get('day');
  const day = dayParam && /^\d{4}-\d{2}-\d{2}$/.test(dayParam) ? dayParam : localDay();

  const users = await listUsersWithItemsForDay(day);
  const results: Array<{ userId: string; ok: boolean; error?: string }> = [];

  for (const userId of users) {
    try {
      await summarizeDay(userId, day);
      results.push({ userId, ok: true });
    } catch (err) {
      results.push({
        userId,
        ok: false,
        error: err instanceof Error ? err.message : 'unknown error',
      });
    }
  }

  return NextResponse.json({
    day,
    users: users.length,
    succeeded: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    results,
  });
}

// Vercel Cron triggers jobs with GET by default; support both verbs.
export const GET = POST;
