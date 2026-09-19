import type { PropsWithChildren } from 'react';

// Shimmering placeholder block. Works in server and client components.
export function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`skeleton ${className}`} aria-hidden="true" />;
}

export function SkeletonCircle({ className = '' }: { className?: string }) {
  return <div className={`skeleton rounded-full ${className}`} aria-hidden="true" />;
}

export function SkeletonText({ lines = 3, className = '' }: { lines?: number; className?: string }) {
  return (
    <div className={`space-y-2 ${className}`} aria-hidden="true">
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton key={i} className={`h-3.5 ${i === lines - 1 ? 'w-2/3' : 'w-full'}`} />
      ))}
    </div>
  );
}

// Message-bubble-shaped skeleton with the standard stagger.
export function MessageSkeleton({ align = 'start' }: { align?: 'start' | 'end' }) {
  const widths = align === 'end' ? ['w-2/3', 'w-1/3'] : ['w-2/3', 'w-1/2', 'w-1/3'];
  return (
    <div className={`flex gap-3 ${align === 'end' ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[80%] px-4 py-3 rounded-2xl skeleton ${
          align === 'end' ? 'rounded-br-md' : 'rounded-bl-md'
        }`}
      >
        <div className="space-y-2.5">
          {widths.map((w, i) => (
            <div key={i} className={`h-3.5 rounded bg-background/40 ${w}`} />
          ))}
        </div>
      </div>
    </div>
  );
}

// Full-screen app shell skeleton shown while the user's chats hydrate.
export function AppSkeleton() {
  return (
    <div className="flex h-dvh bg-background overflow-hidden animate-app-in">
      <aside className="hidden lg:flex w-72 flex-shrink-0 border-r animate-shift">
        <div className="flex flex-col h-full w-full p-4 space-y-4" aria-hidden="true">
          <div className="flex items-center gap-2">
            <SkeletonCircle className="w-6 h-6" />
            <Skeleton className="h-5 w-24" />
          </div>
          <Skeleton className="h-11 w-full" />
          <Skeleton className="h-11 w-full" />
          <div className="flex-1 space-y-2 pt-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-11 w-full" />
            ))}
          </div>
        </div>
      </aside>
      <main className="flex-1 flex flex-col min-w-0">
        <div className="lg:hidden flex items-center gap-3 h-14 px-3 border-b flex-shrink-0 animate-shift" aria-hidden="true">
          <Skeleton className="h-9 w-9" />
          <Skeleton className="h-4 flex-1" />
          <Skeleton className="h-9 w-9" />
        </div>
        <div className="flex-1 overflow-hidden px-4 py-6">
          <div className="max-w-3xl mx-auto space-y-4 pt-8">
            <MessageSkeleton align="end" />
            <MessageSkeleton align="start" />
            <MessageSkeleton align="start" />
          </div>
        </div>
      </main>
    </div>
  );
}

export function DigestCardSkeleton() {
  return (
    <div className="space-y-2 overscroll" aria-hidden="true">
      <Skeleton className="h-3.5 w-28" />
      <div className="rounded-xl border p-4 space-y-3">
        <Skeleton className="h-3.5 w-full" />
        <Skeleton className="h-3.5 w-full" />
        <Skeleton className="h-3.5 w-4/5" />
      </div>
    </div>
  );
}

export function PageSkeleton({ children }: PropsWithChildren) {
  return (
    <div className="flex min-h-dvh flex-col bg-background px-4 animate-shift">
      <div className="w-full max-w-2xl mx-auto flex-1 my-8 space-y-6">{children}</div>
    </div>
  );
}