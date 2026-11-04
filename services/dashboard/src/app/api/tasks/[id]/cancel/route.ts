import { controller, ControllerError, UUID } from '@/lib/controller';
import { authorizePost, back } from '@/lib/routes';
import { audit } from '@/lib/server';

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const form = await req.formData();
  const session = await authorizePost(req, form, UUID.test(id) ? `/tasks/${id}` : '/tasks');
  if (session instanceof Response) return session;
  if (!UUID.test(id)) return back('/tasks', { kind: 'error', text: 'Invalid task id' });
  try {
    const res = await controller.cancel(id);
    await audit({ event: 'task.cancel', user: session.user, taskId: id, outcome: res.outcome });
    return back(`/tasks/${id}`, { kind: 'ok', text: res.message });
  } catch (error) {
    const e = error as ControllerError;
    await audit({ event: 'task.cancel.failed', user: session.user, taskId: id, status: e.status });
    return back(`/tasks/${id}`, { kind: 'error', text: e.message });
  }
}
