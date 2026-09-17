import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { SESSION_COOKIE } from '@/lib/session';

// Optimistic check only: presence of the session cookie.
// Full verification happens in Server Components / route handlers.
export function proxy(request: NextRequest) {
  const hasSession = Boolean(request.cookies.get(SESSION_COOKIE)?.value);
  const { pathname } = request.nextUrl;

  const isLoginPage = pathname === '/login';

  if (!hasSession && !isLoginPage) {
    return NextResponse.redirect(new URL('/login', request.url));
  }

  if (hasSession && isLoginPage) {
    return NextResponse.redirect(new URL('/', request.url));
  }

  return NextResponse.next();
}

export const config = {
  // Protect everything except Next internals, the auth API, public
  // infra endpoints (health/warm), and static assets.
  matcher: ['/((?!api/auth|api/health|api/warm|_next/static|_next/image|favicon.ico).*)'],
};