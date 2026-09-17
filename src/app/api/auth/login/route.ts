import { NextRequest, NextResponse } from 'next/server';
import { getUserByUsername } from '@/lib/queries';
import { verifyPassword } from '@/lib/auth';
import { createSession } from '@/lib/session';
import { checkRateLimit, clearAttempts, recordAttempt } from '@/lib/rateLimit';

const LOGIN_LIMIT = {
  max: Number(process.env.LOGIN_MAX_ATTEMPTS || 10),
  windowSeconds: 900,
};

export async function POST(request: NextRequest) {
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';

  try {
    const { username, password } = await request.json();
    const uname = String(username || '').trim();

    // Cheap pre-checks before any DB work.
    const perUsername = await checkRateLimit(`login:u:${uname}`, LOGIN_LIMIT.max, LOGIN_LIMIT.windowSeconds);
    const perIp = await checkRateLimit(`login:ip:${ip}`, LOGIN_LIMIT.max * 2, LOGIN_LIMIT.windowSeconds);
    if (!perUsername.allowed || !perIp.allowed) {
      return NextResponse.json(
        { error: 'Too many failed attempts. Try again later.', retryAfterSeconds: Math.max(perUsername.retryAfterSeconds, perIp.retryAfterSeconds) },
        { status: 429 }
      );
    }

    const user = await getUserByUsername(uname);
    if (!user || !(await verifyPassword(String(password || ''), user.password_hash))) {
      await Promise.all([recordAttempt(`login:u:${uname}`), recordAttempt(`login:ip:${ip}`)]);
      return NextResponse.json({ error: 'Invalid username or password.' }, { status: 401 });
    }

    await Promise.all([clearAttempts(`login:u:${uname}`), clearAttempts(`login:ip:${ip}`)]);
    await createSession(user.id, user.username);
    return NextResponse.json({ ok: true, username: user.username });
  } catch {
    return NextResponse.json({ error: 'Bad request' }, { status: 400 });
  }
}