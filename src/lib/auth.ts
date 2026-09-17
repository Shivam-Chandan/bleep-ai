import 'server-only';
import bcrypt from 'bcryptjs';
import { NextResponse } from 'next/server';
import { getSession, type SessionPayload } from './session';

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