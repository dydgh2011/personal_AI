# Personal AI — Hermes ↔ Task Controller 연동

Hermes(관리 AI)가 자연어 요청을 받아 Claude/Codex Worker에 코딩 작업을 위임하고 결과를 보고합니다.
Hermes는 직접 코딩하지 않으며, **Controller 인증 정보를 갖고 있지 않습니다.**

```text
사용자 (Telegram / hermes chat)
   │
Hermes (LLM) ── 네이티브 도구 personal_ai_task (플러그인, Hermes 프로세스 안, 셸·파일 없음)
   │  HTTP, 인증 없음 (ai-internal 네트워크)
   ▼
hermes-broker ── delegator 토큰 보유 (compose secret, 이 컨테이너에만 있음)
   │  고정된 API만 중계, 입력 검증, 작업 생성 속도 제한, 감사 로그(지시문 내용 제외)
   ▼
NestJS Controller ── delegator 역할: 등록·활성 프로젝트만, 자기 작업만
   ▲ pull
claude-worker / codex-worker
```

## 구조

```text
services/hermes-integration/
├── plugins/personal-ai-controller/      Hermes 플러그인 (읽기 전용 마운트 → /opt/data/plugins/personal-ai-controller)
│   ├── plugin.yaml
│   ├── __init__.py                      도구 personal_ai_task 등록 + pre_tool_call 가드 훅
│   ├── controller_client.py             브로커 API 클라이언트 (도구와 운영자 CLI가 공유, 표준 라이브러리만)
│   └── guard.py                         Controller 우회·인증 파일 접근 도구 호출 차단
├── skills/personal-ai-controller/SKILL.md   사용 절차·보고 템플릿 (읽기 전용 마운트, skills.external_dirs)
├── hermes-config/SOUL.personal-ai.md    SOUL.md에 들어가는 역할 규칙
├── scripts/configure-hermes.mjs         data/hermes 설정 적용/점검 (멱등, 백업)
└── tests/                               test_controller.py(클라이언트), test_plugin.py(도구·가드) — 31개
```

## 보안 구조 (Phase A)

| 통제 | 방식 | 강제 여부 |
|---|---|---|
| 인증 정보 분리 | delegator 토큰은 hermes-broker 컨테이너에만 있음. Hermes에는 토큰 파일·환경변수 없음 (`/run/secrets` 없음 확인) | **강제** (다른 컨테이너) |
| API 범위 | 브로커가 허용하는 것: 상태 조회, 프로젝트 조회, 작업 목록/조회/생성/취소. 그 외 경로는 404/405로 브로커가 직접 응답 | **강제** |
| 권한 범위 | Controller가 delegator 역할 검사: 활성 프로젝트, 허용 agent, 자기 작업만. 프로젝트 등록·수정, `/internal/*`, GitHub 조회 불가 | **강제** |
| 남용 방지 | 새 작업 분당 5개, 시간당 30개 (브로커). 내용 해시 기반 Idempotency-Key로 중복 등록 방지 | **강제** |
| 직접 코딩·시스템 제어 차단 | telegram/cli/cron 플랫폼 toolset에서 `terminal`, `code_execution`, `file`, `computer_use`, `delegation` 제거 | **강제** (Hermes 설정; 운영자가 되돌릴 수 있음) |
| 우회 차단 | `pre_tool_call` 가드: 도구가 다시 켜지더라도 docker/claude/codex 실행, CLI 설치, git 원격 작업, 인증 파일 읽기, 통합 파일 수정, 같은 이름 Skill 생성/대체, `delegate_task` 차단 | Hermes 프로세스 안에서 강제 (패턴 기반) |
| 코드·Skill 변조 방지 | 플러그인·Skill을 저장소에서 읽기 전용 마운트 | **강제** |
| 행동 규칙 | SOUL.md, SKILL.md, 도구 설명, 결과의 `userReport`(Controller 사실만으로 만든 보고문) | 유도 (보안 경계 아님) |

## 설치 (재현 방법)

`D:\personal_ai`에서:

```powershell
# 1) Hermes 전용 delegator 토큰 (처음 한 번). 노출이 의심되면 rotate-hermes-token.mjs
node services\controller\scripts\add-hermes-token.mjs
# 2) Controller + 브로커
docker compose -f compose.yaml -f compose.workers.yaml -f compose.controller.yaml up -d --build --no-deps controller hermes-broker
# 3) Hermes 설정 (external skill, 내장 코딩 skill 비활성화, 플러그인 활성화, toolset 축소, SOUL 규칙)
node services\hermes-integration\scripts\configure-hermes.mjs
# 4) Hermes 재생성 (플러그인·Skill 읽기 전용 마운트, 브로커 URL)
docker compose -f compose.yaml -f compose.workers.yaml -f compose.controller.yaml up -d --no-deps hermes
# 점검
node services\hermes-integration\scripts\configure-hermes.mjs --check
```

플러그인 코드를 바꾼 뒤에는 `docker restart personal_ai-hermes-1`이 필요합니다(Python 모듈은 시작 시 로드). SKILL.md는 새 대화부터 반영됩니다.

되돌리기: `config.yaml`의 각 `platform_toolsets` 줄 위에 이전 값이 주석으로 남아 있고, 원본은 `data/hermes/backups/`에 있습니다.

## 도구 `personal_ai_task`

| action | 인자 | 결과 |
|---|---|---|
| `projects` | – | 작업을 받을 수 있는 등록 프로젝트 (Registry) |
| `submit` | `agent`, `project_id`, `instruction`, `new?` | 등록 결과, `duplicate`, `userReport` |
| `status` / `result` / `wait` | `task_id` (`timeout_seconds`) | 상태 / `agent-worker/v1` 해석 / 완료까지 대기 (최대 170초) |
| `list` | `list_agent?`, `status?`, `limit?` | Hermes가 만든 최근 작업 |
| `cancel` | `task_id` | `stopped` vs `cancel_requested` 구분 |
| `system_status` | – | Worker 온라인 여부, 작업 수, 프로젝트 |

- 지시문은 도구 인자로 그대로 전달됩니다. 셸·파일을 거치지 않습니다.
- `submit`은 먼저 Registry를 조회해 미등록·비활성 프로젝트, 허용되지 않은 agent를 명확한 메시지로 거부합니다(Controller도 다시 검증).
- `userReport`: Task ID, 결과, 변경 파일, 브랜치, 커밋, 실행 시간, PC 경로, "테스트 결과 없음"을 Controller 사실로만 채운 한국어 보고문.

운영자 CLI (같은 코드, 브로커 경유):

```powershell
docker exec personal_ai-hermes-1 python3 /opt/data/plugins/personal-ai-controller/controller_client.py projects
docker exec personal_ai-hermes-1 python3 /opt/data/plugins/personal-ai-controller/controller_client.py status <task-id>
```

## 테스트

```powershell
python -m unittest discover -s services\hermes-integration\tests -v
# Hermes 이미지의 Python으로
docker run --rm -e PYTHONDONTWRITEBYTECODE=1 -v "${PWD}\services\hermes-integration:/src:ro" --entrypoint /opt/hermes/.venv/bin/python3 nousresearch/hermes-agent:stable -B -m unittest discover -s /src/tests
```

## 남은 한계

- 브로커 자체는 호출자를 인증하지 않습니다(같은 네트워크의 Hermes 프로세스·브라우저 도구도 호출 가능). 브로커가 주는 능력은 delegator 권한과 같고, 그 범위는 Controller가 제한합니다.
- `pre_tool_call` 가드는 패턴 기반이라 의도적인 난독화를 모두 막지는 못합니다. 주 통제는 toolset 제거와 인증 정보 부재입니다.
- Hermes(LLM)가 쓸 수 있는 `browser`, `web`, `cronjob`, `memory` 등은 유지됩니다. cron 작업도 같은 축소 toolset으로 실행됩니다.
