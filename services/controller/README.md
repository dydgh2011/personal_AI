# Personal AI — NestJS Task Controller

Hermes(관리자)가 작업을 등록하고, Claude/Codex Worker가 **직접 가져가서(pull)** 실행하는 구조의 작업 관리 서비스입니다.
Controller는 프로세스를 실행하지 않고, Docker를 제어하지 않으며, 작업 상태만 관리합니다.

```text
Hermes ──▶ hermes-broker ──(delegator token)──▶ Controller ◀──(worker token)── claude-worker / codex-worker
                          │  SQLite (named volume)
                          └─ /tasks, /system/status        /internal/* (claim, heartbeat, complete, fail, cancel-ack)
```

## 구조

```text
src/
├── main.ts                 설정 로드(실패 시 즉시 종료) → Nest 부트스트랩
├── app.module.ts / app.setup.ts   모듈 조립, ValidationPipe·body limit (테스트와 공유)
├── config/                 환경변수 검증 (토큰 길이/중복, projectId 형식, probe URL)
├── auth/                   전역 Bearer 토큰 Guard, admin/delegator/worker 역할, 토큰 → principal
├── tasks/                  Task 모델, 상태 전환표, Repository(추상) + SQLite 구현, 관리 API
├── workers/                Worker 내부 API, worker 최근 접속 시각(메모리)
├── projects/               등록된 projectId 레지스트리
├── health/                 /health(공개), /system/status(admin, delegator)
├── database/               SQLite 연결, PRAGMA, 마이그레이션(user_version)
└── common/                 Clock (테스트에서 시간 제어)
test/                       e2e(supertest) 테스트, 공용 헬퍼
scripts/init-secrets.mjs    토큰 생성 (값 출력 안 함, 기존 파일 덮어쓰기 안 함)
scripts/verify.ps1          실행 중인 컨테이너 대상 종단 검증
```

## 실행 (PowerShell, 저장소 루트 `D:\personal_ai`)

```powershell
# 1) 최초 1회: 토큰 생성 → secrets\controller.env 등 (git-ignored)
node services\controller\scripts\init-secrets.mjs

# 2) 빌드 + 기동 (controller만 생성/재생성, Hermes·Worker는 건드리지 않음)
docker compose -f compose.yaml -f compose.workers.yaml -f compose.controller.yaml up -d --build controller

# 3) 검증
docker compose -f compose.yaml -f compose.workers.yaml -f compose.controller.yaml ps
Invoke-RestMethod http://127.0.0.1:8700/health
powershell -ExecutionPolicy Bypass -File services\controller\scripts\verify.ps1
```

> `compose.workers.yaml`을 빼고 `-f compose.yaml -f compose.controller.yaml`만으로도 실행되지만, 이때 Worker가 "orphan"으로 경고됩니다.
> 그 상태에서 `--remove-orphans`를 붙이면 Worker 컨테이너가 삭제되므로 세 파일을 함께 쓰는 것을 권장합니다.

## 설정

토큰은 `secrets/controller.env`, 나머지는 `compose.controller.yaml`의 `environment`에 있습니다. 전체 목록은 `.env.example` 참고.

| 변수 | 기본값 | 설명 |
|---|---|---|
| `CONTROLLER_ADMIN_TOKEN` | (필수) | 관리 API. 32자 이상 |
| `CONTROLLER_CLAUDE_WORKER_TOKEN` / `CONTROLLER_CODEX_WORKER_TOKEN` | (필수) | Worker API. 토큰이 어떤 agent의 작업을 가져갈지 결정 |
| `CONTROLLER_HERMES_TOKEN` | (선택) | Hermes 전용 delegator 역할. 없으면 delegator 로그인 불가. `scripts/add-hermes-token.mjs`로 추가 |
| `CONTROLLER_IDEMPOTENCY_WINDOW_SECONDS` | `600` | 같은 `Idempotency-Key`의 재요청을 기존 작업으로 돌려주는 기간 |
| `CONTROLLER_PROJECT_IDS` | `sandbox` | 시작 시 Registry에 **없으면** 활성 local 프로젝트로 추가 (기존 행은 바꾸지 않음) |
| `GITHUB_API_URL` | `https://api.github.com` | GitHub REST API 주소 |
| `GITHUB_TOKEN_FILE` | (없음) | 읽기 전용 GitHub 토큰 파일. 없으면 익명(공개 저장소만) |
| `CONTROLLER_LEASE_SECONDS` | `900` (compose: `300`) | claim/heartbeat 후 lease 유효 시간 |
| `CONTROLLER_LEASE_SWEEP_SECONDS` | `15` | 만료 lease 정리 주기 |
| `CONTROLLER_STATUS_PROBES` | `hermes=http://hermes:9119/` | `/system/status`에서 확인할 서비스 |
| `CONTROLLER_HOST_PORT` | `8700` | 호스트 바인딩 포트 (항상 `127.0.0.1`) |

## API

모든 응답은 JSON. 오류는 `{ statusCode, message, error }`.
`401` = 토큰 없음/잘못됨, `403` = 역할 불일치, `400` = 입력 검증 실패, `404` = 없음, `409` = 허용되지 않는 상태 전환.

### 역할

| 역할 | 토큰 | 허용 |
|---|---|---|
| `admin` | `CONTROLLER_ADMIN_TOKEN` (어느 서비스에도 주지 않음) | 관리 API 전체, 모든 작업 |
| `delegator` | `CONTROLLER_HERMES_TOKEN` (hermes-broker만 보유) | **활성** 프로젝트에 허용된 agent로 작업 생성(`projectId` 필수), **자신이 만든 작업만** 조회·취소, 활성 프로젝트 조회(축소된 정보), `/system/status`. 다른 작업·비활성 프로젝트는 404 |
| `worker` | `CONTROLLER_*_WORKER_TOKEN` | `/internal/*`만, 자기 agent의 작업만 |

delegator에게는 `/internal/*`(403), 토큰 조회/변경, Docker, DB 직접 접근, push/merge 같은 기능이 없습니다(그런 API 자체가 없음).
작업에는 `createdBy`(`admin` 또는 `delegator:hermes`)가 기록됩니다. 스키마 v2 이전의 작업은 모두 `admin`으로 기록됩니다.

### Project Registry (`projects` 테이블, 스키마 v3)

| Method | Path | 권한 | 설명 |
|---|---|---|---|
| `GET` | `/projects` | admin(전체), delegator(활성만, 축소) | `{ items }` |
| `GET` | `/projects/:id` | admin, delegator(활성만) | |
| `GET` | `/projects/:id/status?refresh=true` | admin, delegator(활성만) | 작업 수, 동기화 상태, GitHub 원격 기본 브랜치 HEAD와 캐시 비교(60초 캐시) |
| `POST` | `/projects` | admin | `{ id, source: "local"\|"github", fullName?, allowedAgents, enabled?, allowCodeChanges?, defaultBranch?, description? }` |
| `PATCH` | `/projects/:id` | admin | `enabled, allowCodeChanges, allowedAgents, defaultBranch, description`, 동기화 결과 필드, `testCommands`, 그리고 v7의 `commitAuthor`(null로 지움, 저장만), `commitStyle { mode: off\|auto\|manual, guide }`, `agentInstructions { rules, forbiddenPaths }` (각각 통째로 교체, docs/coding-agent-settings.md) |
| `GET` | `/github/repositories?owner=\|org=` | admin | 저장소 Discovery (읽기 전용 GitHub API, 페이지네이션·rate limit 처리) |
| `GET` | `/internal/projects` | worker | 자기 agent가 쓸 수 있는 활성 프로젝트 (`id, source, defaultBranch, allowCodeChanges, cachedHeadSha, syncStatus, commitStyle, agentInstructions`; `commitAuthor`는 보내지 않음) |

- GitHub 프로젝트는 GitHub API로 확인해 `githubRepositoryId`, 기본 브랜치, clone URL(인증 정보 없음), visibility를 **GitHub에서** 가져옵니다. 요청으로 remote URL을 받지 않습니다
- 새 프로젝트는 기본 `enabled: false`, `allowCodeChanges: false`. 같은 id, 같은 저장소(대소문자 무시), 같은 GitHub id는 409
- 작업 생성 조건: 프로젝트 존재 + `enabled` + agent가 `allowedAgents`에 포함 (admin·delegator 모두)
- Discovery 결과는 `complete: false`: 현재 인증 정보(익명/토큰/GitHub App 설치 범위)로 보이는 저장소만 나옵니다
- 익명 상태에서 private 저장소는 404로 보이며, 인증을 명시적으로 설정하기 전에는 접근하지 않습니다
- 동기화(clone/fetch)는 Controller가 아니라 별도 도구 `services/repo-sync`가 합니다(Controller에는 git이 없음)

### 관리 API (admin, delegator 토큰)

| Method | Path | 설명 |
|---|---|---|
| `GET` | `/health` | **인증 없음.** `{ "status": "ok" }`, DB 이상 시 503 |
| `GET` | `/system/status` | Controller·DB·작업 집계·Worker 최근 접속·서비스 probe |
| `POST` | `/tasks` | `{ agent: "claude"\|"codex", instruction, projectId? }` → 201. 선택 헤더 `Idempotency-Key` (8–128자) |
| `GET` | `/tasks?status=&agent=&limit=50&offset=0` | `{ items, total, limit, offset }` (최신순, limit ≤ 200) |
| `GET` | `/tasks/:id` | Task 상세 |
| `POST` | `/tasks/:id/cancel` | `{ outcome, message, task }` |

`Idempotency-Key`: 같은 생성자가 같은 키로 `CONTROLLER_IDEMPOTENCY_WINDOW_SECONDS` 안에 다시 보내면 새 작업을 만들지 않고
기존 작업을 `200` + `Idempotent-Replayed: true`로 돌려줍니다. 같은 키에 다른 내용이면 `409`. 동시 요청도 트랜잭션으로 하나만 생성됩니다.

`outcome`:
- `canceled` — queued 작업이 실행 전에 취소됨
- `cancel_requested` — running 작업에 취소 **요청**만 기록됨. Worker가 실제 중단을 확인(`cancel-ack`)하기 전까지 `canceled`가 아님
- `cancel_already_requested` — 이미 요청된 상태 (멱등)

### Worker API (worker 토큰)

| Method | Path | Body | 설명 |
|---|---|---|---|
| `POST` | `/internal/workers/claim` | – | 내 agent의 가장 오래된 queued 작업을 원자적으로 running으로 전환 후 반환. 없으면 `{ "task": null }` |
| `POST` | `/internal/tasks/:id/heartbeat` | – | lease 연장. `{ task, cancelRequested }` |
| `POST` | `/internal/tasks/:id/complete` | `{ result }` | → completed |
| `POST` | `/internal/tasks/:id/fail` | `{ error }` | → failed |
| `POST` | `/internal/tasks/:id/cancel-ack` | – | cancel_requested → canceled (실제로 중단했을 때만 호출) |

Worker는 자신이 claim한(`claimedBy`가 자신인) 작업만 보고할 수 있습니다. 다른 agent의 작업은 404로 보입니다.

### 상태 전환

```text
queued ──claim──▶ running ──complete──▶ completed
  │                 │   └────fail─────▶ failed
  │                 └─cancel─▶ cancel_requested ──cancel-ack──▶ canceled
  │                                     └── complete / fail (취소를 보기 전에 끝난 경우 실제 결과 기록)
  └──────cancel──────────────────────────────────────────────▶ canceled
```

전환표는 `src/tasks/task-state.ts` 한 곳에 있고, 모든 전환은 `UPDATE ... WHERE status IN (...) RETURNING *` 형태의 compare-and-set으로 적용됩니다.

### Lease

- claim 시 `leaseExpiresAt = now + CONTROLLER_LEASE_SECONDS`(compose 기본 300초), heartbeat마다 연장
- Worker의 heartbeat/complete/fail/cancel-ack는 **lease가 유효할 때만** 적용 (`lease_expires_at > now`). 만료 후에는 409 → Worker는 소유권을 잃은 것으로 보고 실행을 중단
- `LeaseReaper`가 시작 시 한 번, 이후 `CONTROLLER_LEASE_SWEEP_SECONDS`(15초)마다 만료된 `running`/`cancel_requested` 작업을 `failed`로 전환. `error`는 `lease_expired:`로 시작
- 만료된 코딩 작업은 **자동으로 재실행하지 않음** (부분 변경이 남아 있을 수 있으므로 확인 후 새 작업으로 등록)

### PowerShell 예시

```powershell
$t = @{}; Get-Content secrets\controller.env | % { if ($_ -match '^([A-Z_]+)=(.+)$') { $t[$Matches[1]] = $Matches[2] } }
$admin = @{ Authorization = "Bearer $($t.CONTROLLER_ADMIN_TOKEN)" }
$task = Invoke-RestMethod -Method Post http://127.0.0.1:8700/tasks -Headers $admin `
  -ContentType 'application/json' -Body (@{ agent = 'claude'; projectId = 'sandbox'; instruction = 'README 정리' } | ConvertTo-Json)
Invoke-RestMethod "http://127.0.0.1:8700/tasks/$($task.id)" -Headers $admin
Invoke-RestMethod -Method Post "http://127.0.0.1:8700/tasks/$($task.id)/cancel" -Headers $admin
```

## 데이터

- SQLite 파일: 컨테이너 `/var/lib/controller/controller.db`, Docker named volume `personal_ai_controller-data`
- Windows bind mount 대신 named volume을 쓰는 이유: Windows 호스트 디렉터리 공유에서는 SQLite의 파일 잠금과 WAL 공유 메모리가 신뢰할 수 없음
- PRAGMA: `journal_mode=WAL`, `synchronous=FULL`(커밋된 상태 변경은 전원 차단에도 유지), `busy_timeout=5000`
- 스키마: `src/database/migrations.ts`, 버전은 `PRAGMA user_version` (v2: `created_by`, `idempotency_key` 컬럼 추가. 기존 데이터 유지)

백업 (실행 중에도 일관된 스냅샷):

```powershell
docker exec personal_ai-controller-1 node -e "const D=require('better-sqlite3');const db=new D('/var/lib/controller/controller.db');db.backup('/var/lib/controller/backup.db').then(()=>db.close())"
docker cp personal_ai-controller-1:/var/lib/controller/backup.db .\data\controller-backup.db
docker exec personal_ai-controller-1 rm /var/lib/controller/backup.db
```

> `docker compose down -v`는 이 볼륨을 삭제합니다. `-v`를 쓰지 마세요.

## 보안

- Docker socket 미마운트, 호스트 명령 실행 코드 없음, `projectId`는 정규식(`^[a-z0-9][a-z0-9_-]{0,63}$`) + 레지스트리로만 해석 (경로로 쓰지 않음)
- 전역 Guard: `@Public()`이 아닌 모든 경로는 인증 필요, `@RequireRole()`이 없으면 admin 전용 (fail-closed)
- 토큰은 SHA-256 다이제스트로 상수 시간 비교, 설정 오류 메시지·로그에 토큰 값을 쓰지 않음, instruction 내용도 로그에 남기지 않음
- 컨테이너: `node`(uid 1000) 사용자, read-only rootfs, `cap_drop: ALL`, `no-new-privileges`, 512MB / 1 CPU / 256 pids
- 포트는 `127.0.0.1`에만 바인딩. Worker와 Hermes는 서로 다른 네트워크에 있어 Worker → Hermes 직접 접근은 불가
- 입력 검증: whitelist + forbidNonWhitelisted, instruction ≤ 20,000자, result/error ≤ 500,000자, JSON body ≤ 2MB
- `.npmrc`의 `ignore-scripts=true`: 의존성 install script 실행 차단 (better-sqlite3는 prebuilt 바이너리 포함)

## 현재 한계 (MVP)

- 자동 재시도/재큐잉 없음 (의도된 정책). lease 만료로 실패한 작업은 workspace를 확인한 뒤 새 작업으로 다시 등록
- Worker 최근 접속 시각은 메모리 저장 → 재시작 시 초기화
- 승인(approval) 흐름 없음. 추가 시 `task-state.ts`에 `awaiting_approval` 상태와 `approve`/`reject` 전환을 넣고, claim은 queued만 가져가므로 그대로 동작
- 단일 인스턴스 전제 (SQLite). 토큰 교체 시 Controller 재시작 필요. env_file 값은 `docker inspect`로 보일 수 있음 (Docker secrets로 전환 가능)
- 이전 단계에서 만든 `secrets/hermes.controller.env`(admin 토큰 사본, 미사용)는 2026-11-25에 삭제했습니다. 다시 만들지 마세요
- Worker는 작업마다 `GET /internal/projects`로 Registry를 확인합니다(활성, allowedAgents, allowCodeChanges, syncStatus, cachedHeadSha). worker view에는 remote URL이 없습니다. GitHub 프로젝트는 repo-sync 캐시로만 체크아웃됩니다 (services/worker/README.md)

## PostgreSQL로 전환하려면

`TaskRepository`(비동기 인터페이스)를 구현하는 `PostgresTaskRepository`를 만들고 `tasks.module.ts`의 `useClass`만 교체합니다.
claim은 다음과 같이 옮기면 동일한 보장을 가집니다.

```sql
UPDATE tasks SET status = 'running', claimed_by = $1, ...
WHERE id = (SELECT id FROM tasks WHERE agent = $2 AND status = 'queued'
            ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1)
RETURNING *;
```

## 개발

```powershell
cd services\controller
npx npm@11 ci        # 호스트의 npm 10.9.x는 vitest peer dependency 처리 버그로 실패함
npm run build        # tsc → dist/
npm test             # vitest: 단위 + e2e (SQLite :memory:/임시 파일, 외부 의존 없음)
```

Docker 이미지 빌드 시에도 build 단계에서 `npm test`가 실행되며, 실패하면 이미지가 만들어지지 않습니다.
