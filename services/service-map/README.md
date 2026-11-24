# Service Map 수집기

Dashboard의 서비스 지도(ROADMAP 20절)가 읽는 스냅샷을 만든다. **호스트에서** 돈다. Docker CLI가 필요하고, 어떤 컨테이너에도 Docker 소켓을 주지 않는다는 원칙 때문이다.

```text
compose config · docker inspect · catalog.mjs ─▶ collect.mjs (호스트) ─▶ data/service-map/service-map.json ─▶ Dashboard (읽기 전용)
```

## 실행

```powershell
node D:\personal_ai\services\service-map\collect.mjs
```

- 프로젝트(`personal_ai`)를 띄울 때 쓴 Compose 파일 목록은 `docker compose ls`에서 읽는다. 파일 목록을 따로 적을 필요가 없다.
- 옵션: `--project <이름>`, `--out <파일>`, `--stdout`(파일 대신 화면에 출력).
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

## 서비스 설명 고치기

`catalog.mjs`의 `SERVICES`에 서비스마다 제목, 층(`LAYERS`), 설명, 외부 연결(이름과 목적만)을 적는다. 주소, 키, 계정 이름은 적지 않는다.

## 테스트

```powershell
node --test D:\personal_ai\services\service-map\collect.test.mjs
```
