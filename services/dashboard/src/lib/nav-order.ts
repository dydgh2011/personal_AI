/**
 * Sidebar order (temporary, 2026-11-25). The owner's order is kept in the `pai_nav` cookie so the
 * server renders the sidebar already in that order: links are plain <a> (full page loads), and an
 * order applied only after the page loads showed the default order for a moment.
 *
 * The cookie holds only module paths, nothing secret. Anything that is not a known module path is
 * ignored by orderItems. Once the owner settles on one order it goes into src/modules/registry.ts
 * and this goes away.
 */
export const NAV_ORDER_COOKIE = 'pai_nav';
const MAX_ENTRIES = 50;

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

/** Cookie value -> list of paths. Bad or oversized values give an empty list (default order). */
export function parseNavOrder(raw: string | undefined): string[] {
  if (!raw || raw.length > 4000) return [];
  let text: string;
  try {
    text = decodeURIComponent(raw);
  } catch {
    return [];
  }
  return text
    .split(',')
    .filter((h) => /^\/[a-z0-9/_-]*$/i.test(h))
    .slice(0, MAX_ENTRIES);
}

export function serializeNavOrder(order: string[]): string {
  return encodeURIComponent(order.slice(0, MAX_ENTRIES).join(','));
}
