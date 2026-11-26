import { controller, ControllerError, SHA, UUID } from '@/lib/controller';
import { backendMessage } from '@/components/ui';
import { authorizePost, back, routeT } from '@/lib/routes';
import { audit } from '@/lib/server';

/**
 * Approve or reject one exact commit. The form comes from the confirmation step, which shows the
 * project, base/head SHA and files; it must carry the head SHA the reviewer saw and an explicit
 * confirmation. The controller rejects stale or duplicate decisions with 409.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const form = await req.formData();
  const session = await authorizePost(req, form, UUID.test(id) ? `/reviews/${id}` : '/reviews');
  if (session instanceof Response) return session;
  const t = await routeT();
  if (!UUID.test(id)) return back('/reviews', { kind: 'error', text: t.flash.invalidTaskId });

  const decision = form.get('decision');
  const headSha = String(form.get('headSha') ?? '');
  const reason = String(form.get('reason') ?? '').trim().slice(0, 2000) || undefined;
  const page = `/reviews/${id}`;
  if (decision !== 'approve' && decision !== 'reject') return back(page, { kind: 'error', text: t.flash.unknownDecision });
  if (!SHA.test(headSha)) return back(page, { kind: 'error', text: t.flash.invalidHeadSha });
  if (form.get('confirmed') !== 'yes') {
    return back(`${page}?confirm=${decision}`, { kind: 'error', text: t.flash.tickToContinue });
  }

  try {
    const review = await controller.decide(id, decision, headSha, reason, session.user);
    await audit({ event: `review.${decision}`, user: session.user, taskId: id, headSha, status: review.status });
    return back(page, { kind: 'ok', text: t.flash.decided(review.status, headSha.slice(0, 12)) });
  } catch (error) {
    const e = error as ControllerError;
    await audit({ event: `review.${decision}.failed`, user: session.user, taskId: id, headSha, status: e.status, message: e.message });
    const text = e.status === 409 ? t.flash.notRecorded(e.message) : backendMessage(e, t);
    return back(page, { kind: 'error', text });
  }
}
