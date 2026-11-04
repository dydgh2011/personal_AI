import { redirect } from 'next/navigation';
import { Flash } from '@/components/ui';
import { currentSession } from '@/lib/server';

export const dynamic = 'force-dynamic';

export default async function LoginPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if (await currentSession()) redirect('/');
  const sp = await searchParams;
  return (
    <div className="login">
      <h1>Personal AI OS</h1>
      <p className="muted">Admin sign-in</p>
      <Flash ok={sp.ok} error={sp.error} />
      <form method="post" action="/api/auth/login" autoComplete="on">
        <label>
          User
          <input name="username" autoComplete="username" required maxLength={64} />
        </label>
        <label>
          Password
          <input name="password" type="password" autoComplete="current-password" required maxLength={256} />
        </label>
        <button className="primary" type="submit">
          Sign in
        </button>
      </form>
    </div>
  );
}
