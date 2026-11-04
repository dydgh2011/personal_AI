import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { CommandResult } from './sandbox.js';

export interface Evidence {
  format: 'personal-ai-test-evidence/v1';
  validationId: string;
  taskId: string;
  projectId: string;
  agent: string;
  baseSha: string;
  commitSha: string;
  treeSha: string | null;
  commands: Array<{ name: string; argv: string[]; timeoutSeconds: number }>;
  results: CommandResult[];
  status: 'passed' | 'failed' | 'skipped' | 'aborted';
  error: string | null;
  runner: { id: string; sandboxUid: number; network: 'controller-only' };
  startedAt: string;
  completedAt: string;
}

/** Same precedence as the controller: aborted > failed > skipped > passed. */
export function overallStatus(commands: Evidence['commands'], results: CommandResult[]): Evidence['status'] {
  if (results.length !== commands.length) return 'aborted';
  const ran = results.filter((r) => r.status !== 'skipped');
  if (ran.some((r) => r.status === 'aborted' || r.timedOut || r.exitCode === null)) return 'aborted';
  if (ran.some((r) => r.status !== 'passed' || r.exitCode !== 0)) return 'failed';
  if (ran.length !== results.length) return 'skipped';
  return 'passed';
}

/** The exact string that is hashed and signed (and later re-verified by the publisher). */
export function seal(evidence: Evidence, key: Buffer): { evidence: string; evidenceHash: string; evidenceSignature: string } {
  const text = JSON.stringify(evidence);
  return {
    evidence: text,
    evidenceHash: createHash('sha256').update(text).digest('hex'),
    evidenceSignature: createHmac('sha256', key).update(text).digest('hex'),
  };
}

export function verifySeal(text: string, hash: string, signature: string, key: Buffer): boolean {
  if (createHash('sha256').update(text).digest('hex') !== hash) return false;
  const want = createHmac('sha256', key).update(text).digest();
  const got = Buffer.from(signature, 'hex');
  return got.length === want.length && timingSafeEqual(got, want);
}
