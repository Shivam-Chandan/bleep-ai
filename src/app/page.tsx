import { redirect } from 'next/navigation';
import { ViewTransition } from 'react';
import { ChatLayout } from '@/components/ChatLayout';
import { getSession } from '@/lib/session';

const VT_DIRECTION = {
  'nav-forward': 'nav-forward',
  'nav-back': 'nav-back',
  default: 'none',
} as const;

export default async function Home() {
  const session = await getSession();
  if (!session) redirect('/login');

  return (
    <ViewTransition enter={VT_DIRECTION} exit={VT_DIRECTION} default="none">
      <ChatLayout username={session.username} />
    </ViewTransition>
  );
}