import { knowledge, KnowledgeError } from '@/lib/knowledge';
import { aliasesFromInput, knowledgeHref, parseSelection, safeReturn } from '@/lib/knowledge-graph';
import { authorizePost, back } from '@/lib/routes';
import { audit } from '@/lib/server';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const text = (f: FormData, k: string) => {
  const v = f.get(k);
  return typeof v === 'string' ? v.trim() : '';
};

/** Owner-facing text for the store's refusals (the store validates everything again). */
function explain(e: KnowledgeError): string {
  if (e.status === 409) return `이미 있거나 겹칩니다: ${e.message}`;
  if (e.status === 404) return `찾을 수 없습니다: ${e.message}`;
  if (e.status === 403) return '지식 저장소가 이 작업을 허용하지 않습니다.';
  if (e.status === 400) return `입력이 올바르지 않습니다: ${e.message}`;
  return e.message;
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
  const parts = (await params).action;
  const form = await req.formData();
  const returnTo = safeReturn(form.get('returnTo'));
  const session = await authorizePost(req, form, returnTo);
  if (session instanceof Response) return session;
  const user = session.user;
  const reason = text(form, 'reason');
  if (!reason) return back(returnTo, { kind: 'error', text: '이유를 적어야 저장됩니다.' });
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
        if (change.text === undefined && change.kind === undefined) return back(returnTo, { kind: 'ok', text: '바뀐 내용이 없습니다.' });
        const r = await knowledge.editFact(id, change);
        await audit({ event: 'knowledge.fact.edit', user, id, newId: r.fact.id, fields: Object.keys(change).filter((k) => k !== 'reason') });
        const msg = r.replaced ? '사실을 고쳤습니다. 새 버전이 생겼고 이전 것은 옛 버전으로 남았습니다.' : r.changed ? '종류를 바꿨습니다.' : '바뀐 내용이 없습니다.';
        return back(returnWith(returnTo, { kind: 'fact', id: r.fact.id }), { kind: 'ok', text: msg });
      }
      case 'facts/:id/archive': {
        const archived = text(form, 'archived') === 'true';
        const r = await knowledge.archiveFact(id, archived, reason);
        await audit({ event: archived ? 'knowledge.fact.archive' : 'knowledge.fact.restore', user, id });
        return back(returnWith(returnTo, { kind: 'fact', id: r.fact.id }), { kind: 'ok', text: archived ? '사실을 보관했습니다.' : '사실을 되살렸습니다.' });
      }
      case 'pages/edit': {
        const page = text(form, 'page');
        const change: { page: string; title?: string; aliases?: string[]; archived?: boolean; reason: string } = { page, reason };
        if (form.has('archived')) {
          if (form.get('confirmed') !== 'yes') return back(returnTo, { kind: 'error', text: '확인 체크박스를 선택해야 합니다.' });
          change.archived = text(form, 'archived') === 'true';
        } else {
          const title = text(form, 'title');
          if (title && title !== text(form, 'original_title')) change.title = title;
          const aliases = aliasesFromInput(text(form, 'aliases'));
          if (aliases.join('\n') !== aliasesFromInput(text(form, 'original_aliases')).join('\n')) change.aliases = aliases;
          if (change.title === undefined && change.aliases === undefined) return back(returnTo, { kind: 'ok', text: '바뀐 내용이 없습니다.' });
        }
        const r = await knowledge.editPage(change);
        await audit({ event: 'knowledge.page.edit', user, page, fields: Object.keys(change).filter((k) => k !== 'reason' && k !== 'page') });
        const msg = change.archived === true ? '문서를 보관했습니다.' : change.archived === false ? '문서를 되살렸습니다.' : '문서를 고쳤습니다.';
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
        return back(returnWith(returnTo, { kind: 'page', slug: from }), { kind: 'ok', text: remove ? '연결을 지웠습니다.' : '연결을 추가했습니다.' });
      }
      default:
        return back(returnTo, { kind: 'error', text: 'Unknown action' });
    }
  } catch (error) {
    const e = error instanceof KnowledgeError ? error : new KnowledgeError('Unexpected error', 500, 'error');
    await audit({ event: `knowledge.${key}.failed`, user, status: e.status, code: e.code });
    return back(returnTo, { kind: 'error', text: explain(e) });
  }
}
