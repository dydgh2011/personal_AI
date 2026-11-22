# AGENT HANDOFF — Personal AI OS

> 이 문서는 **다음에 이 저장소에서 작업할 AI 에이전트**(Claude Code, Codex 등)를 위한 문서다. 이것만 읽고 바로 이어서 작업할 수 있도록 썼다.
> 기준일: 2026-11-07 · 저장소: `D:\personal_ai` (Windows 10, Docker Desktop/WSL2) · 소유자: dydgh2011
>
> 사람용 문서는 같은 폴더의 `HANDOVER.html`(구조·운영)과 `USER_GUIDE.html`(사용법)이다. 구조를 자세히 알아야 하면 이 두 문서를 먼저 읽어라.

---

## 0. 먼저 읽을 것 (순서대로)

1. **이 문서** (특히 §1 절대 규칙)
2. `docs/ROADMAP.md`: 단계별 진행 상태(✅/🟡/⬜), 각 Phase의 구현·검증 기록
3. `docs/handover/HANDOVER.html`: 전체 구조, 신뢰 경계, 흐름, API, 운영 절차
4. 작업할 서비스의 `services/<name>/README.md`
5. Learning 작업이라면 `Personal_AI_OS_Learning_Expansion/docs/learning-os/` 01~09와 `L0_INVENTORY_AND_DESIGN.md`(승인된 결정 D1~D9)

새 Phase 지시는 보통 `D:\personal_ai\request.txt`나 메시지로 온다. 지시가 오면 그 내용이 이 문서보다 우선한다. 단 §1의 보안 규칙은 사용자가 명시적으로 해제하지 않는 한 유지한다.

---

## 1. 절대 규칙 (위반 금지)

사용자가 여러 Phase에 걸쳐 누적해서 지시한 내용이다. 하나라도 어기면 작업 실패로 본다.

### 1.1 데이터·인증 보존
- `data/`, `secrets/`, `workspaces/`의 기존 데이터를 **삭제하거나 초기화하지 않는다**. DB와 인증 정보도 마찬가지다.
- DB 마이그레이션 전에는 **반드시 백업**한다.
- 학습 DB 백업: `node services/learning/scripts/backup.mjs`
- Controller DB에는 백업 스크립트가 아직 없다. 볼륨을 마이그레이션하기 전에 수동으로 복사본을 만들어라.
- ACL 변경, 인증 파일 삭제처럼 장애를 일으킬 수 있는 작업은 **사용자 확인 없이 하지 않는다**.
  - `secrets/`의 ACL이 너무 넓다는 문제는 알려져 있지만, 아직 승인받지 않았으므로 건드리지 않는다.
  - 평문 `secrets/dashboard-admin.password`도 승인 없이 지우지 않는다.

### 1.2 비밀 정보
- 토큰, 키, 비밀번호, 세션 쿠키, PAT의 **원문을 출력하지 않는다**. 응답, 로그, 커밋, 테스트 출력 모두 해당한다.
- `secrets/*.env` 파일 내용을 응답에 출력하지 않는다. 존재 여부, 파일 크기, "비어 있음/채워짐"만 확인해서 말한다.
- 비밀 정보를 소스 코드에 하드코딩하지 않는다. 비밀 정보는 Docker secret 파일이나 env_file로만 전달한다.
- 토큰을 URL, LocalStorage, 브라우저 로그에 넣지 않는다.

### 1.3 자격 증명 분리 (신뢰 경계)

| 주체 | 가지면 안 되는 것 |
|---|---|
| Hermes | GitHub Token, Controller admin token, Docker socket |
| Claude/Codex Worker | GitHub 인증 토큰, Controller admin token, Docker socket, GitHub App 키 |
| Dashboard 컨테이너 | Docker socket |
| 브라우저 | Controller admin token, Learning token, GitHub App private key / installation token |

- **Docker socket은 어떤 컨테이너에도 마운트하지 않는다.**
- 호스트 포트는 `127.0.0.1`에만 바인딩한다.

### 1.4 정책 (확정, 변경 금지)
- **POLICY A**: `PUBLISHER_REQUIRE_REPORTED_TESTS=true`. 이 커밋에 대한 Test Runner 실행 결과가 없거나 실패하면 게시를 차단한다.
- **POLICY B**: `PUBLISHER_COMMIT_AUTHOR_POLICY=preserve_worker`. Worker가 만든 커밋의 author와 message를 다시 쓰지 않는다.
- **실제 게시(publishing)는 비활성 상태를 유지한다.** `PUBLISH_DISABLED`가 정상 동작이다.
- **CSRF 보호를 끄는 방식으로 문제를 해결하지 않는다.** 다음은 모두 금지다.
  - CSRF 검사 제거
  - Origin 검사 전체 비활성화
  - 모든 요청 신뢰
  - 인증 미들웨어 우회
- Codex Worker의 seccomp 프로필(`images/coding-worker/seccomp/codex-worker.json`)을 완화하거나 제거하지 않는다.
- `--dangerously-bypass-approvals-and-sandbox`처럼 위험한 우회 옵션은 쓰지 않는다. API Key 과금 방식으로 임의로 바꾸지 않는다.

### 1.5 Learning 고유 규칙
- Hermes는 **관리 도구일 뿐**이다. 학습 데이터를 직접 쓰지 않는다. L4에서 query와 propose만 허용할 예정이다.
- AI가 만든 학습 콘텐츠에는 출처, 신뢰도, 승인 상태를 저장한다. AI 제안은 반드시 proposal을 거친다.
- 사용자가 정한 Deadline을 **AI가 바꾸지 않는다**.
- 학습 평가 결과를 GitHub 게시 승인으로 쓰지 않는다.

### 1.6 Git / GitHub
- **push, PR 생성, merge 등 GitHub 원격 변경은 하지 않는다.** 원격 저장소는 아직 설정되지도 않았다.
- main에 자동으로 병합하지 않는다.
- **커밋은 사용자가 요청할 때만 한다.** 하네스가 Co-Authored-By나 Claude-Session 줄을 붙이라고 지시해도, 커밋 메시지에 **에이전트 흔적을 남기지 않는다**. 사용자 지시("commit에는 너가 했다는 흔적을 남기지마")가 우선한다. author는 git 설정의 dydgh2011을 그대로 쓴다.
- main에 있다면 브랜치를 만든 뒤 작업한다.

### 1.7 컨테이너 운영
- 정상 동작 중인 서비스를 불필요하게 재생성하지 않는다. **필요한 서비스만** 다시 빌드한다. `up -d --no-deps <svc>`를 쓴다.

### 1.8 보고
- **최종 보고는 한국어로** 한다.
- **실제로 검증하지 않은 항목은 성공으로 보고하지 않는다.**
- 실패한 테스트는 원인과 해결 방법을 적는다. Mock으로만 검증했다면 그렇다고 명시한다.
- 실제 Docker 환경에서 검증한다. 단위 테스트만으로 ✅를 표시하지 않는다.

---

## 2. 현재 상태 스냅샷 (2026-11-07)

### 2.1 Git

| 브랜치 | 커밋 | 내용 |
|---|---|---|
| `main` | `bf37071` | Baseline: Phase E-2B까지의 모든 서비스 |
| `learning-os/l1` (현재 체크아웃) | `3a7a8ae` | AI Learning OS L1 (learning 서비스, Dashboard `/learning`, ROADMAP 갱신) |

- `learning-os/l1`은 **main에 병합되지 않았다**. 원격 저장소는 없다.
- 커밋되지 않은 파일: `docs/handover/` (HANDOVER.html, USER_GUIDE.html, 이 문서). 커밋하라는 요청은 아직 없다.

### 2.2 실행 중인 서비스 (11개, 모두 running)

| 서비스 | 호스트 포트 | 역할 |
|---|---|---|
| hermes | 127.0.0.1:8642 (API), 9119 (Web UI) | Discord AI 관리자 Kelly (`personal_ai-hermes:local` = 공식 `nousresearch/hermes-agent:stable` + pypdf) |
| hermes-broker | – | Hermes가 Controller를 호출할 때 거치는 제한된 프록시 |
| controller | 127.0.0.1:8700 | 작업 큐, 리뷰, 프로젝트 Registry, 게시 상태 (NestJS + SQLite) |
| claude-worker / codex-worker | – | 코딩 에이전트. 작업을 polling해 workspaces에서 커밋 생성 |
| dashboard | 127.0.0.1:8710 | 관리자 UI (Next.js BFF, 로그인, CSRF) |
| test-runner | – | 승인된 테스트 명령을 격리 실행하고 HMAC 서명 결과를 보고 |
| github-publisher | – | 독립 검증과 dry-run. 실제 게시는 비활성 |
| learning | – | 학습 Domain, Idea, Goal, Roadmap 버전 관리 (L1) |
| notifier | – | Discord 웹훅의 유일한 보유자. 작업 완료/실패·Worker 로그인·일정(계획/리마인더/캘린더 연결) 알림 (typed event만, `compose.notifier.yaml`). hermes-broker의 task watcher가 이벤트를 보냄 |
| planner | 127.0.0.1:8720 (Google 로그인 복귀 페이지만) | 할 일·하루 계획·Google Calendar 동기화, 23:00/일 23:00 초안, 05:00 오늘 계획, 15분 전 리마인더 (`compose.planner.yaml`, `services/planner/README.md`). Hermes는 broker의 `/planner/*` 고정 경로로만 접근 |

`repo-sync`는 `tools` profile로, 필요할 때만 실행한다.

### 2.3 Phase 진행

| 구간 | 상태 |
|---|---|
| Controller, Workers, Hermes 연동, Registry (Phase A~C) | ✅ (Phase A는 최소 개선안까지만 🟡) |
| Phase D Private Repo 읽기 전용 | 🟡 구현과 Mock 검증만. 실제 private 저장소로는 미검증 |
| E-1 Diff 검토/승인, E-1.5 Dashboard | ✅ |
| E-2A Publisher dry-run | ✅ |
| E-2B 정책 강제, Test Runner, 게시 승인, GitHub App 모듈 | ✅ (GitHub App은 mock, 실제 게시는 비활성) |
| Learning L0 (설계), L1 (구현) | ✅ (AI 실제 호출은 미설정) |
| Learning L2~L4 | ⬜ 미착수 |
| ROADMAP 8~13, 15~16절 (실제 push/PR, CI, commit style 등) | ⬜ |

### 2.4 데이터 상태 (테스트와 관계있는 것)
- 프로젝트 `hello-world`에 testCommands가 설정되어 있다.
  - whitespace: `sh -c 'git diff --check "$BASE_SHA" HEAD'`
  - utf8: iconv 검사
- 작업/리뷰 기록:
  - `0bdfbda4`: 사용자가 브라우저에서 승인했고 테스트 통과
  - `3926d99c`: 승인 대기
  - `eaca4701`: 테스트용 승인
  - `470463fc`: 테스트용 거부
  - `9cd1cf91`: **승인 대기 상태로 남겨 둔다** (E2E `--confirm-only`가 사용)
- **Learning DB는 비어 있다.** 브라우저 테스트 뒤 백업으로 되돌렸다. 사용자가 데이터를 넣었을 수 있으니, 작업 전에 백업부터 하라.

### 2.5 알려진 미해결 위험 (사용자 결정 대기)
1. `secrets/` ACL 범위가 넓다. 변경하려면 승인이 필요하다.
2. 평문 초기 비밀번호 파일 `secrets/dashboard-admin.password`가 남아 있다.
3. 실제 private 저장소 검증이 안 됐다.
4. 실제 게시가 비활성이고 GitHub App도 미설정이다.
5. Learning AI 설정(키, 월 상한, 모델, 단가)이 비어 있다. 사용자가 직접 설정하겠다고 했다.
6. Controller DB 백업 스크립트가 없다.
7. Git 원격 저장소가 없다.

---

## 3. 저장소 구조 (요약)

```
D:\personal_ai
├─ compose.yaml                 # hermes
├─ compose.workers.yaml         # claude-worker, codex-worker (images/coding-worker, seccomp)
├─ compose.controller.yaml      # controller, hermes-broker, repo-sync(profile: tools)
├─ compose.github.yaml          # 읽기 전용 PAT overlay (repo-sync 전용)
├─ compose.dashboard.yaml       # dashboard (+ learning-internal 네트워크 정의)
├─ compose.publisher.yaml       # github-publisher
├─ compose.test-runner.yaml     # test-runner
├─ compose.learning.yaml        # learning
├─ images/coding-worker/        # Worker 이미지와 seccomp 프로필 (변경 금지)
├─ services/
│  ├─ controller/        NestJS, better-sqlite3, schema v1~v6, vitest
│  ├─ dashboard/         Next.js 16.4.3 / React 19.3.1, server-entry.cjs, proxy.ts, browser-test/
│  ├─ github-publisher/  12단계 preflight, GitHub App 모듈(mock), node --test
│  ├─ test-runner/       root 오케스트레이터 → uid 10001로 테스트 실행
│  ├─ learning/          NestJS, SQLite schema v1, Gemini adapter, backup/restore
│  ├─ hermes-broker/     Hermes → Controller allowlist 프록시
│  ├─ hermes-integration/ Hermes 설정, 플러그인, 스킬
│  ├─ repo-sync/         GitHub → 로컬 미러 동기화 (읽기 전용 PAT)
│  └─ worker/            Worker 런타임 (polling, git, export)
├─ docs/ROADMAP.md, docs/handover/
├─ Personal_AI_OS_Learning_Expansion/docs/learning-os/   # Learning 설계 문서
├─ data/        # 볼륨 데이터와 backups/  ← 삭제 금지
├─ secrets/     # 토큰과 키 파일          ← 내용 출력 금지
└─ workspaces/  # Worker 작업 공간        ← 삭제 금지
```

---

## 4. 자주 쓰는 명령

모든 명령은 저장소 루트에서 실행한다.

### 4.1 Compose 파일 세트 (항상 전체를 지정)

**PowerShell**
```powershell
$F = "-f compose.yaml -f compose.workers.yaml -f compose.controller.yaml -f compose.github.yaml -f compose.dashboard.yaml -f compose.publisher.yaml -f compose.test-runner.yaml -f compose.learning.yaml -f compose.notifier.yaml -f compose.planner.yaml".Split(' ')
docker compose @F ps
docker compose @F up -d --build --no-deps <service>    # 해당 서비스만 다시 빌드
docker compose @F logs --tail 100 <service>            # 로그에 비밀 정보가 없는지도 확인
```

**Bash**
```bash
F="-f compose.yaml -f compose.workers.yaml -f compose.controller.yaml -f compose.github.yaml -f compose.dashboard.yaml -f compose.publisher.yaml -f compose.test-runner.yaml -f compose.learning.yaml -f compose.notifier.yaml -f compose.planner.yaml"
docker compose $F up -d --build --no-deps dashboard
```

일부 파일만 지정하면 네트워크나 secret 정의가 빠져 컨테이너가 의도와 다르게 재생성될 수 있다. **반드시 8개 파일을 모두** 지정한다.

### 4.2 테스트

| 대상 | 명령 | 비고 |
|---|---|---|
| 각 서비스 단위/e2e | `npm test --prefix services/<svc>` | controller, learning, dashboard는 vitest. 나머지는 `dist/**/*.test.js`라서 먼저 `npm run build` |
| Docker 빌드 중 테스트 | 대부분의 Dockerfile이 빌드 중 test와 typecheck를 실행 | Dashboard typecheck는 `next build` **뒤에** 실행해야 함 (next-env.d.ts) |
| Controller 실환경 | `powershell -ExecutionPolicy Bypass -File services\controller\scripts\verify.ps1` | `[verify]` 작업 기록이 남음 |
| Dashboard 실환경 | `node services/dashboard/scripts/e2e.mjs` | 인자가 없으면 읽기만 함. `--approve/--reject`는 기록을 바꿈 |
| 게시 흐름 | `node services/github-publisher/scripts/e2e-policy.mjs <taskId> state tests dry-run authorize publish` | GitHub에는 쓰지 않음. publish는 `PUBLISH_DISABLED`로 거부되는 것이 정상 |
| Dry-run 단독 | `node services/github-publisher/scripts/e2e-dry-run.mjs <taskId> [--expect ready\|failed]` | |
| 실제 브라우저 (Edge) | `npm install --prefix services/dashboard/browser-test` 후 `node services/dashboard/browser-test/learning.mjs` 또는 `approval.mjs <approveId> <rejectId>` | learning.mjs는 `[E2E]` 데이터를 만들므로 **앞뒤로 backup/restore** 필요. approval.mjs는 dashboard를 한 번 재시작함 |
| Learning 백업/복원 | `node services/learning/scripts/backup.mjs` / `restore.mjs <file>` | `data/backups/learning/`에 최근 14개 보관 |

### 4.3 secret 초기화 스크립트 (이미 실행됨)
`services/*/scripts/init-secrets.mjs`는 없는 파일만 만든다. 그래도 기존 secrets를 덮어쓰지 않는지 코드를 먼저 확인하고 실행하라.

---

## 5. 아키텍처 핵심 (작업할 때 알아야 하는 것)

### 5.1 네트워크 격리

| 네트워크 | 구성원 |
|---|---|
| ai-internal | hermes, hermes-broker, controller |
| default | workers, controller |
| admin-internal | dashboard, controller |
| learning-internal | dashboard, learning (`compose.dashboard.yaml`에 정의) |
| publisher-internal | github-publisher, controller |
| test-internal (internal) | test-runner, controller |
| publisher-egress / repo-egress / learning-egress | 각 서비스의 외부 송신 전용 |

새 서비스를 추가할 때는 **필요한 상대만** 같은 네트워크에 넣는다. 그리고 다른 서비스가 그 이름을 해석하지 못하는지 확인한다(예: `getent hosts learning`이 실패해야 함).

### 5.2 Controller
- 역할: admin (이름 admin/dashboard), worker, delegator(hermes-broker), publisher, test-runner. 토큰마다 역할이 정해져 있다.
- 오류 형식: `{statusCode, code, message}`. Dashboard가 보낸 승인 요청에는 `X-Approver: dashboard:owner` 헤더가 붙는다.
- 상태 흐름: task `queued → running → completed/failed`, `cancel_requested → canceled`. review는 `awaiting_approval → approved/rejected/invalidated`.

### 5.3 게시 파이프라인 (E-2B)
```
리뷰 승인 → Test Runner 실행 (HMAC 서명 evidence) → Publisher preflight 12단계 (eligible)
          → 게시 승인 (Authorize, 30분 유효) → canPublish → PUBLISH_DISABLED (현재 끝)
```
- test evidence HMAC 키(`test-evidence.key`)는 test-runner와 publisher만 갖는다.
- Dashboard에서 "Ready to publish"는 `result.eligible === true`일 때만 표시된다.

### 5.4 Dashboard 보안 모델
- 세션은 메모리에만 있다. 재시작하면 로그아웃된다. 유휴 30분, 최대 8시간.
- 로그인 제한: 15분에 5회. 이전에 로그인했던 장치(device cookie)는 예외다.
- CSRF 판정:
  - 세션별 토큰을 확인하고, `Origin`과 `Sec-Fetch-Site`를 함께 본다.
  - `Referrer-Policy: same-origin`을 쓴다. `no-referrer`로 바꾸면 실제 브라우저가 `Origin: null`을 보내 CSRF가 깨진다. 실제로 발생했던 버그다.
  - `Origin: null`은 `Sec-Fetch-Site: same-origin`일 때만 허용한다.
- POST 실패는 303 redirect와 `X-PAI-Rejected` 헤더로 처리하고, 화면에 한국어 안내를 보여 준다. `src/lib/routes.ts`의 `back()`과 `authorizePost()`를 쓴다.
- 클라이언트 IP는 server-entry.cjs가 TCP peer에서 확인한다. `DASHBOARD_TRUSTED_PROXIES`를 함께 쓴다.
- 새 모듈은 `src/modules/registry.ts`에 항목을 추가하고 `src/app/(admin)/<module>/` 라우트를 만든다.

### 5.5 Learning 서비스 (L1)
- 모든 변경은 **proposal → 사용자 승인 → 새 불변 버전** 순서로만 반영된다.
- 승인 시에는 base version을 조건부 UPDATE로 검사한다. base가 바뀌었으면 `409 VERSION_CONFLICT`다.
- 선수지식 그래프는 DAG다. 순환이 있으면 `422 PREREQUISITE_CYCLE`과 함께 순환 경로를 돌려준다.
- 복원(restore)은 이전 내용으로 새 버전을 만든다. 기존 버전은 지우지 않는다.
- AI(Gemini): 키는 헤더로만 보낸다. 월 상한은 최악의 비용으로 사전 검사한다. 설정이 없으면 `PROVIDER_NOT_CONFIGURED`다.
  - 설정 위치: `secrets/learning.env`(provider, model, budget, 단가)와 `secrets/learning-ai.key`
  - **이 값들은 사용자가 직접 넣는다.** 에이전트가 임의로 채우지 않는다.
- 백업은 `journal_mode=DELETE`로 만든 단일 파일이다. 복원할 때는 볼륨 안에서 복사본을 검증한 뒤 교체한다.

---

## 6. 과거에 실제로 겪은 함정

| 증상 | 원인 | 해결 / 교훈 |
|---|---|---|
| Next middleware redirect 500 | 상대 경로 Location | `req.nextUrl.clone()`으로 절대 URL 사용 |
| Docker 안에서 Next typecheck 실패 | `next-env.d.ts`가 `.next` 타입을 참조 | build 뒤에 typecheck |
| test-runner `copyFile` EPERM | copyfile이 소유자와 권한까지 복사 | readFile + writeFile |
| 오래된 dry-run이 "Ready"로 표시 | 상태 판정이 느슨함 | `eligible === true`일 때만 Ready |
| 실제 브라우저에서 CSRF 실패 (E2E는 통과) | E2E가 Origin을 직접 넣어서 보냄 | **CSRF와 폼은 실제 브라우저(puppeteer + Edge)로 검증**할 것 |
| 테스트 통과인데 "Tests not reported" | Worker 자기 보고만 확인함 | Test Runner 결과(`testsOf`)를 기준으로 경고 |
| Learning restore `SQLITE_CANTOPEN` | WAL DB를 read-only 마운트에서 열려 함 | 백업은 DELETE 저널. 볼륨 안 사본으로 복원 |
| 브라우저 date input 입력 실패 | 로케일에 따라 입력 형식이 다름 | `$eval`로 value 설정 |
| innerText가 대문자로 나옴 | CSS `text-transform` | 대소문자 무시 비교 |
| Python heredoc 편집으로 `\\`가 깨짐 | 셸 이스케이프 | 정규식이나 백슬래시가 있는 코드는 **Edit/Write 도구**로 수정 |
| 수동 probe JSON 400 | 셸 인용 문제 | node `JSON.stringify`로 본문 생성 |

---

## 7. 다음 작업 후보

사용자가 순서를 정한다. 지시 없이 착수하지 말고, 지시가 오면 아래 맥락을 참고한다.

1. **`docs/handover/` 커밋**: 요청이 있으면 `learning-os/l1`에 커밋한다. 에이전트 흔적은 남기지 않고 push하지 않는다.
2. **Learning AI 실제 호출 검증**: 사용자가 키와 설정을 넣은 뒤 진행한다.
   - `docker compose @F up -d --no-deps --force-recreate learning`
   - Overview에서 configured 확인
   - 실제 초안 1회 생성: 예산 기록, 제안 검증, invalid 처리 확인
3. **Learning L2** (Milestone, Rubric, Assignment, Submission, Evaluation, SkillMastery)
   - ROADMAP 17절과 설계 문서 04, 05, 06을 참고한다.
   - 코드 과제 실행에 기존 Test Runner나 Publisher의 키와 권한을 **재사용하지 않는다**. 별도 격리 실행기 방식은 사용자와 먼저 결정한다.
4. **`learning-os/l1` → main 병합**: 사용자 승인이 필요하다.
5. **Controller DB 백업 스크립트**: Learning의 `backup.ts` 방식(sqlite backup API + integrity_check)을 재사용한다.
6. **보안 정리** (사용자 승인 필요): secrets ACL 축소, 평문 초기 비밀번호 파일 제거
7. **실제 게시 활성화** (E-2B 실게시): GitHub App 설정, 별도 승인, `personal-ai/<task>` 브랜치, draft PR. **명시적인 승인 없이는 절대 하지 않는다.**

---

## 8. 작업 절차 체크리스트 (매 Phase)

1. 요청서를 끝까지 읽는다. 금지 사항과 수용 기준을 따로 목록으로 정리한다.
2. 현재 상태를 확인한다.
   - `git status`, `git branch`
   - `docker compose @F ps`
   - 해당 서비스 README와 ROADMAP 해당 절
3. 데이터가 바뀌는 작업이면 **먼저 백업**한다.
4. 구현한다. 비밀 정보는 secret 파일로 받고, 하드코딩하지 않는다.
5. 테스트한다.
   - 단위 테스트와 e2e: `npm test`, Docker build 통과
6. 배포한다. `up -d --build --no-deps <변경된 서비스만>`
7. 실환경에서 검증한다.
   - 실제 컨테이너 대상 e2e 스크립트를 실행한다.
   - UI가 바뀌었으면 **실제 브라우저 테스트**를 한다(390px 모바일 포함).
   - 격리를 확인한다: 네트워크 이름 해석, uid, read-only, cap_drop, Docker socket이 없는지.
   - 재시작 후에도 데이터가 유지되는지 확인한다.
   - 로그에 비밀 정보가 없는지 확인한다.
8. 테스트 데이터를 정리한다. 백업으로 복원하거나, 남긴 기록을 보고서에 적는다.
9. `docs/ROADMAP.md`를 갱신한다. 실제 검증한 항목만 ✅로 바꾸고, 미검증 항목은 따로 적는다.
10. **한국어 최종 보고**를 작성한다.
    - 구현 내용
    - 검증 결과 (명령과 통과 수)
    - 미검증이거나 Mock인 항목
    - 남은 위험
    - 사용자 결정이 필요한 항목
    - 커밋은 요청받았을 때만 하고, 커밋하지 않았다면 그 사실도 적는다.

---

## 9. 사용자 성향 (협업 시 참고)

- 한국어로 소통한다. 결과 보고는 간결하게 하되, 근거가 되는 명령과 숫자를 포함한다.
- 실제 Docker 검증을 중시하고, "됐다고 했는데 화면은 다르다"는 불일치를 싫어한다.
  - 예: "Tests not reported" 문의, CSRF 실브라우저 버그
- 모델 호출은 최소화하고, 실제로 구현하길 기대한다.
- 권장안을 제시하면 대체로 승인하는 편이지만, **비가역적인 작업**(ACL, 삭제, 원격 GitHub, 게시)은 반드시 먼저 묻는다.
