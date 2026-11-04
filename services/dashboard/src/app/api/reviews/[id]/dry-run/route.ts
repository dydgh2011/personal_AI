import { controller, ControllerError, SHA, UUID } from '@/lib/controller';
import { authorizePost, back } from '@/lib/routes';
import { audit } from '@/lib/server';

/**
 * Asks the GitHub Publisher to validate one approved commit (dry-run). This is separate from the
 * approval and publishes nothing; a future publish step will ask again for repository, branch,
 * commit and files.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const form = await req.formData();
  const session = await authorizePost(req, form, UUID.test(id) ? `/reviews/${id}` : '/reviews');
  if (session instanceof Response) return session;
  if (!UUID.test(id)) return back('/reviews', { kind: 'error', text: 'Invalid task id' });
  const headSha = String(form.get('headSha') ?? '');
  const page = `/reviews/${id}#publication`;
  if (!SHA.test(headSha)) return back(page, { kind: 'error', text: 'Missing or invalid head SHA' });
  try {
    const publication = await controller.dryRun(id, headSha, session.user);
    await audit({ event: 'publication.dry-run', user: session.user, taskId: id, headSha, publicationId: publication.id });
    return back(`/reviews/${id}`, { kind: 'ok', text: 'Validation requested (dry-run). Nothing will be pushed.' });
  } catch (error) {
    const e = error as ControllerError;
    await audit({ event: 'publication.dry-run.failed', user: session.user, taskId: id, headSha, status: e.status, message: e.message });
    return back(`/reviews/${id}`, { kind: 'error', text: e.message });
  }
}
