import { ViewTransition } from 'react';
import { PageSkeleton, Skeleton } from '@/components/Skeleton';

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
        <div className="flex items-center gap-3">
          <span className="skeleton h-12 w-12 rounded-full" />
          <div className="space-y-2">
            <span className="skeleton block h-5 w-32" />
            <span className="skeleton block h-4 w-24" />
          </div>
        </div>
        <div className="space-y-3">
          <Skeleton className="h-11 w-full" />
          <Skeleton className="h-3.5 w-1/2" />
        </div>
        <div className="border-t pt-8 space-y-4">
          <Skeleton className="h-11 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      </PageSkeleton>
    </ViewTransition>
  );
}