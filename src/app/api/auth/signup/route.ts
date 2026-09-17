import { NextRequest, NextResponse } from 'next/server';
import { createUser, getUserByUsername } from '@/lib/queries';
import { hashPassword } from '@/lib/auth';
import { createSession } from '@/lib/session';
import { checkRateLimit, recordAttempt } from '@/lib/rateLimit';

// Set REGISTRATION_OPEN=false in env to disable self-signup after
// creating your accounts.
const REGISTRATION_OPEN = process.env.REGISTRATION_OPEN !== 'false';

const SIGNUP_LIMIT = {
  max: Number(process.env.SIGNUP_MAX_PER_IP || 3),
  windowSeconds: 3600,
};

export async function POST(request: NextRequest) {
  if (!REGISTRATION_OPEN) {
    return NextResponse.json({ error: 'Registration is closed.' }, { status: 403 });
  }

  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
  const signupLimit = await checkRateLimit(`signup:${ip}`, SIGNUP_LIMIT.max, SIGNUP_LIMIT.windowSeconds);
  if (!signupLimit.allowed) {
    return NextResponse.json(
      { error: 'Too many signup attempts. Try again later.', retryAfterSeconds: signupLimit.retryAfterSeconds },
      { status: 429 }
    );
  }

  try {
    const { username, password } = await request.json();
    const uname = String(username || '').trim();
    const pass = String(password || '');

    if (uname.length < 3) {
      return NextResponse.json({ error: 'Username must be at least 3 characters.' }, { status: 400 });
    }
    if (pass.length < 10) {
      return NextResponse.json({ error: 'Password must be at least 10 characters.' }, { status: 400 });
    }
    if (await getUserByUsername(uname)) {
      return NextResponse.json({ error: 'Username already taken.' }, { status: 409 });
    }

    const user = await createUser(uname, await hashPassword(pass));
    await createSession(user.id, user.username);
    return NextResponse.json({ ok: true, username: user.username });
  } catch {
    return NextResponse.json({ error: 'Bad request' }, { status: 400 });
  } finally {
    await recordAttempt(`signup:${ip}`);
  }
}