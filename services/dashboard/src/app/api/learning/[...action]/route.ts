import { learning, LearningError } from '@/lib/learning';
import { DEFAULT_UPLOAD_LIMITS, LEARNING_UUID, safeLearningReturn, uploadProblem } from '@/lib/learning-view';
import { authorizePost, back } from '@/lib/routes';
import { audit } from '@/lib/server';

/** Owner-facing text for the learning service's error codes. */
const CODES: Record<string, string> = {
  PROVIDER_NOT_CONFIGURED: 'AI 기능이 아직 설정되지 않았습니다 (모델, 키, 월 상한 필요). 직접 평가는 그대로 쓸 수 있습니다.',
  AI_BUDGET_EXCEEDED: '이번 달 AI 비용 상한에 도달했습니다.',
  AI_RATE_LIMITED: 'AI 제공자가 요청을 제한했습니다. 잠시 후 다시 시도하세요.',
  AI_PROVIDER_TIMEOUT: 'AI 응답 시간이 초과되었습니다. 기존 데이터는 바뀌지 않았습니다.',
  AI_PROVIDER_ERROR: 'AI 제공자 오류입니다. 기존 데이터는 바뀌지 않았습니다.',
  VERSION_CONFLICT: '그 사이 내용이 바뀌었습니다. 최신 버전을 확인하고 다시 시도하세요.',
  PREREQUISITE_CYCLE: '선수지식 관계에 순환이 있습니다.',
  INVALID_ROADMAP: '로드맵 내용이 올바르지 않습니다.',
  DOMAIN_CYCLE: '분야를 자기 자신이나 하위 분야 아래에 둘 수 없습니다.',
  PROPOSAL_NOT_PENDING: '이미 처리된 제안입니다.',
  // L2
  INVALID_RUBRIC: '루브릭이 올바르지 않습니다.',
  NO_CHANGES: '바뀐 내용이 없습니다.',
  INVALID_DATE: '존재하지 않는 날짜입니다.',
  UNKNOWN_NODE: '현재 로드맵 버전에 없는 노드입니다.',
  NO_SUGGESTION: '제안된 마감일이 없습니다.',
  SUGGESTION_CHANGED: '그 사이 제안된 마감일이 바뀌었습니다. 다시 확인하세요.',
  MILESTONE_NOT_READY: '모든 과제가 통과해야 마일스톤을 완료할 수 있습니다.',
  MILESTONE_CLOSED: '완료되었거나 보관된 마일스톤에는 과제를 추가할 수 없습니다.',
  INVALID_TRANSITION: '지금 상태에서는 그렇게 바꿀 수 없습니다.',
  ASSIGNMENT_NOT_OPEN: '이 과제는 지금 제출을 받지 않습니다.',
  ASSIGNMENT_CHANGED: '그 사이 과제가 바뀌었습니다. 새로고침 후 다시 시도하세요.',
  UPLOAD_REJECTED: '파일을 받을 수 없습니다.',
  EMPTY_SUBMISSION: '제출할 내용이 없습니다.',
  DUPLICATE_SUBMISSION: '직전 제출과 똑같은 내용입니다.',
  RUBRIC_REQUIRED: '이 과제에는 루브릭이 없습니다. 루브릭을 연결한 뒤 다시 제출하세요.',
  EVALUATION_IN_PROGRESS: '이 제출물은 이미 평가 중입니다.',
  INVALID_SCORES: '점수가 올바르지 않습니다.',
  EVALUATION_NOT_COMPLETED: '완료된 평가만 사용할 수 있습니다.',
  EVIDENCE_REQUIRED: '루브릭과 근거가 있는 평가가 필요합니다.',
  STALE_EVALUATION: '최신 제출본에 대한 평가가 아닙니다.',
  SKILL_EXISTS: '같은 이름의 스킬이 이미 있습니다.',
  SKILL_NOT_ASSESSED: '이 평가는 해당 스킬을 다루는 마일스톤의 평가가 아닙니다.',
  UNREACHABLE: 'Learning 서비스에 연결할 수 없습니다.',
};

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

async function filesFrom(f: FormData): Promise<Array<{ name: string; contentBase64: string }> | string> {
  const files = f.getAll('files').filter((v): v is File => typeof v !== 'string' && v.name !== '');
  const problem = uploadProblem(files.map((x) => ({ name: x.name, size: x.size })), DEFAULT_UPLOAD_LIMITS);
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
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    // Unreadable body (e.g. cut off because it was too large): nothing was done.
    return back('/learning', { kind: 'error', text: '요청을 읽을 수 없습니다. 파일이 크다면 합계 6MB 이하로 줄여 다시 시도하세요.' }, 'body');
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
        return done(by, 'domain.create', d.id, returnTo, `분야 "${d.title}"를 만들었습니다.`);
      }
      case 'domains/:id/update': {
        const d = await learning.updateDomain(entityId!, { status: text(form, 'status'), priority: int(form, 'priority'), title: text(form, 'title') }, by);
        return done(by, 'domain.update', d.id, returnTo, `분야 "${d.title}": ${d.status}`);
      }
      case 'ideas/create': {
        const i = await learning.createIdea({ text: text(form, 'text'), domainIds: list(form, 'domainIds'), priority: text(form, 'priority') }, by);
        return done(by, 'idea.create', i.id, returnTo, '아이디어를 저장했습니다. (일정에는 자동으로 들어가지 않습니다)');
      }
      case 'ideas/:id/update': {
        const i = await learning.updateIdea(entityId!, { text: text(form, 'text'), state: text(form, 'state'), priority: text(form, 'priority'), domainIds: form.has('domainIds-present') ? list(form, 'domainIds') : undefined }, by);
        return done(by, 'idea.update', i.id, returnTo, `아이디어를 수정했습니다 (${i.state}).`);
      }
      case 'goals/create': {
        const g = await learning.createGoal({
          domainId: text(form, 'domainId'), title: text(form, 'title'), target: text(form, 'target'), targetLevel: int(form, 'targetLevel'),
          constraints: defined({ weeklyMinutes: int(form, 'weeklyMinutes'), deadline: text(form, 'deadline'), priorKnowledge: text(form, 'priorKnowledge'), equipment: text(form, 'equipment') }),
        }, by);
        return done(by, 'goal.create', g.id, returnTo, `목표 "${g.title}"를 만들었습니다.`);
      }
      case 'goals/:id/update': {
        const g = await learning.updateGoal(entityId!, defined({ status: text(form, 'status'), targetLevel: int(form, 'targetLevel') }), by);
        return done(by, 'goal.update', g.id, returnTo, `목표 "${g.title}": ${g.status}`);
      }
      case 'roadmaps/create': {
        const r = await learning.createRoadmap({ goalId: text(form, 'goalId'), title: text(form, 'title') }, by);
        return done(by, 'roadmap.create', r.id, `/learning/roadmaps/${r.id}`, '로드맵을 만들었습니다. 수동 편집이나 AI 초안으로 첫 버전을 제안하세요.');
      }
      case 'roadmaps/:id/propose': {
        let content: unknown;
        try {
          content = JSON.parse(String(form.get('content') ?? ''));
        } catch {
          return back(`${roadmapPage}?edit=1`, { kind: 'error', text: 'JSON 형식이 올바르지 않습니다.' });
        }
        const p = await learning.propose(entityId!, { baseVersionId: nullableUuid(form, 'baseVersionId'), content }, by);
        return done(by, 'roadmap.propose', p.id, `${roadmapPage}?proposal=${p.id}`, '변경 제안을 만들었습니다. 차이를 확인하고 승인하세요.');
      }
      case 'roadmaps/:id/generate': {
        const p = await learning.generate(entityId!, { baseVersionId: nullableUuid(form, 'baseVersionId'), currentLevel: text(form, 'currentLevel'), weeklyMinutes: int(form, 'weeklyMinutes'), notes: text(form, 'notes') }, by);
        return done(by, 'roadmap.generate', p.id, `${roadmapPage}?proposal=${p.id}`, p.state === 'invalid' ? 'AI 출력이 검증을 통과하지 못했습니다. 로드맵은 그대로입니다.' : 'AI 초안을 만들었습니다. 차이를 확인하고 승인하세요.');
      }
      case 'roadmaps/:id/apply': {
        const proposalId = text(form, 'proposalId') ?? '';
        if (!confirmed) return back(`${roadmapPage}?proposal=${proposalId}`, { kind: 'error', text: '확인 체크박스를 선택해야 승인됩니다.' });
        const r = await learning.apply(entityId!, proposalId, nullableUuid(form, 'baseVersionId'), by);
        return done(by, 'roadmap.apply', entityId!, roadmapPage, `버전 ${r.version.version}을 승인했습니다.`);
      }
      case 'roadmaps/:id/reject': {
        await learning.reject(entityId!, text(form, 'proposalId') ?? '', by);
        return done(by, 'roadmap.reject', entityId!, roadmapPage, '제안을 거부했습니다.');
      }
      case 'roadmaps/:id/restore': {
        if (!confirmed) return back(roadmapPage, { kind: 'error', text: '복원하려면 확인 체크박스를 선택하세요.' });
        const r = await learning.restore(entityId!, text(form, 'versionId') ?? '', text(form, 'baseVersionId') ?? '', by);
        return done(by, 'roadmap.restore', entityId!, roadmapPage, `이전 내용을 새 버전 ${r.version.version}으로 복원했습니다.`);
      }

      // ---------------- L2: rubrics
      case 'rubrics/create': {
        const r = await learning.createRubric({ title: text(form, 'title'), criteria: criteriaFrom(form), passingScore: num(form, 'passingScore') }, by);
        return done(by, 'rubric.create', r.id, returnTo, `루브릭 "${r.title}" v1을 만들었습니다.`);
      }
      case 'rubrics/:id/version': {
        const v = await learning.addRubricVersion(entityId!, { criteria: criteriaFrom(form), passingScore: num(form, 'passingScore'), baseVersion: int(form, 'baseVersion') }, by);
        return done(by, 'rubric.version', entityId!, returnTo, `루브릭 v${v.version}을 만들었습니다. 기존 과제와 평가는 이전 버전을 그대로 가리킵니다.`);
      }
      case 'rubrics/:id/update': {
        const r = await learning.updateRubric(entityId!, defined({ status: text(form, 'status'), title: text(form, 'title') }), by);
        return done(by, 'rubric.update', r.id, returnTo, `루브릭 "${r.title}": ${r.status}`);
      }

      // ---------------- L2: milestones
      case 'milestones/create': {
        const m = await learning.createMilestone(defined({
          roadmapId: text(form, 'roadmapId'), title: text(form, 'title'), description: longText(form, 'description'), passingCriteria: longText(form, 'passingCriteria'),
          nodeKey: text(form, 'nodeKey'), rubricVersionId: text(form, 'rubricVersionId'), skillIds: list(form, 'skillIds'), weight: int(form, 'weight'),
          fixedDeadline: text(form, 'fixedDeadline'), status: text(form, 'status'),
        }), by);
        return done(by, 'milestone.create', m.id, `/learning/milestones/${m.id}`, `마일스톤 "${m.title}"을 만들었습니다. 이제 과제를 추가하세요.`);
      }
      case 'milestones/:id/update': {
        const body = defined({
          title: text(form, 'title'), description: clearable(form, 'description'), passingCriteria: clearable(form, 'passingCriteria'), nodeKey: clearable(form, 'nodeKey'),
          rubricVersionId: clearable(form, 'rubricVersionId'), skillIds: form.has('skillIds-present') ? list(form, 'skillIds') : undefined, weight: int(form, 'weight'),
          fixedDeadline: clearable(form, 'fixedDeadline'), status: text(form, 'status'),
        });
        const m = await learning.updateMilestone(entityId!, body, by);
        return done(by, 'milestone.update', m.id, returnTo, form.has('fixedDeadline') ? `마감일을 ${m.deadline.fixed ?? '없음'}으로 저장했습니다 (직접 고정).` : `마일스톤을 저장했습니다 (${m.status}).`);
      }
      case 'milestones/:id/accept-deadline': {
        if (!confirmed) return back(returnTo, { kind: 'error', text: '제안된 마감일을 적용하려면 확인 체크박스를 선택하세요.' });
        const m = await learning.acceptSuggestedDeadline(entityId!, text(form, 'date') ?? '', by);
        return done(by, 'milestone.accept_deadline', m.id, returnTo, `제안을 받아들여 마감일을 ${m.deadline.fixed}로 고정했습니다.`);
      }
      case 'milestones/:id/dismiss-deadline': {
        const m = await learning.dismissSuggestedDeadline(entityId!, by);
        return done(by, 'milestone.dismiss_deadline', m.id, returnTo, '제안된 마감일을 버렸습니다. 고정 마감일은 그대로입니다.');
      }

      // ---------------- L2: assignments, submissions, decisions
      case 'assignments/create': {
        const a = await learning.createAssignment(defined({
          milestoneId: text(form, 'milestoneId'), title: text(form, 'title'), kind: text(form, 'kind'), instructions: longText(form, 'instructions'),
          rubricVersionId: text(form, 'rubricVersionId'), status: text(form, 'status'),
        }), by);
        return done(by, 'assignment.create', a.id, `/learning/assignments/${a.id}`, `과제 "${a.title}"를 만들었습니다.`);
      }
      case 'assignments/:id/update': {
        const a = await learning.updateAssignment(entityId!, defined({
          title: text(form, 'title'), kind: text(form, 'kind'), instructions: longText(form, 'instructions'), rubricVersionId: clearable(form, 'rubricVersionId'), status: text(form, 'status'),
        }), by);
        return done(by, 'assignment.update', a.id, returnTo, `과제를 저장했습니다 (정의 v${a.definitionVersion}, ${a.status}).`);
      }
      case 'assignments/:id/submit': {
        const files = await filesFrom(form);
        if (typeof files === 'string') return back(returnTo, { kind: 'error', text: files }, 'upload');
        const sub = await learning.submit(entityId!, defined({ body: longText(form, 'body'), note: text(form, 'note'), files: files.length ? files : undefined }), by);
        return done(by, 'submission.create', sub.id, returnTo, `제출본 r${sub.revision}을 저장했습니다${sub.files.length ? ` (파일 ${sub.files.length}개, 실행하지 않음)` : ''}.`);
      }
      case 'assignments/:id/decide': {
        const decision = text(form, 'decision') as 'passed' | 'revision_required' | undefined;
        if (!confirmed) return back(returnTo, { kind: 'error', text: '결정하려면 확인 체크박스를 선택하세요.' });
        const a = await learning.decide(entityId!, { evaluationId: text(form, 'evaluationId') ?? '', decision: decision ?? ('' as 'passed') }, by);
        return done(by, `assignment.decide.${a.status}`, a.id, returnTo, a.status === 'passed' ? '과제를 통과로 확정했습니다.' : '수정이 필요하다고 기록했습니다. 다시 제출할 수 있습니다.');
      }
      case 'submissions/:id/evaluate-ai': {
        const ev = await learning.evaluateWithAi(entityId!, by);
        return done(by, 'evaluation.ai', ev.id, returnTo, ev.status === 'failed'
          ? `AI 평가가 실패로 기록되었습니다 (${ev.error?.code}). 제출본은 그대로입니다.`
          : 'AI 의견을 받았습니다. 통과 여부와 검증 수준은 직접 결정하세요.');
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
        return done(by, 'evaluation.owner', ev.id, returnTo, `평가를 기록했습니다: ${ev.totalScore} / ${ev.maxScore}.`);
      }

      // ---------------- L2: skills and gaps
      case 'skills/create': {
        const sk = await learning.createSkill(text(form, 'name') ?? '', by);
        return done(by, 'skill.create', sk.id, `/learning/skills/${sk.id}`, `스킬 "${sk.displayName}"을 만들었습니다.`);
      }
      case 'skills/:id/self': {
        const sk = await learning.selfAssess(entityId!, defined({ level: int(form, 'level'), note: text(form, 'note') }) as { level: number }, by);
        return done(by, 'skill.self', sk.id, returnTo, `자가평가를 ${sk.mastery.self?.level}로 기록했습니다. 검증 수준과는 따로 저장됩니다.`);
      }
      case 'skills/:id/verify': {
        if (!confirmed) return back(returnTo, { kind: 'error', text: '검증 수준을 기록하려면 확인 체크박스를 선택하세요.' });
        const sk = await learning.verifySkill(entityId!, defined({ level: int(form, 'level'), evaluationId: text(form, 'evaluationId'), note: text(form, 'note') }) as { level: number; evaluationId: string }, by);
        return done(by, 'skill.verify', sk.id, returnTo, `검증 수준 ${sk.mastery.verified?.level}을 기록했습니다.`);
      }
      case 'gaps/create': {
        const g = await learning.createGap(defined({ title: text(form, 'title'), description: longText(form, 'description'), skillId: text(form, 'skillId') }), by);
        return done(by, 'gap.create', g.id, returnTo, `약점 "${g.title}"을 기록했습니다.`);
      }
      case 'gaps/:id/update': {
        const g = await learning.updateGap(entityId!, text(form, 'status'), by);
        return done(by, 'gap.update', g.id, returnTo, `약점 "${g.title}": ${g.status}`);
      }
      default:
        return back('/learning', { kind: 'error', text: 'Unknown action' });
    }
  } catch (error) {
    const e = error as LearningError;
    await audit({ event: `learning.${key}.failed`, user: by, status: e.status, code: e.code });
    const detail = e.code && CODES[e.code] ? `${CODES[e.code]}${e.code === 'UPLOAD_REJECTED' || e.code === 'INVALID_SCORES' || e.code === 'INVALID_RUBRIC' ? ` ${e.message}` : ''} (${e.code})` : e.message;
    const extra = e.code === 'PREREQUISITE_CYCLE' && (e.details as { cycle?: string[] })?.cycle ? `: ${(e.details as { cycle: string[] }).cycle.join(' → ')}` : '';
    return back(key === 'roadmaps/:id/propose' ? `${roadmapPage}?edit=1` : returnTo, { kind: 'error', text: `${detail}${extra}` });
  }
}

async function done(user: string, event: string, id: string, page: string, message: string) {
  await audit({ event: `learning.${event}`, user, id });
  return back(page, { kind: 'ok', text: message });
}
