import type { Dict } from '@/i18n';
import { short } from './diff';
import type { DiffResponse, Review, TestValidation } from './types';

/** Conditions the reviewer must see before deciding. Derived only from what the controller returned. */
export function reviewWarnings(d: DiffResponse, tests: TestValidation | null | undefined, t: Dict): Array<{ level: 'warn' | 'bad'; text: string }> {
  const w = t.review.warn;
  const out: Array<{ level: 'warn' | 'bad'; text: string }> = [];
  const r = d.review;
  if (!r) out.push({ level: 'bad', text: w.noRecord });
  else if (r.status === 'invalidated') out.push({ level: 'bad', text: w.invalidated(r.invalidatedReason ?? w.targetChangedDefault) });
  else if (r.headSha !== d.headSha) out.push({ level: 'bad', text: w.targetChanged(short(r.headSha), short(d.headSha)) });
  // patchWithheld is the controller's own explanation (free text): shown as it is.
  if (d.patchWithheld) out.push({ level: 'warn', text: d.patchWithheld });
  if (d.patch === null && !d.patchWithheld) out.push({ level: 'warn', text: w.noPatch });
  if (d.patchTruncated) out.push({ level: 'warn', text: w.truncated(d.omittedFiles.length) });
  const binary = d.files.filter((f) => f.binary).length;
  if (binary) out.push({ level: 'warn', text: w.binary(binary) });
  const sensitive = d.files.filter((f) => f.sensitive).length;
  if (sensitive) out.push({ level: 'bad', text: w.sensitive(sensitive) });
  const result = testsOf(d, tests, t);
  if (result.level) out.push({ level: result.level, text: result.text });
  if (!d.headTree) out.push({ level: 'warn', text: w.noTree });
  return out;
}

/**
 * Test status of exactly this commit, from the isolated test runner (POLICY A). What the worker or
 * the agent wrote about tests in its report is not evidence and is not shown as a test result.
 */
export function testsOf(d: DiffResponse, tests: TestValidation | null | undefined, t: Dict): { level: 'warn' | 'bad' | null; status: string; text: string } {
  const x = t.review.testText;
  if (!tests) return { level: 'warn', status: t.review.testStatus.notRun, text: x.none };
  if (tests.commitSha !== d.headSha) return { level: 'bad', status: t.review.testStatus.otherCommit, text: x.otherCommit(short(tests.commitSha)) };
  const codes = (tests.results ?? []).map((r) => x.exit(r.name, String(r.exitCode ?? (r.timedOut ? 'timeout' : '-')))).join(', ');
  switch (tests.status) {
    case 'passed':
      return { level: null, status: 'passed', text: x.passed(codes) };
    case 'pending':
    case 'running':
      return { level: 'warn', status: tests.status, text: x.inProgress(tests.status) };
    default:
      return { level: 'bad', status: tests.status, text: x.failed(tests.status, codes, tests.error ?? '') };
  }
}

/** A decision is possible only for an awaiting review of exactly the reported head commit. */
export function decidable(d: DiffResponse): Review | null {
  return d.review && d.review.status === 'awaiting_approval' && d.review.headSha === d.headSha ? d.review : null;
}
