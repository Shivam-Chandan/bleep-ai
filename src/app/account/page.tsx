import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getSession } from '@/lib/session';
import { listIngestTokens } from '@/lib/queries';
import { ChangePasswordForm } from './ChangePasswordForm';
import { ApiTokenManager } from './ApiTokenManager';

export const dynamic = 'force-dynamic';

export default async function AccountPage() {
  const session = await getSession();
  if (!session) redirect('/login');

  const tokens = await listIngestTokens(session.userId);

  return (
    <div className="flex min-h-dvh flex-col bg-background px-4">
      <div className="w-full max-w-2xl mx-auto flex-1 my-8 space-y-8">
        <div className="flex items-center justify-between">
          <Link
            href="/"
            className="inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-primary transition-colors"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18" />
            </svg>
            Back to chat
          </Link>
        </div>

        <div className="flex items-center gap-3">
          <div className="w-12 h-12 rounded-full bg-primary/10 text-primary flex items-center justify-center text-lg font-semibold uppercase">
            {session.username.charAt(0)}
          </div>
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold">Account</h1>
            <p className="text-sm text-muted-foreground truncate">
              {session.username}
            </p>
          </div>
        </div>

        <div className="max-w-sm">
          <ChangePasswordForm username={session.username} embedded />
        </div>

        <div className="border-t pt-8">
          <ApiTokenManager
            initialTokens={tokens.map((t) => ({
              fingerprint: t.token_hash.slice(0, 8),
              tokenHash: t.token_hash,
              label: t.label,
              createdAt: new Date(t.created_at).toISOString(),
              lastUsedAt: t.last_used_at
                ? new Date(t.last_used_at).toISOString()
                : null,
            }))}
          />
        </div>
      </div>
    </div>
  );
}
