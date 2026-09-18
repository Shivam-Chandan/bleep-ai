import { NextRequest, NextResponse } from 'next/server';
import { after } from 'next/server';
import { resolveIngestUser } from '@/lib/ingest';
import { localDay, summarizeDay } from '@/lib/digest';

export const dynamic = 'force-dynamic';
// Give the background summary generous room on serverless (it can take ~130s).
export const maxDuration = 300;

// POST /api/digest/run
// Auth: Authorization: Bearer <ingest token>  (same token the scraper uses)
// Fire-and-forget: resolves the caller's user from the token, then generates
// THAT user's summary for the day in the background via after(), returning 202
// immediately so the Google Apps Script never waits on the ~130s generation.
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

  // Run the slow LLM work after the response is sent. On Vercel, after() keeps
  // the function alive until this settles (up to maxDuration); on a self-hosted
  // Node server the process simply continues running it.
  after(async () => {
    try {
      await summarizeDay(userId, day);
    } catch (err) {
      console.error(
        `[digest/run] summarize failed for ${userId} ${day}:`,
        err instanceof Error ? err.message : err
      );
    }
  });

  // 202 Accepted: work started, not finished. The summary appears on /digest
  // once generation completes (a couple of minutes later).
  return NextResponse.json({ accepted: true, userId, day }, { status: 202 });
}
