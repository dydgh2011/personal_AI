# Learning Service (AI Learning OS)

학습 분야(Domain), 아이디어(Idea Inbox), 목표(Goal), 버전이 있는 학습 로드맵, AI 로드맵 초안을 관리한다. 개발 프로젝트 로드맵(`docs/ROADMAP.md`)과는 **별도의 데이터**다.

```
Browser ─▶ Dashboard (/learning, 기존 로그인·CSRF) ──learning-internal──▶ learning (이 서비스, learning-data 볼륨)
                                                                         └─ learning-egress ─▶ AI 제공자 (설정 후에만)
```

## 규칙
- **변경은 모두 제안을 거친다.** 수동 편집, AI 초안, 복원, 가져오기 모두 proposal을 만들고, 소유자가 차이를 확인해 승인해야 새 버전이 생긴다.
  - 승인은 base version을 검사하는 조건부 UPDATE 한 번으로 처리한다. 그 사이 다른 버전이 생겼으면 409(`VERSION_CONFLICT`)다.
- **승인된 버전은 불변이다.** 복원하면 이전 내용으로 새 버전을 만든다.
- **선수지식 그래프는 DAG다.** 직접 순환과 간접 순환 모두 422(`PREREQUISITE_CYCLE`)이며, 응답에 순환 경로가 포함된다.
- **AI 초안은 항상 proposal로만 저장한다.** 검증에 실패하면 `invalid` 상태가 되고, 현행 버전과 목표 Deadline(사용자 고정값)은 바뀌지 않는다. AI가 제안한 자료는 `ai_suggested`(미검증)로 표시한다.
- **삭제 대신 보관한다.** 분야와 아이디어는 archived 상태로 바꾸며, 기록은 지우지 않는다.
- **감사 로그**: 모든 변경에 대해 주체, 동작, 대상과 내용의 hash를 남긴다(내용 원문은 저장하지 않음).

## 학습 일정과 복습

Dashboard의 `/learning/planner`에서 Toronto 시간으로 오늘 또는 시작일부터 7일을 미리 봅니다. 주간 가용 시간과 Kelly의 바쁜 시간을 겹쳐 보고, 미완료 과제와 복습을 30분 또는 60분 블록에 배치합니다. 남은 과제는 다음 계획에도 포함됩니다. 고정 마감은 유지합니다. 복습일은 마지막 검증과 검증 수준에서 계산합니다. 오래된 검증을 갱신하려면 새 근거로 숙련도를 다시 검증합니다.

`PATCH /schedule/availability`는 Dashboard만 사용할 수 있습니다. `POST /schedule/propose`는 Planner에 승인 대기 시안을 만듭니다. 시안 번호를 Kelly에서 열어 승인할 블록을 고릅니다. 기존 Planner에서 승인한 블록이 할 일과 Kelly 캘린더 일정으로 등록됩니다.

연결 설정은 `LEARNING_PLANNER_URL`, `LEARNING_PLANNER_KEY_FILE`, `LEARNING_BROKER_KEY_FILE`입니다. Learning의 secret 초기화가 `learning-planner.key`와 `learning-broker.key`를 생성합니다. Planner와 Learning에 첫 번째 파일을, Hermes Broker와 Learning에 두 번째 파일을 각각 읽기 전용으로 마운트합니다. 연결은 각 서비스 쌍의 내부 네트워크를 사용합니다. 호출자 키가 설정되면 브로커는 허용된 분야·로드맵·일정 조회와 일정 시안 생성만 호출할 수 있습니다.

DB v3로 갱신하기 전에 `scripts\stack.ps1 backup learning`을 실행합니다. JSON 내보내기에 직접 저장한 주간 가용 시간이 포함되며 v1·v2 내보내기도 가져올 수 있습니다.

## 설치와 실행
```powershell
node services/learning/scripts/init-secrets.mjs
#   → secrets/learning.env (LEARNING_DASHBOARD_TOKEN과 AI 설정 자리)
#   → secrets/learning-dashboard.token (Dashboard에만 mount)
#   → secrets/learning-ai.key (빈 파일, AI 키를 넣을 자리)
$F = "-f compose.yaml -f compose.workers.yaml -f compose.controller.yaml -f compose.github.yaml -f compose.dashboard.yaml -f compose.publisher.yaml -f compose.test-runner.yaml -f compose.learning.yaml -f compose.notifier.yaml -f compose.planner.yaml -f compose.knowledge.yaml -f compose.llm.yaml -f compose.school.yaml".Split(' ')
docker compose @F up -d --build --no-deps learning dashboard
```

## AI 초안 켜기 (나중에 소유자가 설정)
1. `secrets/learning.env`의 주석을 풀어 다음 값을 채운다.
   - `LEARNING_AI_PROVIDER=gemini`
   - `LEARNING_AI_MODEL`
   - `LEARNING_AI_MONTHLY_BUDGET_USD`: 월 상한. 넘지 않도록 호출 전에 최악의 비용으로 검사한다.
   - `LEARNING_AI_INPUT_USD_PER_MTOK`, `LEARNING_AI_OUTPUT_USD_PER_MTOK`: 비용 계산용 단가
2. API 키를 `secrets/learning-ai.key`에 한 줄로 넣는다. 키는 헤더로만 보내며 URL이나 로그에는 남기지 않는다.
3. `docker compose @F up -d --no-deps --force-recreate learning`으로 재생성한다.

설정 전에는 `PROVIDER_NOT_CONFIGURED`를 돌려준다. Dashboard Overview에 빠진 설정 이름이 표시된다.

## 백업과 복원
```powershell
node services/learning/scripts/backup.mjs                                    # data/backups/learning/ (최근 14개 보관)
node services/learning/scripts/restore.mjs data/backups/learning/<file>.db   # learning 서비스만 중지했다가 다시 시작
```
JSON 내보내기는 Dashboard의 `Export JSON`(또는 `GET /export`)으로 한다. `POST /import`는 비어 있는 DB에만 복원하며, 모든 버전의 내용 hash를 다시 검증한다.

## 테스트
- `npm test`(Docker 빌드 중에도 실행): DAG, diff, hash 단위 테스트와 e2e(인증, 분야, 아이디어, 버전, 409, 422, 복원, Mock Gemini, 예산, 타임아웃, 429, export/import, 재시작 후 유지)
- 실제 브라우저: `npm install --prefix services/dashboard/browser-test` 후 `node services/dashboard/browser-test/learning.mjs`
  - `[E2E]` 테스트 데이터를 만든다. 실행 전에 backup을 받고, 끝나면 restore로 되돌린다.
