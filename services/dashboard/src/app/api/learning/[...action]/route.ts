import { backendMessage } from '@/components/ui';
import { learning, LearningError } from '@/lib/learning';
import { DEFAULT_UPLOAD_LIMITS, LEARNING_UUID, safeLearningReturn, uploadProblem } from '@/lib/learning-view';
import type { Dict } from '@/i18n';
import { authorizePost, back, routeT } from '@/lib/routes';
import { audit } from '@/lib/server';

/** Owner-facing text for the learning service's error codes: t.learnFlash.codes (dictionaries). */

const text = (f: FormData, k: string) => {
  const v = f.get(k);
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
};
/** Keeps line breaks and inner spacing (answers, instructions). */
const longText = (f: FormData, k: string) => {
  const v = f.get(k);
  return typeof v === 'string' && v.trim() !== '' ? v.replace(/\r\n/g, '\n') : undefined;
};
const int = (f: FormData, k: string) => {
  const v = text(f, k);
  return v === undefined ? undefined : Number.parseInt(v, 10);
};
const num = (f: FormData, k: string) => {
  const v = text(f, k);
  return v === undefined ? undefined : Number(v);
};
const list = (f: FormData, k: string) => f.getAll(k).filter((v): v is string => typeof v === 'string' && v !== '');
const nullableUuid = (f: FormData, k: string) => {
  const v = text(f, k);
  return v && LEARNING_UUID.test(v) ? v : null;
};
/** Present-but-empty means "clear" (null); absent means "leave as is" (undefined). */
const clearable = (f: FormData, k: string) => (f.has(k) ? (text(f, k) ?? null) : undefined);
const defined = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

/** Rubric criteria from repeated form rows (c_title / c_max / c_key / c_desc). */
function criteriaFrom(f: FormData) {
  const titles = f.getAll('c_title');
  const maxes = f.getAll('c_max');
  const keys = f.getAll('c_key').map((key) => typeof key === 'string' ? key.trim() : '');
  const descs = f.getAll('c_desc');
  const used = new Set(keys.filter(Boolean));
  return titles.flatMap((t, i) => {
    const title = typeof t === 'string' ? t.trim() : '';
    if (!title) return [];
    const slug = title.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    const base = slug.slice(0, 40) || `c${i + 1}`;
    let key = keys[i] || base;
    if (!keys[i]) {
      for (let index = 2; used.has(key); index++) {
        const suffix = `-${index}`;
        key = base.slice(0, 40 - suffix.length) + suffix;
      }
      used.add(key);
    }
    const desc = typeof descs[i] === 'string' ? (descs[i] as string).trim() : '';
    return [{ key, title, maxScore: Number(maxes[i]), ...(desc ? { description: desc } : {}) }];
  });
}

async function filesFrom(f: FormData, t: Dict): Promise<Array<{ name: string; contentBase64: string }> | string> {
  const files = f.getAll('files').filter((v): v is File => typeof v !== 'string' && v.name !== '');
  const problem = uploadProblem(files.map((x) => ({ name: x.name, size: x.size })), DEFAULT_UPLOAD_LIMITS, t);
  if (problem) return problem;
  return Promise.all(files.map(async (x) => ({ name: x.name, contentBase64: Buffer.from(await x.arrayBuffer()).toString('base64') })));
}

/**
 * All learning form posts: /api/learning/<entity>/<action> or /<entity>/<id>/<action>.
 * Same session + CSRF checks as every other dashboard form; the learning service enforces the
 * domain rules (versions, DAG, deadlines, transitions, uploads, evidence) again.
 */
export async function POST(req: Request, { params }: { params: Promise<{ action: string[] }> }) {
  const parts = (await params).action;
  const t = await routeT();
  const x = t.learnFlash;
  const st = (status: string) => t.learn.status[status] ?? status;
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    // Unreadable body (e.g. cut off because it was too large): nothing was done.
    return back('/learning', { kind: 'error', text: x.unreadable }, 'body');
  }
  const entityId = parts.length === 3 && LEARNING_UUID.test(parts[1]) ? parts[1] : null;
  const key = entityId ? `${parts[0]}/:id/${parts[2]}` : parts.length === 2 ? `${parts[0]}/${parts[1]}` : null;
  const own = (base: string) => (entityId ? `/learning/${base}/${entityId}` : `/learning/${base}`);
  const roadmapPage = parts[0] === 'roadmaps' && entityId ? `/learning/roadmaps/${entityId}` : '/learning/domains';
  const defaults: Record<string, string> = {
    ideas: '/learning/ideas', domains: '/learning/domains', goals: '/learning/domains', roadmaps: roadmapPage,
    rubrics: '/learning/rubrics', milestones: own('milestones'), assignments: own('assignments'), submissions: '/learning/evaluations',
    skills: own('skills'), gaps: '/learning/skills',
  };
  const returnTo = safeLearningReturn(text(form, 'returnTo'), defaults[parts[0]] ?? '/learning');
  const session = await authorizePost(req, form, returnTo);
  if (session instanceof Response) return session;
  const by = session.user;
  const confirmed = form.get('confirmed') === 'yes';
  try {
    switch (key) {
      // ---------------- L1: domains, ideas, goals, roadmaps
      case 'domains/create': {
        const d = await learning.createDomain({ title: text(form, 'title'), parentId: text(form, 'parentId'), status: text(form, 'status'), priority: int(form, 'priority'), description: text(form, 'description') }, by);
        return done(by, 'domain.create', d.id, returnTo, x.domainCreated(d.title));
      }
      case 'domains/:id/update': {
        const d = await learning.updateDomain(entityId!, { status: text(form, 'status'), priority: int(form, 'priority'), title: text(form, 'title') }, by);
        return done(by, 'domain.update', d.id, returnTo, x.domainUpdated(d.title, st(d.status)));
      }
      case 'ideas/create': {
        const i = await learning.createIdea({ text: text(form, 'text'), domainIds: list(form, 'domainIds'), priority: text(form, 'priority') }, by);
        return done(by, 'idea.create', i.id, returnTo, x.ideaCreated);
      }
      case 'ideas/:id/update': {
        const i = await learning.updateIdea(entityId!, { text: text(form, 'text'), state: text(form, 'state'), priority: text(form, 'priority'), domainIds: form.has('domainIds-present') ? list(form, 'domainIds') : undefined }, by);
        return done(by, 'idea.update', i.id, returnTo, x.ideaUpdated(t.learnIdeas.states[i.state] ?? i.state));
      }
      case 'goals/create': {
        const g = await learning.createGoal({
          domainId: text(form, 'domainId'), title: text(form, 'title'), target: text(form, 'target'), targetLevel: int(form, 'targetLevel'),
          constraints: defined({ weeklyMinutes: int(form, 'weeklyMinutes'), deadline: text(form, 'deadline'), priorKnowledge: text(form, 'priorKnowledge'), equipment: text(form, 'equipment') }),
        }, by);
        return done(by, 'goal.create', g.id, returnTo, x.goalCreated(g.title));
      }
      case 'goals/:id/update': {
        const g = await learning.updateGoal(entityId!, defined({ status: text(form, 'status'), targetLevel: int(form, 'targetLevel') }), by);
        return done(by, 'goal.update', g.id, returnTo, x.goalUpdated(g.title, st(g.status)));
      }
      case 'roadmaps/create': {
        const r = await learning.createRoadmap({ goalId: text(form, 'goalId'), title: text(form, 'title') }, by);
        return done(by, 'roadmap.create', r.id, `/learning/roadmaps/${r.id}`, x.roadmapCreated);
      }
      case 'roadmaps/:id/propose': {
        let content: unknown;
        try {
          content = JSON.parse(String(form.get('content') ?? ''));
        } catch {
          return back(`${roadmapPage}?edit=1`, { kind: 'error', text: x.badJson });
        }
        const p = await learning.propose(entityId!, { baseVersionId: nullableUuid(form, 'baseVersionId'), content }, by);
        return done(by, 'roadmap.propose', p.id, `${roadmapPage}?proposal=${p.id}`, x.proposed);
      }
      case 'roadmaps/:id/generate': {
        const p = await learning.generate(entityId!, { baseVersionId: nullableUuid(form, 'baseVersionId'), currentLevel: text(form, 'currentLevel'), weeklyMinutes: int(form, 'weeklyMinutes'), notes: text(form, 'notes') }, by);
        return done(by, 'roadmap.generate', p.id, `${roadmapPage}?proposal=${p.id}`, p.state === 'invalid' ? x.aiInvalid : x.aiDrafted);
      }
      case 'roadmaps/:id/apply': {
        const proposalId = text(form, 'proposalId') ?? '';
        if (!confirmed) return back(`${roadmapPage}?proposal=${proposalId}`, { kind: 'error', text: x.tickToApprove });
        const r = await learning.apply(entityId!, proposalId, nullableUuid(form, 'baseVersionId'), by);
        return done(by, 'roadmap.apply', entityId!, roadmapPage, x.applied(r.version.version));
      }
      case 'roadmaps/:id/reject': {
        await learning.reject(entityId!, text(form, 'proposalId') ?? '', by);
        return done(by, 'roadmap.reject', entityId!, roadmapPage, x.rejected);
      }
      case 'roadmaps/:id/restore': {
        if (!confirmed) return back(roadmapPage, { kind: 'error', text: x.tickToRestore });
        const r = await learning.restore(entityId!, text(form, 'versionId') ?? '', text(form, 'baseVersionId') ?? '', by);
        return done(by, 'roadmap.restore', entityId!, roadmapPage, x.restored(r.version.version));
      }

      // ---------------- L2: rubrics
      case 'rubrics/create': {
        const r = await learning.createRubric({ title: text(form, 'title'), criteria: criteriaFrom(form), passingScore: num(form, 'passingScore') }, by);
        return done(by, 'rubric.create', r.id, returnTo, x.rubricCreated(r.title));
      }
      case 'rubrics/:id/version': {
        const v = await learning.addRubricVersion(entityId!, { criteria: criteriaFrom(form), passingScore: num(form, 'passingScore'), baseVersion: int(form, 'baseVersion') }, by);
        return done(by, 'rubric.version', entityId!, returnTo, x.rubricVersioned(v.version));
      }
      case 'rubrics/:id/update': {
        const r = await learning.updateRubric(entityId!, defined({ status: text(form, 'status'), title: text(form, 'title') }), by);
        return done(by, 'rubric.update', r.id, returnTo, x.rubricUpdated(r.title, st(r.status)));
      }

      // ---------------- L2: milestones
      case 'milestones/create': {
        const m = await learning.createMilestone(defined({
          roadmapId: text(form, 'roadmapId'), title: text(form, 'title'), description: longText(form, 'description'), passingCriteria: longText(form, 'passingCriteria'),
          nodeKey: text(form, 'nodeKey'), rubricVersionId: text(form, 'rubricVersionId'), skillIds: list(form, 'skillIds'), weight: int(form, 'weight'),
          fixedDeadline: text(form, 'fixedDeadline'), status: text(form, 'status'),
        }), by);
        return done(by, 'milestone.create', m.id, `/learning/milestones/${m.id}`, x.milestoneCreated(m.title));
      }
      case 'milestones/:id/update': {
        const body = defined({
          title: text(form, 'title'), description: clearable(form, 'description'), passingCriteria: clearable(form, 'passingCriteria'), nodeKey: clearable(form, 'nodeKey'),
          rubricVersionId: clearable(form, 'rubricVersionId'), skillIds: form.has('skillIds-present') ? list(form, 'skillIds') : undefined, weight: int(form, 'weight'),
          fixedDeadline: clearable(form, 'fixedDeadline'), status: text(form, 'status'),
        });
        const m = await learning.updateMilestone(entityId!, body, by);
        return done(by, 'milestone.update', m.id, returnTo, form.has('fixedDeadline') ? x.deadlineSaved(m.deadline.fixed) : x.milestoneSaved(st(m.status)));
      }
      case 'milestones/:id/accept-deadline': {
        if (!confirmed) return back(returnTo, { kind: 'error', text: x.tickToAcceptDeadline });
        const m = await learning.acceptSuggestedDeadline(entityId!, text(form, 'date') ?? '', by);
        return done(by, 'milestone.accept_deadline', m.id, returnTo, x.deadlineAccepted(String(m.deadline.fixed)));
      }
      case 'milestones/:id/dismiss-deadline': {
        const m = await learning.dismissSuggestedDeadline(entityId!, by);
        return done(by, 'milestone.dismiss_deadline', m.id, returnTo, x.deadlineDismissed);
      }

      // ---------------- L2: assignments, submissions, decisions
      case 'assignments/create': {
        const a = await learning.createAssignment(defined({
          milestoneId: text(form, 'milestoneId'), title: text(form, 'title'), kind: text(form, 'kind'), instructions: longText(form, 'instructions'),
          rubricVersionId: text(form, 'rubricVersionId'), status: text(form, 'status'),
        }), by);
        return done(by, 'assignment.create', a.id, `/learning/assignments/${a.id}`, x.assignmentCreated(a.title));
      }
      case 'assignments/:id/update': {
        const a = await learning.updateAssignment(entityId!, defined({
          title: text(form, 'title'), kind: text(form, 'kind'), instructions: longText(form, 'instructions'), rubricVersionId: clearable(form, 'rubricVersionId'), status: text(form, 'status'),
        }), by);
        return done(by, 'assignment.update', a.id, returnTo, x.assignmentSaved(a.definitionVersion, st(a.status)));
      }
      case 'assignments/:id/submit': {
        const files = await filesFrom(form, t);
        if (typeof files === 'string') return back(returnTo, { kind: 'error', text: files }, 'upload');
        const sub = await learning.submit(entityId!, defined({ body: longText(form, 'body'), note: text(form, 'note'), files: files.length ? files : undefined }), by);
        return done(by, 'submission.create', sub.id, returnTo, x.submissionSaved(sub.revision, sub.files.length));
      }
      case 'assignments/:id/decide': {
        const decision = text(form, 'decision') as 'passed' | 'revision_required' | undefined;
        if (!confirmed) return back(returnTo, { kind: 'error', text: x.tickToDecide });
        const a = await learning.decide(entityId!, { evaluationId: text(form, 'evaluationId') ?? '', decision: decision ?? ('' as 'passed') }, by);
        return done(by, `assignment.decide.${a.status}`, a.id, returnTo, a.status === 'passed' ? x.decidedPassed : x.decidedRevision);
      }
      case 'submissions/:id/evaluate-ai': {
        const ev = await learning.evaluateWithAi(entityId!, by);
        return done(by, 'evaluation.ai', ev.id, returnTo, ev.status === 'failed'
          ? x.aiEvalFailed(String(ev.error?.code))
          : x.aiEvalDone);
      }
      case 'submissions/:id/evaluate-owner': {
        const scores = list(form, 'criterion').map((c) => defined({ criterion: c, score: num(form, `score:${c}`), note: text(form, `note:${c}`) }));
        const evidenceNote = longText(form, 'evidenceNote');
        const confidence = num(form, 'confidence');
        const ev = await learning.evaluateAsOwner(entityId!, defined({
          scores, feedback: longText(form, 'feedback'), confidence: confidence === undefined ? undefined : confidence / 100,
          evidence: evidenceNote ? [{ type: 'owner_check', note: evidenceNote.trim() }] : undefined,
          limitations: longText(form, 'limitations')?.split('\n').map((l) => l.trim()).filter(Boolean),
        }), by);
        return done(by, 'evaluation.owner', ev.id, returnTo, x.ownerEval(String(ev.totalScore), String(ev.maxScore)));
      }

      // ---------------- L2: skills and gaps
      case 'skills/create': {
        const sk = await learning.createSkill(text(form, 'name') ?? '', by);
        return done(by, 'skill.create', sk.id, `/learning/skills/${sk.id}`, x.skillCreated(sk.displayName));
      }
      case 'skills/:id/self': {
        const sk = await learning.selfAssess(entityId!, defined({ level: int(form, 'level'), note: text(form, 'note') }) as { level: number }, by);
        return done(by, 'skill.self', sk.id, returnTo, x.selfSaved(String(sk.mastery.self?.level)));
      }
      case 'skills/:id/verify': {
        if (!confirmed) return back(returnTo, { kind: 'error', text: x.tickToVerify });
        const sk = await learning.verifySkill(entityId!, defined({ level: int(form, 'level'), evaluationId: text(form, 'evaluationId'), note: text(form, 'note') }) as { level: number; evaluationId: string }, by);
        return done(by, 'skill.verify', sk.id, returnTo, x.verified(String(sk.mastery.verified?.level)));
      }
      case 'gaps/create': {
        const g = await learning.createGap(defined({ title: text(form, 'title'), description: longText(form, 'description'), skillId: text(form, 'skillId') }), by);
        return done(by, 'gap.create', g.id, returnTo, x.gapCreated(g.title));
      }
      case 'gaps/:id/update': {
        const g = await learning.updateGap(entityId!, text(form, 'status'), by);
        return done(by, 'gap.update', g.id, returnTo, x.gapUpdated(g.title, st(g.status)));
      }
      default:
        return back('/learning', { kind: 'error', text: x.unknownAction });
    }
  } catch (error) {
    const e = error as LearningError;
    await audit({ event: `learning.${key}.failed`, user: by, status: e.status, code: e.code });
    // Known codes are translated; the service's own message is added only where it names the problem.
    const known = e.code ? x.codes[e.code] : undefined;
    const detail = known && e.code ? x.withCode(`${known}${e.code === 'UPLOAD_REJECTED' || e.code === 'INVALID_SCORES' || e.code === 'INVALID_RUBRIC' ? ` ${e.message}` : ''}`, e.code) : backendMessage(e, t);
    const extra = e.code === 'PREREQUISITE_CYCLE' && (e.details as { cycle?: string[] })?.cycle ? `: ${(e.details as { cycle: string[] }).cycle.join(' → ')}` : '';
    return back(key === 'roadmaps/:id/propose' ? `${roadmapPage}?edit=1` : returnTo, { kind: 'error', text: `${detail}${extra}` });
  }
}

async function done(user: string, event: string, id: string, page: string, message: string) {
  await audit({ event: `learning.${event}`, user, id });
  return back(page, { kind: 'ok', text: message });
}
