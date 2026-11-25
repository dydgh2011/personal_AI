'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, type CSSProperties } from 'react';

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

/**
 * Sidebar links in the owner's order (temporary, 2026-11-25): the order can be changed here and is
 * kept in this browser (localStorage). Once the owner settles on one order it goes into
 * src/modules/registry.ts and this editing goes away. Links unknown to the saved order (new
 * modules) are added at the end in registry order.
 */
const NAV_ORDER_KEY = 'pai-nav-order';

function readOrder(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(NAV_ORDER_KEY) || 'null');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export function orderItems<T extends { href: string }>(items: T[], order: string[]): T[] {
  const byHref = new Map(items.map((i) => [i.href, i]));
  const seen = new Set<string>();
  const out: T[] = [];
  for (const href of order) {
    const item = byHref.get(href);
    if (item && !seen.has(href)) {
      out.push(item);
      seen.add(href);
    }
  }
  for (const item of items) if (!seen.has(item.href)) out.push(item);
  return out;
}

export function NavLinks({ items }: { items: Array<{ href: string; title: string }> }) {
  const path = usePathname();
  const [order, setOrder] = useState<string[]>([]);
  const [editing, setEditing] = useState(false);
  const [copied, setCopied] = useState(false);
  useEffect(() => setOrder(readOrder()), []);
  const list = orderItems(items, order);
  const save = (next: string[]) => {
    setOrder(next);
    try {
      localStorage.setItem(NAV_ORDER_KEY, JSON.stringify(next));
    } catch {
      // storage blocked: the order still applies until the page reloads
    }
  };
  const move = (index: number, delta: number) => {
    const hrefs = list.map((i) => i.href);
    const to = index + delta;
    if (to < 0 || to >= hrefs.length) return;
    [hrefs[index], hrefs[to]] = [hrefs[to], hrefs[index]];
    save(hrefs);
  };
  const reset = () => {
    setOrder([]);
    try {
      localStorage.removeItem(NAV_ORDER_KEY);
    } catch {
      // ignore
    }
  };
  const copy = async () => {
    const text = list.map((i, n) => `${n + 1}. ${i.title} (${i.href})`).join('\n');
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      window.prompt('순서를 복사하세요', text.replace(/\n/g, ' / '));
    }
  };
  const small: CSSProperties = { padding: '0 6px', fontSize: 12, lineHeight: '20px', minWidth: 24 };
  return (
    <nav aria-label="메뉴">
      {list.map((m, index) => {
        const active = m.href === '/' ? path === '/' : path.startsWith(m.href);
        if (!editing) {
          return (
            <a key={m.href} href={m.href} className={active ? 'active' : undefined}>
              {m.title}
            </a>
          );
        }
        return (
          <div key={m.href} style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '2px 0' }}>
            <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', padding: '4px 8px' }}>{m.title}</span>
            <button type="button" style={small} onClick={() => move(index, -1)} disabled={index === 0} aria-label={`${m.title} 위로`}>
              ↑
            </button>
            <button type="button" style={small} onClick={() => move(index, 1)} disabled={index === list.length - 1} aria-label={`${m.title} 아래로`}>
              ↓
            </button>
          </div>
        );
      })}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 8 }}>
        <button type="button" style={small} onClick={() => setEditing(!editing)} aria-pressed={editing}>
          {editing ? '편집 끝' : '순서 편집'}
        </button>
        {editing && (
          <>
            <button type="button" style={small} onClick={reset}>
              기본 순서
            </button>
            <button type="button" style={small} onClick={copy}>
              {copied ? '복사됨' : '순서 복사'}
            </button>
          </>
        )}
      </div>
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
