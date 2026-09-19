'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { MarkdownMessage } from '@/components/MarkdownMessage';

export interface DigestDay {
  day: string;
  content: string;
}

// Infinite-scroll feed of daily digests, newest first. Server-renders the first
// page; this component appends older days as the sentinel scrolls into view.
export function DigestFeed({
  initialDays,
  initialCursor,
}: {
  initialDays: DigestDay[];
  initialCursor: string | null;
}) {
  const [days, setDays] = useState<DigestDay[]>(initialDays);
  const [cursor, setCursor] = useState<string | null>(initialCursor);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  const loadMore = useCallback(async () => {
    if (loading || cursor === null) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/digest/days?before=${encodeURIComponent(cursor)}&limit=4`
      );
      if (!res.ok) {
        setError('Failed to load more.');
        return;
      }
      const data = (await res.json()) as {
        days: DigestDay[];
        nextCursor: string | null;
      };
      setDays((prev) => [...prev, ...data.days]);
      setCursor(data.nextCursor);
    } catch {
      setError('Network error.');
    } finally {
      setLoading(false);
    }
  }, [cursor, loading]);

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || cursor === null) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) loadMore();
      },
      { rootMargin: '400px' } // prefetch before it's fully visible
    );
    io.observe(el);
    return () => io.disconnect();
  }, [loadMore, cursor]);

  const formatDay = (day: string) =>
    new Date(day + 'T00:00:00').toLocaleDateString(undefined, {
      weekday: 'long',
      month: 'short',
      day: 'numeric',
    });

  if (days.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No digests yet. They appear here once your daily summary runs.
      </p>
    );
  }

  return (
    <div className="space-y-8">
      {days.map((d) => (
        <article key={d.day} className="space-y-2 animate-message-in">
          <h2 className="text-sm font-medium text-muted-foreground">
            {formatDay(d.day)}
          </h2>
          <div className="rounded-xl border bg-muted/30 p-4">
            <MarkdownMessage content={d.content} />
          </div>
        </article>
      ))}

      {cursor !== null && (
        <div ref={sentinelRef} className="py-4 text-center">
          {loading ? (
            <span className="text-sm text-muted-foreground">Loading…</span>
          ) : error ? (
            <button
              onClick={loadMore}
              className="text-sm font-medium text-primary hover:underline"
            >
              {error} Retry
            </button>
          ) : (
            <span className="text-xs text-muted-foreground">Scroll for more</span>
          )}
        </div>
      )}
    </div>
  );
}
