import { cookies } from 'next/headers';
import { deviceKey, loginBuckets, safeEqual, signDevice, verifyDevice, verifyPassword } from '@/lib/security';
import { back } from '@/lib/routes';
import { audit, clientIp, DEVICE_COOKIE, DEVICE_TTL_MS, limiter, readSecret, SESSION_COOKIE, sessions, settings } from '@/lib/server';

export async function POST(req: Request) {
  const form = await req.formData();
  const user = String(form.get('username') ?? '').trim().toLowerCase().slice(0, 64);
  const password = String(form.get('password') ?? '');
  const ip = await clientIp();

  // Same-origin form posts only (no CSRF token exists before login).
  const site = req.headers.get('sec-fetch-site');
  if (site && site !== 'same-origin') return back('/login', { kind: 'error', text: 'Cross-site login refused' });

  let hash: string;
  try {
    hash = readSecret(settings.adminHashFile);
  } catch {
    await audit({ event: 'login.misconfigured', ip });
    return back('/login', { kind: 'error', text: 'Login is not configured (admin password hash missing).' });
  }
  // The device key derives from the password hash: changing the password retires every device cookie.
  const key = deviceKey(hash);
  const jar = await cookies();
  const device = verifyDevice(key, jar.get(DEVICE_COOKIE)?.value, user, Date.now());
  const keys = loginBuckets(device, ip, user);

  const retry = limiter.blocked(keys);
  if (retry > 0) {
    await audit({ event: 'login.blocked', user, ip, knownDevice: !!device, retryAfterSeconds: retry });
    return back('/login', { kind: 'error', text: `Too many attempts. Try again in ${retry}s.` });
  }

  const ok = safeEqual(user, settings.adminUser) && verifyPassword(password, hash);
  if (!ok) {
    limiter.fail(keys);
    await audit({ event: 'login.failed', user, ip, knownDevice: !!device });
    return back('/login', { kind: 'error', text: 'Invalid user name or password.' });
  }

  limiter.reset(keys);
  sessions.destroy(jar.get(SESSION_COOKIE)?.value);
  const session = sessions.create(user);
  await audit({ event: 'login.ok', user, ip, knownDevice: !!device });
  const res = back('/');
  res.cookies.set(SESSION_COOKIE, session.id, {
    httpOnly: true,
    sameSite: 'strict',
    secure: settings.cookieSecure,
    path: '/',
    maxAge: settings.absoluteHours * 3600,
  });
  // Sent back only to the login endpoint; marks this browser as one that has logged in before.
  res.cookies.set(DEVICE_COOKIE, signDevice(key, user, Date.now(), DEVICE_TTL_MS, device?.nonce), {
    httpOnly: true,
    sameSite: 'strict',
    secure: settings.cookieSecure,
    path: '/api/auth/login',
    maxAge: DEVICE_TTL_MS / 1000,
  });
  return res;
}
