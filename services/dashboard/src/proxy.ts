import { NextResponse, type NextRequest } from 'next/server';

/**
 * First gate: no session cookie, no admin page or API. This only checks presence; the session
 * itself is validated server-side by every page (requireSession) and route (authorizePost).
 */
export function proxy(req: NextRequest) {
  if (req.cookies.get('pai_session')?.value) return NextResponse.next();
  if (req.nextUrl.pathname.startsWith('/api/')) {
    if (req.method === 'POST') {
      // A form posted without a session (logged out / expired): back to the login page, nothing done.
      const login = req.nextUrl.clone();
      login.pathname = '/login';
      login.search = `?error=${encodeURIComponent('Your session has expired or you are logged out. Log in again, then repeat the action.')}`;
      const res = NextResponse.redirect(login, 303);
      res.headers.set('X-PAI-Rejected', 'session');
      return res;
    }
    return NextResponse.json({ message: 'Not logged in' }, { status: 401 });
  }
  // Middleware needs an absolute URL; nextUrl carries the Host the browser used.
  const url = req.nextUrl.clone();
  url.pathname = '/login';
  url.search = '';
  return NextResponse.redirect(url, 307);
}

export const config = {
  matcher: ['/((?!login|api/auth/login|api/health|_next/static|_next/image|favicon.ico|icon.svg).*)'],
};
