import { authorizePost, back } from '@/lib/routes';
import { audit, SESSION_COOKIE, sessions, settings } from '@/lib/server';

export async function POST(req: Request) {
  const session = await authorizePost(req, await req.formData(), '/');
  if (session instanceof Response) return session;
  sessions.destroy(session.id);
  await audit({ event: 'logout', user: session.user });
  const res = back('/login', { kind: 'ok', text: 'Logged out.' });
  res.cookies.set(SESSION_COOKIE, '', { httpOnly: true, sameSite: 'strict', secure: settings.cookieSecure, path: '/', maxAge: 0 });
  return res;
}
