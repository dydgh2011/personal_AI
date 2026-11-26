# hermes-broker

Hermes 도구는 `X-Broker-Key`로 인증한 뒤 `http://hermes-broker:8080`을 호출합니다. 브로커가 고정된 경로를 검증하고 각 서비스 호출에 해당 자격을 붙입니다. 브로커는 유효한 클라이언트 키 파일이 있어야 시작합니다. `GET /health`는 상태 점검용으로 공개합니다. Controller delegator 토큰은 브로커에만 둡니다.

허용 경로 (그 외는 브로커가 404/405로 직접 응답, Controller에 전달하지 않음):

| Method | Path | 비고 |
|---|---|---|
| GET | `/health` | 브로커 자체 |
| GET | `/system/status` | |
| GET | `/projects`, `/projects/:id`, `/projects/:id/status?refresh=` | Controller가 활성 프로젝트만 보여 줌 |
| GET | `/tasks?status&agent&limit&offset`, `/tasks/:uuid` | 쿼리는 허용 목록·검증 |
| POST | `/tasks` | `{agent, projectId, instruction}`만, 지시문 ≤ 20,000자, body ≤ 64KB. Idempotency-Key가 없으면 내용 해시로 생성 |
| POST | `/tasks/:uuid/cancel` | |

- 인증 키 파일은 `BROKER_CLIENT_KEY_FILE`에서 지정하며 기본 경로는 `/run/secrets/broker_client_key`입니다. `services/hermes-broker/scripts/add-client-key.mjs`는 없는 파일만 만듭니다. Hermes 내에서 같은 Unix 사용자 권한으로 실행하는 코드에는 파일 접근 권한이 있을 수 있습니다.
- 새 작업 속도 제한: `BROKER_SUBMIT_PER_MINUTE`(5), `BROKER_SUBMIT_PER_HOUR`(30). 중복 재요청(200 replay)은 세지 않음
- 응답에 토큰 문자열이 섞이면 `[redacted]`로 바꿈(방어용). 감사 로그는 JSON 한 줄: 작업 ID, agent, 프로젝트, 지시문 글자 수(내용 없음), 상태 코드
- Node 22 내장 모듈만 사용, 비root, read-only rootfs, cap_drop ALL, 128MB / 0.5 CPU / 64 pids, 호스트 포트 없음

## planner 경로

`/planner/...`는 planner의 고정 경로만 `X-Planner-Key`를 붙여 넘깁니다(`src/broker.ts`의 `plannerRoutes`). 2026-11-26 추가: `POST /planner/todos/:uuid/schedule`, `POST /planner/reports`, `GET /planner/pace?days=`, `GET /planner/agenda?days=`. 쓰기(POST)는 분당 30회로 제한하되, 아무것도 쓰지 않는 겹침 미리보기(`"dryRun": true`)는 세지 않습니다.

## 학습 조회와 일정 시안

| Method | Path |
|---|---|
| GET | `/learning/domains`, `/learning/roadmaps`, `/learning/roadmaps/:uuid` |
| GET | `/learning/schedule/status` |
| GET | `/learning/schedule` (`date=YYYY-MM-DD`, `period=day\|week` 선택) |
| POST | `/learning/schedule/propose` (`date`, `period`만 허용) |

배포할 때 `LEARNING_URL=http://learning:3000`과 `LEARNING_KEY_FILE=/run/secrets/learning_key`를 설정하고 Learning과 브로커에 전용 내부망과 공용 키 파일을 연결합니다. Learning의 `init-secrets.mjs`가 그 키 파일을 제공합니다. 브로커는 요청에 `X-Learning-Key`만 붙이고 `/learning` 접두어를 뗍니다. Learning에서 각 요청의 권한을 확인하고 최종 승인 전까지 플래너 시안을 보관합니다.

연결 설정이 없으면 학습 경로는 503을 반환합니다. 기본 한도는 조회 분당 60회(`BROKER_LEARNING_QUERIES_PER_MINUTE`), 시안 분당 5회(`BROKER_LEARNING_PROPOSALS_PER_MINUTE`), 시안 본문 1 KiB입니다. 감사 로그에는 인증된 호출자, 경로, 명령과 상태를 적습니다.

```powershell
cd services\hermes-broker
npm ci
npm run build
npm test
docker logs personal_ai-hermes-broker-1    # 감사 로그
```
