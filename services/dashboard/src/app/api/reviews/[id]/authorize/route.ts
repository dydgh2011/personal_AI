import { controller, ControllerError, SHA, UUID } from '@/lib/controller';
import { reasonText } from '@/lib/publishing';
import { backendMessage } from '@/components/ui';
import { authorizePost, back, routeT } from '@/lib/routes';
import { audit } from '@/lib/server';

/**
 * The separate publish approval. Comes only from the confirmation step (repository, branch, commit,
 * files, tests, author shown) with an explicit checkbox. The controller re-checks the full policy;
 * the publisher checks it again before anything is pushed.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const form = await req.formData();
  const session = await authorizePost(req, form, UUID.test(id) ? `/reviews/${id}` : '/reviews');
  if (session instanceof Response) return session;
  const t = await routeT();
  if (!UUID.test(id)) return back('/reviews', { kind: 'error', text: t.flash.invalidTaskId });
  const headSha = String(form.get('headSha') ?? '');
  const dryRunId = String(form.get('dryRunId') ?? '');
  const idempotencyKey = String(form.get('idempotencyKey') ?? '');
  const page = `/reviews/${id}`;
  if (!SHA.test(headSha) || !UUID.test(dryRunId) || !/^[A-Za-z0-9_-]{8,100}$/.test(idempotencyKey)) {
    return back(page, { kind: 'error', text: t.flash.invalidAuthorization });
  }
  if (form.get('confirmed') !== 'yes') return back(`${page}?confirm=authorize`, { kind: 'error', text: t.flash.tickToAuthorize });
  try {
    const auth = await controller.authorize(id, { headSha, dryRunId, idempotencyKey }, session.user);
    await audit({ event: 'publication.authorize', user: session.user, taskId: id, headSha, authorizationId: auth.id, testValidationId: auth.testValidationId, expiresAt: auth.expiresAt });
    return back(page, { kind: 'ok', text: t.flash.authorized(headSha.slice(0, 12), auth.expiresAt) });
  } catch (error) {
    const e = error as ControllerError;
    await audit({ event: 'publication.authorize.failed', user: session.user, taskId: id, headSha, status: e.status, code: e.code });
    return back(page, { kind: 'error', text: e.code ? t.flash.reasonWithCode(reasonText(e.code, t), e.code) : backendMessage(e, t) });
  }
}
