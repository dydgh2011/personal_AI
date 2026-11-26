import 'server-only';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { getT } from '@/i18n/server';
import { csrfFailure, type Session } from './security';
import { audit, clientIp, SESSION_COOKIE, sessions } from './server';

/**
 * 303 back to a same-site path. The Location is relative on purpose: behind Docker port mapping or
 * a reverse proxy the server does not reliably know its public origin, the browser does.
 */
export function back(path: string, message?: { kind: 'ok' | 'error'; text: string }, rejected?: string): NextResponse {
  const safe = path.startsWith('/') && !path.startsWith('//') && !path.includes('\\') ? path : '/';
  let location = safe;
  if (message) {
    const sep = safe.includes('?') ? '&' : '?';
    location += `${sep}${message.kind}=${encodeURIComponent(message.text.slice(0, 300))}`;
  }
  // X-PAI-Rejected tells scripts (and tests) that nothing was done, without exposing details.
  return new NextResponse(null, { status: 303, headers: { Location: location, ...(rejected ? { 'X-PAI-Rejected': rejected } : {}) } });
}

/**
 * Flash text is translated here, on the server, with the request's `pai_lang` cookie (see README
 * "언어(i18n)"): route handlers call `routeT()` and pass the finished text to back().
 */
export const routeT = getT;

/**
 * Session + CSRF check for every state-changing form post. Failures change nothing and send the
 * browser back with a readable message: to /login when the session is gone, otherwise to `returnTo`.
 */
export async function authorizePost(req: Request, form: FormData, returnTo: string): Promise<Session | NextResponse> {
  const session = sessions.get((await cookies()).get(SESSION_COOKIE)?.value);
  const t = await routeT();
  if (!session) {
    return back('/login', { kind: 'error', text: t.flash.sessionExpired }, 'session');
  }
  const failure = csrfFailure(session, form.get('csrf'), req.headers);
  if (failure) {
    await audit({ event: 'csrf.rejected', user: session.user, ip: await clientIp(), reason: failure, path: new URL(req.url).pathname });
    return back(returnTo, { kind: 'error', text: t.flash.csrf[failure] }, `csrf:${failure}`);
  }
  return session;
}
