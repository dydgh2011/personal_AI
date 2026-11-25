import { errorText } from '@/components/ui';
import { learning } from '@/lib/learning';
import { scheduleDate, scheduleHref, schedulePeriod } from '@/lib/learning-schedule-view';
import { authorizePost, back } from '@/lib/routes';
import { audit } from '@/lib/server';

export async function POST(request: Request) {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return back('/learning/planner', { kind: 'error', text: 'The study planner could not read the form.' }, 'body');
  }
  const date = scheduleDate(form.get('date'));
  const period = schedulePeriod(form.get('period'));
  const here = scheduleHref(date, period);
  const session = await authorizePost(request, form, here);
  if (session instanceof Response) return session;

  const intent = form.get('intent');
  try {
    if (intent === 'availability') {
      const windows = [];
      for (let weekday = 0; weekday < 7; weekday++) {
        const start = form.get(`start-${weekday}`);
        const end = form.get(`end-${weekday}`);
        if (start === '' && end === '') continue;
        if (typeof start !== 'string' || typeof end !== 'string' || !start || !end) {
          return back(here, { kind: 'error', text: 'Enter both times for each study day or leave both blank.' });
        }
        windows.push({ weekday, start, end });
      }
      await learning.updateScheduleAvailability(windows, session.user);
      await audit({ event: 'learning.schedule.availability', user: session.user });
      return back(here, { kind: 'ok', text: 'Weekly availability saved.' });
    }
    if (intent === 'propose') {
      const { proposal } = await learning.proposeSchedule({ date, period }, session.user);
      await audit({ event: 'learning.schedule.propose', user: session.user, id: proposal.code });
      const text = proposal.status === 'applied'
        ? `Planner proposal ${proposal.code} has already been applied.`
        : `Planner draft ${proposal.code} is ready. Ask Kelly to show this proposal and approve the blocks you want.`;
      return back(here, { kind: 'ok', text });
    }
    return back(here, { kind: 'error', text: 'Unknown study planner action.' });
  } catch (error) {
    return back(here, { kind: 'error', text: errorText(error) });
  }
}
