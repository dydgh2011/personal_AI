# hermes-broker

Hermes와 Task Controller 사이의 인증 정보 중계 서비스입니다. Hermes 전용(delegator) Controller 토큰은 이 컨테이너에만
있고(compose secret `/run/secrets/controller_token`), Hermes는 토큰 없이 `http://hermes-broker:8080`을 호출합니다.

허용 경로 (그 외는 브로커가 404/405로 직접 응답, Controller에 전달하지 않음):

| Method | Path | 비고 |
|---|---|---|
| GET | `/health` | 브로커 자체 |
| GET | `/system/status` | |
| GET | `/projects`, `/projects/:id`, `/projects/:id/status?refresh=` | Controller가 활성 프로젝트만 보여 줌 |
| GET | `/tasks?status&agent&limit&offset`, `/tasks/:uuid` | 쿼리는 허용 목록·검증 |
| POST | `/tasks` | `{agent, projectId, instruction}`만, 지시문 ≤ 20,000자, body ≤ 64KB. Idempotency-Key가 없으면 내용 해시로 생성 |
| POST | `/tasks/:uuid/cancel` | |

- 새 작업 속도 제한: `BROKER_SUBMIT_PER_MINUTE`(5), `BROKER_SUBMIT_PER_HOUR`(30). 중복 재요청(200 replay)은 세지 않음
- 응답에 토큰 문자열이 섞이면 `[redacted]`로 바꿈(방어용). 감사 로그는 JSON 한 줄: 작업 ID, agent, 프로젝트, 지시문 글자 수(내용 없음), 상태 코드
- Node 22 내장 모듈만 사용, 비root, read-only rootfs, cap_drop ALL, 128MB / 0.5 CPU / 64 pids, 호스트 포트 없음

```powershell
cd services\hermes-broker; npx npm@11 ci; npm run build; npm test   # 6 tests
docker logs personal_ai-hermes-broker-1    # 감사 로그
```
