'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

interface ChangePasswordFormProps {
  username: string;
  embedded?: boolean;
}

export function ChangePasswordForm({ username, embedded = false }: ChangePasswordFormProps) {
  const router = useRouter();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (newPassword !== confirmPassword) {
      setError('New password and confirmation do not match.');
      return;
    }
    if (newPassword.length < 10) {
      setError('Password must be at least 10 characters.');
      return;
    }

    setLoading(true);
    try {
      const res = await fetch('/api/auth/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword, newPassword }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error || 'Something went wrong.');
        setLoading(false);
        return;
      }

      setDone(true);
      // Require a fresh sign-in with the new password.
      await fetch('/api/auth/logout', { method: 'POST' });
      setTimeout(() => {
        router.push('/login');
        router.refresh();
      }, 1500);
    } catch {
      setError('Network error. Is the server running?');
      setLoading(false);
    }
  };

  const formBody = done ? (
    <div className="rounded-2xl border bg-muted/50 p-6 text-center space-y-2">
      <h2 className="font-semibold">Password updated</h2>
      <p className="text-sm text-muted-foreground">
        Please sign in again with your new password.
      </p>
      <p className="text-xs text-muted-foreground">Redirecting to sign-in…</p>
    </div>
  ) : (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="space-y-1">
        <label htmlFor="currentPassword" className="text-sm font-medium">
          Current password
        </label>
        <input
          id="currentPassword"
          name="currentPassword"
          type="password"
          autoComplete="current-password"
          required
          value={currentPassword}
          onChange={(e) => setCurrentPassword(e.target.value)}
          className="w-full h-11 px-3 rounded-xl border bg-background text-base focus:outline-none focus:ring-2 focus:ring-primary"
        />
      </div>

      <div className="space-y-1">
        <label htmlFor="newPassword" className="text-sm font-medium">
          New password
        </label>
        <input
          id="newPassword"
          name="newPassword"
          type="password"
          autoComplete="new-password"
          required
          minLength={10}
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          className="w-full h-11 px-3 rounded-xl border bg-background text-base focus:outline-none focus:ring-2 focus:ring-primary"
        />
        <p className="text-xs text-muted-foreground">
          At least 10 characters.
        </p>
      </div>

      <div className="space-y-1">
        <label htmlFor="confirmPassword" className="text-sm font-medium">
          Confirm new password
        </label>
        <input
          id="confirmPassword"
          name="confirmPassword"
          type="password"
          autoComplete="new-password"
          required
          minLength={10}
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          className="w-full h-11 px-3 rounded-xl border bg-background text-base focus:outline-none focus:ring-2 focus:ring-primary"
        />
      </div>

      {error && <p className="text-sm text-red-500">{error}</p>}

      <button
        type="submit"
        disabled={loading}
        className="w-full h-11 rounded-xl bg-primary text-primary-foreground font-medium hover:bg-primary/90 active:bg-primary/80 disabled:opacity-50 transition-colors"
      >
        {loading ? 'Please wait…' : 'Update password'}
      </button>
    </form>
  );

  // Embedded mode: just the heading + form, no page chrome (the account page
  // provides the shell and renders other sections alongside this one).
  if (embedded) {
    return (
      <div className="space-y-4">
        <h2 className="text-lg font-semibold">Change password</h2>
        {formBody}
      </div>
    );
  }

  return (
    <div className="flex min-h-dvh flex-col bg-background px-4">
      <div className="w-full max-w-sm mx-auto flex-1 flex flex-col justify-center my-8">
        <div className="flex items-center justify-between mb-6">
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

        <div className="flex items-center gap-3 mb-6">
          <div className="w-12 h-12 rounded-full bg-primary/10 text-primary flex items-center justify-center text-lg font-semibold uppercase">
            {username.charAt(0)}
          </div>
          <div className="min-w-0">
            <h1 className="text-xl font-semibold">Account</h1>
            <p className="text-sm text-muted-foreground truncate">{username}</p>
          </div>
        </div>

        {formBody}
      </div>
    </div>
  );
}