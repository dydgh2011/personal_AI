# GitHub Publisher (Phase E-2A dry-run → E-2B 정책 게이트)

승인된 Task Commit을 신뢰할 수 있는 Git 객체로 **독립 검증**하고, GitHub 게시 계획(브랜치, PR 초안)을 만든다.
이번 단계에서는 Push, PR 생성, Merge를 하지 않으며 GitHub 쓰기 자격 증명도 없다.

```
Dashboard ──"Validate / Dry-run"──▶ Controller (publications 테이블, v5)
                                       ▲  claim / result (publisher 토큰, publisher-internal 네트워크)
                                       │
                               github-publisher ──GET only──▶ api.github.com (publisher-egress)
                                 │ 읽기 전용 마운트
                                 ├─ /artifacts/claude, /artifacts/codex   ← Worker가 쓴 git bundle + manifest
                                 └─ /repo-exports/<project>.git           ← repo-sync의 publisher 전용 export
```

## 동작
1. 관리자가 Dashboard에서 승인된 커밋에 **Validate / Dry-run**을 누른다. Controller는 승인된 리뷰의 head SHA가 일치할 때만 요청을 받는다. 리뷰 하나당 진행 중인 요청은 하나만 허용하며, 이는 DB unique index로 보장한다.
2. Publisher가 요청을 claim한다(lease 5분). 재시작 등으로 lease가 만료되면 다시 claim할 수 있고, 3번 실패하면 failed로 처리한다.
3. 아래 검증을 거친 뒤 구조화된 보고서를 Controller에 보낸다. 모두 통과하면 `ready`, 하나라도 실패하면 `failed`다. 같은 기록을 자체 저널(`/var/lib/publisher/publications.jsonl`)에도 남긴다.

## 검증 항목 (하나라도 실패하면 차단)
| id | 내용 |
|---|---|
| task_completed | Task가 completed 상태 |
| review_approved | 리뷰가 approved이고, 요청한 head와 같으며, 최신 리뷰임 |
| review_complete | 승인 시 모든 변경 줄이 표시되었음: patch 기록됨, 잘림 없음, 바이너리·민감 파일 없음, tree 기록됨 |
| tests_reported | `PUBLISHER_REQUIRE_REPORTED_TESTS=true`일 때만 검사. 기본값에서는 경고만 남김 |
| target_allowed | GitHub 프로젝트이고, enabled이며 allowCodeChanges가 켜져 있음. `PUBLISHER_ALLOWED_REPOSITORIES`에 포함되고 remoteUrl이 일치함 |
| target_branch | `personal-ai/<taskId>`(기본 브랜치에는 절대 push하지 않음) |
| artifact | manifest가 승인 값(task·agent·project·branch·base·head)과 일치하고, bundle sha256이 일치하며, 크기 제한 이내임. bundle은 Worker 볼륨에서 복사한 사본으로 검증함 |
| trusted_repository | publisher export의 `<project>.git`가 bare 저장소이고 `personal-ai.upstream`이 Registry의 remoteUrl과 같음 |
| base_in_repository | 승인 base가 신뢰 사본의 기본 브랜치 이력에 있음 |
| bundle | `git bundle verify` 통과(필요한 커밋이 이 저장소에 있음 = 다른 저장소의 객체가 아님). ref는 정확히 `refs/heads/<agent>/task-<taskId>` 하나 |
| head_matches / tree_matches | bundle tip이 승인 head와 같고, `head^{tree}`가 승인 headTree와 같음 |
| base_is_ancestor / linear_history | base가 head의 조상이고, merge 없이 base 위에 바로 쌓인 커밋만 있음 |
| files_match | `git diff --name-status base head`가 승인 화면의 파일 목록과 정확히 같음 |
| remote_repository | GitHub 저장소 id·이름·기본 브랜치가 Registry와 같음. 자격 증명이 없어 Private 저장소를 볼 수 없으면 차단 |
| base_current | 원격 기본 브랜치 head가 승인 base와 같음. 다르면 중단하고 재검토를 요구하며, 자동 rebase나 merge는 하지 않음 |
| target_branch_free | 대상 브랜치가 원격에 아직 없음(이미 있으면 중복 게시로 보고 차단) |

검증은 `/tmp`(tmpfs)의 임시 bare 저장소에서 한다. 이 저장소는 신뢰 사본을 `alternates`로 읽기만 하고, 필요한 커밋은 bundle에서 fetch한다. hook, 전역 설정, 네트워크 프로토콜은 쓰지 않는다.

## 설치
```powershell
node services/github-publisher/scripts/init-secrets.mjs      # CONTROLLER_PUBLISHER_TOKEN + secrets/publisher-controller.token
$F = "-f compose.yaml -f compose.workers.yaml -f compose.controller.yaml -f compose.github.yaml -f compose.dashboard.yaml -f compose.publisher.yaml".Split(' ')
docker compose @F up -d --build --no-deps controller claude-worker codex-worker dashboard github-publisher
powershell -ExecutionPolicy Bypass -File services\repo-sync\scripts\provision-exports.ps1   # publisher export 포함
```
E-2A 이전에 끝난 작업의 artifact는 Worker 안에서 직접 만든다.
```powershell
docker exec personal_ai-codex-worker-1 node /opt/agent-worker/export-artifact.js --task <taskId> --project <projectId> --base <baseSha>
```

## 테스트
- `npm test`(Docker 빌드 중 실행): 로컬 bare "원격" 저장소, repo-sync export, Worker bundle, 가짜 GitHub reader, mock GitHub HTTP API를 사용한다.
- `node services/github-publisher/scripts/e2e-dry-run.mjs <taskId> --expect ready|failed`: 실제 Dashboard에서 요청하고 Publisher의 판정까지 확인한다.

## E-2B 준비 사항
`src/github-app.ts`(App JWT, 저장소 1개로 범위를 제한한 설치 토큰, 토큰 redaction)와 `GitHubWriter` 인터페이스는 준비되어 있지만 연결하지 않았다. `loadConfig()`는 `GITHUB_APP_*`, `GITHUB_TOKEN`, `PUBLISHER_MODE=publish`를 거부한다.

## Phase E-2B 변경

### 고정 정책
설정이 아래 값과 다르면 Publisher는 시작을 거부한다.
- **POLICY A** `PUBLISHER_REQUIRE_REPORTED_TESTS=true`: 이 커밋에 대한 Test Runner 서명 증거가 있어야 하고, 모든 명령의 종료 코드가 0이어야 하며, 현재 Registry의 명령과 같아야 한다. Worker 보고서에 적힌 테스트 주장은 증거로 쓰지 않는다(경고만 표시).
- **POLICY B** `PUBLISHER_COMMIT_AUTHOR_POLICY=preserve_worker`: base..head의 모든 커밋에서 author와 committer가 `<agent>-worker <<agent>-worker@personal-ai.local>`여야 하고, head 메시지는 리뷰 당시 기록과 같아야 한다. 게시는 승인된 SHA를 그대로 push한다(amend, rebase, 재작성 없음).

### Preflight 순서와 사유 코드
| 순서 | 검사 | 실패 시 사유 코드 |
|---|---|---|
| 1 | 작업 완료 | `TASK_NOT_COMPLETED` |
| 2 | 리뷰 승인 | `REVIEW_NOT_APPROVED` |
| 3 | 대상 커밋 | `ARTIFACT_INVALID` / `COMMIT_MISMATCH` |
| 4 | tree | `TREE_MISMATCH` |
| 5 | base | `BASE_INVALID` |
| 6 | 파일 범위, 리뷰 완전성, 작성자 | `FILES_MISMATCH`, `REVIEW_INCOMPLETE`, `AUTHOR_CHANGED` |
| 7 | 테스트 증거 존재 | `TEST_REPORT_MISSING` / `TEST_EVIDENCE_INVALID` |
| 8 | 테스트 결과 | `TEST_FAILED` / `TEST_ABORTED` / `TEST_SKIPPED` / `TEST_COMMANDS_CHANGED` |
| 9 | 테스트 대상 SHA | `TEST_COMMIT_MISMATCH` |
| 10 | 허용 저장소 | `REPOSITORY_NOT_ALLOWED` / `REMOTE_REPOSITORY_MISMATCH` |
| 11 | 원격 기본 브랜치 | `REMOTE_BASE_CHANGED` / `TARGET_BRANCH_EXISTS` |
| 12 | 별도 게시 승인 | `PUBLISH_APPROVAL_REQUIRED` |

보고서의 주요 필드는 다음과 같다.
- `eligible`: 12번(게시 승인)을 뺀 모든 검사를 통과함.
- `canPublish`: `eligible`이면서 유효한 게시 승인도 있음.
- `reason`: 위 순서에서 처음으로 실패한 검사의 사유 코드. 예: `{ "eligible": false, "reason": "TEST_REPORT_MISSING", "canPublish": false }`

### 게시 승인과 게시
- **게시 승인(Publish Authorization)**:
  - 리뷰 승인과는 별개의 기록이다.
  - 연결되는 정보: 승인자, Task, Review, Repository ID, head SHA, Test Validation ID, Dry-run ID, 승인 시각.
  - 30분 뒤 만료되고, 한 번만 사용할 수 있으며, idempotency key로 중복 요청을 처리한다.
  - Controller도 같은 정책을 다시 검사한다(409 코드).
- **게시 요청**:
  - `CONTROLLER_PUBLISH_ENABLED=false`(기본값)이면 `PUBLISH_DISABLED`로 거부된다.
  - Publisher의 `PUBLISHER_PUBLISH_BACKEND`는 기본 `disabled`이고, 테스트에서는 `mock`을 쓴다. `github`는 이번 단계에서 설정 자체가 거부된다.
- **중복 방지**: 승인은 원자적으로 소모되고, 리뷰당 게시 기록은 하나뿐이다(unique index). Publisher 저널도 이미 게시된 리뷰는 다시 push하지 않는다.

### GitHub App (Mock으로만 검증)
- **인증**: App ID, Installation ID, PEM(Docker secret)으로 App JWT를 만든다. 설치 토큰은 **저장소 하나로 범위를 좁혀** 발급한다.
  - 읽기: `metadata:read`, `contents:read`
  - 쓰기: 여기에 `contents:write`, `pull_requests:write`를 더함
- **토큰 관리**: 메모리에만 캐시하고, 만료 5분 전에 갱신한다.
- **요청 처리**:
  - 허용 목록에 없는 저장소는 GitHub에 요청하기 전에 거부한다.
  - 5xx 응답은 재시도한다.
  - rate limit에 걸리면 기다린다(상한 있음).
- **감사 로그**: `github-audit.jsonl`에 토큰 발급, 요청, push를 기록한다. 토큰 값은 남기지 않는다.
- **Writer**: 검증 저장소의 커밋 객체를 그대로 `personal-ai/<task>`로 push하고 draft PR을 연다.
  - 자격 증명은 git 프로세스 환경의 extraHeader로만 전달한다. URL, 설정, 로그에는 남지 않는다.
  - force push는 하지 않는다. 같은 커밋을 다시 요청하면 아무것도 하지 않는다(멱등).

### 실환경 시나리오
```powershell
node services/github-publisher/scripts/e2e-policy.mjs <taskId> state tests dry-run authorize dry-run publish
```
