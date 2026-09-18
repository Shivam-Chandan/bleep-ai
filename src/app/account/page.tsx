import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';
import { ChangePasswordForm } from './ChangePasswordForm';

export default async function AccountPage() {
  const session = await getSession();
  if (!session) redirect('/login');

  return <ChangePasswordForm username={session.username} />;
}