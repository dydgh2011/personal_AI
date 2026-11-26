import { redirect } from 'next/navigation';
import { Flash } from '@/components/ui';
import { LangToggle } from '@/i18n/client';
import { getT } from '@/i18n/server';
import { currentSession } from '@/lib/server';

export const dynamic = 'force-dynamic';

export default async function LoginPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if (await currentSession()) redirect('/');
  const [sp, t] = await Promise.all([searchParams, getT()]);
  return (
    <div className="login">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h1>Personal AI OS</h1>
        <LangToggle />
      </div>
      <p className="muted">{t.login.subtitle}</p>
      <Flash ok={sp.ok} error={sp.error} />
      <form method="post" action="/api/auth/login" autoComplete="on">
        <label>
          {t.login.user}
          <input name="username" autoComplete="username" required maxLength={64} />
        </label>
        <label>
          {t.login.password}
          <input name="password" type="password" autoComplete="current-password" required maxLength={256} />
        </label>
        <button className="primary" type="submit">
          {t.login.signIn}
        </button>
      </form>
    </div>
  );
}
