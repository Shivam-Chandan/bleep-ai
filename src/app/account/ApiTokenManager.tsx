'use client';

import { useState } from 'react';

interface TokenInfo {
  fingerprint: string;
  tokenHash: string;
  label: string;
  createdAt: string;
  lastUsedAt: string | null;
}

// Embeddable "API Token" section for the account page. Creates/lists/revokes
// the ingest tokens used by the Google Apps Script (and any other data source)
// to POST into /api/ingest.
export function ApiTokenManager({
  initialTokens,
}: {
  initialTokens: TokenInfo[];
}) {
  const [tokens, setTokens] = useState<TokenInfo[]>(initialTokens);
  const [label, setLabel] = useState('');
  const [newToken, setNewToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = async () => {
    setBusy(true);
    setError(null);
    setNewToken(null);
    setCopied(false);
    try {
      const res = await fetch('/api/ingest/tokens', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Failed to create token.');
        return;
      }
      setNewToken(data.token);
      setTokens((prev) => [
        {
          fingerprint: data.fingerprint,
          tokenHash: '', // unknown client-side until reload; fine for display
          label: data.label,
          createdAt: new Date().toISOString(),
          lastUsedAt: null,
        },
        ...prev,
      ]);
      setLabel('');
    } catch {
      setError('Network error.');
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (tokenHash: string) => {
    if (!tokenHash) return;
    setBusy(true);
    try {
      await fetch('/api/ingest/tokens', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tokenHash }),
      });
      setTokens((prev) => prev.filter((t) => t.tokenHash !== tokenHash));
    } finally {
      setBusy(false);
    }
  };

  const copy = () => {
    if (!newToken) return;
    navigator.clipboard?.writeText(newToken);
    setCopied(true);
  };

  return (
    <div className="space-y-3">
      <h2 className="text-sm font-semibold">API Token</h2>

      <div className="flex gap-2">
        <input
          id="token-label"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Name"
          className="flex-1 h-9 px-3 rounded-md border bg-background text-sm focus:outline-none focus:ring-1 focus:ring-primary"
        />
        <button
          onClick={create}
          disabled={busy}
          className="h-9 px-3 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50 transition-colors"
        >
          Create
        </button>
      </div>
      {error && <p className="text-xs text-red-500">{error}</p>}
      {newToken && (
        <div className="flex items-center gap-2">
          <code className="flex-1 break-all rounded-md border bg-muted/40 px-2 py-1.5 font-mono text-xs">
            {newToken}
          </code>
          <button
            onClick={copy}
            className="text-xs font-medium text-primary hover:underline shrink-0"
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      )}

      {tokens.length > 0 && (
        <ul className="divide-y rounded-md border">
          {tokens.map((t) => (
            <li
              key={t.tokenHash || t.fingerprint}
              className="flex items-center justify-between gap-3 px-3 py-2 text-sm"
            >
              <span className="truncate">
                {t.label || t.fingerprint + '…'}
              </span>
              <button
                onClick={() => revoke(t.tokenHash)}
                disabled={busy || !t.tokenHash}
                className="text-xs text-muted-foreground hover:text-red-500 disabled:opacity-40 transition-colors shrink-0"
              >
                Revoke
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
