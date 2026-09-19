import { ViewTransition } from 'react';
import { DigestCardSkeleton, PageSkeleton } from '@/components/Skeleton';

export default function Loading() {
  return (
    <ViewTransition
      exit={{
        'nav-forward': 'nav-forward',
        'nav-back': 'nav-back',
        default: 'reveal-exit',
      }}
      default="none"
    >
      <PageSkeleton>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            <span className="skeleton h-4 w-4" />
            <span className="skeleton h-4 w-24" />
          </div>
        </div>
        <div className="skeleton h-7 w-40" />
        <div className="space-y-8">
          <DigestCardSkeleton />
          <DigestCardSkeleton />
        </div>
      </PageSkeleton>
    </ViewTransition>
  );
}