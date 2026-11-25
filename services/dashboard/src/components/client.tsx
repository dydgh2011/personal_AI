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

/**
 * Dashboard forms post and come back through a redirect, a full page load that would start at the
 * top. Just before a POST form on this page submits, the scroll position is remembered for this
 * path; when the redirect lands on the same path (within a minute) it is restored once. Kept only
 * in this tab's sessionStorage; nothing is sent anywhere.
 */
const SCROLL_KEY = 'pai-scroll';

export function ScrollKeeper() {
  const pathname = usePathname();
  useEffect(() => {
    try {
      const saved = JSON.parse(sessionStorage.getItem(SCROLL_KEY) || 'null') as { path: string; y: number; at: number } | null;
      sessionStorage.removeItem(SCROLL_KEY);
      if (saved && saved.path === window.location.pathname && Date.now() - saved.at < 60_000 && saved.y > 0) {
        requestAnimationFrame(() => window.scrollTo({ top: saved.y, behavior: 'instant' as ScrollBehavior }));
      }
    } catch {
      // storage blocked: just keep the browser's default
    }
    const onSubmit = (event: SubmitEvent) => {
      const form = event.target;
      if (!(form instanceof HTMLFormElement) || form.method.toLowerCase() !== 'post' || event.defaultPrevented) return;
      try {
        sessionStorage.setItem(SCROLL_KEY, JSON.stringify({ path: window.location.pathname, y: window.scrollY, at: Date.now() }));
      } catch {
        // ignore
      }
    };
    document.addEventListener('submit', onSubmit);
    return () => document.removeEventListener('submit', onSubmit);
  }, [pathname]);
  return null;
}
