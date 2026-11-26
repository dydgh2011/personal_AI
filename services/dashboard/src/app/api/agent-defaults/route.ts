import { parseDefaultsForm } from '@/lib/agent-defaults';
import { controller, ControllerError } from '@/lib/controller';
import { authorizePost, back } from '@/lib/routes';
import { audit } from '@/lib/server';

/**
 * Saves a worker's default model and effort through the controller's POST /agent-defaults/:agent.
 * Session + CSRF like every dashboard form. Applies to tasks created from now on.
 */
export async function POST(req: Request) {
  const form = await req.formData();
  const session = await authorizePost(req, form, '/tasks');
  if (session instanceof Response) return session;
  const parsed = parseDefaultsForm(form);
  if ('error' in parsed) return back('/tasks', { kind: 'error', text: parsed.error }, 'input');
  try {
    const saved = await controller.setAgentDefaults(parsed.agent, { model: parsed.model, effort: parsed.effort });
    await audit({ event: 'agent.defaults', user: session.user, agent: parsed.agent, model: saved.model, effort: saved.effort });
    return back('/tasks', {
      kind: 'ok',
      text: `${parsed.agent} default: model ${saved.model ?? 'CLI default'}, effort ${saved.effort ?? 'CLI default'}. Applies to new tasks.`,
    });
  } catch (error) {
    const e = error as ControllerError;
    await audit({ event: 'agent.defaults.failed', user: session.user, agent: parsed.agent, status: e.status ?? null });
    return back('/tasks', { kind: 'error', text: e.message });
  }
}
