import 'server-only';
import bcrypt from 'bcryptjs';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { getSession, type SessionPayload } from './session';

// Shared secret used to protect the public infra endpoints (/api/warm,
// /api/health). When set, callers must present it in the Authorization
// Bearer header (or a custom header via HEALTH_SECRET_HEADER). When unset
// the endpoints stay open for local development / uptime checks.
// Generate with: openssl rand -base64 24
const HEALTH_CHECK_SECRET = process.env.HEALTH_CHECK_SECRET || '';
const HEALTH_SECRET_HEADER = process.env.HEALTH_SECRET_HEADER || 'x-health-check';

export function checkHealthAccess(request: NextRequest): boolean {
  if (!HEALTH_CHECK_SECRET) return true;
  const header = request.headers.get(HEALTH_SECRET_HEADER);
  if (header) return header === HEALTH_CHECK_SECRET;
  const bearer = request.headers.get('authorization') || '';
  const match = /^Bearer\s+(.+)$/i.exec(bearer);
  return match !== null && match[1].trim() === HEALTH_CHECK_SECRET;
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 10);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

/**
 * For route handlers: returns the session or a 401 response.
 * Usage:
 *   const auth = await requireSession();
 *   if (auth instanceof NextResponse) return auth;
 *   // auth.userId is available here
 */
export async function requireSession(): Promise<SessionPayload | NextResponse> {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return session;
}