import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DiffView } from '@/components/DiffView';
import { parsePatch } from '@/lib/diff';
import { parseReport, workerState } from '@/lib/report';
import { decidable, reviewWarnings, testsOf } from '@/lib/review';
import type { DiffResponse, PublicationStatus, Review, TestValidation } from '@/lib/types';
import { PublicationPanel } from '@/components/PublicationPanel';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const PATCH = [
  'diff --git a/src/x.ts b/src/x.ts',
  'index 111..222 100644',
  '--- a/src/x.ts',
  '+++ b/src/x.ts',
  '@@ -1,2 +1,2 @@',
  ' keep',
  '-old <b>line</b>',
  '+new <script>alert(1)</script>',
  'diff --git a/README.md b/README.md',
  '--- a/README.md',
  '+++ b/README.md',
  '@@ -0,0 +1 @@',
  '+<img src=x onerror=alert(2)>',
].join('\n');

function review(over: Partial<Review> = {}): Review {
  return {
    id: 'r1', taskId: 't1', projectId: 'hello-world', agent: 'codex', baseSha: A, headSha: B, headTree: 'c'.repeat(40),
    status: 'awaiting_approval', decidedBy: null, decidedAt: null, reason: null, invalidatedReason: null, createdAt: new Date().toISOString(),
    ...over,
  };
}

function diff(over: Partial<DiffResponse> = {}): DiffResponse {
  return {
    taskId: 't1', projectId: 'hello-world', agent: 'codex', baseSha: A, headSha: B, headTree: 'c'.repeat(40), commitMessage: 'msg',
    additions: 2, deletions: 1,
    files: [
      { path: 'src/x.ts', status: 'M', additions: 1, deletions: 1, binary: false, sensitive: false },
      { path: 'README.md', status: 'A', additions: 1, deletions: 0, binary: false, sensitive: false },
    ],
    patch: PATCH, patchWithheld: null, patchTruncated: false, omittedFiles: [], tests: null, review: review(), history: [review()],
    ...over,
  };
}

describe('parsePatch', () => {
  it('splits files and classifies lines', () => {
    const files = parsePatch(PATCH);
    expect(files.map((f) => f.path)).toEqual(['src/x.ts', 'README.md']);
    expect(files[0].lines.map((l) => l.kind)).toEqual(['meta', 'meta', 'meta', 'meta', 'hunk', 'ctx', 'del', 'add']);
    expect(parsePatch(null)).toEqual([]);
  });
});

describe('DiffView', () => {
  it('renders markup in diffs as escaped text', () => {
    const html = renderToStaticMarkup(<DiffView files={diff().files} patch={PATCH} omitted={[]} withheld={null} />);
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<b>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&lt;img src=x onerror=alert(2)&gt;');
  });
  it('hides binary, sensitive, omitted and withheld content', () => {
    const files = [
      { path: 'img.png', status: 'A', additions: null, deletions: null, binary: true, sensitive: false },
      { path: '.env', status: 'A', additions: 1, deletions: 0, binary: false, sensitive: true },
      { path: 'big.txt', status: 'A', additions: 9, deletions: 0, binary: false, sensitive: false },
    ];
    const html = renderToStaticMarkup(<DiffView files={files} patch={'diff --git a/x b/x\n+SECRET=1'} omitted={['big.txt']} withheld={null} />);
    expect(html).toContain('Binary file');
    expect(html).toContain('Sensitive file');
    expect(html).toContain('omitted');
    expect(html).not.toContain('SECRET');
    const withheld = renderToStaticMarkup(<DiffView files={diff().files} patch={null} omitted={[]} withheld="Patch withheld" />);
    expect(withheld).toContain('Patch withheld');
  });
});

function run(status: TestValidation['status'], exitCode: number | null = 0): TestValidation {
  return {
    id: 'tv1', taskId: 't1', projectId: 'hello-world', baseSha: A, commitSha: B, status, commands: [{ name: 'whitespace', argv: ['sh'], timeoutSeconds: 60 }],
    results: status === 'pending' || status === 'running' ? null : [{ name: 'whitespace', argv: ['sh'], status, exitCode, timedOut: exitCode === null, durationMs: 5, outputTail: '' }],
    requestedBy: 'controller:auto', requestedAt: new Date().toISOString(), completedAt: null, evidenceHash: 'e'.repeat(64), error: null,
  };
}

describe('reviewWarnings / decidable', () => {
  const texts = (d: DiffResponse) => reviewWarnings(d).map((w) => w.text).join('\n');
  it('flags tests not reported, and nothing else for a clean diff', () => {
    // no test-runner result yet: warning (a worker/agent claim about tests does not count)
    expect(reviewWarnings(diff()).map((w) => w.text)).toEqual(['No test run for this commit yet (isolated test runner). It cannot be published until the approved test commands pass.']);
    expect(reviewWarnings(diff({ tests: { passed: 3 } })).map((w) => w.level)).toEqual(['warn']);
    // passed on this exact commit: no warning
    expect(reviewWarnings(diff(), run('passed'))).toEqual([]);
    expect(testsOf(diff(), run('passed')).text).toMatch(/whitespace exit 0/);
    // failed / aborted / other commit: error
    expect(reviewWarnings(diff(), run('failed', 1)).map((w) => w.level)).toEqual(['bad']);
    expect(reviewWarnings(diff(), run('aborted', null)).map((w) => w.text).join()).toMatch(/aborted.*timeout/);
    expect(reviewWarnings(diff(), { ...run('passed'), commitSha: A }).map((w) => w.text).join()).toMatch(/not this commit/);
    expect(reviewWarnings(diff(), run('running')).map((w) => w.text).join()).toMatch(/running/);
    expect(decidable(diff())?.headSha).toBe(B);
  });
  it('flags truncation, binary, sensitive and old tasks without patch', () => {
    const t = texts(diff({
      patch: null, patchTruncated: true, omittedFiles: ['a'], headTree: null,
      files: [{ path: 'p', status: 'A', additions: null, deletions: null, binary: true, sensitive: false }, { path: '.env', status: 'A', additions: 1, deletions: 0, binary: false, sensitive: true }],
    }));
    for (const s of ['Diff truncated', 'binary file', 'sensitive file', 'No patch text', 'Tree SHA not reported']) expect(t).toContain(s);
  });
  it('blocks decisions on invalidated, decided or moved reviews', () => {
    const inv = diff({ review: review({ status: 'invalidated', invalidatedReason: 'Task branch now points to x' }) });
    expect(texts(inv)).toContain('Review invalidated');
    expect(decidable(inv)).toBeNull();
    const moved = diff({ review: review({ headSha: 'd'.repeat(40) }) });
    expect(texts(moved)).toContain('Target commit changed');
    expect(decidable(moved)).toBeNull();
    expect(decidable(diff({ review: review({ status: 'approved', decidedBy: 'dashboard:owner' }) }))).toBeNull();
    expect(decidable(diff({ review: null }))).toBeNull();
  });
});

describe('report helpers', () => {
  it('parses only agent-worker/v1 reports', () => {
    expect(parseReport(JSON.stringify({ format: 'agent-worker/v1', message: 'hi' }))?.message).toBe('hi');
    expect(parseReport('plain text')).toBeNull();
    expect(parseReport(JSON.stringify({ format: 'other' }))).toBeNull();
    expect(parseReport(null)).toBeNull();
  });
  it('derives worker state without guessing', () => {
    const now = Date.parse('2026-01-01T00:01:00Z');
    expect(workerState(null, now)).toBe('unknown');
    expect(workerState('2026-01-01T00:00:30Z', now)).toBe('online');
    expect(workerState('2025-12-31T00:00:00Z', now)).toBe('stale');
    expect(workerState('garbage', now)).toBe('unknown');
  });
});

describe('PublicationPanel', () => {
  const status = (state: PublicationStatus['state'], result: PublicationStatus['current'] extends infer P ? (P extends { result: infer R } ? R : never) : never = null): PublicationStatus => ({
    state,
    review: review({ status: state === 'not_approved' ? 'awaiting_approval' : 'approved' }),
    current: result ? { id: 'p', taskId: 't1', reviewId: 'r1', headSha: B, mode: 'dry-run', status: 'ready', requestedBy: 'dashboard:owner', requestedAt: new Date().toISOString(), attempts: 1, completedAt: null, result } : null,
    history: [],
  });
  it('offers only Validate / Dry-run, and only for an approved commit', () => {
    const approved = renderToStaticMarkup(<PublicationPanel taskId="t1" status={status('approved')} csrf="c" />);
    expect(approved).toContain('Validate / Dry-run');
    expect(approved).toContain(`value="${B}"`);
    expect(approved).toMatch(/<button type="button" disabled=""[^>]*>Publish \(disabled in Phase E-2B\)</);
    expect(approved).toContain('게시 불가 — 이 커밋에 연결된 테스트 실행 결과가 없습니다.');
    expect(renderToStaticMarkup(<PublicationPanel taskId="t1" status={status('not_approved')} csrf="c" />)).not.toContain('Validate / Dry-run');
    expect(renderToStaticMarkup(<PublicationPanel taskId="t1" status={status('validation_pending')} csrf="c" />)).not.toContain('Validate / Dry-run');
  });
  it('renders publisher reports as text', () => {
    const html = renderToStaticMarkup(<PublicationPanel taskId="t1" csrf="c" status={status('ready_to_publish', {
      gitVerified: true, publishable: true, pushPerformed: false, pullRequestCreated: false, blockers: [], warnings: ['tests_not_reported'],
      checks: [{ id: 'head_matches', ok: true, detail: '<img src=x onerror=alert(1)>' }],
      target: { repository: 'owner/hello', baseBranch: 'main', branch: 'personal-ai/t1', baseSha: A, headSha: B, headTree: 'c'.repeat(40) },
      pullRequest: { title: '<script>x</script>', body: 'body', head: 'personal-ai/t1', base: 'main', draft: true },
    })} />);
    expect(html).toContain('Ready to publish');
    expect(html).toContain('Planned pull request (not created)');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img');
  });
});
