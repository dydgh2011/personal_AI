import 'server-only';
import { readSecret } from './server';
import type {
  Assignment, AssignmentDetail, CodeExecution, Domain, Evaluation, EvaluationDetail, Gap, Goal, Idea, LearningStatus, Milestone, MilestoneProgress, Proposal,
  ProposalDiff, Roadmap, RoadmapContent, RoadmapDetail, RoadmapVersion, Rubric, RubricVersion, Skill, SchedulePeriod, ScheduleWindow, SkillDetail, StudyPlan, Submission, SubmissionFile, UploadLimits,
} from './learning-types';

export class LearningError extends Error {
  constructor(message: string, readonly status: number | null, readonly code: string | null = null, readonly details: unknown = null) {
    super(message);
  }
}

const settings = {
  url: (process.env.LEARNING_URL?.trim() || 'http://learning:3000').replace(/\/+$/, ''),
  tokenFile: process.env.LEARNING_TOKEN_FILE?.trim() || '/run/secrets/learning_token',
};

/** The dashboard's only way to reach the learning service. Server side; the token never reaches the browser. */
async function call<T>(method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown, approver?: string, timeoutMs = 10_000): Promise<T> {
  let token: string;
  try {
    token = readSecret(settings.tokenFile);
  } catch {
    throw new LearningError('Learning service token is not configured', null, 'NOT_CONFIGURED');
  }
  let res: Response;
  try {
    res = await fetch(settings.url + path, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(approver ? { 'X-Approver': approver } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      cache: 'no-store',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new LearningError('Learning service unreachable', null, 'UNREACHABLE');
  }
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    const d = (data ?? {}) as { message?: unknown; code?: unknown; details?: unknown };
    const message = Array.isArray(d.message) ? d.message.join('; ') : typeof d.message === 'string' ? d.message : `Learning service error ${res.status}`;
    throw new LearningError(message, res.status, typeof d.code === 'string' ? d.code : null, d.details ?? null);
  }
  return data as T;
}

const q = (params: Record<string, string | undefined>) => {
  const s = new URLSearchParams(Object.entries(params).filter(([, v]) => v) as [string, string][]).toString();
  return s ? `?${s}` : '';
};
const id = encodeURIComponent;

export const learning = {
  status: () => call<LearningStatus>('GET', '/status'),
  domains: () => call<{ items: Domain[] }>('GET', '/domains').then((r) => r.items),
  createDomain: (body: Record<string, unknown>, by: string) => call<Domain>('POST', '/domains', body, by),
  updateDomain: (d: string, body: Record<string, unknown>, by: string) => call<Domain>('PATCH', `/domains/${id(d)}`, body, by),
  ideas: (f: { q?: string; state?: string; domainId?: string } = {}) => call<{ items: Idea[] }>('GET', `/ideas${q(f)}`).then((r) => r.items),
  createIdea: (body: Record<string, unknown>, by: string) => call<Idea>('POST', '/ideas', body, by),
  updateIdea: (i: string, body: Record<string, unknown>, by: string) => call<Idea>('PATCH', `/ideas/${id(i)}`, body, by),
  goals: () => call<{ items: Goal[] }>('GET', '/goals').then((r) => r.items),
  goal: (g: string) => call<Goal>('GET', `/goals/${id(g)}`),
  createGoal: (body: Record<string, unknown>, by: string) => call<Goal>('POST', '/goals', body, by),
  updateGoal: (g: string, body: Record<string, unknown>, by: string) => call<Goal>('PATCH', `/goals/${id(g)}`, body, by),
  roadmaps: () => call<{ items: Roadmap[] }>('GET', '/roadmaps').then((r) => r.items),
  roadmap: (r: string) => call<RoadmapDetail>('GET', `/roadmaps/${id(r)}`),
  createRoadmap: (body: Record<string, unknown>, by: string) => call<Roadmap>('POST', '/roadmaps', body, by),
  versions: (r: string) => call<{ items: RoadmapVersion[] }>('GET', `/roadmaps/${id(r)}/versions`).then((x) => x.items),
  version: (r: string, v: string) => call<RoadmapVersion & { content: RoadmapContent }>('GET', `/roadmaps/${id(r)}/versions/${id(v)}`),
  proposals: (r: string) => call<{ items: Proposal[] }>('GET', `/roadmaps/${id(r)}/proposals`).then((x) => x.items),
  proposalDiff: (r: string, p: string) => call<ProposalDiff>('GET', `/roadmaps/${id(r)}/proposals/${id(p)}/diff`),
  propose: (r: string, body: { baseVersionId: string | null; content: unknown }, by: string) => call<Proposal>('POST', `/roadmaps/${id(r)}/proposals`, body, by),
  // AI calls can take up to the provider timeout (plus one retry).
  generate: (r: string, body: Record<string, unknown>, by: string) => call<Proposal>('POST', `/roadmaps/${id(r)}/proposals/generate`, body, by, 90_000),
  apply: (r: string, p: string, baseVersionId: string | null, by: string) => call<{ version: RoadmapVersion }>('POST', `/roadmaps/${id(r)}/proposals/${id(p)}/apply`, { baseVersionId }, by),
  reject: (r: string, p: string, by: string) => call<Proposal>('POST', `/roadmaps/${id(r)}/proposals/${id(p)}/reject`, {}, by),
  restore: (r: string, versionId: string, baseVersionId: string, by: string) => call<{ version: RoadmapVersion }>('POST', `/roadmaps/${id(r)}/restore`, { versionId, baseVersionId }, by),
  export: (by: string) => call<Record<string, unknown>>('GET', '/export', undefined, by, 30_000),

  schedule: (date: string, period: SchedulePeriod) => call<StudyPlan>('GET', `/schedule${q({ date, period })}`),
  updateScheduleAvailability: (windows: ScheduleWindow[], by: string) => call<StudyPlan['availability']>('PATCH', '/schedule/availability', { windows }, by),
  proposeSchedule: (input: { date?: string; period: SchedulePeriod }, by: string) =>
    call<{ proposal: { code: string; title: string; status: string } }>('POST', '/schedule/propose', input, by, 15_000),

  // L2: rubrics, milestones, assignments, submissions, evaluations, skills, gaps
  rubrics: () => call<{ items: Rubric[] }>('GET', '/rubrics').then((r) => r.items),
  rubric: (r: string) => call<Rubric & { versions: RubricVersion[] }>('GET', `/rubrics/${id(r)}`),
  rubricVersion: (v: string) => call<RubricVersion>('GET', `/rubrics/versions/${id(v)}`),
  createRubric: (body: Record<string, unknown>, by: string) => call<Rubric>('POST', '/rubrics', body, by),
  addRubricVersion: (r: string, body: Record<string, unknown>, by: string) => call<RubricVersion>('POST', `/rubrics/${id(r)}/versions`, body, by),
  updateRubric: (r: string, body: Record<string, unknown>, by: string) => call<Rubric>('PATCH', `/rubrics/${id(r)}`, body, by),
  milestones: (f: { roadmapId?: string; status?: string } = {}) => call<{ items: Milestone[]; progress: MilestoneProgress | null }>('GET', `/milestones${q(f)}`),
  milestone: (m: string) => call<Milestone>('GET', `/milestones/${id(m)}`),
  createMilestone: (body: Record<string, unknown>, by: string) => call<Milestone>('POST', '/milestones', body, by),
  updateMilestone: (m: string, body: Record<string, unknown>, by: string) => call<Milestone>('PATCH', `/milestones/${id(m)}`, body, by),
  acceptSuggestedDeadline: (m: string, date: string, by: string) => call<Milestone>('POST', `/milestones/${id(m)}/suggested-deadline/accept`, { date }, by),
  dismissSuggestedDeadline: (m: string, by: string) => call<Milestone>('POST', `/milestones/${id(m)}/suggested-deadline/dismiss`, {}, by),
  assignments: (f: { milestoneId?: string; status?: string } = {}) => call<{ items: Assignment[]; uploadLimits: UploadLimits; codeExecution: CodeExecution }>('GET', `/assignments${q(f)}`),
  assignment: (a: string) => call<AssignmentDetail>('GET', `/assignments/${id(a)}`),
  createAssignment: (body: Record<string, unknown>, by: string) => call<Assignment>('POST', '/assignments', body, by),
  updateAssignment: (a: string, body: Record<string, unknown>, by: string) => call<Assignment>('PATCH', `/assignments/${id(a)}`, body, by),
  // Uploads travel as base64 JSON (at most a few MB); the learning service checks them again.
  submit: (a: string, body: { body?: string; note?: string; files?: Array<{ name: string; contentBase64: string }> }, by: string) =>
    call<Submission>('POST', `/assignments/${id(a)}/submissions`, body, by, 30_000),
  decide: (a: string, body: { evaluationId: string; decision: 'passed' | 'revision_required' }, by: string) => call<Assignment>('POST', `/assignments/${id(a)}/decision`, body, by),
  submissionFile: (s: string, f: string) => call<SubmissionFile & { contentBase64: string }>('GET', `/submissions/${id(s)}/files/${id(f)}`),
  submissionEvaluations: (s: string) => call<{ items: Evaluation[] }>('GET', `/submissions/${id(s)}/evaluations`).then((r) => r.items),
  evaluations: (f: { status?: string; limit?: string } = {}) => call<{ items: Evaluation[]; codeExecution: CodeExecution }>('GET', `/evaluations${q(f)}`),
  evaluation: (e: string) => call<EvaluationDetail>('GET', `/evaluations/${id(e)}`),
  // AI calls can take up to the provider timeout (plus one retry).
  evaluateWithAi: (s: string, by: string) => call<EvaluationDetail>('POST', `/submissions/${id(s)}/evaluate`, {}, by, 90_000),
  evaluateAsOwner: (s: string, body: Record<string, unknown>, by: string) => call<EvaluationDetail>('POST', `/submissions/${id(s)}/evaluations`, body, by),
  skills: () => call<{ items: Skill[]; freshDays: number }>('GET', '/skills'),
  skill: (s: string) => call<SkillDetail>('GET', `/skills/${id(s)}`),
  createSkill: (name: string, by: string) => call<Skill>('POST', '/skills', { name }, by),
  selfAssess: (s: string, body: { level: number | undefined; note?: string }, by: string) => call<Skill>('POST', `/skills/${id(s)}/self-assessment`, body, by),
  verifySkill: (s: string, body: { level: number | undefined; evaluationId: string | undefined; note?: string }, by: string) => call<Skill>('POST', `/skills/${id(s)}/verify`, body, by),
  gaps: (f: { status?: string; skillId?: string } = {}) => call<{ items: Gap[] }>('GET', `/gaps${q(f)}`).then((r) => r.items),
  createGap: (body: Record<string, unknown>, by: string) => call<Gap>('POST', '/gaps', body, by),
  updateGap: (g: string, status: string | undefined, by: string) => call<Gap>('PATCH', `/gaps/${id(g)}`, { status }, by),
};
