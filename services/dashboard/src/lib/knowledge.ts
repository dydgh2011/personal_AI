import 'server-only';
import { readSecret } from './server';
import type { FactDetail, GraphView, PageDetail } from './knowledge-graph';

/**
 * The knowledge store as client "dashboard" (compose.knowledge.yaml overlay): read the graph, pages
 * and facts; edit facts, pages and links. The key stays on the server. The store enforces the route
 * allowlist and logs every edit with actor "dashboard"; nothing here can delete for good.
 */
const settings = {
  url: (process.env.KNOWLEDGE_URL?.trim() || 'http://knowledge:8092').replace(/\/+$/, ''),
  keyFile: process.env.KNOWLEDGE_KEY_FILE?.trim() || '/run/secrets/knowledge_key',
};

export class KnowledgeError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
  }
}

async function call<T>(method: 'GET' | 'POST', path: string, body?: Record<string, unknown>): Promise<T> {
  let key: string;
  try {
    key = readSecret(settings.keyFile);
  } catch {
    throw new KnowledgeError('Knowledge key is not configured (secrets/knowledge-dashboard.key, compose.knowledge.yaml)', 503, 'not_configured');
  }
  let res: Response;
  try {
    res = await fetch(`${settings.url}${path}`, {
      method,
      headers: { 'X-Knowledge-Key': key, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      cache: 'no-store',
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    throw new KnowledgeError('Knowledge store unreachable', 503, 'unreachable');
  }
  const data = (await res.json().catch(() => null)) as (T & { code?: string; message?: string }) | null;
  if (!res.ok) {
    throw new KnowledgeError(String(data?.message || `Knowledge store answered ${res.status}`).slice(0, 300), res.status, String(data?.code || 'error'));
  }
  return data as T;
}

export const knowledge = {
  graph(opts: { facts: boolean; archived: boolean }) {
    const q = new URLSearchParams({ facts: opts.facts ? '1' : '0', archived: opts.archived ? '1' : '0' });
    return call<GraphView>('GET', `/graph/view?${q}`);
  },
  page(slug: string) {
    return call<PageDetail>('GET', `/page?${new URLSearchParams({ ref: slug })}`);
  },
  fact(id: string) {
    return call<FactDetail>('GET', `/facts/${encodeURIComponent(id)}`);
  },
  editFact(id: string, change: { text?: string; kind?: string | null; reason: string }) {
    return call<{ changed: boolean; replaced?: string; fact: FactDetail }>('POST', `/edit/facts/${encodeURIComponent(id)}`, change);
  },
  archiveFact(id: string, archived: boolean, reason: string) {
    return call<{ changed: boolean; fact: FactDetail }>('POST', `/edit/facts/${encodeURIComponent(id)}/archive`, { archived, reason });
  },
  editPage(change: { page: string; title?: string; aliases?: string[]; archived?: boolean; reason: string }) {
    return call<{ changed: boolean; page: { slug: string; title: string } }>('POST', '/edit/pages', change);
  },
  editLink(change: { from: string; to: string; relation: string; note?: string; remove?: boolean; reason: string }) {
    return call<{ changed?: boolean }>('POST', '/edit/links', change);
  },
};
