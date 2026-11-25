import { describe, expect, it } from 'vitest';
import { orderItems, parseNavOrder, serializeNavOrder } from '@/lib/nav-order';

const items = [
  { href: '/', title: 'Overview' },
  { href: '/tasks', title: 'Tasks' },
  { href: '/knowledge', title: 'Knowledge' },
  { href: '/services', title: 'Services' },
];

describe('sidebar order (temporary owner editing)', () => {
  it('keeps the registry order without a saved order', () => {
    expect(orderItems(items, []).map((i) => i.href)).toEqual(['/', '/tasks', '/knowledge', '/services']);
  });
  it('applies a saved order, skips unknown or repeated entries, and appends new modules', () => {
    expect(orderItems(items, ['/knowledge', '/gone', '/', '/knowledge']).map((i) => i.href)).toEqual(['/knowledge', '/', '/tasks', '/services']);
  });
  it('round-trips the order through the cookie value', () => {
    const order = ['/knowledge', '/', '/learning/planner'];
    expect(parseNavOrder(serializeNavOrder(order))).toEqual(order);
  });
  it('ignores missing, malformed or non-path cookie values', () => {
    expect(parseNavOrder(undefined)).toEqual([]);
    expect(parseNavOrder('%E0%A4%A')).toEqual([]);
    expect(parseNavOrder(encodeURIComponent('/ok,javascript:alert(1),https://x.test,<b>'))).toEqual(['/ok']);
    expect(parseNavOrder('x'.repeat(5000))).toEqual([]);
  });
});
