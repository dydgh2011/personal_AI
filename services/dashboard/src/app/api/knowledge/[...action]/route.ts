import { knowledge, KnowledgeError } from '@/lib/knowledge';
import { aliasesFromInput, knowledgeHref, parseSelection, safeReturn } from '@/lib/knowledge-graph';
import type { Dict } from '@/i18n';
import { backendMessage } from '@/components/ui';
import { authorizePost, back, routeT } from '@/lib/routes';
import { audit } from '@/lib/server';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const text = (f: FormData, k: string) => {
  const v = f.get(k);
  return typeof v === 'string' ? v.trim() : '';
};

/** Owner-facing text for the store's refusals (the store validates everything again). */
function explain(e: KnowledgeError, t: Dict): string {
  const x = t.kg.flash;
  if (e.status === 409) return x.conflict(e.message);
  if (e.status === 404) return x.notFound(e.message);
  if (e.status === 403) return x.forbidden;
  if (e.status === 400) return x.badInput(e.message);
  return backendMessage(e, t);
}

/** Keep the view options of the page the form came from, and point the selection somewhere useful. */
function returnWith(returnTo: string, sel: ReturnType<typeof parseSelection>): string {
  const url = new URL(returnTo, 'http://x');
  return knowledgeHref({ facts: url.searchParams.get('facts') === '1', archived: url.searchParams.get('archived') === '1', sel });
}

/**
 * Knowledge graph edits: /api/knowledge/facts/<id>/edit|archive, /pages/edit, /links/edit.
 * Session + CSRF like every dashboard form; the store's dashboard client can only do these four
 * things, needs a reason for each, logs them and never deletes for good.
 */
export async function POST(req: Request, { params }: { params: Promise<{ action: string[] }> }) {
  const t = await routeT();
  const x = t.kg.flash;
  const parts = (await params).action;
  const form = await req.formData();
  const returnTo = safeReturn(form.get('returnTo'));
  const session = await authorizePost(req, form, returnTo);
  if (session instanceof Response) return session;
  const user = session.user;
  const reason = text(form, 'reason');
  if (!reason) return back(returnTo, { kind: 'error', text: x.needReason });
  const key = parts.length === 3 && UUID.test(parts[1]) ? `${parts[0]}/:id/${parts[2]}` : parts.join('/');
  const id = parts[1];

  try {
    switch (key) {
      case 'facts/:id/edit': {
        const change: { text?: string; kind?: string | null; reason: string } = { reason };
        const newText = text(form, 'text');
        if (newText && newText !== text(form, 'original_text')) change.text = newText;
        const kind = text(form, 'kind');
        if (kind !== text(form, 'original_kind')) change.kind = kind === '' ? null : kind;
        if (change.text === undefined && change.kind === undefined) return back(returnTo, { kind: 'ok', text: x.noChanges });
        const r = await knowledge.editFact(id, change);
        await audit({ event: 'knowledge.fact.edit', user, id, newId: r.fact.id, fields: Object.keys(change).filter((k) => k !== 'reason') });
        const msg = r.replaced ? x.factReplaced : r.changed ? x.kindChanged : x.noChanges;
        return back(returnWith(returnTo, { kind: 'fact', id: r.fact.id }), { kind: 'ok', text: msg });
      }
      case 'facts/:id/archive': {
        const archived = text(form, 'archived') === 'true';
        const r = await knowledge.archiveFact(id, archived, reason);
        await audit({ event: archived ? 'knowledge.fact.archive' : 'knowledge.fact.restore', user, id });
        return back(returnWith(returnTo, { kind: 'fact', id: r.fact.id }), { kind: 'ok', text: archived ? x.factArchived : x.factRestored });
      }
      case 'pages/edit': {
        const page = text(form, 'page');
        const change: { page: string; title?: string; aliases?: string[]; archived?: boolean; reason: string } = { page, reason };
        if (form.has('archived')) {
          if (form.get('confirmed') !== 'yes') return back(returnTo, { kind: 'error', text: x.needConfirm });
          change.archived = text(form, 'archived') === 'true';
        } else {
          const title = text(form, 'title');
          if (title && title !== text(form, 'original_title')) change.title = title;
          const aliases = aliasesFromInput(text(form, 'aliases'));
          if (aliases.join('\n') !== aliasesFromInput(text(form, 'original_aliases')).join('\n')) change.aliases = aliases;
          if (change.title === undefined && change.aliases === undefined) return back(returnTo, { kind: 'ok', text: x.noChanges });
        }
        const r = await knowledge.editPage(change);
        await audit({ event: 'knowledge.page.edit', user, page, fields: Object.keys(change).filter((k) => k !== 'reason' && k !== 'page') });
        const msg = change.archived === true ? x.pageArchived : change.archived === false ? x.pageRestored : x.pageEdited;
        return back(returnWith(returnTo, change.archived === true ? null : { kind: 'page', slug: r.page.slug }), { kind: 'ok', text: msg });
      }
      case 'links/edit': {
        const from = text(form, 'from');
        const to = text(form, 'to');
        const relation = text(form, 'relation');
        const remove = text(form, 'remove') === 'true';
        const note = text(form, 'note');
        await knowledge.editLink({ from, to, relation, reason, ...(remove ? { remove: true } : {}), ...(!remove && note ? { note } : {}) });
        await audit({ event: remove ? 'knowledge.link.remove' : 'knowledge.link.add', user, from, to, relation });
        return back(returnWith(returnTo, { kind: 'page', slug: from }), { kind: 'ok', text: remove ? x.linkRemoved : x.linkAdded });
      }
      default:
        return back(returnTo, { kind: 'error', text: x.unknownAction });
    }
  } catch (error) {
    const e = error instanceof KnowledgeError ? error : new KnowledgeError(x.unexpected, 500, 'error');
    await audit({ event: `knowledge.${key}.failed`, user, status: e.status, code: e.code });
    return back(returnTo, { kind: 'error', text: explain(e, t) });
  }
}
