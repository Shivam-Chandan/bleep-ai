import { redirect } from 'next/navigation';
import { ChatLayout } from '@/components/ChatLayout';
import { getSession } from '@/lib/session';

export default async function Home() {
  const session = await getSession();
  if (!session) redirect('/login');

  return <ChatLayout username={session.username} />;
}