'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

/** Re-renders the server page every `seconds` while enabled (no data is cached in the browser). */
export function AutoRefresh({ seconds = 5 }: { seconds?: number }) {
  const router = useRouter();
  const [on, setOn] = useState(true);
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') router.refresh();
    }, seconds * 1000);
    return () => clearInterval(t);
  }, [on, seconds, router]);
  return (
    <label className="muted row" style={{ gap: 4 }}>
      <input type="checkbox" checked={on} onChange={(e) => setOn(e.target.checked)} /> auto-refresh {seconds}s
    </label>
  );
}

export function ThemeToggle() {
  const toggle = () => {
    const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    document.documentElement.dataset.theme = next;
    document.cookie = `pai_theme=${next}; path=/; max-age=31536000; samesite=strict`;
  };
  return (
    <button type="button" onClick={toggle} title="Toggle light/dark">
      Theme
    </button>
  );
}

export function NavLinks({ items }: { items: Array<{ href: string; title: string }> }) {
  const path = usePathname();
  return (
    <nav>
      {items.map((m) => {
        const active = m.href === '/' ? path === '/' : path.startsWith(m.href);
        return (
          <a key={m.href} href={m.href} className={active ? 'active' : undefined}>
            {m.title}
          </a>
        );
      })}
    </nav>
  );
}
