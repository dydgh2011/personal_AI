import { describe, expect, it } from 'vitest';
import { orderItems } from '@/components/client';

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
});
