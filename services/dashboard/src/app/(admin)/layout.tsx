import { NavLinks, ScrollKeeper, ThemeToggle } from '@/components/client';
import { CsrfField } from '@/components/ui';
import { LangToggle } from '@/i18n/client';
import { getT } from '@/i18n/server';
import { NAV_ORDER_COOKIE, parseNavOrder } from '@/lib/nav-order';
import { requireSession } from '@/lib/server';
import { MODULES, moduleText } from '@/modules/registry';
import { cookies } from 'next/headers';

export const dynamic = 'force-dynamic';

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await requireSession();
  const t = await getT();
  // Single admin account: every module requires "admin", which the session has.
  const items = MODULES.filter((m) => m.permission === 'admin').map(({ href, id }) => ({ href, title: moduleText(t, id).title }));
  // Owner's sidebar order (temporary): rendered on the server so the default order never flashes.
  const navOrder = parseNavOrder((await cookies()).get(NAV_ORDER_COOKIE)?.value);
  return (
    <div className="shell">
      <aside className="side">
        <div className="brand">Personal AI OS</div>
        <NavLinks items={items} initialOrder={navOrder} />
        <div className="grow" />
        <div className="row side-controls">
          <ThemeToggle />
          <LangToggle />
          <form className="inline" method="post" action="/api/auth/logout">
            <CsrfField token={session.csrf} />
            <button type="submit">{t.shell.logout}</button>
          </form>
        </div>
        <div className="who">{session.user}</div>
      </aside>
      <main>{children}</main>
      <ScrollKeeper />
    </div>
  );
}
