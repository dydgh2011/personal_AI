import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import nextConfig from '../next.config.mjs';
import AssignmentPage from '@/app/(admin)/learning/assignments/[id]/page';
import SubmissionPage from '@/app/(admin)/learning/assignments/[id]/submissions/[submissionId]/page';
import EvaluationsPage from '@/app/(admin)/learning/evaluations/page';
import EvaluationPage from '@/app/(admin)/learning/evaluations/[id]/page';
import RubricPage from '@/app/(admin)/learning/rubrics/[id]/page';
import SkillsPage from '@/app/(admin)/learning/skills/page';
import SkillPage from '@/app/(admin)/learning/skills/[id]/page';
import { GET as download } from '@/app/api/learning-files/[submissionId]/[fileId]/route';
import { POST as post } from '@/app/api/learning/[...action]/route';
import type { AssignmentDetail, EvaluationDetail, Gap, Rubric, RubricVersion, Skill, SkillDetail, Submission } from '@/lib/learning-types';
import { fileHref, submissionHref } from '@/lib/learning-view';

const auth = vi.hoisted(() => ({
  active: true,
  session: { id: 'fixture-session', user: 'owner', csrf: 'fixture-csrf' },
}));

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => auth.active ? { value: auth.session.id } : undefined }),
}));

vi.mock('@/lib/server', () => ({
  SESSION_COOKIE: 'pai_session',
  sessions: { get: (id: string) => id === auth.session.id ? auth.session : null },
  currentSession: async () => auth.active ? auth.session : null,
  requireSession: async () => auth.session,
  clientIp: async () => '127.0.0.1',
  audit: async () => {},
  readSecret: () => 'fixture-learning-auth',
}));

const id = (suffix: number) => `7c711533-1438-4dab-aa27-${String(suffix).padStart(12, '0')}`;
const ASSIGNMENT = id(1);
const MILESTONE = id(2);
const PREVIOUS = id(3);
const LATEST = id(4);
const FILE = id(5);
const EVALUATION = id(6);
const SKILL = id(7);
const GAP = id(8);
const RUBRIC = id(9);
const RUBRIC_V1 = id(10);
const RUBRIC_V2 = id(11);
const AT = '2026-11-24T09:00:00.000Z';
const DASHBOARD = 'http://dashboard.test';
const ASSIGNMENT_PAGE = `/learning/assignments/${ASSIGNMENT}`;
const REVISION_PAGE = submissionHref(ASSIGNMENT, LATEST);
const EVALUATION_PAGE = `/learning/evaluations/${EVALUATION}`;
const SKILL_PAGE = `/learning/skills/${SKILL}`;
const DOWNLOAD = fileHref(LATEST, FILE);
const CODE = '<script>answer kept as text</script>';

const originalRubric: RubricVersion = {
  id: RUBRIC_V1, rubricId: RUBRIC, version: 1,
  criteria: [{ key: 'reasoning', title: 'Explain the slope', description: null, maxScore: 10 }],
  passingScore: 7, maxScore: 10, contentHash: 'rubric-1', createdAt: AT, createdBy: 'owner',
};
const latestRubric: RubricVersion = {
  ...originalRubric, id: RUBRIC_V2, version: 2,
  criteria: [{ key: 'notation', title: 'Show the notation', description: null, maxScore: 12 }], maxScore: 12,
};
const rubric: Rubric = { id: RUBRIC, title: 'Derivatives rubric', status: 'active', latestVersion: latestRubric, createdAt: AT, updatedAt: AT, createdBy: 'owner' };

const revision: Submission = {
  id: LATEST, assignmentId: ASSIGNMENT, revision: 2, definitionVersion: 1, body: CODE, note: 'Added the calculation',
  contentHash: 'submission-hash', submittedBy: 'owner', submittedAt: AT,
  files: [{ id: FILE, position: 1, name: '답안.html', mediaType: 'text/plain; charset=utf-8', category: 'text', size: Buffer.byteLength(CODE), sha256: 'file-hash' }],
};
const assignment: AssignmentDetail['assignment'] = {
  id: ASSIGNMENT, milestoneId: MILESTONE, title: 'Calculate the slope', kind: 'code', instructions: 'Show the steps.',
  rubricVersionId: RUBRIC_V2, definitionVersion: 2, status: 'evaluated', decidedBy: null, decidedAt: null,
  decisionEvaluationId: null, submissions: 2, latestSubmissionId: LATEST, createdBy: 'owner', createdAt: AT, updatedAt: AT,
};
const codeExecution = { available: false, reason: 'An isolated runner is a separate project.' };
const assignmentDetail: AssignmentDetail = {
  assignment, codeExecution,
  definitions: [
    { version: 2, title: assignment.title, kind: 'code', instructions: assignment.instructions, rubricVersionId: RUBRIC_V2, createdBy: 'owner', createdAt: AT },
    { version: 1, title: 'Previous assignment title', kind: 'code', instructions: 'Original instructions.', rubricVersionId: RUBRIC_V1, createdBy: 'owner', createdAt: AT },
  ],
  submissions: [revision, { ...revision, id: PREVIOUS, revision: 1, body: 'First answer', note: null, files: [] }],
  uploadLimits: { maxFileBytes: 2 * 1024 * 1024, maxFiles: 4, maxTotalBytes: 6 * 1024 * 1024, maxBodyChars: 100_000, extensions: ['html', 'md', 'png'] },
};
const evaluation: EvaluationDetail = {
  id: EVALUATION, submissionId: LATEST, assignmentId: ASSIGNMENT, assignmentTitle: assignment.title, revision: 2, rubricVersionId: RUBRIC_V1,
  evaluatorType: 'ai', evaluator: 'test-model', status: 'completed', outcome: 'meets_rubric',
  scores: [{ criterion: 'reasoning', title: 'Explain the slope', score: 8, maxScore: 10, rationale: 'The slope is explained.' }],
  totalScore: 8, maxScore: 10, passingScore: 7, feedback: 'Good work.', confidence: 0.75,
  limitations: ['The reasoning was reviewed from the text.'],
  suggestions: { levels: [{ skill: 'Derivatives', skillId: SKILL, level: 3, rationale: 'Shows independent work' }] },
  error: null, ai: null, evidenceCount: 2, requestedBy: 'owner', createdAt: AT, completedAt: AT,
  evidence: [
    { id: id(21), type: 'excerpt', criterion: 'reasoning', sourceRef: `submission:${LATEST}#file:${FILE}`, excerpt: CODE, hash: 'file-hash', verified: true, score: null, note: null, limitations: null, createdAt: AT },
    { id: id(22), type: 'excerpt', criterion: 'reasoning', sourceRef: `submission:${LATEST}#body`, excerpt: 'A quote missing from the answer', hash: null, verified: false, score: null, note: null, limitations: 'Could not find this excerpt.', createdAt: AT },
  ],
};
const skill: Skill = {
  id: SKILL, displayName: 'Derivatives', canonicalName: 'derivatives', createdAt: AT, openGaps: 0,
  mastery: { self: { level: 0, at: AT, note: 'Starting here' }, verified: null },
};
const gap: Gap = {
  id: GAP, skillId: SKILL, title: 'Check algebra', description: 'Review the final simplification.', source: 'ai',
  evaluationId: EVALUATION, status: 'suggested', createdAt: AT, updatedAt: AT, createdBy: 'owner',
};
const skillDetail: SkillDetail = {
  skill: { ...skill, mastery: {
    ...skill.mastery, verified: { level: 3, at: AT, by: 'owner', ageDays: 95, stale: true, confidence: 0.75, evaluationId: EVALUATION },
  } },
  history: [{ id: id(23), kind: 'verified', level: 3, evaluationId: EVALUATION, note: null, actor: 'owner', at: AT }],
  gaps: [gap], milestones: [{ id: MILESTONE, title: 'Derivative basics', roadmapId: id(24), status: 'active' }], freshDays: 90,
};

const responses = new Map<string, { body: unknown; status: number }>();
const reply = (key: string, body: unknown, status = 200) => responses.set(key, { body, status });
const upstream = vi.fn(async (input: string, init: RequestInit) => {
  const url = new URL(input);
  const response = responses.get(`${init.method} ${url.pathname}${url.search}`);
  return response ? Response.json(response.body, { status: response.status }) : Response.json({ message: 'Fixture not found' }, { status: 404 });
});

beforeEach(() => {
  auth.active = true;
  responses.clear();
  upstream.mockClear();
  vi.stubGlobal('fetch', upstream);
  reply(`GET /assignments/${ASSIGNMENT}`, assignmentDetail);
  reply('GET /assignments', { items: [assignment] });
  reply('GET /rubrics', { items: [rubric] });
  reply(`GET /rubrics/${RUBRIC}`, { ...rubric, versions: [latestRubric, originalRubric] });
  reply(`GET /rubrics/versions/${RUBRIC_V1}`, originalRubric);
  reply(`GET /submissions/${LATEST}/evaluations`, { items: [evaluation] });
  reply('GET /status', { ai: { configured: false } });
  reply(`GET /evaluations/${EVALUATION}`, evaluation);
  reply(`GET /milestones/${MILESTONE}`, { skillIds: [SKILL] });
  reply('GET /skills', { items: [skill], freshDays: 90 });
  reply(`GET /skills/${SKILL}`, skillDetail);
  reply('GET /gaps?status=suggested', { items: [gap] });
});

afterEach(() => vi.unstubAllGlobals());

const pageParams = (id: string) => ({ params: Promise.resolve({ id }), searchParams: Promise.resolve({}) });
const revisionParams = (submissionId = LATEST) => ({ ...pageParams(ASSIGNMENT), params: Promise.resolve({ id: ASSIGNMENT, submissionId }) });
const requestBody = (call = 0) => JSON.parse(String(upstream.mock.calls[call]?.[1].body));

function postForm(parts: string[], fields: Record<string, string> | FormData, options: { csrf?: string; site?: string } = {}) {
  const body = fields instanceof FormData ? fields : new URLSearchParams(fields);
  body.append('csrf', options.csrf ?? auth.session.csrf);
  const req = new Request(`${DASHBOARD}/api/learning/${parts.join('/')}`, {
    method: 'POST', body,
    headers: { host: 'dashboard.test', origin: DASHBOARD, 'sec-fetch-site': options.site ?? 'same-origin' },
  });
  return post(req, { params: Promise.resolve({ action: parts }) });
}

describe('learning L2 screens', () => {
  it('lists immutable revisions and posts new submissions as multipart', async () => {
    const html = renderToStaticMarkup(await AssignmentPage(pageParams(ASSIGNMENT)));
    expect(html).toContain('Calculate the slope');
    expect(html).toContain('Revision 1');
    expect(html).toContain('Revision 2');
    expect(html).toContain(`href="${REVISION_PAGE}"`);
    expect(html).toContain(`action="/api/learning/assignments/${ASSIGNMENT}/submit"`);
    expect(html).toContain('multipart/form-data');
    expect(html).toContain('type="file"');
    expect(html).toContain('.html,.md,.png');
    expect(html).toContain('Code is not run');
  });

  it('keeps submission history accessible when the assignment is closed', async () => {
    reply(`GET /assignments/${ASSIGNMENT}`, { ...assignmentDetail, assignment: { ...assignment, status: 'archived' } });
    const html = renderToStaticMarkup(await AssignmentPage(pageParams(ASSIGNMENT)));
    expect(html).toContain(`href="${REVISION_PAGE}"`);
    expect(html).not.toContain('Save submission');
  });

  it('uses the revision’s pinned rubric and preserves the attachment and manual evaluation when AI is off', async () => {
    const html = renderToStaticMarkup(await SubmissionPage(revisionParams()));
    expect(html).toContain('Previous assignment title');
    expect(html).toContain('&lt;script&gt;answer kept as text&lt;/script&gt;');
    expect(html).toContain(`href="${DOWNLOAD}"`);
    expect(html).toContain(' download=""');
    expect(html).toContain('AI is not configured');
    expect(html).not.toContain('/evaluate-ai');
    expect(html).toContain('name="score:reasoning"');
    expect(html).not.toContain('name="score:notation"');
  });

  it('offers AI evaluation when configured and shows a prior failure next to the preserved revision', async () => {
    reply('GET /status', { ai: { configured: true } });
    reply(`GET /submissions/${LATEST}/evaluations`, { items: [{ ...evaluation, status: 'failed', error: { code: 'AI_PROVIDER_TIMEOUT', message: 'Provider timed out' } }] });
    const html = renderToStaticMarkup(await SubmissionPage(revisionParams()));
    expect(html).toContain(`action="/api/learning/submissions/${LATEST}/evaluate-ai"`);
    expect(html).toContain('Request AI evaluation');
    expect(html).toContain('AI_PROVIDER_TIMEOUT');
    expect(html).toContain('href="' + DOWNLOAD + '"');
  });

  it('rejects a revision outside the assignment before reading evaluations', async () => {
    await expect(SubmissionPage(revisionParams(id(91)))).rejects.toMatchObject({ digest: 'NEXT_HTTP_ERROR_FALLBACK;404' });
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it('links the latest revision from the evaluation queue and filters previous attempts', async () => {
    reply('GET /evaluations?status=failed', { items: [{ ...evaluation, status: 'failed' }] });
    const html = renderToStaticMarkup(await EvaluationsPage({ searchParams: Promise.resolve({ status: 'failed' }) }));
    expect(html).toContain(`href="${REVISION_PAGE}"`);
    expect(html).toContain(`href="${EVALUATION_PAGE}"`);
    expect(html).toContain('awaiting your decision');
    expect(html).toContain('value="failed" selected=""');
  });

  it('shows evidence provenance, confidence, limitations and owner controls', async () => {
    const html = renderToStaticMarkup(await EvaluationPage(pageParams(EVALUATION)));
    expect(html).toContain('confidence 75%');
    expect(html).toContain('The reasoning was reviewed from the text.');
    expect(html).toContain('답안.html');
    expect(html).toContain('found in submission');
    expect(html).toContain('not found · unverified');
    expect(html).toContain('Could not find this excerpt.');
    expect(html).toContain(`action="/api/learning/assignments/${ASSIGNMENT}/decide"`);
    expect(html).toContain(`action="/api/learning/skills/${SKILL}/verify"`);
    expect(html).toContain('name="confirmed"');
  });

  it('does not offer a decision based on an older revision', async () => {
    reply(`GET /evaluations/${EVALUATION}`, { ...evaluation, submissionId: PREVIOUS, revision: 1 });
    const html = renderToStaticMarkup(await EvaluationPage(pageParams(EVALUATION)));
    expect(html).toContain('Evaluation of revision 1');
    expect(html).not.toContain('/decide');
  });

  it('distinguishes self level zero from unverified and offers actions on AI gaps', async () => {
    const html = renderToStaticMarkup(await SkillsPage({ searchParams: Promise.resolve({ status: 'suggested' }) }));
    expect(html).toContain('0 · None');
    expect(html).toContain('unverified');
    expect(html).toContain(`href="${SKILL_PAGE}"`);
    expect(html).toContain('Check algebra');
    expect(html).toContain(`href="${EVALUATION_PAGE}"`);
expect(html).toMatch(/<button[^>]+value="open"[^>]*>Accept<\/button>/);
    expect(html).toMatch(/<button[^>]+value="dismissed"[^>]*>Dismiss<\/button>/);
  });

  it('shows a separately verified level, the supporting evaluation and a self-assessment form', async () => {
    const html = renderToStaticMarkup(await SkillPage(pageParams(SKILL)));
    expect(html).toContain('0 · None');
    expect(html).toContain('3 · Independent');
    expect(html).toContain('Review due');
    expect(html).toContain('View supporting evidence');
    expect(html).toContain(`action="/api/learning/skills/${SKILL}/self"`);
    expect(html).toContain(`name="skillId" value="${SKILL}"`);
  });

  it('preserves rubric criterion keys and uses a base version for the version form', async () => {
    const html = renderToStaticMarkup(await RubricPage(pageParams(RUBRIC)));
    expect(html).toContain('Explain the slope');
    expect(html).toContain('Show the notation');
    expect(html).toContain('name="baseVersion" value="2"');
    expect(html).toContain('name="c_key" value="notation"');
  });
});

describe('learning L2 form routes', () => {
  it('converts a multipart submission to a revision payload without losing lines or file bytes', async () => {
    reply(`POST /assignments/${ASSIGNMENT}/submissions`, revision, 201);
    const body = new FormData();
    body.append('body', 'first line\r\nsecond line');
    body.append('note', '  corrected  ');
    body.append('files', new Blob([CODE], { type: 'text/html' }), '답안.html');
    body.append('returnTo', ASSIGNMENT_PAGE);
    const response = await postForm(['assignments', ASSIGNMENT, 'submit'], body);
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toContain(ASSIGNMENT_PAGE + '?ok=');
    expect(requestBody()).toEqual({
      body: 'first line\nsecond line', note: 'corrected', files: [{ name: '답안.html', contentBase64: Buffer.from(CODE).toString('base64') }],
    });
  });

  it('rejects an oversized attachment before contacting the service', async () => {
    const body = new FormData();
    body.append('files', new Blob([new Uint8Array(assignmentDetail.uploadLimits.maxFileBytes + 1)]), 'big.txt');
    body.append('returnTo', ASSIGNMENT_PAGE);
    const response = await postForm(['assignments', ASSIGNMENT, 'submit'], body);
    expect(response.headers.get('x-pai-rejected')).toBe('upload');
    expect(upstream).not.toHaveBeenCalled();
  });

  it('rejects a cross-site form with a valid token using authorizePost', async () => {
    const response = await postForm(['skills', SKILL, 'self'], { level: '3', returnTo: SKILL_PAGE }, { site: 'cross-site' });
    expect(response.headers.get('x-pai-rejected')).toBe('csrf:cross_site');
    expect(upstream).not.toHaveBeenCalled();
  });

  it('rejects extra path segments even when their first and last segments name a valid action', async () => {
    const response = await postForm(['skills', 'invalid-id', 'create'], { name: 'Algebra' });
    expect(decodeURIComponent(response.headers.get('location') ?? '')).toContain('Unknown action');
    expect(upstream).not.toHaveBeenCalled();
  });

  it('posts owner scores, evidence and confidence using the evaluation DTO', async () => {
    reply(`POST /submissions/${LATEST}/evaluations`, evaluation, 201);
    const response = await postForm(['submissions', LATEST, 'evaluate-owner'], {
      criterion: 'reasoning', 'score:reasoning': '7.5', 'note:reasoning': ' work checked ',
      evidenceNote: ' Calculated the slope by hand. ', feedback: 'See notes.',
      confidence: '75', limitations: 'Paper calculation\r\n\r\nSample size one', returnTo: REVISION_PAGE,
    });
    expect(response.headers.get('location')).toContain(REVISION_PAGE + '?ok=');
    expect(requestBody()).toEqual({
      scores: [{ criterion: 'reasoning', score: 7.5, note: 'work checked' }], feedback: 'See notes.', confidence: 0.75,
      evidence: [{ type: 'owner_check', note: 'Calculated the slope by hand.' }], limitations: ['Paper calculation', 'Sample size one'],
    });
  });

  it('returns the provider-not-configured error to the submission', async () => {
    reply(`POST /submissions/${LATEST}/evaluate`, { code: 'PROVIDER_NOT_CONFIGURED', message: 'Provider unavailable' }, 503);
    const response = await postForm(['submissions', LATEST, 'evaluate-ai'], { returnTo: REVISION_PAGE });
    const location = decodeURIComponent(response.headers.get('location') ?? '');
    expect(location).toContain(REVISION_PAGE + '?error=');
    expect(location).toContain('PROVIDER_NOT_CONFIGURED');
    expect(requestBody()).toEqual({});
  });

  it('requires confirmation for decisions and posts the chosen evaluation when confirmed', async () => {
    const action = ['assignments', ASSIGNMENT, 'decide'];
    const fields = { evaluationId: EVALUATION, decision: 'passed', returnTo: EVALUATION_PAGE };
    await postForm(action, fields);
    expect(upstream).not.toHaveBeenCalled();
    reply(`POST /assignments/${ASSIGNMENT}/decision`, { ...assignment, status: 'passed' });
    const response = await postForm(action, { ...fields, confirmed: 'yes' });
    expect(response.headers.get('location')).toContain(EVALUATION_PAGE + '?ok=');
    expect(requestBody()).toEqual({ evaluationId: EVALUATION, decision: 'passed' });
  });

  it('keeps self-assessment level zero separate from verification payloads', async () => {
    reply(`POST /skills/${SKILL}/self-assessment`, skill, 201);
    reply(`POST /skills/${SKILL}/verify`, skillDetail.skill, 201);
    await postForm(['skills', SKILL, 'self'], { level: '0', note: 'Trying it', returnTo: SKILL_PAGE });
    await postForm(['skills', SKILL, 'verify'], { level: '3', evaluationId: EVALUATION, confirmed: 'yes', returnTo: EVALUATION_PAGE });
    expect(requestBody(0)).toEqual({ level: 0, note: 'Trying it' });
    expect(requestBody(1)).toEqual({ level: 3, evaluationId: EVALUATION });
  });

  it('updates gap status and retains the selected list filter', async () => {
    const here = '/learning/skills?status=suggested';
    reply(`PATCH /gaps/${GAP}`, { ...gap, status: 'open' });
    const response = await postForm(['gaps', GAP, 'update'], { status: 'open', returnTo: here });
    expect(response.headers.get('location')).toContain(here + '&ok=');
    expect(requestBody()).toEqual({ status: 'open' });
  });

  it('keeps explicit rubric keys and generates distinct keys for matching new titles', async () => {
    reply('POST /rubrics', rubric, 201);
    const body = new FormData();
    body.append('title', rubric.title);
    body.append('passingScore', '7');
    for (const key of ['', '', 'reasoning']) {
      body.append('c_title', 'Reasoning');
      body.append('c_max', '5');
      body.append('c_key', key);
      body.append('c_desc', '');
    }
    await postForm(['rubrics', 'create'], body);
    expect(requestBody().criteria.map((criterion: { key: string }) => criterion.key)).toEqual(['reasoning-2', 'reasoning-3', 'reasoning']);
  });
});

describe('learning L2 file route', () => {
  it('configures the file CSP after the dashboard-wide policy', async () => {
    const rules = await nextConfig.headers();
    const fileRule = rules.at(-1);
    expect(fileRule?.source).toBe('/api/learning-files/:submissionId/:fileId');
    expect(fileRule?.headers).toContainEqual({
      key: 'Content-Security-Policy',
      value: expect.stringContaining('sandbox'),
    });
  });

  const getFile = (submissionId = LATEST, fileId = FILE) =>
    download(new Request(DASHBOARD + fileHref(submissionId, fileId)), { params: Promise.resolve({ submissionId, fileId }) });

  it('rejects signed-out downloads before calling the service', async () => {
    auth.active = false;
    expect((await getFile()).status).toBe(401);
    expect(upstream).not.toHaveBeenCalled();
  });

  it.each([['../latest', FILE], [LATEST, 'abc/def']])('rejects malformed file coordinates (%s, %s)', async (submissionId, fileId) => {
    expect((await getFile(submissionId, fileId)).status).toBe(404);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('fetches files by both IDs and preserves a not-found response for non-members', async () => {
    const response = await getFile(PREVIOUS, FILE);
    expect(response.status).toBe(404);
    expect(new URL(upstream.mock.calls[0][0]).pathname).toBe(`/submissions/${PREVIOUS}/files/${FILE}`);
  });

  it('serves saved HTML as sandboxed plain text with no sniffing or caching', async () => {
    reply(`GET /submissions/${LATEST}/files/${FILE}`, { ...revision.files[0], contentBase64: Buffer.from(CODE).toString('base64') });
    const response = await getFile();
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(response.headers.get('content-security-policy')).toContain('sandbox');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-disposition')).toContain(encodeURIComponent(revision.files[0].name));
    expect(await response.text()).toBe(CODE);
  });
});
