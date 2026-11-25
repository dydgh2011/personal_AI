# Service Map 수집기

Dashboard의 서비스 지도(ROADMAP 20절)가 읽는 스냅샷을 만든다. **호스트에서** 돈다. Docker CLI가 필요하고, 어떤 컨테이너에도 Docker 소켓을 주지 않는다는 원칙 때문이다.

```text
compose config · docker inspect · catalog.mjs
rules.mjs (소스 코드의 허용 표) · calls.mjs (docker logs, 게이트웨이 집계) ─▶ collect.mjs (호스트) ─▶ data/service-map/service-map.json ─▶ Dashboard (읽기 전용)
```

## 실행

```powershell
node D:\personal_ai\services\service-map\collect.mjs
```

- 프로젝트(`personal_ai`)를 띄울 때 쓴 Compose 파일 목록은 `docker compose ls`에서 읽는다. 파일 목록을 따로 적을 필요가 없다.
- 옵션: `--project <이름>`, `--out <파일>`, `--stdout`(파일 대신 화면에 출력), `--no-calls`(최근 호출 수를 세지 않음).
- 결과 파일은 임시 파일에 쓴 뒤 이름을 바꿔서 한 번에 교체한다. Dashboard가 반쯤 쓴 파일을 읽지 않는다.
- Docker가 꺼져 있으면 실패하고 이전 파일을 그대로 둔다. Dashboard는 `generatedAt`이 오래된 것으로 "수집 멈춤"을 안다.

## 스냅샷에 들어가는 것과 안 들어가는 것

| 들어감 | 안 들어감 |
|---|---|
| 서비스 이름, 설명, 층, 이미지 이름 | 환경 변수 **값** |
| 네트워크와 internal 여부, 포트, 볼륨(프로젝트 안 경로는 상대 경로로) | build args, labels, command, entrypoint |
| 비밀(secret) **이름** | 비밀 파일 경로와 내용 |
| 다른 서비스를 가리키는 URL 변수의 **이름**(예: `CONTROLLER_URL`) | URL 자체, 외부 주소 |
| 상태(실행·헬스·시작 시각·재시작 횟수·종료 코드) | `docker inspect`의 나머지 전부 |

허용 목록 방식이다. 필요한 필드만 골라 복사하므로, Compose에 새 필드가 생겨도 저절로 새어 나가지 않는다.

## 연결의 두 종류

- **links** (부름): 환경 변수 값이 `http://<다른 서비스>:포트`이면 그 서비스를 부른다고 본다.
- **reachable** (닿음): 같은 네트워크에 있으면 서로 닿을 수 있다.
- 둘이 안 맞으면 `findings`에 남는다.
  - `link-unreachable`(경고): 부르는데 닿지 않는다. 고장이다.
  - `reachable-unused`(정보): 닿는데 부르지 않는다. 줄일 수 있는 권한이다.

## 그 밖의 findings

| code | 단계 | 뜻 |
|---|---|---|
| `port-exposed` | 위험 | 포트가 127.0.0.1 밖에 열려 있다 |
| `not-running`, `unhealthy` | 경고 | 컨테이너가 없거나 멈췄다, 헬스체크 실패 |
| `internal-has-internet` | 경고 | 이름은 `*-internal`인데 `internal: true`가 아니다 |
| `writable-root`, `caps-kept` | 정보 | 읽기 전용이 아니다, capabilities를 다 버리지 않았다 |
| `uncatalogued`, `catalog-extra` | 정보 | `catalog.mjs`와 Compose가 서로 다르다 |

## 연결마다 허용된 명령 (2단계, `rules.mjs`)

손으로 적지 않는다. 각 서비스가 **실제로 검사하는 표**를 저장소의 소스 코드에서 읽어 연결선(`links[].allowed`)에 붙인다. 수집기가 있는 저장소(`services/service-map/../..`)를 읽으므로, 운영에서는 스택을 띄운 `D:\personal_ai`와 같은 코드다.

| 연결 | 읽는 곳 | 누가 막나 |
|---|---|---|
| hermes → hermes-broker | `hermes-broker/src/broker.ts`의 `ROUTES`(도우미 `plannerRoutes()` 등 포함) | 받는 쪽(broker) |
| hermes-broker → controller·planner·knowledge·school | 같은 `ROUTES`의 `target` | 보내는 쪽(broker가 이것만 넘김) |
| hermes-broker·school·dashboard → knowledge | `knowledge/src/api.ts`의 `CLIENT_ROUTES`와 경로별 `clients` | 받는 쪽 |
| hermes·learning·school·dashboard → llm-gateway | `llm-gateway/src/config.ts`의 `CLIENT_RIGHTS`(별칭, `/usage`, `/control/paid`). `gateway.ts`에 그 검사가 그대로 있는지도 확인 | 받는 쪽 |
| dashboard·작업자·github-publisher·test-runner·hermes-broker → controller | `controller/src/**/*.controller.ts`의 `@RequireRole`(없으면 admin), 역할↔서비스는 `token-registry.ts`·`app-config.ts` | 받는 쪽 |
| 모든 호출자 → notifier | `notifier/src/notifier.ts`의 이벤트 종류(`PAYLOAD`). 호출자를 구분하지 않는다 | 받는 쪽 |

- 이름, 메서드, 경로 모양만 들어간다. 정규식의 변수 부분은 `:id`, `:project`, `{claude|codex}`처럼 바뀐다. 키, 토큰, 환경 변수 값은 읽지 않는다.
- 파서는 "읽은 개수 = 코드에 있는 개수"를 스스로 확인하고, 다르면 실패한다(조용히 줄어든 지도를 만들지 않음). 실패한 파서는 `rules-extract-failed`로 남고, 나머지는 계속 나온다.
- 테스트가 **실제 소스**를 읽어 알려진 경로(예: `tasks.create`, `planner.day`, 작업자 `POST /internal/workers/claim`)와 안전 성질(Hermes는 승인·거절·게시 불가, 대시보드 knowledge 키는 편집만)을 확인한다. 경로를 바꾸면 테스트도 같이 고친다.
- 아직 못 읽는 연결: `dashboard → learning`(Learning OS의 권한 구조는 아직 파서 없음) → `link-no-rules`(정보).

## 최근 호출 수 (3단계, `calls.mjs`)

최근 24시간, 연결마다(`links[].calls`) 그리고 가능하면 명령마다 센다. **횟수와 상태 코드만** 남는다.

| 출처 | 방법 | 세는 연결 |
|---|---|---|
| hermes-broker 로그 | `docker logs --since 24h` → 요청 한 줄마다 `op`, `status`만 | hermes → broker 전부, broker → controller·planner·knowledge·school (Kelly 요청 전달분) |
| knowledge, planner, notifier 로그 | 같은 방법, `client`(호출자 이름) + `op` + `status` | 그 서비스로 들어오는 나머지 연결 (예: school → knowledge, planner → notifier, broker의 알림) |
| llm-gateway `calls` 표 | `docker exec`로 게이트웨이 컨테이너 안에서 **읽기 전용** SQLite 연결을 열고 `SELECT client, alias, outcome, COUNT(*) … GROUP BY`만 실행 | hermes·learning·school → llm-gateway, 별칭별 |

- 게이트웨이의 `/usage/series`는 쓰지 않았다. 호출자 키가 있어야 하는데, 수집기는 키를 읽지 않는다는 원칙 때문이다. `docker exec` 질의는 집계(호출자, 별칭, 성공/실패, 개수)만 밖으로 내보내고 프롬프트·오류 문구·토큰 수는 내보내지 않는다.
- 게이트웨이 수는 **공급자 호출 단위**다(한 요청이 무료 경로를 넘어가며 두 번 시도되면 2).
- 로그 줄의 경로, id, 본문, 오류 문구는 읽는 즉시 버린다. 헬스체크 줄은 세지 않는다.
- 세는 출처가 없는 연결은 `calls`가 아예 없다(= 측정 안 함). `0`은 "봤는데 없음"이다. 예: dashboard → controller(컨트롤러는 요청 로그 없음), dashboard → llm-gateway(`calls` 표에는 대화 호출만 기록).
- broker의 백그라운드 호출(작업 감시가 controller를 읽는 것)은 broker 로그에 없어서 broker → controller 수에 들어가지 않는다.
- 출처 하나가 실패하면(컨테이너가 멈춤 등) `calls-unavailable`(정보)로 남고 나머지는 센다. 실행 시간은 실제 스택에서 약 2초.

## 새 findings

| code | 단계 | 뜻 |
|---|---|---|
| `rules-extract-failed` | 경고 | 코드에서 허용 명령 표를 읽지 못했다 (파서가 코드 변경을 따라가지 못함) |
| `call-outside-rules` | 경고 | 허용 목록에 없는 명령이 성공했다 (실행 중인 코드와 저장소가 다를 수 있음) |
| `link-no-rules` | 정보 | 이 연결의 허용 명령을 읽는 파서가 없다 |
| `calls-unavailable` | 정보 | 그 서비스의 호출 수를 읽지 못했다 |

스냅샷 `version`은 1 그대로다. 새 필드(`links[].allowed`, `links[].calls`, `callWindow`)는 모두 선택 사항이라 예전 Dashboard는 무시하고, 새 Dashboard는 예전 스냅샷도 그린다.

## 서비스 설명 고치기

`catalog.mjs`의 `SERVICES`에 서비스마다 제목, 층(`LAYERS`), 설명, 외부 연결(이름과 목적만)을 적는다. 주소, 키, 계정 이름은 적지 않는다.

## 테스트

```powershell
node --test D:\personal_ai\services\service-map\collect.test.mjs
```
