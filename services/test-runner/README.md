# Test Runner (Phase E-2B)

게시 정책 A(테스트 필수)의 증거를 만드는 **격리된 테스트 실행기**다. 프로젝트 Registry에 관리자가 승인한 `testCommands`를 **승인 대상 커밋 그 자체**에 대해 실행한다. 실행 결과는 LLM의 답변이 아니라 실제 프로세스 종료 코드이며, 이를 HMAC으로 서명해 보고한다.

```
Controller (test_validations, v6) ◀──claim / result── test-runner ── test-internal (internal: 인터넷 없음)
                                                         │ 읽기 전용: Worker bundle, publisher export (둘 다 uid 1000 전용 0700)
                                                         └ 테스트 프로세스: uid 10001, 깨끗한 환경, 작업마다 새 checkout
```

## 흐름
1. 테스트 실행이 요청된다. 요청 경로는 두 가지다:
   - Worker가 GitHub 프로젝트 작업을 완료하면 Controller가 자동으로 요청한다(`controller:auto`).
   - 관리자가 Dashboard에서 **Run tests**를 누른다.
   - 어느 쪽이든 실행할 명령은 요청 시점의 Registry 설정을 스냅샷으로 저장한다.
2. Runner가 실행할 커밋을 준비한다. 그 다음 모든 명령을 순서대로 실행한다. 앞 명령이 실패해도 나머지를 건너뛰지 않는다.
   - Worker bundle과 manifest(sha256)를 검증한다.
   - 신뢰 사본(repo-sync export)을 기준으로 bundle을 검증한다.
   - head와 tree가 요청한 커밋과 일치하는지 확인한다.
   - checkout은 객체를 복사하고, alternates와 hook은 제거한다.
3. 명령마다 다음을 기록한다: 종료 코드, signal, 시간 초과 여부, 소요 시간, 출력의 sha256, 출력 끝부분.
4. 결과는 evidence(JSON)로 만들어 `HMAC-SHA256(TEST_EVIDENCE_KEY)`로 서명한다. Controller는 이 키를 갖지 않으며, Publisher가 서명을 검증한다.
5. Controller가 상태를 다시 계산한다. 순서는 aborted > failed > skipped > passed다. 종료 코드와 맞지 않는 "passed" 보고는 낮춰서 저장한다.

## 격리
- 오케스트레이터는 root로 실행하되 capability는 CHOWN, SETUID, SETGID, KILL, DAC_READ_SEARCH만 가진다. 테스트 명령은 uid 10001로 실행되며 capability가 없다.
- 토큰과 evidence 키는 root 프로세스의 환경 변수로만 존재하고, 시작 직후 `process.env`에서도 지운다. 테스트 프로세스에는 PATH, HOME, LANG, CI, BASE_SHA, HEAD_SHA, TASK_ID, PROJECT_ID만 전달한다. `/proc/1/environ`은 읽을 수 없다.
- 네트워크는 `test-internal` 하나뿐이다. 인터넷이 없고, Controller 외에는 연결 대상이 없다.
- 명령이 끝날 때마다 sandbox uid의 남은 프로세스를 모두 종료한다. 작업 디렉터리는 매번 삭제한다.
- Docker 소켓, GitHub 자격 증명, Worker 홈과 clone은 없다.

## 설치
```powershell
node services/test-runner/scripts/init-secrets.mjs
#   → controller.env: CONTROLLER_TEST_RUNNER_TOKEN
#   → secrets/test-runner.env: 토큰 + TEST_EVIDENCE_KEY (Runner 전용)
#   → secrets/test-evidence.key: 같은 키 (Publisher가 서명 검증에 사용)
docker compose ... -f compose.test-runner.yaml up -d --build --no-deps test-runner
```
프로젝트 명령은 관리자만 등록할 수 있다(`PATCH /projects/:id`의 `testCommands`). 한 명령의 형식은 `{ name, argv, timeoutSeconds }`다. 문서 작업도 예외가 아니므로 문서 검사 명령을 등록해야 한다.

## 테스트
- `npm test`: Docker 빌드 안에서 root로 실행한다. uid 전환, 종료 코드, timeout, 남은 프로세스 정리, 자격 증명과 다른 저장소 접근 차단, 아티팩트 손상 처리를 검증한다.
- 실환경 검증은 `services/github-publisher/scripts/e2e-policy.mjs <taskId> tests`로 한다.
