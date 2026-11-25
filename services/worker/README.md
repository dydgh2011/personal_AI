# Personal AI — Agent Worker (Polling Client)

Worker 컨테이너 안에서 장기 실행되는 Node.js 프로세스입니다. Controller에서 자기 agent의 작업을 가져와(pull)
코딩 CLI(Claude Code 또는 Codex)를 실행하고 결과를 보고합니다. 런타임 의존성은 없습니다(Node 22 내장 모듈만 사용).

```text
loop:  POST /internal/workers/claim ──(없음)──▶ 5초 대기
          │ task
          ▼
       workspace.prepare      /workspace/<projectId> 검증 → .worktrees/<taskId> (branch <agent>/task-<taskId>)
          ▼
       claude -p … | codex exec --json … -   (stdin=instruction, shell 없음)   ◀── 10초마다 heartbeat (lease 연장, 취소 감지)
          ▼
       workspace.finalize     변경사항을 작업 브랜치에 커밋 (성공/실패/취소 모두; 삭제 없음)
          ▼
       complete | fail | cancel-ack   (결과는 agent-worker/v1 JSON)
```

## 구조

```text
src/
├── main.ts               설정 → 의존성 조립 → SIGTERM 처리
├── worker.ts             poll loop, 재연결 backoff, 재시작 시 중단 작업 복구
├── executor.ts           작업 1건: workspace → CLI 실행 + heartbeat → 커밋 → 보고 (agent 무관)
├── controller-client.ts  /internal API 클라이언트 (Bearer 토큰, 재시도 가능 오류 구분)
├── process-runner.ts     spawn(shell:false), stdin 전달 후 종료, 시간/출력 제한, 프로세스 그룹 SIGTERM→SIGKILL
├── workspace.ts          projectId 검증, worktree/branch, 커밋 (hook 비활성화, merge/push 없음)
├── state.ts              단일 인스턴스 lock, 현재 작업 기록, 로컬 보고서
├── backoff.ts / logger.ts / config.ts
├── runners/
│   ├── agent-runner.ts   AgentRunner 인터페이스 + 환경변수 allowlist
│   ├── claude-runner.ts  Claude Code 인자 구성과 JSON 결과 해석
│   └── codex-runner.ts   codex exec 인자/권한 프로필 구성과 JSONL 이벤트 해석
└── testing/              FakeController (실제 API 계약을 구현한 인메모리 서버), 헬퍼
test-fixtures/fake-claude.mjs   Claude CLI 출력 형식을 흉내 내는 Mock CLI
test-fixtures/fake-codex.mjs    codex exec --json 형식의 Mock CLI (stdin EOF까지 대기)
scripts/submit-task.ps1         PowerShell에서 작업 등록·대기·결과 조회
scripts/verify-worker.ps1       실행 중인 Worker 검증 (-Agent claude|codex, -RealTask 시 실제 1회 호출)
scripts/codex-sandbox-probe.mjs codex-worker 안에서 샌드박스 탈출 시도 검사 (모델 호출 없음)
```

## Claude Code 실행 권한 (Claude Code 2.1.310에서 확인)

```text
claude -p --output-format json --restricted --tools Read,Edit,Write,Glob,Grep
       --permission-mode acceptEdits --permission-prompts none --strict-mcp-config
       --disable-slash-commands --session-id <taskId> --append-system-prompt <무인 실행 안내>
```

| 옵션 | 효과 |
|---|---|
| `--restricted` | Bash 등 코드 실행 도구와 WebFetch 제거, 파일 도구를 작업 디렉터리로 제한, user/project 설정 무시, bypass 거부, git/설정 파일 쓰기는 사람 승인 필요 |
| `--tools` | 쓰기 가능 프로젝트: `Read,Edit,Write,Glob,Grep` / 읽기 전용 프로젝트: `Read,Glob,Grep` |
| `--permission-prompts none` | 승인이 필요한 동작은 기다리지 않고 자동 거부 (`permissionDenials`로 보고) |
| `--strict-mcp-config`, `--disable-slash-commands` | MCP 서버, skill/command 실행 차단 |

사용하지 않는 것: `--dangerously-skip-permissions`, `bypassPermissions`, `--bare`(OAuth 대신 API Key 인증만 사용하게 됨).
CLI 프로세스의 환경변수는 allowlist(HOME, PATH, LANG 등)라서 `CONTROLLER_WORKER_TOKEN`과 `ANTHROPIC_API_KEY`는 전달되지 않습니다.
Instruction은 argv가 아니라 stdin으로 전달합니다(`--`로 시작하는 문장이 옵션으로 해석되지 않음).

## Codex 실행 권한 (codex-cli 0.164.0에서 확인)

```text
codex exec --json --color never --ephemeral --ignore-user-config --ignore-rules
     -c default_permissions="agent-worker" -c permissions.agent-worker={…}
     -c approval_policy="never" -c web_search="disabled" (+ update check/analytics/feedback/history off)
     --disable apps,plugins,remote_plugin,hooks,browser_use,computer_use,image_generation,
               daemon_auto_start,skill_mcp_dependency_install,tool_suggest,goals,memories
     -C <worktree> [--model <WORKER_MODEL>] -          ← 지시문은 stdin, 전달 후 stdin 종료
```

권한 프로필 `agent-worker` (bubblewrap + seccomp로 강제, 셸 명령과 apply_patch 모두 적용):

| 경로 | 권한 |
|---|---|
| 작업 worktree (`:workspace_roots`) | 쓰기 (읽기 전용 프로젝트는 읽기). 안의 `.git`/`.codex`/`.agents`는 읽기 전용 |
| `:minimal` (/usr, /bin, /etc 등 도구 실행에 필요한 경로) | 읽기 |
| 그 외 전체 (`:root`), `/tmp`, `$TMPDIR` | 거부. `~/.codex/auth.json`, Worker 상태, main 체크아웃, 다른 worktree 포함 |
| 네트워크 | 차단 (별도 network namespace) |

- 모델이 실행한 명령은 별도 pid namespace에서 돌아 Worker 프로세스와 그 환경변수(`CONTROLLER_WORKER_TOKEN`)를 볼 수 없습니다.
- worktree의 git 메타데이터는 main 체크아웃의 `.git` 안에 있어 Codex는 git 명령을 쓸 수 없습니다. 커밋은 Worker가 합니다.
- 사용하지 않는 것: `--dangerously-bypass-approvals-and-sandbox`, `danger-full-access`, `--dangerously-bypass-hook-trust`, API Key 인증.
- 사용 모델은 JSONL에 나오지 않습니다. `WORKER_MODEL`을 지정하지 않으면 보고서에 `model: "cli-default"`로 남습니다.

**Docker에서의 bubblewrap:** Docker 기본 seccomp 프로필은 user namespace 생성을 막아 Codex 샌드박스가 동작하지 않습니다
(`bwrap: No permissions to create a new namespace`). codex-worker에만
`images/coding-worker/seccomp/codex-worker.json`(Docker 기본 프로필 + `clone/unshare/mount/umount2/pivot_root`)을 적용합니다.
capability 추가나 privileged는 없고, 컨테이너는 계속 `cap_drop: ALL` + `no-new-privileges`입니다.
프로필 재생성: `node images/coding-worker/seccomp/build-codex-profile.mjs`.

**arg0 경고:** `failed to clean up stale arg0 temp dirs`는 Windows bind mount가 flock을 지원하지 않아 생기는 무해한 경고였고,
`~/.codex/tmp`를 tmpfs로 마운트해 해결했습니다.

샌드박스 검사 (모델 호출 없음, Runner와 같은 인자를 `codex sandbox`에 적용):

```powershell
Get-Content -Raw services\worker\scripts\codex-sandbox-probe.mjs | docker exec -i personal_ai-codex-worker-1 node -
```

## 작업 격리

- **허용 프로젝트는 Controller Registry가 결정**합니다. Worker는 작업마다 `GET /internal/projects`를 조회합니다.
  - 목록에 없으면(미등록, 비활성, 다른 agent 전용) CLI를 실행하지 않고 실패로 보고합니다.
  - 쓰기 여부는 `allowCodeChanges`로 정합니다.
  - Registry를 읽지 못하면 실행하지 않습니다(fail-closed). 등록·변경은 재시작 없이 다음 작업부터 반영됩니다.
- `WORKER_PROJECTS` / `WORKER_WRITABLE_PROJECTS`는 설정했을 때만 **추가 제한**으로 동작합니다(기본은 미설정).
- local 프로젝트: projectId 정규식 검사 → `realpath`가 `/workspace` 안인지 확인(symlink 탈출 차단) → git 저장소 루트인지 확인
- `projectId`가 없는 작업은 CLI를 실행하지 않고 실패 처리
- 쓰기 작업은 `/workspace/.worktrees/<taskId>`의 전용 worktree(branch `claude/task-<taskId>` 또는 `codex/task-<taskId>`)에서만 실행. main 체크아웃은 건드리지 않음
- 같은 작업의 worktree가 이미 있으면 실행 거부(중복 실행 방지)
- 결과는 Worker가 직접 커밋(`core.hooksPath=/dev/null`, `--no-verify`). **merge, push, worktree 삭제는 하지 않음**
- `sandbox`가 없으면 첫 시작 시 `git init -b main` + README 커밋으로 생성

### 프로젝트별 설정 (Registry v7, `src/project-settings.ts`)

- `agentInstructions.rules`: 고정 프롬프트(`UNATTENDED_PROMPT`) **뒤에** 붙입니다(Claude는 `--append-system-prompt`, Codex는 stdin의 작업 앞).
- `agentInstructions.forbiddenPaths`: 커밋 직전에 기준 커밋과 비교해 바뀐 경로를 검사합니다. 하나라도 걸리면 `git reset` 후 **커밋하지 않고** 작업을 실패로 보고합니다(`workspace.blockedPaths`). 읽기는 막지 못합니다(프롬프트로만 요청).
- `commitStyle`: `auto`는 작업 기준 커밋까지의 최근 제목 50개를 읽어(읽기 전용) 코드가 정해진 문장으로 스타일을 설명합니다. 저장소의 커밋 문구는 프롬프트에 넣지 않습니다(보고서 `workspace.commitStyle.examples`에만). 에이전트가 마지막 줄에 `COMMIT_MESSAGE: …`를 쓰면 성공한 작업에 한해 그 한 줄(100자 이내)을 커밋 제목으로 씁니다. `off`(기본)는 예전 메시지 그대로입니다.
- 커밋 작성자·커미터는 항상 `<agent>-worker`입니다(POLICY B). Registry의 `commitAuthor`는 Worker에 오지 않습니다. 자세한 내용: `docs/coding-agent-settings.md`.
- Registry 값이 범위를 벗어나면 실행하지 않습니다(fail-closed). 옛 Controller가 값을 보내지 않으면 "설정 없음"입니다.

### GitHub 프로젝트 (Registry `source: github`)

```text
/repo-cache/<id>.git                 repo-sync가 만든 bare 미러 (Worker에는 읽기 전용 마운트)
   │ file:// fetch (객체 복사, alternates·hardlink 없음)
/workspace/repos/<id>.git            Worker 전용 bare 저장소, 원격 브랜치는 refs/remotes/origin/*
   │ worktree add <cachedHeadSha>
/workspace/.worktrees/<taskId>       작업 브랜치 <agent>/task-<taskId>, 결과 커밋
```

- **실행 조건**: `syncStatus=synced`, `cachedHeadSha`가 캐시에 있음, 캐시가 캐시 루트 안의 bare 저장소, 크기 ≤ `WORKER_MAX_REPO_BYTES`. 하나라도 어긋나면 CLI를 실행하지 않고 실패.
- **Git URL·경로**: 작업이나 Registry에서 Git URL이나 경로를 받지 않습니다. 저장소는 프로젝트 id로만 선택합니다.
- **보안 설정**: `core.hooksPath=/dev/null`, `core.symlinks=false`(symlink는 링크 문자열이 든 일반 파일), submodule 미초기화, fsck, `GIT_ALLOW_PROTOCOL=file`, 전역·시스템 git 설정 무시. symlink·submodule 개수는 보고서 `workspace.notes`에 기록됩니다.
- **결과 보존**: 실패나 취소된 작업도 작업 브랜치에 커밋해 보존합니다. 기본 브랜치, 캐시, GitHub에는 쓰지 않습니다(Worker에는 GitHub 인증 정보가 없음).
- **`--shared`를 쓰지 않는 이유**: 캐시가 강제 갱신·gc되면 alternates로 빌려 쓰던 객체가 사라져 작업 커밋이 깨질 수 있습니다. 독립 저장소는 Worker당 한 벌이고(Hello-World 기준 캐시 68KB, Worker 저장소 124KB) 작업마다 worktree만 늘어납니다.

호스트에서 보기: `D:\personal_ai\workspaces\claude\.worktrees\<taskId>\`, `D:\personal_ai\workspaces\codex\.worktrees\<taskId>\`.
Claude와 Codex는 홈(인증)과 `/workspace`를 따로 씁니다(`data/{claude,codex}-home`, `workspaces/{claude,codex}`).
worktree의 `.git` 파일은 컨테이너 경로(`/workspace/...`)를 가리키므로 git 명령은 컨테이너 안에서 실행하세요.

```powershell
docker compose -f compose.yaml -f compose.workers.yaml -f compose.controller.yaml exec claude-worker git -C /workspace/sandbox log --oneline --all --graph
```

## 장애 처리

| 상황 | 동작 |
|---|---|
| Controller 연결 실패 (claim) | 0.5초~60초 지수 backoff(jitter)로 재시도, 복구되면 로그 |
| Heartbeat 일시 실패 | 경고만 남기고 작업 계속, 다음 주기에 재시도 |
| Heartbeat 409/404 (lease 만료, 소유권 상실) | CLI 종료, 보고하지 않음(`lost`) |
| 취소 요청 (`cancelRequested`) | CLI 프로세스 그룹 SIGTERM → 10초 후 SIGKILL → 변경사항 커밋 → `cancel-ack` |
| 실행 시간 초과 (기본 30분) | CLI 종료 → `fail` (`timedOut: true`) |
| 보고 실패 (5xx/네트워크) | backoff로 최대 8회 재시도. 실패해도 `~/.agent-worker/reports/<id>.json`에 보존 |
| Worker 정상 종료 (SIGTERM) | CLI 종료 → 커밋 → `fail`(`interrupted`) |
| Worker 강제 종료 (SIGKILL, OOM, 정전) | 재시작 시 `current-task.json`을 보고 커밋 후 `fail`(`interrupted`). 재실행하지 않음 |
| Worker가 돌아오지 않음 | Controller가 lease(300초) 만료 후 `failed`(`lease_expired:`) 처리. 재큐잉하지 않음 |
| 두 번째 Worker 프로세스 | `~/.agent-worker/worker.lock` 때문에 시작 거부 |

## 보고 형식 (`result` / `error` 필드의 JSON 문자열)

```json
{
  "format": "agent-worker/v1", "taskId": "…", "agent": "claude", "workerId": "claude-worker", "attempt": 1,
  "outcome": "completed | failed | canceled | interrupted",
  "message": "Claude의 최종 답변 또는 실패 사유",
  "exitCode": 0, "signal": null, "durationMs": 8948, "timedOut": false, "stdoutTruncated": false,
  "stderrTail": "…마지막 4000자…",
  "agentDetails": { "subtype": "success", "numTurns": 3, "sessionId": "<taskId>", "permissionDenials": [], "tokens": {…} },
  "workspace": { "projectId": "sandbox", "mode": "write", "path": "/workspace/.worktrees/<id>",
                 "branch": "claude/task-<id>", "baseCommit": "…", "commit": "…",
                 "changedFiles": [{ "status": "A", "path": "index.html" }] },
  "workspaceError": null
}
```

## 설정 (compose.workers.yaml)

| 변수 | 기본값 | 설명 |
|---|---|---|
| `CONTROLLER_URL`, `CONTROLLER_WORKER_TOKEN` | (필수) | `secrets/<agent>-worker.controller.env` |
| `WORKER_AGENT` | `claude` | runner 선택 |
| `WORKER_PROJECTS` / `WORKER_WRITABLE_PROJECTS` | (미설정) | Registry 위에 더하는 추가 제한(선택) |
| `WORKER_REPO_CACHE` | `/repo-cache` | repo-sync 캐시 (읽기 전용 마운트) |
| `WORKER_MAX_REPO_BYTES` | 1 GiB | 이보다 큰 캐시는 거부 |
| `WORKER_POLL_INTERVAL_SECONDS` | `5` | 작업이 없을 때 claim 간격 |
| `WORKER_HEARTBEAT_SECONDS` | `10` (compose) | heartbeat 주기 = 취소 감지 지연. lease의 1/3보다 짧아야 함 |
| `WORKER_TASK_TIMEOUT_SECONDS` | `1800` | 작업당 최대 실행 시간 |
| `WORKER_MAX_OUTPUT_BYTES` | 2 MiB (codex compose: 8 MiB) | 수집할 stdout 최대 크기. 넘으면 앞/뒤 절반씩 보존 (최종 결과는 끝에 있음) |
| `WORKER_MODEL` | (CLI 기본값) | `--model` |
| `WORKER_AGENT_COMMAND` | `["<agent>"]` | 실행 파일 (JSON 배열, 테스트용) |

새 프로젝트 추가 (Worker 재시작 불필요):
- GitHub: `POST /projects` → `servicesepo-syncscriptssync-project.ps1 -ProjectId <id>` → `PATCH /projects/<id>` `{ "enabled": true, "allowCodeChanges": true }`
- local: Registry에 등록·활성화하고, 각 Worker의 `workspaces/<agent>/<id>`에 git 저장소를 둡니다.

## 개발

```powershell
cd services\worker
npx npm@11 ci
npm run build
npm test          # node:test, Mock CLI + FakeController, 모델 호출 없음 (Docker 빌드에서도 실행)
```

## 새 Agent 추가

`runners/<agent>-runner.ts`에 `AgentRunner`(`buildInvocation`, `interpret`)를 구현하고 `main.ts`의 `createRunner`에 연결합니다.
나머지(poll loop, heartbeat, 취소, workspace, lock, 복구, 보고)는 그대로 재사용됩니다. Codex가 이 방식으로 추가되었습니다.
