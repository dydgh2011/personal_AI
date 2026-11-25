# AGENT HANDOFF — Personal AI OS

> 이 문서는 **다음에 이 저장소에서 작업할 AI 에이전트**(Claude Code, Codex 등)를 위한 문서다. 이것만 읽고 바로 이어서 작업할 수 있도록 썼다.
> 기준일: 2026-11-07, 2026-11-24 갱신(규칙은 `AGENTS.md`, 현재 상태는 `CURRENT_WORK.md`로 옮김) · 저장소: `D:\personal_ai` (Windows 10, Docker Desktop/WSL2) · 소유자: dydgh2011
>
> 사람용 문서는 같은 폴더의 `HANDOVER.html`(구조·운영)과 `USER_GUIDE.html`(사용법)이다. 구조를 자세히 알아야 하면 이 두 문서를 먼저 읽어라.

---

## 0. 먼저 읽을 것 (순서대로)

1. 저장소 맨 위 `AGENTS.md`: 모든 에이전트 공용 규칙(Codex는 자동으로, Claude Code는 `CLAUDE.md`로 읽는다)
2. `docs/handover/CURRENT_WORK.md`: 지금 진행 중인 일과 다음 할 일
3. `docs/ROADMAP.md`: 단계별 진행 상태(✅/🟡/⬜)와 구현·검증 기록
4. 이 문서: 구조, 운영, 과거의 함정
5. 작업할 서비스의 `services/<name>/README.md`
6. Learning 작업이라면 `Personal_AI_OS_Learning_Expansion/docs/learning-os/` 01~09와 `L0_INVENTORY_AND_DESIGN.md`

사람용 문서는 `HANDOVER.html`(구조·운영)과 `USER_GUIDE.html`(사용법)이다. 두 문서는 11월 초 기준이라 개인 비서(Kelly, 지식 저장소, LLM 게이트웨이, 학교 연결)와 서비스 지도는 아직 빠져 있다.

---

## 1. 절대 규칙

**`AGENTS.md` 2절로 옮겼다.** 규칙은 그 파일 한 곳에만 둔다(여기에 다시 쓰지 않는다).

---

## 2. 현재 상태

**`docs/handover/CURRENT_WORK.md`와 `docs/ROADMAP.md` 맨 위 진행 요약을 본다.** 실행 중인 서비스와 연결은 Dashboard `/services`(서비스 지도) 또는 `scripts\stack.ps1 ps`로 본다.

2026-11-24 기준 서비스 14개: hermes(Kelly, Discord), hermes-broker, llm-gateway, controller, claude-worker, codex-worker, test-runner, github-publisher(게시 비활성), dashboard, learning, planner, notifier, knowledge, school.

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

### 4.1 스택 운영은 `scripts\stack.ps1`

compose 파일 13개를 직접 나열하지 않는다. 같은 목록을 쓰는 스크립트를 쓴다.

```powershell
powershell -ExecutionPolicy Bypass -File scripts\stack.ps1 help
powershell -ExecutionPolicy Bypass -File scripts\stack.ps1 ps
powershell -ExecutionPolicy Bypass -File scripts\stack.ps1 rebuild dashboard     # 바꾼 서비스만, 하나씩
powershell -ExecutionPolicy Bypass -File scripts\stack.ps1 backup knowledge      # knowledge | controller | learning
```

- 원래 폴더(`D:\personal_ai`)가 아니면(worktree 등) 스택을 바꾸는 명령을 거부한다.
- 이미지를 동시에 여러 개 빌드하지 않는다. CPU가 바빠지면 빌드 중 테스트가 시간 초과로 실패한다.

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

### 5.1 네트워크 격리 (2026-11-24 강화)

- 여러 서비스가 함께 쓰는 네트워크는 모두 `internal: true`(인터넷 없음)다. 인터넷이 필요하거나 포트를 여는 서비스는 **혼자 쓰는 출구 네트워크**를 따로 갖는다(예: `hermes-egress`, `dashboard-port`).
- hermes-broker와 test-runner는 인터넷으로 나갈 수 없다.
- 지금 구성과 서비스별 인터넷 여부: `scripts\stack.ps1 verify-networks` 또는 Dashboard `/services`의 네트워크 필터.
- 새 서비스를 추가할 때는 **필요한 상대만** 같은 네트워크에 넣고, 바꾼 뒤 `verify-networks`가 통과해야 한다. 다른 서비스가 그 이름을 해석하지 못하는지도 확인한다.
- Docker 네트워크 주소 여유가 적다(2026-11-24 기준 약 2개). 네트워크를 늘리기 전에 확인한다.
- 네트워크 설정을 바꿔 적용할 때 Docker가 멈춘 컨테이너를 옛 네트워크에 묶어 둔 채 다시 붙이기를 실패할 수 있다. 그때는 멈춘 컨테이너를 지우고(`docker rm`, 볼륨은 그대로) 다시 `up` 한다.

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
| Controller 이미지 빌드 실패 | Docker 안 디스크가 느려 SQLite 테스트(synchronous=FULL)가 vitest 기본 5초를 넘김 | `vitest.config.ts`의 testTimeout·hookTimeout 60초 |
| 이미지 두 개를 동시에 빌드하면 테스트 실패 | CPU 경쟁으로 시간 초과 | 하나씩 빌드한다 |
| 합친 뒤 Dashboard 테스트 실패 | 세션 저장(관리자 비밀번호 해시로 키를 만듦)과 세션을 만드는 새 테스트가 만남 | 테스트마다 임시 해시·세션 파일 경로를 준다 |
| Kelly 첫 일정 질문에 플래너 항목 누락 | 플래너 호출 3개를 차례로 불러 3초 제한 초과, `with` 블록이 늦은 호출을 기다림 | 동시 호출, 제한 넘으면 기다리지 않음 |
| 사실 종류 미리보기에서 배점이 시험으로 분류 | 배점 문장 안의 날짜·분수가 먼저 걸림 | 규칙 순서(배점 머리말 우선)와 미리보기의 "빠지는 사실" 확인 |
| 게시 테스트가 "artifact missing"으로 중단, Authorize 버튼 없음 | worker 결과물 볼륨(`publisher-artifacts-claude`)이 root 소유라 bundle 쓰기 실패(`EPERM chmod /artifacts`) | 볼륨 루트를 uid 1000으로(2026-11-24 수정), `export-artifact`로 다시 만듦 |
| git merge가 `index.lock`으로 실패 | 앱의 백그라운드 git이 잠깐 잠금 | 잠시 뒤 다시 시도 |

---

## 7. 다음 작업 후보

`docs/handover/CURRENT_WORK.md`의 "다음 후보"를 본다. 주인이 순서를 정한다.

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
