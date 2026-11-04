import { controller, ControllerError, SHA, UUID } from '@/lib/controller';
import { reasonText } from '@/lib/publishing';
import { authorizePost, back } from '@/lib/routes';
import { audit } from '@/lib/server';

/** Queues the project's admin-approved test commands for the reviewed commit (isolated test runner). */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const form = await req.formData();
  const session = await authorizePost(req, form, UUID.test(id) ? `/reviews/${id}` : '/reviews');
  if (session instanceof Response) return session;
  if (!UUID.test(id)) return back('/reviews', { kind: 'error', text: 'Invalid task id' });
  const headSha = String(form.get('headSha') ?? '');
  if (!SHA.test(headSha)) return back(`/reviews/${id}`, { kind: 'error', text: 'Missing or invalid head SHA' });
  try {
    const run = await controller.runTests(id, headSha, session.user);
    await audit({ event: 'tests.request', user: session.user, taskId: id, headSha, validationId: run.id });
    return back(`/reviews/${id}`, { kind: 'ok', text: 'Test run queued. The isolated test runner executes the approved commands on this exact commit.' });
  } catch (error) {
    const e = error as ControllerError;
    await audit({ event: 'tests.request.failed', user: session.user, taskId: id, headSha, status: e.status, code: e.code });
    return back(`/reviews/${id}`, { kind: 'error', text: e.code ? `${reasonText(e.code)} (${e.code})` : e.message });
  }
}
