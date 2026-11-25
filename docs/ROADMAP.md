# Personal AI OS — Roadmap

상태 표기: ✅ 완료(검증됨) · 🟡 부분 완료 · ⬜ 미착수. 완료는 실제 Docker 환경에서 검증한 경우에만 표시합니다.
마지막 갱신: 2026-11-25 (Codex 작업 A·B·C 합쳐 배포: Learning L3·플래너 연결, Kelly 학습 도구·broker 인증, 매일 밤 지식 정리·활동·OCR·받아쓰기, Next.js 16.4.6)

**진행 요약** (✅ 1 · 🟡 0.5 · ⬜ 0으로 센 대략값)

| 트랙 | 절 | 진행 | 남은 큰 일 |
|---|---|---|---|
| 코딩 자동화 | 1~15 | 약 90% (✅ 17 · 🟡 2 · ⬜ 1) | CI 결과 확인(10), 실제 프로젝트 저장소로 게시 확대(15), Hermes 보안 마무리(5, Codex) |
| AI Learning OS | 17 | 약 90% (L0~L3 ✅ · L4 🟡) | L4-02 외부 자료, L4-03 프로젝트 연결, L4-04 퀘스트·음성(선택), 실제 AI 호출 확인 |
| 개인 비서·Kelly | 18~19 | 약 89% (✅ 15 · 🟡 2 · ⬜ 1) | 강의 받아쓰기 모델(주인), 기말 계획(주인), 할 일 확인(나중) |
| Service Map | 20 | 완료 | (서비스 15개, 연결 23개, 경고 0) |

```text
사용자 ─ Telegram/hermes chat ─▶ Hermes ─▶ hermes-broker ─▶ Controller ◀─ claude-worker / codex-worker
                                                              │
                                     Project Registry ─ GitHub API (읽기)   repo-sync ─▶ repo-cache (읽기 전용 미러)
```

---

## 1. Task Controller MVP ✅

- **목표**: 작업 등록·배정·취소·상태·결과 저장. pull 방식, Docker 제어 없음.
- **구현 상태**: NestJS + SQLite(named volume), admin/worker 토큰, lease와 만료 처리, 상태 전환 CAS.
- **완료 조건**: 작업 등록 → Worker claim → complete/fail/cancel-ack, 재시작 후 상태 유지.
- **검증 근거**: Controller 테스트(현재 83개), `services/controller/scripts/verify.ps1`, 재생성 후 작업 유지 확인.
- **남은 문제**: Worker presence가 메모리에만 있음. 승인(approval) 상태 없음.
- **다음 의존 작업**: 8 (Push 승인).

## 2. Claude Worker ✅

- **목표**: Controller 작업을 Claude Code로 자동 실행하고 결과를 보고.
- **구현 상태**: polling 클라이언트, 작업별 worktree와 브랜치, 결과 커밋, heartbeat·취소·재시작 복구, 제한된 권한(`--restricted`).
- **완료 조건**: 실제 작업 생성 → 브랜치 커밋 → completed.
- **검증 근거**: Worker 테스트 59개, `verify-worker.ps1 -Agent claude` 10/10, 실제 Claude 작업 다수(예: `57934196-…`).
- **남은 문제**: claude-worker 이미지는 Codex 단계 이전 빌드(공통 출력 버퍼 개선 미반영). 다음 재빌드 때 반영.
- **다음 의존 작업**: 7.

## 3. Codex Worker ✅

- **목표**: 같은 공통 코드로 Codex CLI 실행.
- **구현 상태**: CodexRunner(JSONL), bubblewrap 샌드박스용 seccomp 프로필, `~/.codex/tmp` tmpfs.
- **완료 조건**: 실제 작업 성공·취소, 샌드박스 탈출 차단.
- **검증 근거**: `verify-worker.ps1 -Agent codex` 13/13, 샌드박스 프로브 42/42, 실제 취소 테스트(`50df693c-…`).
- **남은 문제**: seccomp에서 user namespace 허용(커널 공격 면 증가). Codex는 git 명령 사용 불가(설계상).
- **다음 의존 작업**: 7.

## 4. Hermes ↔ Controller 연동 ✅

- **목표**: 자연어로 작업 위임, 상태·결과 보고.
- **구현 상태**: delegator 역할(자기 작업만), Idempotency-Key, Hermes 플러그인 도구 `personal_ai_task`, Skill(읽기 전용).
- **완료 조건**: Hermes 대화 → 등록 → Worker 실행 → 결과 보고.
- **검증 근거**: 실제 Hermes 대화로 Claude 작업 등록·대기·결과 보고(`57934196-…`), Codex 등록 후 실행 중 취소(`50df693c-…`), 미등록 프로젝트 거부, 작업 목록 조회.
- **남은 문제**: 행동 품질은 LLM(gemini-3.5-flash-lite)에 따라 달라짐. 보고문은 `userReport`로 고정해 보완.
- **다음 의존 작업**: 13 (Dashboard).

## 5. Phase A — Hermes 위임 보안 강화 🟡 (2026-11-25: broker 호출자 인증 필수, Hermes 설정 점검 `configure-hermes --check` 추가. 남은 것: 정기 점검 등록과 레거시 `secrets/hermes.controller.env` 삭제 — 주인 결정)

- **목표**: 코딩 위임은 반드시 Controller 경유, 직접 코딩·시스템 제어 최소화, 인증 정보를 LLM 실행 환경에서 분리.
- **구현 상태 (완료)**:
  - hermes-broker: delegator 토큰은 브로커 컨테이너에만 있음. Hermes 컨테이너에는 토큰이 없음.
  - 토큰 교체: Hermes에 노출됐던 토큰을 교체함.
  - Hermes 플랫폼(telegram/cli/cron)에서 `terminal`, `code_execution`, `file`, `computer_use`, `delegation` 제거.
  - `pre_tool_call` 가드(Controller 우회, 인증 파일 접근, 같은 이름 Skill 생성 차단).
  - 플러그인과 Skill은 읽기 전용 마운트. 충돌하는 내장 Skill 3개는 비활성화.
- **완료 조건**: Hermes에서 토큰을 얻을 경로가 없고, 위임 외 직접 코딩 수단이 없으며, 기존 대화 기능이 유지됨.
- **검증 근거**:
  - Hermes 컨테이너: `/run/secrets` 없음, 토큰 환경변수 0건, Controller 직접 호출 401, 브로커의 `/internal/*` 404.
  - 플러그인 디렉터리 읽기 전용, 플러그인 상태 차이는 `personal-ai-controller` 1건뿐.
  - Hermes 대화 4회로 등록, 조회, 결과, 취소, 미등록 프로젝트 거부를 확인하고, `docker ps` 시도는 "도구 없음"으로 처리됨.
  - 토큰 값 노출 0건(로그, 파일, 대화 기록).
  - 테스트: 플러그인·클라이언트 31개, 브로커 6개.
- **남은 문제 (권장안)**:
  - 브로커는 호출자를 인증하지 않음(Hermes 컨테이너 안의 무엇이든 delegator 권한으로 호출 가능). 장기적으로는 Hermes 게이트웨이와 도구 실행 프로세스를 분리(별도 UID 또는 컨테이너)하고, 브로커가 게이트웨이 전용 자격을 확인하는 구조가 필요함.
  - 가드는 패턴 기반이라 우회 가능. 주 통제는 toolset 제거와 인증 정보 부재.
  - `config.yaml`은 Hermes가 쓸 수 있는 위치에 있음(파일 도구는 제거됨). 설정 무결성 점검(`configure-hermes.mjs --check`)을 정기 실행 권장.
  - 레거시 `secrets/hermes.controller.env`(현재 유효한 admin 토큰 사본, 미사용) 수동 삭제 필요.
- **다음 의존 작업**: 8 (승인 흐름은 브로커가 아닌 사용자 승인 채널 필요).

## 6. Phase B — GitHub Repository Registry MVP ✅

- **목표**: GitHub 프로젝트를 중앙 Registry에서 관리하고 저장소 정보를 안전하게 조회.
- **구현 상태**:
  - `projects` 테이블(v3)과 env 시드 호환.
  - API: `GET/POST/PATCH /projects`, `/projects/:id/status`, `GET /github/repositories`, `GET /internal/projects`.
  - GitHub REST 어댑터: 페이지네이션, rate limit, 인증 인터페이스.
  - repo-sync: bare 미러, checkout·hook 없음.
- **검증 근거**:
  - 실제 `octocat` Discovery, `octocat/Hello-World` 등록과 동기화.
  - 테스트: Controller 83개, repo-sync 6개.
- **남은 문제**:
  - 인증된 Discovery와 private 저장소는 미검증(토큰 미설정).
  - 동기화는 운영자 스크립트(`sync-project.ps1`)로 실행하며, 자동 주기 동기화는 없음.
- **다음 의존 작업**: 14 (Private 읽기 인증).

## 7. Phase C — Registry ↔ Coding Worker 연결 ✅

- **목표**: Registry에 등록된 공개 GitHub 프로젝트를 Claude/Codex Worker가 독립 작업 공간에서 수정하고 결과를 보고.
- **구현 상태**:
  - **Registry 기준 판단**: Worker는 작업마다 `GET /internal/projects`(worker 토큰)로 활성 여부·allowedAgents·allowCodeChanges·동기화 상태를 확인.
  - **fail-closed**: 조회에 실패하면 실행하지 않고 failed로 보고.
  - **환경변수 역할 축소**: `WORKER_PROJECTS`/`WORKER_WRITABLE_PROJECTS`는 미설정이 기본이며, 설정하면 추가 제한으로만 동작.
  - **캐시 연결**: `repo-cache` 볼륨을 두 Worker에 `/repo-cache`로 **읽기 전용** 마운트. 쓰기는 repo-sync만.
  - **GitHub 프로젝트 작업 흐름**:
    - 캐시 검증: 캐시 루트 안의 경로인지, bare 저장소인지, 크기 제한(`WORKER_MAX_REPO_BYTES`, 기본 1GiB) 이내인지.
    - Worker 전용 저장소 `/workspace/repos/<id>.git`로 `file://` fetch(객체 복사, alternates·hardlink 없음).
    - 원격 브랜치는 `refs/remotes/origin/*`에만 받으므로 작업 브랜치가 덮이지 않음.
    - Registry의 `cachedHeadSha`로 `.worktrees/<taskId>`에 worktree 생성 → 브랜치 `<agent>/task-<id>`에 커밋.
  - **악성 콘텐츠 대비**: `core.hooksPath=/dev/null`, `core.symlinks=false`(symlink는 일반 파일로 체크아웃), submodule 미초기화, fsck, `GIT_ALLOW_PROTOCOL=file`, 전역·시스템 git 설정 무시. symlink·submodule 개수는 보고서 `workspace.notes`에 기록.
  - **거부 조건**: 동기화되지 않은 프로젝트, 캐시에 없는 커밋, 크기 초과, 비활성 프로젝트.
  - **Controller 변경**: worker view에서 remote URL을 제거하고 `syncStatus` 추가. Worker는 Git URL을 받지 않음.
- **완료 조건**: Hermes 위임 → Worker가 GitHub 프로젝트의 독립 작업 공간에서 수정·커밋 → completed. 기본 브랜치, 캐시, 원격 변경 없음.
- **검증 근거 (2026-10-24, 실제 Docker)**:
  - Hermes 대화로 Claude에 `hello-world` 작업 위임 `d8bc0ec1-…` → `README.md` 추가. 기준 `7fd1a60`, 커밋 `7c27c66` on `claude/task-d8bc0ec1-…`.
  - Codex 작업 `171eeb27-…` → `CONTRIBUTING.md`, 커밋 `a8763a4` on `codex/task-171eeb27-…`.
  - 두 Worker의 저장소에는 서로의 브랜치가 없음. 캐시 refs는 변경 전과 동일. GitHub 원격 master `7fd1a60`, 브랜치 3개 그대로(task 브랜치 0개).
  - Worker 재시작 없이 프로젝트 활성화·비활성화가 반영됨. 미동기화 프로젝트 `spoon-knife`는 CLI 실행 없이 거부.
  - sandbox 회귀 작업 `738fa96a-…` completed.
  - 테스트: Worker 69개(Linux 69/69, Registry 통합 5개와 GitHub 캐시 작업 공간 5개 포함), Controller 83개, `verify-worker` Claude 10/10, Codex 13/13(샌드박스 42/42).
- **디스크 비용 (측정값, Hello-World 기준)**:
  - 캐시 68KB, Worker별 독립 저장소 124KB(객체 복사본 + worktree 메타데이터), worktree당 체크아웃 4KB.
  - `--shared`(alternates)를 쓰면 Worker 저장소가 수 KB로 줄지만, 캐시가 강제 갱신·gc되면 이미 만든 작업 커밋이 깨질 수 있어 채택하지 않음.
  - 독립 저장소는 Worker당 한 벌만 두고 작업마다 worktree를 만들므로, 작업 수가 늘어도 체크아웃 크기만 늘어남. 첫 fetch는 저장소 전체 크기만큼 걸리고 이후는 증분.
- **남은 문제**:
  - Worker 저장소와 worktree를 정리하는 기능 없음(작업물 보존이 우선).
  - 동기화 상태는 Registry 값을 신뢰함. 캐시가 Registry보다 오래되면 "커밋 없음"으로 거부.
  - symlink를 일반 파일로 바꾸면 symlink에 의존하는 프로젝트는 동작이 달라질 수 있음(의도된 제한).
  - Codex는 git 메타데이터를 읽을 수 없음(기존과 같음).
- **다음 의존 작업**: 8, 14 (Phase D에서 일부 해결).

## 8. Git Diff 검토와 Push 승인 ✅ (2026-11-24: 리뷰 승인 → 테스트 통과 → dry-run → 별도 게시 승인 후에만 push. sandbox에서 실제 게시)

- **목표**: 작업 브랜치 diff를 사용자에게 보여 주고 명시적 승인 후에만 push.
- **확장 지점**:
  - Controller `task-state.ts`에 `awaiting_approval`/`approved`/`rejected` 상태 추가.
  - `GET /tasks/:id/diff`(Worker 또는 repo 서비스가 생성).
  - push는 별도 서비스(예: repo-sync 확장, 쓰기 권한 deploy key/GitHub App)만 수행. Hermes·코딩 에이전트에는 권한을 주지 않음.
- **완료 조건**: 승인 없이는 push 불가를 테스트로 증명.
- **다음 의존 작업**: 9.

## 9. Pull Request 생성 ✅ (2026-11-24: GitHub App이 draft PR을 연다. dydgh2011/personal-ai-sandbox#1, PR 본문에 AI 흔적 없음)

- **목표**: 승인된 브랜치로 PR 생성.
- **확장 지점**: `GitHubCredentials`에 GitHub App 설치 토큰 구현(`github-credentials.ts`). PR 생성은 쓰기 권한이 있는 별도 서비스에서만.
- **다음 의존 작업**: 10.

## 10. CI 결과 확인 ⬜

- **목표**: PR/브랜치의 check run 결과를 Registry 상태와 Hermes 보고에 반영.
- **확장 지점**: `GitHubClient`에 checks API 읽기 추가. `userReport`의 "테스트" 줄을 실제 결과로 대체(보고된 경우에만).

## 11. 사용자 Git 작성 스타일 분석과 Commit Author 설정 ✅ (2026-11-24: POLICY B 변경 — 커밋 author·committer = 주인, AI 흔적이 있으면 게시 차단. GitHub에서 계정 연결 확인)

- **목표**: 사용자의 커밋 메시지 스타일 반영, 작성자 정보 설정.
- **확장 지점**: Registry 프로젝트 필드 추가(`commitAuthor`, `commitStyle`). Worker `workspace.ts`의 `GIT_IDENTITY`를 프로젝트 설정에서 받기.

## 12. 프로젝트별 AI 코딩 규칙 ✅ (2026-11-24: 규칙은 프롬프트에, 금지 경로는 Worker 코드에서 검사. Controller migration v7)

- **목표**: 프로젝트마다 에이전트 지침(예: 코딩 규칙, 금지 경로)을 관리.
- **확장 지점**: Registry에 `agentInstructions` 필드 추가. Runner의 시스템 프롬프트(`UNATTENDED_PROMPT`)에 병합.

## 13. Dashboard에서 프로젝트 선택 ✅ (2026-11-24: 프로젝트 상세에서 규칙·금지 경로·스타일·작성자 편집, CSRF·감사 기록)

- **목표**: 관리 화면에서 프로젝트와 작업 관리.
- **확장 지점**: 기존 admin API(`/projects`, `/tasks`, `/github/repositories`) 재사용. Dashboard 전용 토큰/역할 추가 권장.

## 14. Phase D — Private Repository 읽기 전용 연동 ✅ (2026-11-24: 실제 비공개 저장소로 discovery·토큰 동기화·worker export 확인)

- **목표**: 선택한 Private 저장소를 읽기 전용으로 동기화하고, 허용된 Worker만 독립 작업 공간에서 사용.
- **구현 상태**:
  - **인증**: Fine-grained PAT 파일 `secrets/github-readonly.token`을 선택적 overlay `compose.github.yaml`의 Docker secret으로 **Controller와 repo-sync에만** 주입.
    - Controller는 메타데이터와 Discovery에 사용(`GitHubCredentials`/`TokenFileCredentials`).
    - repo-sync는 git fetch에 `http.<origin>/.extraHeader`로 사용하며, 이 설정은 git 프로세스 환경변수(`GIT_CONFIG_*`)로만 전달. URL, argv, 저장소 설정, 로그에는 남지 않음.
  - **익명 대체 없음**: `authMode=token` 프로젝트에 토큰이 없으면 `auth_required`, 거부된 토큰은 `auth_failed`, 접근이 철회되면 `not_found_or_no_access`.
  - **실패 상태 보존**: 실패 시 Registry `syncStatus=error`와 `lastSyncError`(코드 포함)를 남기고, 마지막으로 성공한 캐시는 유지. Worker는 error 상태 프로젝트를 거부.
  - **제한**: 저장소 크기(2GiB), 전체 캐시(20GiB), 단일 파일(100MB).
  - **기본 비활성**: 동기화해도 프로젝트는 활성화되지 않음(등록 기본값 `enabled: false`).
  - **수동 동기화 + 향후 자동화**: `sync-project.ps1 -ProjectId|-All`. repo-sync CLI(JSON 입출력)가 향후 cron이나 이벤트 실행기가 호출할 인터페이스.
  - **저장소별 파일 격리 (커널 수준, 마운트)**:
    - repo-sync가 에이전트별 export 볼륨(`repo-export-claude`, `repo-export-codex`)에 해당 에이전트가 쓸 수 있는 프로젝트만 독립 복사본으로 넣음.
    - 각 Worker는 자기 볼륨만 `/repo-cache`에 읽기 전용으로 마운트하고, 전체 캐시는 마운트하지 않음.
    - 비활성화나 allowedAgents 변경 후 `provision-exports.ps1`을 실행하면 해당 Worker 컨테이너에서 저장소가 사라짐.
  - **브로커 호출자 인증**: `X-Broker-Key`(compose secret). Hermes 플러그인만 읽으며, 키가 없으면 401(Controller에 전달하지 않음). 가드가 browser 도구의 `file:`·내부 서비스 접근을 차단.
  - **admin 토큰 교체**: 레거시 사본 `secrets/hermes.controller.env`는 무효(401).
- **검증 근거**:
  - Mock·로컬 인증 git 서버(`git http-backend`) 테스트: 토큰 있음, 토큰 없음, 만료·잘못된 토큰, 접근 철회, 크기 제한, 로그 정리, export 부여·회수(repo-sync 15/15, Linux).
  - 실제 Docker:
    - Codex 권한 회수 → Codex 컨테이너에서 저장소가 사라짐(`not a git repository`) → 재부여 후 복구.
    - export 기반 실제 작업: Claude `aa29dc81-…`(Hermes 경유, 키 포함 브로커), Codex `58445bd8-…`.
    - Phase C 작업 브랜치 유지, 캐시·export·GitHub 브랜치 동일.
    - 키 없는 브로커 호출 401, 레거시 admin 토큰 401.
  - 테스트: broker 7/7, Hermes 연동 33/33.
- **미검증**: 실제 Private 저장소와 실제 PAT(토큰 없음). 실제 인증 성공은 보고하지 않음.
- **남은 문제**:
  - 회수는 Registry 변경 후 `provision-exports.ps1` 실행이 필요한 2단계 절차. Worker의 Registry 검사는 즉시 적용되지만, 파일 회수는 프로비저닝 시점에 일어남.
  - Worker 자신의 clone(`workspaces/<agent>/repos/<id>.git`, 과거 작업 브랜치 포함)은 회수 시 삭제되지 않음(작업물 보존).
  - 같은 에이전트의 Worker는 그 에이전트에 허용된 모든 프로젝트를 볼 수 있음(작업 단위 노출은 아님).
  - 브로커 키는 hermes 사용자로 실행되는 코드라면 읽을 수 있음(LLM 격리가 아님).
- **향후 권장 (작업 단위 격리)**: 프로젝트 또는 작업 단위 실행 컨테이너(`claude-worker-<project>`)에 해당 export만 마운트하거나, Docker API 권한을 가진 별도 provisioner가 작업마다 일회용 Worker를 띄우는 방식. 다만 Docker 소켓을 쓰는 구성요소가 새로 생기므로 별도 보안 검토가 필요함.

## 14-1. Phase D 실제 검증 시도 (2026-10-25) ✅ (2026-11-24 비공개 저장소로 완료)

- PAT 파일 존재 확인(fine-grained 형식). `compose.github.yaml`로 Controller에 적용한 뒤 인증된 Discovery 성공(rate limit 5000/h).
- **실제 Private 저장소 검증은 미완료**: 이 토큰으로 보이는 저장소 11개가 모두 public이며, 토큰의 저장소 선택에 private 저장소가 없음. 공개 저장소로 대신 검증하지 않음.
- Discovery의 `permissions`(push/admin=true)는 **계정 역할**이지 토큰 권한이 아님. 토큰이 Contents: Read-only인지는 GitHub 설정에서 사용자가 확인해야 함(쓰기 시도는 하지 않음).
- **권한 회수 후 남는 데이터**:
  - `repo-cache`(전체 미러): repo-sync만 접근, 명시적으로 삭제하지 않으면 남음.
  - `workspaces/<agent>/repos/<id>.git`·`.worktrees/<taskId>`: Worker가 접근할 수 있고, 과거 작업 결과로 보존됨.
  - 정리 정책(보존 기간, 승인·거부 후 정리)이 필요함.
- **외부 AI 전송 정책(제안)**: Private 저장소는 작업 전 worktree에서 민감 파일 패턴(.env, 키, 인증 정보 파일)을 검사해 발견 시 실행 거부. 현재 구현된 것은 diff 단계의 민감 파일 패치 제외, 그리고 Hermes(외부 모델)에 private 패치를 보내지 않는 정책.

## 14-2. Phase E-1 — Diff 검토와 승인 기록 ✅

- **구현**:
  - Worker가 커밋할 때 diff 데이터를 기록: base·head·tree SHA, 파일별 +/- 줄 수, 바이너리·민감 정보 표시, 200KB 이하 patch(바이너리·민감 파일 제외), 커밋 메시지.
  - Controller `reviews` 테이블(스키마 v4): 작업 하나와 head 커밋 하나에 행 하나. 상태는 awaiting_approval → approved / rejected, invalidated.
  - API: `GET /tasks/:id/diff`, `GET /tasks/:id/review`(admin, delegator는 자기 작업만), `POST /tasks/:id/approve|reject`(admin 전용, headSha 필수), `POST /internal/tasks/:id/observed-head`(작업을 가진 Worker, 다른 커밋이 관찰되면 승인 무효화).
  - 결정은 조건부 UPDATE 한 번으로 처리하므로 동시 요청 중 하나만 성공. Hermes에는 private 저장소 patch를 주지 않음. 브로커는 diff·review 조회만 중계. 플러그인 `review` 동작은 읽기 전용.
- **검증 근거**:
  - Controller 92/92, Worker 71/71(Linux), broker 7/7, Hermes 연동 34/34.
  - 실제 Codex 작업 `cbd2ede2-…`: diff가 Worker git과 일치(base 7fd1a60, head a638d09, tree 1b39935, +4/-0).
  - 승인 시나리오: 잘못된 SHA 409, Hermes·Worker 403, 브로커 404, admin 200, 재요청 409.
  - 이전 작업 `d8bc0ec1`: 승인 후 다른 head 관찰 → invalidated.
  - Controller 재생성 후 승인 이력 유지. GitHub 원격 변경 없음.
  - Hermes 대화에서 승인 요청을 거부함.
- **남은 문제**:
  - Worker가 브랜치 tip을 자동으로 다시 보고하는 기능이 없음. 무효화는 observed-head를 호출할 때만 일어나며, E-2 Publisher가 push 직전에 반드시 확인해야 함.
  - ~~승인자는 `admin` 하나로만 기록됨~~ → E-1.5에서 Dashboard 결정은 `dashboard:<user>`로 기록.
  - E-1 이전 작업은 줄 수와 patch가 없음.

## 14-3. Phase E-1.5 — Admin Dashboard MVP ✅ (2026-10-25)

- **구현**: `services/dashboard`(Next.js 15 App Router, React 19, TypeScript), `compose.dashboard.yaml`, 접속 주소 `http://127.0.0.1:8710`.
  - **BFF 구조**: 브라우저는 Dashboard 서버와만 통신. 서버가 전용 admin 토큰(`CONTROLLER_DASHBOARD_TOKEN`, Docker secret)으로 Controller를 호출하며, 토큰은 브라우저에 전달하지 않음.
  - **화면**:
    - Overview: Controller·DB·Hermes·Claude/Codex Worker 상태, 작업 수, 승인 대기 수, 응답 시간. 모르는 값은 unknown으로 표시하며, 자원 지표는 확장 지점만 둠.
    - Tasks: 목록, 필터, 상세, 취소.
    - Projects: 읽기 전용.
    - Code Reviews: 목록, 파일별 diff, 경고, 확인 단계, 승인·거부, 이력.
  - **인증**:
    - 단일 관리자 계정, scrypt 해시(secret 파일).
    - 서버 메모리 세션, HttpOnly + SameSite=Strict 쿠키, 유휴 30분·최대 8시간.
    - CSRF: 세션 토큰 + Origin/Sec-Fetch-Site 검사.
    - 로그인 제한: IP와 사용자별로 15분에 5회.
    - 감사 로그: `dashboard-data` 볼륨의 JSONL.
  - **Controller 변경**(스키마 변경 없음):
    - 전용 dashboard 토큰(역할은 admin, 이름은 `dashboard`).
    - `X-Approver` 헤더로 결정자를 `dashboard:<user>`로 기록.
    - `GET /reviews?status=`(admin 전용) 추가, `/tasks?projectId=` 필터 추가.
  - **네트워크**: `admin-internal` 네트워크(Controller와 Dashboard만 참여). Hermes와 Worker는 Dashboard 이름을 해석할 수 없음.
- **검증 근거**:
  - 테스트: Dashboard 단위 22/22, Controller 93/93.
  - E2E: 실제 컨테이너와 실제 Controller 대상 47/55 → 수정 후 46/46. 첫 실행의 실패 8건 중 6건은 미들웨어 상대 경로 리다이렉트로 인한 500, 2건은 테스트의 문자열 비교 문제였음.
  - 실제 승인: Codex `ff303fe6`(XSS 마크업이 들어간 diff, 이스케이프 확인).
  - 실제 거부: Claude `aa29dc81`.
  - 409 처리: 잘못된 SHA와 중복 결정 모두 409로 처리됨.
  - 모바일·데스크톱(390px/1280px): Edge 헤드리스로 7개 화면에서 가로 넘침 없음.
  - Dashboard 재생성 후 감사 로그 유지.
- **남은 문제**:
  - 세션이 메모리에 있어 Dashboard를 재시작하면 다시 로그인해야 함.
  - Docker 포트 매핑에서는 모든 접속의 IP가 게이트웨이 주소로 보여, IP 제한이 사실상 전역으로 동작함.
  - HTTPS가 아니므로 `DASHBOARD_COOKIE_SECURE=false`. Tailscale이나 리버스 프록시 뒤에서는 true로 바꿔야 함.
  - 승인 화면은 Worker가 보고한 diff를 보여 줄 뿐, git 객체를 직접 다시 검증하지 않음(아래 E-2 참조).

## 14-4. Phase E-2A — Secure GitHub Publisher (Dry-run) ✅ (2026-10-25)

- **구성**:
  - `services/github-publisher`: 독립 컨테이너. 비root, read-only rootfs, Docker 소켓 없음, GitHub 쓰기 자격 증명 없음.
  - Compose: `compose.publisher.yaml`.
  - 네트워크:
    - `publisher-internal`: Controller와 Publisher만 참여.
    - `publisher-egress`: GitHub API GET 요청 전용.
- **흐름**:
  1. Dashboard에서 "Validate / Dry-run"을 누르면 Controller `POST /tasks/:id/publication/dry-run`(admin, headSha 고정)으로 요청함.
  2. `publications` 테이블(스키마 v5)에 요청이 기록됨. 리뷰당 진행 중인 요청은 하나, 게시 기록도 하나만 허용(unique index).
  3. Publisher가 `POST /internal/publisher/claim`으로 요청을 가져가 검증함(lease 방식, 3회 실패 시 failed).
  4. 결과는 `/internal/publisher/publications/:id/result`로 보고하고, 자체 저널에도 남김.
  - Controller는 검증 도중 승인이 바뀌었으면 Publisher가 보낸 `ready`를 `failed`로 저장함.
- **아티팩트 전달**:
  - Worker가 커밋할 때 `git bundle`(base..`<agent>/task-<id>`, base는 필요 커밋)과 manifest를 에이전트별 볼륨에 기록함. Publisher는 이 볼륨을 읽기 전용으로 마운트함.
  - 신뢰 기준(base)은 repo-sync의 publisher 전용 export(allowCodeChanges 프로젝트만, `personal-ai.upstream` 표시)에서 가져옴.
  - Worker worktree, clone, 전체 캐시는 Publisher에 마운트하지 않음.
  - 이전 작업의 아티팩트는 `export-artifact` CLI로 만듦.
- **검증**: 17개 항목(`services/github-publisher/README.md`). 불완전한 리뷰(잘림, 민감 파일, 바이너리, patch 없음)는 차단하고, 테스트 미보고는 기본적으로 경고만 남김.
- **Dashboard 상태 표시**: Not approved / Approved / Validation pending / Ready to publish / Validation failed / (Published, PR created는 향후).
- **함께 진행한 보안 정비**:
  - Next.js 15.5.28 → 16.4.3. 15.x Maintenance LTS가 2026-10-21에 종료되었고, 10-14 보안 릴리스에 따라 React 19.1.1 → 19.3.1. `middleware` → `proxy`. npm audit 0건.
  - 로그인 제한: TCP peer 기준으로 IP를 판단하고(신뢰 프록시만 예외), 장치 쿠키로 로컬 잠금 공격을 막음.
- **검증 근거**:
  - 테스트: publisher 17/17, controller 99/99, worker 72/72, repo-sync 16/16, dashboard 29/29, dashboard E2E 46/46.
  - 실제 dry-run: `ff303fe6`, `cbd2ede2` → Ready to publish(17개 항목 통과). 미승인 409, 잘못된 head 409, 중복 409. 아티팩트 손상·누락 → Validation failed, 재생성 → Ready.
  - 재시작 후 이력과 저널 유지. GitHub 원격 변경 없음.
- **남은 문제**:
  - Private 저장소는 자격 증명 없이는 원격 상태를 확인할 수 없어 항상 차단됨(E-2B GitHub App 필요). Private 저장소 실환경 검증은 여전히 미완료.
  - Worker 볼륨은 해당 Worker 안에서 실행되는 에이전트도 쓸 수 있음. 내용은 승인된 SHA로 고정되어 있어 위조해도 통과하지 못하지만, 볼륨을 가득 채우는 등의 방해는 가능함.
  - SHA-1 충돌 공격에 대한 방어는 git의 SHA-1 collision detection에 의존함.

## 14-5. Phase E-2B — Publisher 정책 강제와 GitHub App 준비 ✅ (2026-10-26, 실제 게시는 비활성)

- **고정 정책**:
  - POLICY A: 테스트를 보고하지 않은 작업은 게시를 차단한다.
  - POLICY B: Worker의 Commit Author를 유지한다.
  - Publisher는 다른 설정값으로는 시작하지 않는다. Controller도 게시 승인 단계에서 같은 테스트 정책을 강제한다.
- **Test Validation**:
  - Controller v6에 `projects.test_commands`(관리자만 설정)와 `test_validations`를 추가했다.
  - 작업 완료 시 테스트를 자동 요청하고, Dashboard의 Run tests로도 요청할 수 있다.
  - 실행: 격리된 `test-runner` 컨테이너에서 uid 10001로 실행한다. 인터넷 없는 `test-internal` 네트워크를 쓰고, 결과는 HMAC으로 서명한다.
  - 판정: 실제 종료 코드 기준이다. 실패, 누락, 시간 초과는 fail-closed로 처리하고, 다른 커밋의 결과는 재사용하지 않는다.
- **Publisher preflight**: 12단계 순서로 검사하고 사유 코드를 남긴다(TEST_REPORT_MISSING … PUBLISH_APPROVAL_REQUIRED). Worker Author, Committer, 메시지가 바뀌지 않았는지도 확인한다.
- **게시 승인**(`publish_authorizations`):
  - 리뷰 승인과 별개의 기록이다.
  - 연결 정보: 승인자, Task, Review, Repository ID, head SHA, Test Validation ID, Dry-run.
  - 30분 뒤 만료되고, 한 번만 쓸 수 있으며, 멱등 키로 중복을 처리한다.
  - Dashboard에서는 확인 단계와 체크박스를 거쳐야 한다.
  - 실제 게시 요청은 `PUBLISH_DISABLED`로 거부된다.
- **GitHub App 모듈**:
  - 기능: JWT, 저장소 하나로 범위를 좁힌 설치 토큰, 캐시와 만료 처리, 허용 목록, 재시도와 rate limit, 감사 로그.
  - Writer: 기존 커밋 객체를 그대로 push하고 draft PR을 연다.
  - Mock API와 로컬 smart-HTTP git으로만 검증했다. App은 아직 설정하지 않았다.
- **보조 정비**:
  - Worker artifact와 repo-sync export를 0700으로 바꿔 sandbox 사용자가 읽을 수 없게 했다.
  - `request.txt`를 `.gitignore`에 추가했다.
- **검증 근거**:
  - 테스트: controller 108/108, test-runner 6/6(root, uid 전환 실제 수행), publisher 30/30, dashboard 29/29, worker 72/72, repo-sync 16/16, Dashboard E2E 46/46.
  - 실환경 정상 흐름(`ff303fe6`): 테스트 미보고 → TEST_REPORT_MISSING, 테스트 통과(exit 0/0) → eligible + PUBLISH_APPROVAL_REQUIRED, 게시 승인 → canPublish, 게시 → PUBLISH_DISABLED.
  - 실환경 실패 흐름:
    - exit 3 → TEST_FAILED
    - timeout → TEST_ABORTED
    - 명령 변경 → TEST_COMMANDS_CHANGED
    - 미승인 리뷰 → REVIEW_NOT_APPROVED
  - 테스트 프로세스 격리 probe(exit 0)와 재시작 후 기록 유지를 확인했다. GitHub 원격은 변경되지 않았다.
  - 배포 중 발견한 버그: 권한이 제한된 root에서 `copyFile`이 EPERM을 냈다. 시스템은 fail-closed로 동작했고(TEST_ABORTED), read+write 방식으로 수정했다.
- **남은 문제**:
  - 실제 GitHub App 연동과 실제 push는 하지 않았다.
  - Private 저장소 종단 검증은 아직 하지 않았다.
  - `secrets\` ACL이 과도하게 열려 있다.
  - Dashboard 초기 비밀번호가 평문 파일로 남아 있다.
  - 소스 대부분이 아직 커밋되지 않았다.
  - Test Runner는 네트워크가 없어서 의존성 설치(npm install 등)가 필요한 프로젝트 테스트는 아직 실행할 수 없다. 향후 사전 구성 이미지나 캐시가 필요하다.

## 15. Phase E 이후 (GitHub 승인 시스템) 🟡 (2026-11-24: GitHub App 실제 게시 켬, 허용 저장소는 sandbox 하나. 실제 프로젝트 저장소는 App 설치와 허용 목록 추가 후)

- **Phase E-2B 실제 게시(설계)**:
  - 게시 승인을 따로 받음. 저장소, 브랜치, 커밋 SHA, 파일 목록을 다시 보여 주고 명시적으로 승인받음.
  - 게시 직전에 E-2A 검증 전체를 다시 실행함.
  - `published` unique index와 Publisher 저널로 중복 게시를 막음.
  - GitHub App 설치 토큰을 저장소 1개 범위로, 짧은 수명으로 발급하고, 저장·로그·결과에 남기지 않음.
  - push 대상은 `personal-ai/<task>` 브랜치뿐이며 force push는 하지 않음. PR은 draft로 만들고 merge는 사람이 함.

- **Phase E-2 GitHub Publisher 설계**:
  - **실행 형태**: 독립 컨테이너. 쓰기 자격(GitHub App 설치 토큰, 저장소 단위, Contents write만)은 Publisher에만 있음.
  - **입력**: `approved` 리뷰(taskId, projectId, baseSha, headSha, headTree).
  - **독립 검증 (필수)**:
    - Dashboard·Controller·Worker 보고서에 표시된 값은 신뢰하지 않음.
    - Publisher는 신뢰할 수 있는 git 객체를 직접 읽어 확인함. 대상은 자신의 미러, 또는 repo-sync가 원격에서 받은 base와 Worker 브랜치에서 가져온 커밋.
    - 확인 항목:
      - `git rev-parse <branch>^{commit}` == 승인된 headSha
      - `git rev-parse <headSha>^{tree}` == 승인된 headTree
      - 승인된 baseSha가 원격 기본 브랜치에 실제로 있는 커밋인지
      - `git merge-base --is-ancestor <baseSha> <headSha>`
      - push할 커밋 범위(`baseSha..headSha`)의 파일 목록이 승인된 diff 목록과 같은지
    - 하나라도 다르면 push하지 않고, observed-head로 승인을 무효화함.
  - **push 전 검증**: Worker export·clone에서 해당 커밋을 받아 head SHA와 tree가 승인값과 같은지 확인. base가 원격 기본 브랜치의 조상인지 확인. 다르면 observed-head로 무효화하고 중단.
  - **push 방식**: 기본 브랜치에는 push하지 않음. `personal-ai/<task>` 브랜치로만 push하고 force push는 금지.
  - **PR 생성**: 승인 기록 ID를 본문에 남김. merge는 사람만.
  - **감사 로그**: 누가 무엇을 언제 push했는지 기록.

- **사용자 Git Commit 스타일 분석**: Registry 프로젝트에 `commitStyle`·`commitAuthor`. 최근 커밋 메시지를 읽기 전용으로 분석.
- **Code Review / Diff API**: `GET /tasks/:id/diff`(Worker나 repo 서비스가 작업 브랜치와 기준 커밋을 비교해 저장).
- **`awaiting_approval` 상태**: completed → awaiting_approval → approved/rejected. 승인 전에는 push 불가.
- **사용자 승인 후 Push**: 쓰기 권한을 가진 별도 서비스(GitHub App 설치 토큰, 저장소 단위)만 수행. Hermes, Worker, 코딩 에이전트에는 쓰기 권한이 없음.
- **Pull Request 생성**: 같은 서비스에서 수행하며 승인 기록과 연결.
- **GitHub App 기반 쓰기 권한**: `GitHubCredentials`에 App 구현을 추가하고, 읽기용과 쓰기용 자격을 분리.
- **Admin Dashboard 승인 화면**: ✅ E-1.5에서 구현(14-3 참조).
- **Dashboard 후속 모듈**(`src/modules/registry.ts`에 항목과 라우트 폴더를 추가하는 방식, 런타임 플러그인 실행 없음):
  - Agent 관리, Skill/MCP/Plugin Registry, Memory Knowledge Graph, Personal Assistant, Finance, JARVIS Voice
  - Server Monitoring: `src/modules/resources.ts`의 provider로 연결하며, Docker 소켓은 쓰지 않음
  - GitHub Publisher 상태

## 16. 범위 밖 (후속)

Finance Agent, JARVIS TTS 연동, 자동 배포, 다중 Agent 병렬 프로젝트 수정 — ⬜ 미착수.
(학습 기능은 17절 AI Learning OS로 이동했다. Personal Assistant와 Memory(지식 저장소)는 19절로 옮겨 진행 중이다. Learning OS는 자체 선수지식 DAG만 소유하며 지식 저장소와 섞지 않는다.)

## 17. AI Learning OS (L0~L4) 🟡 (L0 ✅ · L1 ✅ 2026-11-04 · L2 ✅ 2026-11-24, AI 실제 호출은 미설정 · L3~L4 미착수)

개발 프로젝트 로드맵(이 문서, 개발 일정·기능 단계)과 **학습 로드맵(Learning 데이터: 지식·선수지식·숙련도)은 별도 데이터 모델**로 관리한다. 이 절은 학습 기능을 *만드는* 개발 작업만 다루며, 학습 로드맵 자체는 Learning Service DB에 저장한다.
설계 근거: `Personal_AI_OS_Learning_Expansion/docs/learning-os/` (01~09) 및 `L0_INVENTORY_AND_DESIGN.md`.

- **보존 정책**: 아래 정책은 Learning OS를 추가해도 바뀌지 않는다.
  - Hermes는 관리 도구로만 쓴다.
  - Worker의 Docker·GitHub 권한 경계를 유지한다.
  - 테스트 미보고 작업은 게시를 차단한다(POLICY A).
  - Worker Author를 보존한다(POLICY B).
  - 실제 게시는 비활성 상태를 유지한다.
  - Dashboard 로그인과 CSRF 보호를 유지한다.
  - 학습 평가 결과를 GitHub 게시 승인으로 쓰지 않는다.
- **L0 — 조사·통합 설계** 🟡
  - L0-01 인벤토리: ✅ 실제 코드, Compose, DB, 인증, Provider, Memory 존재 여부를 확인했다.
    - Learning, Knowledge Graph, Quest 코드는 없다.
    - Hermes 내장 memory와 kanban은 Hermes 전용 기능이며 Personal AI의 Graph가 아니다.
  - L0-02 설계 승인: ✅ 2026-11-04. D1~D9 권장안을 모두 승인받았다. AI 키, 월 상한, 모델은 사용자가 나중에 직접 설정한다.
- **L1 — 학습 Domain·Idea·Roadmap Draft (P0)** ✅ (L1-04는 Mock으로만 검증, 실제 AI 호출은 설정 후 확인)

  | ID | 작업 | 선행 | 수용 기준(검증) |
  |---|---|---|---|
  | L1-01 | `services/learning` 골격 (NestJS + better-sqlite3, 자체 migration, `learning-data` 볼륨, `compose.learning.yaml`, `learning-internal` 네트워크) | L0-02 | health, migration v1, 비root·read-only, Dashboard 전용 토큰 인증, 기존 Dashboard 로그인·CSRF 회귀 테스트 통과 |
  | L1-02 | Domain + Idea CRUD | L1-01 | 생성·수정·보관, 계층 순환 거부, 아이디어는 자동으로 일정에 편성되지 않음, 컨테이너 재생성 후 유지 |
  | L1-03 | Goal / Roadmap / 불변 RoadmapVersion / 선수지식 DAG | L1-01 | 승인된 버전은 불변, stale base는 409, 직접·간접 순환은 422, 복원 시 새 버전 생성 |
  | L1-04 | AI Roadmap Draft (Provider adapter, 월 예산, 스키마 검증, 비용 기록) | L1-03 | 잘못된 JSON은 Draft로 거부되고 원본 불변, 타임아웃·429 처리, 승인 전 현행 버전 불변 |
  | L1-05 | Dashboard `/learning` (Overview, Idea Inbox, Explorer, Draft diff·승인·복원) | L1-02~04 | 데스크톱과 390px 모바일, 실제 브라우저 CSRF 테스트, 상태 배지(draft, awaiting approval, conflict 등) |
  | L1-06 | JSON Export, 백업·복원 스크립트, E2E | L1-05 | export round-trip, 백업에서 복원, 재로그인·재접속 후 동일 |

  - **구현**:
    - `services/learning`: NestJS 12, better-sqlite3, 스키마 v1. 비root, read-only, cap_drop ALL. 네트워크는 `learning-internal`(Dashboard 전용)과 `learning-egress`(AI 제공자용).
    - Dashboard: `/learning`(Overview), `/learning/ideas`, `/learning/roadmaps/[id]`(Explorer, diff, 승인, 복원), JSON export.
    - 스크립트: `init-secrets`, `backup`(볼륨 밖 `data/backups/learning`, 최근 14개 보관), `restore`.
  - **검증 결과**:
    - 테스트: learning 19/19(unit + e2e: T01, T02, T03, T05, T06, T07, budget, timeout, export round-trip), dashboard 단위 34/34, Dashboard E2E 49/49, Learning 실제 브라우저(Edge) 33/33.
    - 실환경: 컨테이너 재생성 후 데이터 유지, 백업과 복원 왕복 확인(테스트 후 빈 DB로 되돌림).
    - 격리: Worker, Publisher, Test Runner, Controller, Hermes는 `learning` 이름을 해석할 수 없다.
  - **미검증**: 실제 Gemini 호출. 키, 모델, 월 상한, 단가가 설정되기 전까지는 `PROVIDER_NOT_CONFIGURED`로 거부된다(정상 동작).

- **L2 — Milestone·과제·평가·숙련도 (P1)** ✅ (2026-11-24, schema v2. 학습 46·Dashboard 133 테스트, 실환경 API·401 확인. 새 `/learning` 화면. 코드 과제 실행은 없음, 실제 AI 평가·브라우저는 미확인)
  - L2-01 Milestone, Rubric, Deadline: user-fixed와 AI-suggested 일정을 구분한다.
  - L2-02 Assignment, Submission: 제출물은 불변 revision이며 업로드는 안전하게 처리한다.
  - L2-03 Evaluation, Evidence: 근거, 신뢰도, 한계를 기록하고, 평가가 실패해도 제출물을 보존한다.
    - 코드 과제 실행은 기존 Test Runner나 Publisher의 권한이나 키를 재사용하지 않는다. 별도 격리 실행기를 쓰며, 그 방식은 별도로 결정한다.
  - L2-04 SkillMastery, Gap: 자가평가와 검증된 수준(0~4)을 분리해 저장한다.
- **L3 — 일정·복습 (P2)** ✅ (2026-11-25: Toronto 일·주 계획, 가용 시간, 미완료 이월, 복습·재검증, `/learning/planner`, 플래너 시안 연동 — 승인은 플래너에서. schema v3, 실환경에서 learning→planner 가용 시간 조회 200)
  - L3-01 가용 시간과 일정 규칙: 결정적 계산을 하며 timezone을 명시한다.
  - L3-02 일·주 Planner: 미완료 과제를 이월하고, 사용자가 고정한 Deadline은 승인 없이 바꾸지 않는다.
  - L3-03 복습 일정: 오래된 숙련도를 재검증하도록 일정을 잡는다.
- **L4 — 연동 (P3)** 🟡 (L4-01 Kelly `personal_ai_learning` 도구 ✅ 2026-11-25: broker 허용 목록의 조회·시안만, 실환경 호출 200. L4-02~04 남음)
  - L4-01 Hermes `personal_ai_learning` 도구: broker allowlist를 쓰며 query와 propose만 허용한다. 직접 쓰기, 셸, 임의 HTTP는 막는다.
  - L4-02 외부 자료와 로드맵 가져오기: provenance를 기록하고, 가져온 자료는 신뢰하지 않는 입력으로 취급한다.
  - L4-03 Project Registry 연결: 개발 로드맵과 상태를 섞지 않고 참조로만 연결한다.
  - L4-04 Quest, 음성 어댑터: 선택 사항이며, 실패해도 핵심 기능에 영향이 없어야 한다.
- **단계 게이트**: L0 승인 전에는 구현하지 않는다. 각 단계는 실제 Docker 검증과 테스트 근거가 있어야 ✅로 표시한다. `S/M/L`은 난이도이지 진행률이 아니다.

## 18. AI 사용량 그래프 (Usage 화면) ✅ (2026-11-24, 커밋 8cdd56f)

- 구현: 게이트웨이 `GET /usage/series`(읽기 전용 집계), Dashboard `/ai-usage` 그래프 화면. 테스트 게이트웨이 22, Dashboard 47.
- 실환경: 실제 `gateway.db`에서 그래프 합계가 `/usage` 일별 합계와 같음(11/23 84회, 11/24 70회, 호출자·별칭·모델 모두), 빈 기간 정상, 잘못된 단위 400. 사용자가 화면 확인, 피드백은 쓰면서 계속 받는다.
- 주의: 게이트웨이와 Dashboard 이미지를 동시에 빌드하면 게이트웨이 테스트가 시간 초과로 실패할 수 있다. 하나씩 빌드한다.

아래는 처음 계획이다.

Claude, ChatGPT의 사용량 화면처럼 AI 사용량의 **변화**를 그래프로 본다. 지금 Dashboard `/ai-usage`는 오늘 숫자와 일별 합계 표만 보여 준다(읽기 전용).

- **데이터**: 새로 모으지 않는다. LLM 게이트웨이 `gateway.db`의 `calls` 표에 호출마다 시각, 호출자(hermes, school, learning, notifier), 별칭(kelly, kelly-aux, batch), 제공자·모델, 입력·캐시·출력 토큰, 비용, 지연 시간, 오류가 이미 남는다.
- **보여줄 것**
  - 기간 선택(오늘 / 7일 / 30일), 시간·일 단위 막대·선 그래프
  - 토큰: 입력 / 캐시된 입력 / 출력을 나눠서, 호출자·모델별로 쌓아 보기
  - 무료 한도: 묶음별 일일 사용률 추이와 80% 차단선
  - 유료: 일별 지출과 일일 상한($0.30), 승인한 날 표시
  - Kelly 대화 크기: 호출당 입력 토큰 분포(고정 비용 약 1만 1천~1만 4천, 압축 기준 4만 표시), 메시지 하나당 호출 수
  - 오류·429·지연 시간 추이
- **방식**
  - 게이트웨이에 읽기 전용 집계 API(예: `GET /usage/series?from=&to=&bucket=hour|day&by=client|alias|model`)를 추가한다. 원본 행은 넘기지 않는다.
  - Dashboard는 기존 로그인·CSRF를 그대로 쓰고, 서버에서 받아 그린다.
  - 프롬프트·응답 본문은 게이트웨이에 저장하지 않는 원칙을 유지한다(토큰 수만).
  - 데스크톱과 390px 모바일, 라이트·다크 모두 확인한다.
- **수용 기준**: 실제 `gateway.db` 기준으로 그래프 합계가 `/usage` 일별 합계와 같다. 빈 기간과 게이트웨이 장애 때 화면이 깨지지 않는다. 실제 브라우저로 확인한다.

## 19. 개인 비서·Kelly 🟡 (2026-11-25 기준 약 89%)

Discord에서 Kelly(Hermes)가 일정, 할 일, 학교, 공부를 돕는다. 계획 결정은 2026-11-21(Discord, 플래너 서비스, Google Calendar, 그래프 화면, LLM 게이트웨이).
원칙: AI는 정해진 도구와 코드 흐름으로만 움직이고(임의 HTTP 없음), 사실은 코드가 모아 붙이고 AI는 말로 옮긴다.

| 상태 | 항목 | 서비스·위치 | 커밋 |
|---|---|---|---|
| ✅ | Discord Kelly, `/new`·`/reset`로 대화 비우기, Discord 전용 도구·스킬 축소 | `hermes`, `data/hermes/config.yaml` | 0fb0781 이후 |
| ✅ | 플래너(할 일, 일정), Kelly 전용 Google 캘린더, 23시·5시 브리핑, 15분 전 알림 | `services/planner`, `services/notifier` | 0fb0781 |
| ✅ | 첨부 문서 읽기(PDF 등) | `hermes-integration/plugins/personal-ai-controller` | 0fb0781 |
| ✅ | 지식 저장소 4층(원본, 활동, 페이지·사실, 프로필), 대량 가져오기 | `services/knowledge`, `services/knowledge-importer` | 922b603 |
| ✅ | LLM 게이트웨이: 무료 경로 우선, 유료는 승인제, 호출별 토큰 기록(LiteLLM 대신 직접 만듦) | `services/llm-gateway` | db1b257 |
| ✅ | 학교 연결: Quercus, Piazza, UofT 메일 규칙, CSC207 사이트 | `services/school` | db1b257, 8b45b23 |
| ✅ | 학교 자료 수집, 다른 AI에 줄 공부 zip | `services/school` | 8b45b23 |
| ✅ | Kelly 답변: 과목 기록·다가오는 일정을 코드가 붙임, 답에서 빠진 사실을 코드가 덧붙임, 토론토 시간 기준 | `plugins/personal-ai-knowledge` | 6e47f40 |
| ✅ | Discord "입력 중" 원인 제거(도구 진행 표시 끔) | `data/hermes/config.yaml` | 설정만 |
| 🟡 | 기말 대비: 자료·과목 정리 완료, Kelly와 공부 계획 세우기는 확인 전 | 지식 저장소 | — |
| ✅ | 지식 그래프 화면: Obsidian 그래프 뷰처럼 페이지·사실·연결을 보고, 필요하면 직접 고치기(아래 설명). Dashboard `/knowledge` 구현, 실환경 API·격리 확인, 사용자 브라우저 확인(2026-11-24) | `dashboard`, `knowledge` | f0c9676 + 작업 중 |
| ✅ | AI 사용량 그래프(18절) | `dashboard`, `llm-gateway` | 8cdd56f |
| ✅ | 사실에 종류 붙이기(점수, 실수, 자료): 코드가 키워드 대신 종류로 고름. migration 3 적용·Kelly 반영 완료, 기존 사실 62개에 종류 채우기는 기존 사실 62개에 종류 채움(백업 후, 변경 기록 62건) | `knowledge`, `personal-ai-knowledge` | f515b3c |
| ✅ | Learning ↔ 플래너 연결(학습 블록을 플래너 시안으로, 승인 후 할 일·Kelly 일정) | `learning`, `planner` | 2026-11-25 |
| ✅ | 매일 밤 지식 정리(Toronto 00:15 일간·주간), 보고한 활동·`사실 [문서]:` 기록(원본 연결) | `knowledge` | 2026-11-25 |
| 🟡 | 이미지 OCR·강의 음성/영상 받아쓰기(네트워크 없는 `knowledge-media`). OCR 동작 준비됨, 받아쓰기는 모델 파일(주인) 필요, 실제 Discord 첨부로는 미확인 | `knowledge-media` | 2026-11-25 |
| ✅ | Learning 화면 다시 만들기(L2와 함께 새 `/learning`) | `dashboard` `/learning` | — |
| ⬜ | 할 일을 실제로 했는지 확인(나중 기능) | `planner` | — |

- **지식 그래프 보기·편집 화면** (2026-11-24 요청)
  - Obsidian 그래프 뷰처럼 페이지(과목, 사람, 습관 등)와 사실, 연결을 점과 선으로 본다. 종류·페이지 유형별 색, 검색, 확대·이동, 노드를 누르면 내용 패널.
  - 필요하면 직접 고친다: 사실 고치기·종류 바꾸기·보관, 페이지 제목·별칭, 연결 추가·삭제. 지우기 대신 보관을 기본으로 하고, 모든 변경은 지식 저장소의 변경 기록에 남는다(누가: dashboard).
  - 연결: Dashboard 전용 키(`secrets/knowledge-dashboard.key`)와 내부 전용 네트워크 `knowledge-dashboard`(두 서비스만). 허용: 그래프·문서·사실 읽기와 고치기 4가지. 원본, 검색, 회상, 프로필, 일반 쓰기, purge, 운영자 경로는 403(실환경 확인). 다른 서비스는 `knowledge` 이름을 찾지 못함(확인). 로그인·CSRF 그대로.
  - 그림: Cytoscape.js 3.34.4(힘 배치, 문서 크기 = 사실 수, 사실은 작은 점, 검색, 목록 보기). Service Map은 React Flow 12.12.1.
- **아직 사용자 확인 전**: Discord에서 "입력 중"이 사라지는지, 답 끝 📌 기록이 잘 보이는지, `/new` 동작.
- **수용 기준**: 다른 절과 같다. 실제 Docker에서 확인하고, Kelly에게 실제로 물어 답을 본 경우에만 ✅.

### 여러 세션 동시 작업 규칙

서비스가 컨테이너로 나뉘어 있어 **코드 작업은 나눠서 동시에** 할 수 있다. 다만 **실행 중인 스택은 하나**라 확인 단계는 한 번에 하나씩 한다.

- **동시에 해도 되는 것**: 각자 git worktree(별도 폴더·브랜치)에서 코드 수정, 단위 테스트, 이미지 빌드(태그를 겹치지 않게).
- **한 번에 하나만**: `docker compose ... up`, 서비스 재생성, DB 백업·정리, 운영자 접근 열기, Kelly에게 실제로 묻기.
  - Compose 프로젝트 이름은 폴더 이름(`personal_ai`)에서 온다. worktree 폴더에서 `up`을 하면 빈 볼륨으로 **두 번째 스택**이 생기고, 같은 포트가 부딪히며, Discord 봇이 두 개 붙는다.
  - `data/`, `secrets/`는 `D:\personal_ai`에만 있다(git에 없음).
- **같은 파일을 건드리는 작업은 같이 하지 않는다**: Dashboard(`services/dashboard`)는 그래프 화면, 사용량 그래프, Learning 화면이 함께 쓰므로 메뉴·레이아웃·`package.json`이 겹친다. 한 번에 하나씩 하거나 순서를 정한다.
- **추천 묶음**
  - 동시 가능: 사용량 그래프(`llm-gateway` + Dashboard) ∥ 사실 종류(`knowledge` + Kelly 플러그인) ∥ 코딩 자동화(`controller`, `github-publisher`).
  - 순서 필요: 사실 종류 → 지식 그래프 화면(종류별로 보여 주기 위해), 사용량 그래프 → Learning 화면(같은 Dashboard).

## 20. Service Map (서비스 지도) ✅ (2026-11-24, 1~3단계)

Docker 인프라 지도와 서비스 의존 지도를 합친 Dashboard 화면. 서비스마다 상태와 설명, 서비스 사이 연결, 연결마다 허용된 명령을 한 화면에서 본다.

- **결정**
  - 추적 도구(Grafana+Tempo, SigNoz, SkyWalking)는 쓰지 않는다. 실제 호출만 보여 주고 "허용된 것"은 모르며, 모든 서비스에 계측 코드를 넣어야 하고, 수집기가 모든 내부망에 붙어야 해서 네트워크 격리가 약해진다.
  - 그림은 React Flow(`@xyflow/react`) + `elkjs` 자동 배치. Cytoscape.js는 지식 그래프 화면에서 검토한다.
  - Dashboard는 Docker 소켓도, 다른 서비스 네트워크도 받지 않는다. 호스트 수집기가 쓴 스냅샷 파일을 읽기 전용으로 받는다.
- **1단계 — 정적 지도와 상태**
  - ✅ 수집기 `services/service-map/collect.mjs`: Compose 설정, 컨테이너 상태, 설명 파일(`catalog.mjs`)로 `data/service-map/service-map.json`을 만든다. 허용 목록 방식이라 환경 변수 값과 비밀은 들어가지 않는다. 테스트 8/8, 실제 스택에서 14개 서비스, 연결 20개, 닿는 쌍 30개 확인.
  - ✅ 1분마다 실행(Windows 작업 스케줄러 `PersonalAIServiceMap`, 2026-11-24 등록·확인). 배터리로 돌 때는 Windows 기본 설정 때문에 멈춘다.
  - ✅ Dashboard `/services` 화면: Knowledge와 같은 그래프(Cytoscape 공통 부품). 점 = 서비스(색 = 층, 크기 = 보기 기준: 연결 수 기본·메모리 한도, 기준은 SIZE_METRICS에 추가해 늘림), 테두리와 ! = 주의, 마름모 = 바깥 연결(기본 켬), 화살표 = 부름, 점선 = 닿기만 함(필터), 네트워크 점(필터, 기본 끔 — 사용자가 써 보고 결정), 자유 배치/층별 정렬, 검색, 목록 보기. React Flow는 뺐다. 선택하면 연결점 강조·나머지 흐리게, 확대는 선택을 풀 때만 원래대로. 테스트 67 통과, 사용자 브라우저 확인(2026-11-24).
- **2단계 — 허용된 명령** ✅ (연결 21개 중 20개, `rules.mjs`): `hermes-broker`의 `ROUTES`, LLM 게이트웨이 별칭, Controller 경로를 코드에서 뽑아 연결선에 붙인다. 코드와 지도가 다르면 테스트가 실패한다.
- **3단계 — 최근 호출 수** ✅ (`calls.mjs`, 24시간, 횟수·상태 코드만): broker 감사 로그와 게이트웨이 `calls` 표로 연결선마다 호출 수를 보여 준다.
- **첫 수집에서 나온 것**
  - `admin-internal`, `ai-internal`, `learning-internal`, `publisher-internal`이 인터넷으로 나갈 수 있었다 → **2026-11-24 네트워크 강화로 해결**(사용자 승인 후 적용): 공유 네트워크는 모두 `internal: true`, 포트를 열거나 인터넷이 필요한 서비스는 혼자 쓰는 출구 네트워크. hermes-broker와 test-runner는 인터넷 없음(실제 접속 시험으로 확인). 증명: `services/service-map/verify-networks.mjs`. 네트워크 주소 여유가 적으니 새 네트워크를 만들 때 Docker 주소 범위를 확인한다.
  - 닿지만 부르지 않는 쌍 10개 → 1개(controller ↔ hermes, 실제로 쓰는 상태 확인). 연결 21개는 모두 그대로 동작(실환경 확인).

## 21. Ubuntu로 이전 ⬜ (먼 훗날, 지금은 신경 쓰지 않음)

Windows 10 지원이 끝나서, 프로젝트가 완성되고 유지보수 단계에 들어가면 언젠가 Ubuntu로 옮긴다. 1~2년 뒤일 수 있다. **지금 작업에서는 고려하지 않는다.**

- 그때 볼 것(메모만): Windows 작업 스케줄러로 도는 Service Map 수집기 → systemd timer나 cron, D 드라이브 경로와 Docker Desktop 전제(`host.docker.internal`, 바인드 마운트 경고) → Linux Docker, `data/`·`secrets/` 옮기기와 권한.

## 22. Dashboard 로그인 유지 ✅ (2026-11-24)

세션을 `dashboard-data` 볼륨의 `sessions.json`(권한 600)에 저장해 다시 만들어도 로그인이 유지된다. 쿠키 원문은 저장하지 않고 HMAC만 남기며, 키는 관리자 비밀번호 해시·이름·`DASHBOARD_SESSION_EPOCH`에서 나온다(하나라도 바뀌면 모든 세션 무효). 유휴 30분·최대 8시간·로그아웃·CSRF는 그대로.
