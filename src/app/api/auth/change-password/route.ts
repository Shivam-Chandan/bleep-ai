import { NextRequest, NextResponse } from 'next/server';
import { hashPassword, requireSession, verifyPassword } from '@/lib/auth';
import { getUserById, updateUserPassword } from '@/lib/queries';
import { checkRateLimit, clearAttempts, recordAttempt } from '@/lib/rateLimit';

const CHANGE_PW_LIMIT = {
  max: Number(process.env.CHANGE_PASSWORD_MAX_ATTEMPTS || 5),
  windowSeconds: 900,
};

export async function POST(request: NextRequest) {
  const auth = await requireSession();
  if (auth instanceof NextResponse) return auth;

  const limitKey = `change-pw:${auth.userId}`;
  try {
    const { currentPassword, newPassword } = await request.json();

    const rateLimit = await checkRateLimit(
      limitKey,
      CHANGE_PW_LIMIT.max,
      CHANGE_PW_LIMIT.windowSeconds
    );
    if (!rateLimit.allowed) {
      return NextResponse.json(
        {
          error: 'Too many attempts. Try again later.',
          retryAfterSeconds: rateLimit.retryAfterSeconds,
        },
        { status: 429 }
      );
    }

    const user = await getUserById(auth.userId);
    if (!user) {
      return NextResponse.json({ error: 'User not found.' }, { status: 404 });
    }

    if (
      !(await verifyPassword(String(currentPassword || ''), user.password_hash))
    ) {
      await recordAttempt(limitKey);
      return NextResponse.json(
        { error: 'Current password is incorrect.' },
        { status: 401 }
      );
    }

    const newPass = String(newPassword || '');
    if (newPass.length < 10) {
      return NextResponse.json(
        { error: 'Password must be at least 10 characters.' },
        { status: 400 }
      );
    }

    await updateUserPassword(user.id, await hashPassword(newPass));
    await clearAttempts(limitKey);
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: 'Bad request' }, { status: 400 });
  }
}