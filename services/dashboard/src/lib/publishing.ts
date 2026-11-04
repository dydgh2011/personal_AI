import type { PublicationStatus } from './types';

/** Owner-facing explanation of each reason code (same codes as controller 409s and publisher reports). */
export const REASONS: Record<string, string> = {
  TEST_REPORT_MISSING: '게시 불가 — 이 커밋에 연결된 테스트 실행 결과가 없습니다.',
  TEST_FAILED: '게시 불가 — 테스트가 실패했습니다.',
  TEST_ABORTED: '게시 불가 — 테스트가 중단되었거나 시간 초과되었습니다.',
  TEST_SKIPPED: '게시 불가 — 건너뛴 테스트가 있습니다.',
  TEST_COMMIT_MISMATCH: '게시 불가 — 테스트 결과가 다른 커밋(또는 트리)에 대한 것입니다.',
  TEST_COMMANDS_CHANGED: '게시 불가 — 프로젝트 테스트 명령이 바뀌었습니다. 테스트를 다시 실행하세요.',
  TEST_EVIDENCE_INVALID: '게시 불가 — 테스트 결과의 무결성(Test Runner 서명)을 확인할 수 없습니다.',
  TEST_COMMANDS_NOT_CONFIGURED: '게시 불가 — 이 프로젝트에 승인된 테스트 명령이 없습니다.',
  REVIEW_NOT_APPROVED: '게시 불가 — 코드 리뷰가 승인되지 않았습니다.',
  COMMIT_MISMATCH: '게시 불가 — 게시 대상 커밋이 승인된 커밋과 다릅니다.',
  TREE_MISMATCH: '게시 불가 — Git 트리가 승인된 트리와 다릅니다.',
  BASE_INVALID: '게시 불가 — 기준(Base) 커밋을 검증할 수 없습니다.',
  FILES_MISMATCH: '게시 불가 — 변경 파일이 승인 시 표시된 목록과 다릅니다.',
  REVIEW_INCOMPLETE: '게시 불가 — 승인 시 숨겨지거나 잘린 변경이 있었습니다.',
  AUTHOR_CHANGED: '게시 불가 — 커밋 작성자/커미터/메시지가 Worker 원본과 다릅니다.',
  ARTIFACT_INVALID: '게시 불가 — Git 아티팩트가 없거나 손상되었습니다.',
  REPOSITORY_NOT_ALLOWED: '게시 불가 — 허용되지 않은 저장소입니다.',
  REMOTE_REPOSITORY_MISMATCH: '게시 불가 — 원격 저장소 정보가 Registry와 다릅니다.',
  REMOTE_BASE_CHANGED: '게시 불가 — 원격 기본 브랜치가 승인 이후 변경되었습니다. 재검토가 필요합니다.',
  TARGET_BRANCH_EXISTS: '게시 불가 — 대상 브랜치가 이미 존재합니다.',
  PUBLISH_APPROVAL_REQUIRED: '게시 승인 필요 — 리뷰 승인과 별도의 게시 승인이 필요합니다.',
  DRY_RUN_REQUIRED: '먼저 Validate / Dry-run을 다시 실행하세요 (최근 30분 이내의 적격 결과 필요).',
  PUBLISH_DISABLED: '실제 게시는 비활성화되어 있습니다 (Phase E-2B).',
  PUBLISH_ALREADY_AUTHORIZED: '이미 유효한 게시 승인이 있습니다.',
  ALREADY_PUBLISHED: '이미 게시되었습니다.',
};

export const reasonText = (code: string | null | undefined) => (code ? REASONS[code] ?? code : '');

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
