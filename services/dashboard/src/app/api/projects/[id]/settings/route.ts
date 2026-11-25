import { controller, ControllerError } from '@/lib/controller';
import { changedSettings, parseSettingsForm, PROJECT_ID } from '@/lib/project-settings';
import { authorizePost, back } from '@/lib/routes';
import { audit } from '@/lib/server';

/**
 * Saves a project's agent settings (commit author, commit style, coding rules, forbidden paths)
 * through the controller's admin PATCH /projects/:id. Session + CSRF like every dashboard form;
 * the audit log records who changed which setting, never the values.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const valid = PROJECT_ID.test(id);
  const page = valid ? `/projects/${id}` : '/projects';
  const form = await req.formData();
  const session = await authorizePost(req, form, page);
  if (session instanceof Response) return session;
  if (!valid) return back('/projects', { kind: 'error', text: 'Invalid project id' }, 'input');

  const parsed = parseSettingsForm(form);
  if ('error' in parsed) return back(page, { kind: 'error', text: parsed.error }, 'input');

  try {
    const current = await controller.project(id);
    const changed = changedSettings(current, parsed.patch);
    if (changed.length === 0) return back(page, { kind: 'ok', text: 'No changes.' });
    await controller.updateProjectSettings(id, parsed.patch);
    await audit({
      event: 'project.settings',
      user: session.user,
      projectId: id,
      changed,
      styleMode: parsed.patch.commitStyle.mode,
      forbiddenPaths: parsed.patch.agentInstructions.forbiddenPaths.length,
      rulesChars: parsed.patch.agentInstructions.rules.length,
    });
    return back(page, { kind: 'ok', text: `Saved: ${changed.join(', ')}. Applies to tasks that start from now on.` });
  } catch (error) {
    const e = error as ControllerError;
    await audit({ event: 'project.settings.failed', user: session.user, projectId: id, status: e.status ?? null });
    return back(page, { kind: 'error', text: e.message });
  }
}
