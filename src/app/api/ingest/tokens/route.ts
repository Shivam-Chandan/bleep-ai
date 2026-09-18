import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth';
import { generateIngestToken, hashIngestToken } from '@/lib/ingest';
import {
  createIngestToken,
  deleteIngestToken,
  listIngestTokens,
} from '@/lib/queries';

// GET /api/ingest/tokens -> list this user's tokens (hashes + metadata only)
export async function GET() {
  const auth = await requireSession();
  if (auth instanceof NextResponse) return auth;

  const tokens = await listIngestTokens(auth.userId);
  return NextResponse.json({
    tokens: tokens.map((t) => ({
      // Return a short fingerprint, never the raw token (it isn't stored).
      fingerprint: t.token_hash.slice(0, 8),
      tokenHash: t.token_hash,
      label: t.label,
      createdAt: new Date(t.created_at).toISOString(),
      lastUsedAt: t.last_used_at ? new Date(t.last_used_at).toISOString() : null,
    })),
  });
}

// POST /api/ingest/tokens { label } -> create a token, returns raw token ONCE
export async function POST(request: NextRequest) {
  const auth = await requireSession();
  if (auth instanceof NextResponse) return auth;

  let label = '';
  try {
    const body = await request.json();
    if (typeof body?.label === 'string') label = body.label.trim().slice(0, 80);
  } catch {
    // no body is fine
  }

  const { token, tokenHash } = generateIngestToken();
  await createIngestToken(auth.userId, tokenHash, label);

  // The raw token is shown exactly once; only its hash is persisted.
  return NextResponse.json({
    token,
    fingerprint: tokenHash.slice(0, 8),
    label,
  });
}

// DELETE /api/ingest/tokens { tokenHash } -> revoke a token
export async function DELETE(request: NextRequest) {
  const auth = await requireSession();
  if (auth instanceof NextResponse) return auth;

  let tokenHash = '';
  try {
    const body = await request.json();
    if (typeof body?.tokenHash === 'string') tokenHash = body.tokenHash;
    else if (typeof body?.token === 'string') tokenHash = hashIngestToken(body.token);
  } catch {
    // fall through
  }
  if (!tokenHash) {
    return NextResponse.json({ error: 'tokenHash required' }, { status: 400 });
  }

  await deleteIngestToken(auth.userId, tokenHash);
  return NextResponse.json({ ok: true });
}
