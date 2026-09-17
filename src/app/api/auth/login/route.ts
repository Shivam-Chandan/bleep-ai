import { NextRequest, NextResponse } from 'next/server';
import { getUserByUsername } from '@/lib/queries';
import { verifyPassword } from '@/lib/auth';
import { createSession } from '@/lib/session';

export async function POST(request: NextRequest) {
  try {
    const { username, password } = await request.json();
    const uname = String(username || '').trim();

    const user = await getUserByUsername(uname);
    if (!user || !(await verifyPassword(String(password || ''), user.password_hash))) {
      return NextResponse.json({ error: 'Invalid username or password.' }, { status: 401 });
    }

    await createSession(user.id, user.username);
    return NextResponse.json({ ok: true, username: user.username });
  } catch {
    return NextResponse.json({ error: 'Bad request' }, { status: 400 });
  }
}