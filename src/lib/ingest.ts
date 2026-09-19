import 'server-only';
import { createHash, randomBytes } from 'node:crypto';
import type { NextRequest } from 'next/server';
import {
  getUserIdByTokenHash,
  touchIngestToken,
} from './queries';

// Ingest tokens authenticate machine-to-machine callers (Google Apps Script,
// Slack poller) into POST /api/ingest without a browser session. The raw token
// is shown to the user once at creation; only its SHA-256 hash is stored.

const TOKEN_PREFIX = 'ingest_';

export function generateIngestToken(): { token: string; tokenHash: string } {
  const token = TOKEN_PREFIX + randomBytes(24).toString('base64url');
  return { token, tokenHash: hashIngestToken(token) };
}

export function hashIngestToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function extractBearer(request: NextRequest): string | null {
  const bearer = request.headers.get('authorization') || '';
  const match = /^Bearer\s+(.+)$/i.exec(bearer);
  if (match) return match[1].trim();
  // Also accept a plain header for environments that strip Authorization.
  const raw = request.headers.get('x-ingest-token');
  return raw ? raw.trim() : null;
}

// Resolve the caller's token to a user id, or null if missing/invalid.
// Records last-used on success (best effort).
export async function resolveIngestUser(
  request: NextRequest
): Promise<string | null> {
  const token = extractBearer(request);
  if (!token) return null;
  const tokenHash = hashIngestToken(token);
  const userId = await getUserIdByTokenHash(tokenHash);
  if (!userId) return null;
  touchIngestToken(tokenHash).catch(() => {});
  return userId;
}

// The Cron secret protecting POST /api/digest/summarize. Vercel Cron sends
// `Authorization: Bearer $CRON_SECRET` automatically when CRON_SECRET is set.
const CRON_SECRET = process.env.CRON_SECRET || '';

export function checkCronAccess(request: NextRequest): boolean {
  if (!CRON_SECRET) return true; // open in local dev when unset
  const bearer = request.headers.get('authorization') || '';
  const match = /^Bearer\s+(.+)$/i.exec(bearer);
  return match !== null && match[1].trim() === CRON_SECRET;
}
