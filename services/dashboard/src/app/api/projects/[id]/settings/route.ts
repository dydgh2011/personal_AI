import { controller, ControllerError } from '@/lib/controller';
import { changedSettings, parseSettingsForm, PROJECT_ID } from '@/lib/project-settings';
import { backendMessage } from '@/components/ui';
import { authorizePost, back, routeT } from '@/lib/routes';
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
  const t = await routeT();
  if (!valid) return back('/projects', { kind: 'error', text: t.flash.invalidProjectId }, 'input');

  const parsed = parseSettingsForm(form, t);
  if ('error' in parsed) return back(page, { kind: 'error', text: parsed.error }, 'input');

  try {
    const current = await controller.project(id);
    const changed = changedSettings(current, parsed.patch);
    if (changed.length === 0) return back(page, { kind: 'ok', text: t.flash.noChanges });
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
    return back(page, { kind: 'ok', text: t.flash.settingsSaved(changed.join(', ')) });
  } catch (error) {
    const e = error as ControllerError;
    await audit({ event: 'project.settings.failed', user: session.user, projectId: id, status: e.status ?? null });
    return back(page, { kind: 'error', text: backendMessage(e, t) });
  }
}
