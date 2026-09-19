import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth';
import { listDigestSummariesPage } from '@/lib/queries';

export const dynamic = 'force-dynamic';

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_LIMIT = 4;
const MAX_LIMIT = 10;

// GET /api/digest/days?before=YYYY-MM-DD&limit=4
// Returns a page of the user's daily summaries, newest first. `before` is the
// cursor (the oldest day already shown); omit it for the first page.
export async function GET(request: NextRequest) {
  const auth = await requireSession();
  if (auth instanceof NextResponse) return auth;

  const url = new URL(request.url);
  const beforeParam = url.searchParams.get('before');
  const before = beforeParam && DAY_RE.test(beforeParam) ? beforeParam : undefined;

  const limitParam = Number(url.searchParams.get('limit'));
  const limit =
    Number.isFinite(limitParam) && limitParam > 0
      ? Math.min(limitParam, MAX_LIMIT)
      : DEFAULT_LIMIT;

  const { days, nextCursor } = await listDigestSummariesPage(
    auth.userId,
    limit,
    before
  );

  return NextResponse.json({
    days: days.map((d) => ({ day: d.day, content: d.content })),
    nextCursor,
  });
}
