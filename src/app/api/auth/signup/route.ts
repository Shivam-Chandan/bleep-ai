import { NextRequest, NextResponse } from 'next/server';
import { createUser, getUserByUsername } from '@/lib/queries';
import { hashPassword } from '@/lib/auth';
import { createSession } from '@/lib/session';

// Set REGISTRATION_OPEN=false in env to disable self-signup after
// creating your accounts.
const REGISTRATION_OPEN = process.env.REGISTRATION_OPEN !== 'false';

export async function POST(request: NextRequest) {
  if (!REGISTRATION_OPEN) {
    return NextResponse.json({ error: 'Registration is closed.' }, { status: 403 });
  }

  try {
    const { username, password } = await request.json();
    const uname = String(username || '').trim();
    const pass = String(password || '');

    if (uname.length < 3) {
      return NextResponse.json({ error: 'Username must be at least 3 characters.' }, { status: 400 });
    }
    if (pass.length < 6) {
      return NextResponse.json({ error: 'Password must be at least 6 characters.' }, { status: 400 });
    }
    if (await getUserByUsername(uname)) {
      return NextResponse.json({ error: 'Username already taken.' }, { status: 409 });
    }

    const user = await createUser(uname, await hashPassword(pass));
    await createSession(user.id, user.username);
    return NextResponse.json({ ok: true, username: user.username });
  } catch {
    return NextResponse.json({ error: 'Bad request' }, { status: 400 });
  }
}