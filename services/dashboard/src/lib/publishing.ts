import type { Dict } from '@/i18n';
import type { PublicationStatus } from './types';

/**
 * Owner-facing explanation of each reason code (same codes as controller 409s and publisher
 * reports). The texts live in the dictionaries (publication.reasons); an unknown code is shown as is.
 */
export const reasonText = (code: string | null | undefined, t: Dict) => (code ? t.publication.reasons[code] ?? code : '');

/** What the owner can do next; the controller and publisher enforce the same conditions. */
export function nextSteps(status: PublicationStatus) {
  const r = status.current?.result ?? null;
  const tests = status.testValidation;
  const approved = status.review?.status === 'approved';
  const freshDryRun = !!status.current && status.current.mode === 'dry-run' && status.current.status === 'ready' && r?.eligible === true &&
    r?.testValidationId === tests?.id;
  const activeAuth = status.authorization?.status === 'active' && Date.parse(status.authorization.expiresAt) > Date.now() ? status.authorization : null;
  return {
    canRunTests: !!status.review && (!tests || !['pending', 'running'].includes(tests.status)),
    canDryRun: approved && status.state !== 'validation_pending',
    canAuthorize: approved && tests?.status === 'passed' && freshDryRun && !activeAuth,
    canPublish: status.publishEnabled && !!activeAuth,
    activeAuth,
    testsMissing: !tests || ['pending', 'running'].includes(tests.status),
  };
}
