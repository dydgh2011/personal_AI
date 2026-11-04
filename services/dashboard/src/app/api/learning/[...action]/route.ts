import { learning, LearningError } from '@/lib/learning';
import { authorizePost, back } from '@/lib/routes';
import { audit } from '@/lib/server';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Owner-facing text for the learning service's error codes. */
const CODES: Record<string, string> = {
  PROVIDER_NOT_CONFIGURED: 'AI 초안 생성이 아직 설정되지 않았습니다 (모델, 키, 월 상한 필요).',
  AI_BUDGET_EXCEEDED: '이번 달 AI 비용 상한에 도달했습니다.',
  AI_RATE_LIMITED: 'AI 제공자가 요청을 제한했습니다. 잠시 후 다시 시도하세요.',
  AI_PROVIDER_TIMEOUT: 'AI 응답 시간이 초과되었습니다. 로드맵은 변경되지 않았습니다.',
  AI_PROVIDER_ERROR: 'AI 제공자 오류입니다. 로드맵은 변경되지 않았습니다.',
  VERSION_CONFLICT: '그 사이 로드맵이 바뀌었습니다. 현재 버전을 확인하고 다시 제안하세요.',
  PREREQUISITE_CYCLE: '선수지식 관계에 순환이 있습니다.',
  INVALID_ROADMAP: '로드맵 내용이 올바르지 않습니다.',
  DOMAIN_CYCLE: '분야를 자기 자신이나 하위 분야 아래에 둘 수 없습니다.',
  PROPOSAL_NOT_PENDING: '이미 처리된 제안입니다.',
};

const text = (f: FormData, k: string) => {
  const v = f.get(k);
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
};
const int = (f: FormData, k: string) => {
  const v = text(f, k);
  return v === undefined ? undefined : Number.parseInt(v, 10);
};
const list = (f: FormData, k: string) => f.getAll(k).filter((v): v is string => typeof v === 'string' && v !== '');
const nullableUuid = (f: FormData, k: string) => {
  const v = text(f, k);
  return v && UUID.test(v) ? v : null;
};

/**
 * All learning form posts: /api/learning/<entity>/<action> or /<entity>/<id>/<action>.
 * Same session + CSRF checks as every other dashboard form; the learning service enforces the
 * domain rules (versions, DAG, conflicts) again.
 */
export async function POST(req: Request, { params }: { params: Promise<{ action: string[] }> }) {
  const parts = (await params).action;
  const form = await req.formData();
  const entityId = parts.length === 3 && UUID.test(parts[1]) ? parts[1] : null;
  const roadmapPage = parts[0] === 'roadmaps' && entityId ? `/learning/roadmaps/${entityId}` : '/learning';
  const returnTo = parts[0] === 'ideas' ? '/learning/ideas' : roadmapPage;
  const session = await authorizePost(req, form, returnTo);
  if (session instanceof Response) return session;
  const by = session.user;
  const key = `${parts[0]}/${entityId ? ':id/' : ''}${parts.at(-1)}`;
  try {
    switch (key) {
      case 'domains/create': {
        const d = await learning.createDomain({ title: text(form, 'title'), parentId: text(form, 'parentId'), status: text(form, 'status'), priority: int(form, 'priority') }, by);
        return done(by, 'domain.create', d.id, '/learning', `분야 "${d.title}"를 만들었습니다.`);
      }
      case 'domains/:id/update': {
        const d = await learning.updateDomain(entityId!, { status: text(form, 'status'), priority: int(form, 'priority'), title: text(form, 'title') }, by);
        return done(by, 'domain.update', d.id, '/learning', `분야 "${d.title}": ${d.status}`);
      }
      case 'ideas/create': {
        const i = await learning.createIdea({ text: text(form, 'text'), domainIds: list(form, 'domainIds'), priority: text(form, 'priority') }, by);
        return done(by, 'idea.create', i.id, text(form, 'returnTo') === '/learning' ? '/learning' : '/learning/ideas', '아이디어를 저장했습니다. (일정에는 자동으로 들어가지 않습니다)');
      }
      case 'ideas/:id/update': {
        const i = await learning.updateIdea(entityId!, { text: text(form, 'text'), state: text(form, 'state'), priority: text(form, 'priority'), domainIds: form.has('domainIds-present') ? list(form, 'domainIds') : undefined }, by);
        return done(by, 'idea.update', i.id, '/learning/ideas', `아이디어를 수정했습니다 (${i.state}).`);
      }
      case 'goals/create': {
        const g = await learning.createGoal({
          domainId: text(form, 'domainId'), title: text(form, 'title'), target: text(form, 'target'), targetLevel: int(form, 'targetLevel'),
          constraints: Object.fromEntries(Object.entries({ weeklyMinutes: int(form, 'weeklyMinutes'), deadline: text(form, 'deadline'), priorKnowledge: text(form, 'priorKnowledge'), equipment: text(form, 'equipment') }).filter(([, v]) => v !== undefined)),
        }, by);
        return done(by, 'goal.create', g.id, '/learning', `목표 "${g.title}"를 만들었습니다.`);
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
        if (form.get('confirmed') !== 'yes') return back(`${roadmapPage}?proposal=${proposalId}`, { kind: 'error', text: '확인 체크박스를 선택해야 승인됩니다.' });
        const r = await learning.apply(entityId!, proposalId, nullableUuid(form, 'baseVersionId'), by);
        return done(by, 'roadmap.apply', entityId!, roadmapPage, `버전 ${r.version.version}을 승인했습니다.`);
      }
      case 'roadmaps/:id/reject': {
        await learning.reject(entityId!, text(form, 'proposalId') ?? '', by);
        return done(by, 'roadmap.reject', entityId!, roadmapPage, '제안을 거부했습니다.');
      }
      case 'roadmaps/:id/restore': {
        if (form.get('confirmed') !== 'yes') return back(roadmapPage, { kind: 'error', text: '복원하려면 확인 체크박스를 선택하세요.' });
        const r = await learning.restore(entityId!, text(form, 'versionId') ?? '', text(form, 'baseVersionId') ?? '', by);
        return done(by, 'roadmap.restore', entityId!, roadmapPage, `이전 내용을 새 버전 ${r.version.version}으로 복원했습니다.`);
      }
      default:
        return back('/learning', { kind: 'error', text: 'Unknown action' });
    }
  } catch (error) {
    const e = error as LearningError;
    await audit({ event: `learning.${key}.failed`, user: by, status: e.status, code: e.code });
    const detail = e.code && CODES[e.code] ? `${CODES[e.code]} (${e.code})` : e.message;
    const extra = e.code === 'PREREQUISITE_CYCLE' && (e.details as { cycle?: string[] })?.cycle ? `: ${(e.details as { cycle: string[] }).cycle.join(' → ')}` : '';
    return back(key === 'roadmaps/:id/propose' ? `${roadmapPage}?edit=1` : returnTo, { kind: 'error', text: `${detail}${extra}` });
  }
}

async function done(user: string, event: string, id: string, page: string, message: string) {
  await audit({ event: `learning.${event}`, user, id });
  return back(page, { kind: 'ok', text: message });
}
