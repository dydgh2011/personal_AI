import { controller, ControllerError, UUID } from '@/lib/controller';
import { reasonText } from '@/lib/publishing';
import { authorizePost, back } from '@/lib/routes';
import { audit } from '@/lib/server';

/**
 * Publish request, from its own confirmation step. In Phase E-2B the controller refuses it
 * (PUBLISH_DISABLED) and the publisher's backend is disabled; this route exists so the flow and its
 * checks are in place, not to push anything.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const form = await req.formData();
  const session = await authorizePost(req, form, UUID.test(id) ? `/reviews/${id}` : '/reviews');
  if (session instanceof Response) return session;
  if (!UUID.test(id)) return back('/reviews', { kind: 'error', text: 'Invalid task id' });
  const authorizationId = String(form.get('authorizationId') ?? '');
  const idempotencyKey = String(form.get('idempotencyKey') ?? '');
  const page = `/reviews/${id}`;
  if (!UUID.test(authorizationId) || !/^[A-Za-z0-9_-]{8,100}$/.test(idempotencyKey)) return back(page, { kind: 'error', text: 'Invalid publish request' });
  if (form.get('confirmed') !== 'yes') return back(`${page}?confirm=publish`, { kind: 'error', text: 'Tick the confirmation box to publish.' });
  try {
    const pub = await controller.publish(id, { authorizationId, idempotencyKey }, session.user);
    await audit({ event: 'publication.publish', user: session.user, taskId: id, authorizationId, publicationId: pub.id });
    return back(page, { kind: 'ok', text: 'Publish requested.' });
  } catch (error) {
    const e = error as ControllerError;
    await audit({ event: 'publication.publish.failed', user: session.user, taskId: id, authorizationId, status: e.status, code: e.code });
    return back(page, { kind: 'error', text: e.code ? `${reasonText(e.code)} (${e.code})` : e.message });
  }
}
