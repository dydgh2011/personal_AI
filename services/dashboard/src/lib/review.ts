import { short } from './diff';
import type { DiffResponse, Review, TestValidation } from './types';

/** Conditions the reviewer must see before deciding. Derived only from what the controller returned. */
export function reviewWarnings(d: DiffResponse, tests?: TestValidation | null): Array<{ level: 'warn' | 'bad'; text: string }> {
  const out: Array<{ level: 'warn' | 'bad'; text: string }> = [];
  const r = d.review;
  if (!r) out.push({ level: 'bad', text: 'No review record exists for this commit.' });
  else if (r.status === 'invalidated') out.push({ level: 'bad', text: `Review invalidated: ${r.invalidatedReason ?? 'target commit changed'}. It can no longer be approved.` });
  else if (r.headSha !== d.headSha) out.push({ level: 'bad', text: `Target commit changed: the current review is for ${short(r.headSha)}, the reported diff is for ${short(d.headSha)}.` });
  if (d.patchWithheld) out.push({ level: 'warn', text: d.patchWithheld });
  if (d.patch === null && !d.patchWithheld) out.push({ level: 'warn', text: 'No patch text: this task was recorded before diff capture (file list only, no line counts).' });
  if (d.patchTruncated) out.push({ level: 'warn', text: `Diff truncated: patch text exceeded the size limit${d.omittedFiles.length ? ` (${d.omittedFiles.length} file(s) omitted)` : ''}. Review the omitted files elsewhere before approving.` });
  const binary = d.files.filter((f) => f.binary).length;
  if (binary) out.push({ level: 'warn', text: `${binary} binary file(s): content is not shown.` });
  const sensitive = d.files.filter((f) => f.sensitive).length;
  if (sensitive) out.push({ level: 'bad', text: `${sensitive} sensitive file(s) (credential/key patterns): patch hidden. Check them before approving.` });
  const t = testsOf(d, tests);
  if (t.level) out.push({ level: t.level, text: t.text });
  if (!d.headTree) out.push({ level: 'warn', text: 'Tree SHA not reported.' });
  return out;
}

/**
 * Test status of exactly this commit, from the isolated test runner (POLICY A). What the worker or
 * the agent wrote about tests in its report is not evidence and is not shown as a test result.
 */
export function testsOf(d: DiffResponse, tests: TestValidation | null | undefined): { level: 'warn' | 'bad' | null; status: string; text: string } {
  if (!tests) return { level: 'warn', status: 'not run', text: 'No test run for this commit yet (isolated test runner). It cannot be published until the approved test commands pass.' };
  if (tests.commitSha !== d.headSha) return { level: 'bad', status: 'other commit', text: `The latest test run was for ${short(tests.commitSha)}, not this commit. Run the tests again.` };
  const codes = (tests.results ?? []).map((r) => `${r.name} exit ${r.exitCode ?? (r.timedOut ? 'timeout' : '-')}`).join(', ');
  switch (tests.status) {
    case 'passed':
      return { level: null, status: 'passed', text: `Tests passed on this commit (test runner): ${codes}.` };
    case 'pending':
    case 'running':
      return { level: 'warn', status: tests.status, text: `Tests are ${tests.status} in the isolated test runner.` };
    default:
      return { level: 'bad', status: tests.status, text: `Tests ${tests.status} on this commit (test runner)${codes ? `: ${codes}` : ''}${tests.error ? ` - ${tests.error}` : ''}.` };
  }
}

/** A decision is possible only for an awaiting review of exactly the reported head commit. */
export function decidable(d: DiffResponse): Review | null {
  return d.review && d.review.status === 'awaiting_approval' && d.review.headSha === d.headSha ? d.review : null;
}
