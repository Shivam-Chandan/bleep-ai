import { redirect } from 'next/navigation';
import Link from 'next/link';
import { ViewTransition } from 'react';
import { getSession } from '@/lib/session';
import { listDigestSummariesPage } from '@/lib/queries';
import { DigestFeed } from '@/components/DigestFeed';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 4;

const VT_DIRECTION = {
  'nav-forward': 'nav-forward',
  'nav-back': 'nav-back',
  default: 'none',
} as const;

export default async function DigestPage() {
  const session = await getSession();
  if (!session) redirect('/login');

  const { days, nextCursor } = await listDigestSummariesPage(
    session.userId,
    PAGE_SIZE
  );

  return (
    <ViewTransition enter={VT_DIRECTION} exit={VT_DIRECTION} default="none">
      <div className="flex min-h-dvh flex-col bg-background px-4">
        <div className="w-full max-w-2xl mx-auto flex-1 my-8 space-y-6">
          <div className="flex items-center justify-between">
            <Link
              href="/"
              transitionTypes={['nav-back']}
              className="inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-primary transition-colors"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18" />
              </svg>
              Back to chat
            </Link>
          </div>

          <h1 className="text-2xl font-semibold">Daily digest</h1>

          <DigestFeed
            initialDays={days.map((d) => ({ day: d.day, content: d.content }))}
            initialCursor={nextCursor}
          />
        </div>
      </div>
    </ViewTransition>
  );
}
