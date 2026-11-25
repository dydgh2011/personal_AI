# Admin Dashboard (Phase E-1.5)

Personal AI OS의 관리자 화면 (Next.js 16.4.3 / React 19.3.1, 2026-10-14 보안 패치 반영). Next.js 서버가 Controller를 대신 호출하는 BFF 구조이며, 브라우저는 Controller나 그 토큰에 접근하지 않는다.

```
브라우저 ──(HttpOnly 세션 쿠키)──▶ dashboard:3000 (127.0.0.1:8710)
                                     │  Bearer CONTROLLER_DASHBOARD_TOKEN (Docker secret, 서버에서만 읽음)
                                     ▼  admin-internal 네트워크 (Controller와 Dashboard만 참여)
                                  controller:3000
```

## 설치

```powershell
# 1) 비밀 정보 생성: 값은 출력하지 않으며, 기존 값은 덮어쓰지 않음
node services/dashboard/scripts/init-secrets.mjs
#    - secrets/controller.env 에 CONTROLLER_DASHBOARD_TOKEN 추가
#    - secrets/dashboard-controller.token: Dashboard에만 mount
#    - secrets/dashboard-admin.hash: scrypt 해시, Dashboard에만 mount
#    - secrets/dashboard-admin.password: 생성된 초기 비밀번호. 직접 열어 확인한 뒤 삭제해도 됨 (mount되지 않음)

# 2) 새 토큰을 읽도록 Controller 재생성 (최초 1회), 이어서 Dashboard 실행
$F = "-f compose.yaml -f compose.workers.yaml -f compose.controller.yaml -f compose.github.yaml -f compose.dashboard.yaml".Split(' ')
docker compose @F up -d --build --no-deps controller
docker compose @F up -d --build --no-deps dashboard
```

브라우저에서 http://127.0.0.1:8710 에 접속한다. 사용자 이름은 `owner`이며, `DASHBOARD_ADMIN_USER`로 바꿀 수 있다.

비밀번호를 변경하려면 아래를 실행한 뒤 Dashboard를 재시작한다. 재시작하면 모든 세션이 종료된다.

```powershell
'새-비밀번호-12자-이상' | node services/dashboard/scripts/init-secrets.mjs set-password
docker restart personal_ai-dashboard-1
```

## 화면

| 경로 | 내용 |
|---|---|
| `/` | Controller·DB·Hermes(Controller가 probe)·Claude/Codex Worker 상태, 작업 수, 승인 대기 수, 응답 시간. 알 수 없는 값은 `unknown`, CPU/RAM/GPU/Disk는 "not collected"로 표시 |
| `/tasks` | Agent·Project·Status 필터, 페이지 이동, 5초 자동 새로고침 |
| `/tasks/:id` | 지시 내용, 결과·오류, 브랜치, base/commit SHA, 소요 시간, 변경 파일, 취소 |
| `/projects` | Registry 읽기 전용 표 (자격 증명은 표시하지 않음) |
| `/reviews` | 상태별 리뷰 큐 |
| `/reviews/:id` | 파일별 diff, 경고, 확인 단계(`?confirm=approve`), 승인·거부, 이력, **Publication(dry-run)**: Validate / Dry-run 실행, 검사 결과, 예정 브랜치와 PR(실제로 만들지는 않음) |

## 보안 동작

- **세션**: 32바이트 난수 ID를 쿠키(`HttpOnly; SameSite=Strict; Path=/`)로만 보낸다. 유휴 30분, 최대 8시간이 지나면 만료되고, 로그아웃하면 즉시 폐기된다.
  - 컨테이너를 재시작·재빌드해도 로그인이 유지되도록 `/var/lib/dashboard/sessions.json`(`dashboard-data` 볼륨, 권한 600)에 저장한다.
  - 파일에는 쿠키 값이 아니라 그 HMAC(`h`), 사용자, 생성·마지막 사용 시각만 있다. CSRF 토큰은 저장하지 않고 매번 다시 계산한다.
  - HMAC 키는 관리자 비밀번호 해시 + 관리자 이름 + `DASHBOARD_SESSION_EPOCH`에서 파생한다. 셋 중 하나가 바뀌면 모든 세션이 무효가 된다(해시 파일은 5초마다 다시 읽음).
  - 마지막 사용 시각은 최대 1분에 한 번만 디스크에 쓴다. 재시작 뒤에는 유휴 만료가 최대 1분 일찍 올 수는 있어도 늦게 오지는 않는다.
  - 파일이 깨졌거나 읽을 수 없으면 "세션 없음"으로 시작한다(다시 로그인). `DASHBOARD_SESSION_FILE=none`이면 메모리에만 보관한다.
- **CSRF**: 상태를 바꾸는 모든 POST는 세션별 CSRF 토큰을 요구하고, `Origin`/`Sec-Fetch-Site`가 같은 출처여야 한다. 로그인은 cross-site 요청을 거부한다.
- **로그인 제한 (E-2A 개선)**:
  - 실패 횟수를 세는 단위:
    - 장치 쿠키가 없는 요청: IP별, 그리고 "미확인 장치의 사용자"별로 따로 셈.
    - 장치 쿠키가 있는 요청: 그 장치별로만 셈.
    - 어느 단위든 15분 동안 5회 실패하면 잠김.
  - 장치 쿠키(`pai_device`):
    - 로그인에 성공하면 발급함.
    - 비밀번호 해시에서 파생한 키로 HMAC 서명함.
    - 30일 동안 유효하고, `Path=/api/auth/login`으로만 전송함.
  - 효과: Docker 포트 매핑 때문에 모든 접속이 같은 게이트웨이 IP로 보여도, 로컬 공격자가 소유자 브라우저를 잠글 수 없음.
  - 비밀번호를 바꾸면 기존 장치 쿠키는 모두 무효가 됨.
- **클라이언트 IP**:
  - `server-entry.cjs`가 TCP peer 주소를 클라이언트 IP로 정하고, 클라이언트가 보낸 `X-Forwarded-*`, `X-Real-IP`, `Forwarded` 헤더는 삭제함.
  - 이 헤더들은 `DASHBOARD_TRUSTED_PROXIES`에 등록한 프록시 주소에서 온 요청일 때만 사용하며, 그때도 그 프록시가 마지막에 덧붙인 항목만 사용함.
  - 참고: Next.js 자체 동작은 클라이언트가 보낸 `X-Forwarded-For`를 그대로 유지함.
- **감사 로그**: `/var/lib/dashboard/audit.log`(`dashboard-data` 볼륨)에 로그인, 로그아웃, 취소, 승인·거부와 그 실패를 남긴다. 비밀번호, 토큰, diff 내용은 기록하지 않는다.
- **렌더링**: diff와 커밋 메시지는 React 텍스트 노드로만 출력하며 `dangerouslySetInnerHTML`은 쓰지 않는다. CSP, `X-Frame-Options: DENY`, `nosniff`, `no-referrer`, `Cache-Control: no-store`를 적용한다.
- **승인**:
  - 확인 단계에서 project, base, head, 파일 목록을 보여 준다. 체크박스를 반드시 선택해야 하며, 화면에서 본 headSha가 그대로 전송된다.
  - Controller가 잘못된 SHA나 중복 결정을 409로 거부하면 그 사유를 화면에 표시한다.
  - 승인은 기록만 남긴다. push, merge, PR은 하지 않는다.
- **Private patch**: Controller가 admin 자격에만 patch를 준다. Dashboard는 로그인한 관리자에게만 이를 표시한다.
- **컨테이너**: non-root(uid 1000), read-only rootfs, `cap_drop: ALL`, `no-new-privileges`, Docker 소켓 없음, 저장소 볼륨 없음, 포트는 127.0.0.1에만 바인딩한다.

HTTPS(Tailscale이나 리버스 프록시) 뒤에 둘 때는 `DASHBOARD_COOKIE_SECURE=true`로 설정한다. 프록시는 `Host`를 그대로 전달하고, `X-Forwarded-For`를 덮어써야 한다.

## 테스트

```powershell
cd services/dashboard; npm test          # 단위 테스트 (Docker 빌드 중에도 실행됨)
node services/dashboard/scripts/e2e.mjs  # 실행 중인 Dashboard와 Controller 대상 E2E (읽기 전용)
node services/dashboard/scripts/e2e.mjs --approve <taskId> --reject <taskId>   # 실제 결정 기록 (Controller DB만 변경)
node services/dashboard/scripts/e2e.mjs --confirm-only <taskId>                # 결정 직전까지만 검사
```

## 모듈 추가

`src/modules/registry.ts`에 항목을 하나 추가하고 `src/app/(admin)/<module>/` 라우트를 만들면 된다. 내비게이션과 권한은 이 목록에서 나온다. 런타임에 플러그인 코드를 불러오지 않는다.

## 초기 비밀번호 파일 (`secrets/dashboard-admin.password`)
컨테이너는 이 파일을 쓰지 않는다(해시만 마운트함). 이 파일이 필요한 곳은 사용자에게 처음 전달할 때와, 환경변수가 없을 때 E2E 스크립트가 대신 읽을 때뿐이다.

안전하게 제거하는 순서:
1. 비밀번호를 비밀번호 관리자에 저장한다.
2. 브라우저에서 로그인해 본다. 이 로그인으로 장치 쿠키도 발급된다.
3. `Remove-Item secrets\dashboard-admin.password`로 파일을 지운다.
4. 이후 E2E는 `$env:DASHBOARD_E2E_PASSWORD`를 설정한 뒤 실행한다.

비밀번호를 잊었다면 `set-password`로 새로 설정한다(위 설치 절 참조).

주의: Windows에서는 `mode 0600`이 적용되지 않는다. `secrets\` 폴더는 D: 드라이브의 기본 ACL을 상속하므로, 다른 로컬 계정도 읽을 수 있다.

## CSRF와 실제 브라우저 (2026-10-26 수정)
- `Referrer-Policy: same-origin`을 사용한다. 이전 값 `no-referrer`에서는 브라우저가 모든 form POST에 `Origin: null`을 보냈고, 그 때문에 Origin 검사가 모든 승인 요청을 거부했다.
- `Origin: null`은 브라우저가 `Sec-Fetch-Site: same-origin`을 함께 보낼 때만 받아들인다. 세션별 CSRF 토큰은 언제나 필요하다.
- 거부된 POST는 아무 동작도 하지 않고 사용자를 돌려보낸다(303, `X-PAI-Rejected` 헤더 포함).
  - CSRF 검사 실패: 원래 화면으로 돌아가며 오류 메시지를 표시한다.
  - 세션 없음 또는 만료: 로그인 화면으로 가며 다시 로그인하라고 안내한다.
- 실제 브라우저 검사: `npm install --prefix services/dashboard/browser-test` 후 `node services/dashboard/browser-test/approval.mjs <승인할 테스트 task> <거부할 테스트 task>` (Edge 사용, 테스트 전용 리뷰에만 실행, Dashboard를 한 번 재시작함).
