import { ViewTransition } from 'react';
import { AppSkeleton } from '@/components/Skeleton';

// Root route shell: shown while the chat app hydrates or a navigation to "/"
// is fetching. Exits with a directional slide when arriving via a tagged
// navigation, otherwise with the gentle reveal handoff.
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
      <AppSkeleton />
    </ViewTransition>
  );
}