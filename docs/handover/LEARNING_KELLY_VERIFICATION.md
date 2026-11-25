# Learning L3와 Kelly 학습 도구 검증 인계

2026-11-25 기준. 작업 A의 학습 일정·복습과 작업 B의 Kelly 학습 도구·브로커 인증·서비스 지도가 검토 대상이다. 두 작업은 로컬 브랜치에 커밋돼 있다. 운영 반영에는 공용 브랜치 통합 승인과 공통 설정이 필요하다. 스택 잠금과 담당은 최신 인계 상태에서 확인한다. [현재 작업](CURRENT_WORK.md) · [작업 계획](CODEX_PLAN.md) · [저장소 지침](../../AGENTS.md)

## 브랜치와 변경 범위

| 작업 | 브랜치와 커밋 | worktree | 변경 범위 |
|---|---|---|---|
| A | `codex/learning-l3` · `99cbddf543f1250df41c79d4ed0e0ca28b0fb10d` | `D:\personal_ai-wt\codex-learning-l3` | 31개 파일. `services/learning`, `services/planner`, Dashboard의 Learning 하위 화면·클라이언트, `compose.learning.yaml`·`compose.planner.yaml`의 환경 변수 |
| B | `codex/kelly-learning` · `6b9e3234854203832a35758e1d79c0bea459991a` | `D:\personal_ai-wt\codex-kelly-learning` | 20개 파일. `services/hermes-broker`, `services/hermes-integration`, `services/service-map`, `compose.yaml`의 Hermes 주석 |

두 커밋의 기준점은 `dfae0a4600e5e89881845e20904b8ff430453641`이다. 11월 25일에 두 worktree가 깨끗한 상태임을 확인했다. 두 커밋의 작성자와 커미터는 저장소 Git 설정과 일치하며, 커밋 메시지에는 에이전트 표기가 없다.

```powershell
$repo = 'D:\personal_ai'
$aTree = 'D:\personal_ai-wt\codex-learning-l3'
$bTree = 'D:\personal_ai-wt\codex-kelly-learning'

git -C $repo worktree list
git -C $aTree status --short --branch
git -C $bTree status --short --branch
git -C $aTree show --stat --oneline 99cbddf
git -C $bTree show --stat --oneline 6b9e323
git -C $aTree diff-tree --no-commit-id --name-only -r 99cbddf
git -C $bTree diff-tree --no-commit-id --name-only -r 6b9e323
```

## 코드에서 확인할 동작

- **일정과 복습**은 A의 `services/learning/src/schedule/plan.ts`와 `schedule.ts`에서 계산한다. `America/Toronto` 시간대의 주간 가용 시간과 바쁜 시간을 반영해 일·주 계획을 만들고, 배치하지 못한 과제를 다음 계획에 포함한다. 마지막 숙련도 검증을 기준으로 복습일과 재검증 필요 여부를 계산한다. DB v3은 주간 가용 시간을 보관하며 v1·v2 JSON 내보내기를 계속 가져올 수 있다.
- **제안과 승인**은 A의 `services/planner/src/api.ts`와 `planner.ts`에서 확인한다. Learning 전용 키는 Planner의 `GET /learning/availability`와 `POST /learning/proposals`에만 쓰인다. 같은 요청은 대기 시안을 재사용한다. 기존 승인 경로에서 선택한 블록만 할 일과 Kelly 캘린더 일정으로 생성하며, 고정 마감을 보존한다. 각 서비스는 자기 DB를 관리하고 정해진 API로 데이터를 주고받는다.
- **Dashboard**의 `/learning/planner`는 일·주 일정, 복습, 가용 시간을 보여 준다. `services/dashboard/src/app/(admin)/learning/planner/change/route.ts`는 기존 세션과 CSRF 검사로 가용 시간 저장과 시안 요청을 처리한다.
- **Kelly**의 `personal_ai_learning` 도구는 브로커를 거친다. 브로커가 허용하는 경로는 `GET /learning/domains`, `/learning/roadmaps`, `/learning/roadmaps/:id`, `/learning/schedule/status`, `/learning/schedule`과 `POST /learning/schedule/propose`다. Hermes는 브로커 호출자 키를 쓰고, 브로커는 Learning에 별도 `X-Learning-Key`를 보낸다. 브로커 호출자 키에 접근 가능한 Hermes 프로세스는 같은 호출 자격을 공유한다.
- **서비스 지도와 설정 점검**은 B의 `services/service-map/rules.mjs`와 `services/hermes-integration/scripts/configure-hermes.mjs`에서 확인한다. 서비스 지도는 Dashboard의 Learning 호출 허용 목록을 소스에서 읽는다. `--check`는 Hermes 도구 목록, Skill·플러그인, SOUL 설정의 관리 항목을 읽기 전용으로 점검한다.

## 검증 기록

아래 결과는 11월 24일 작업에서 확보했다. Docker 빌드는 작업 전용 태그를 사용했다. Hermes Python 검증은 기존 이미지에 플러그인 소스만 읽기 전용으로 마운트한 임시 컨테이너에서 실행했다. 11월 25일에는 서비스 지도와 설정 점검 테스트를 다시 실행해 27/27을 확인했다.

| 대상 | 호스트 | Docker |
|---|---|---|
| Learning | 테스트 51/51, 타입 검사 통과 | 테스트 51/51, 이미지 빌드 통과 |
| Planner | 테스트 23/23, 타입 검사 통과 | 테스트 23/23, 이미지 빌드 통과 |
| Dashboard | 테스트 133/133, 별도 타입 검사 통과. `next build` 종료 1 | 테스트 133/133, 타입 검사와 이미지 빌드 통과 |
| Hermes broker | 테스트 19/19, 빌드와 타입 검사 통과 | 테스트 19/19, 이미지 빌드 통과 |
| Hermes 플러그인 | Python 95개 통과, 2개 건너뜀(PDF 의존성·Windows 링크). 설정 점검 테스트 3/3 | 네트워크 없는 임시 컨테이너에서 Python 97/97 |
| 서비스 지도 | 테스트 24/24. Dashboard→Learning 명령 67개(A 소스)와 broker→Learning 명령 6개(B 소스) 추출 | 운영 확인은 아래 참조 |

Dashboard 호스트 빌드는 컴파일과 경로 생성을 마친 뒤 기존 Next.js 16.4.3에서 `SecurityFatalError`로 종료했다. 공통 `services/dashboard/package.json`과 `services/dashboard/package-lock.json`의 보안 패치를 조율한 뒤 호스트와 Docker 빌드를 다시 확인한다. Next.js는 11월 보안 수정이 16.4.5에 포함되었다고 공지했다. [Next.js 11월 보안 공지](https://nextjs.org/blog/november-2026-security-release)

임시 SQLite DB와 Google Calendar 대역으로 교차 확인 **9건**을 통과했다. 일정 조회에 따른 캘린더 생성 0건, 바쁜 시간 제외, 오래된 숙련도 재검증 표시, 브로커 권한 제한, 동일 시안 재사용, 승인 후 할 일·일정 생성과 고정 마감 보존을 확인했다. Edge에서는 390px 라이트·다크와 1280px 화면, 정상 시안 폼, CSRF 토큰 누락 거부를 확인했다. 별도 임시 SQLite v2 DB는 기존 행을 보존한 채 v3으로 올라갔다. 교차 확인 스크립트는 일회성으로 실행했다. 두 커밋에 포함된 관련 회귀 테스트는 다음 파일에 있다.

- A의 `services/learning/src/schedule/plan.spec.ts`, `services/learning/test/learning-l3.e2e-spec.ts`, `services/planner/src/planner.test.ts`
- B의 `services/hermes-broker/src/broker.test.ts`, `services/hermes-integration/tests/test_learning_tool.py`, `services/hermes-integration/tests/configure-hermes.test.mjs`, `services/service-map/collect.test.mjs`

### 호스트 테스트 다시 실행

위에서 정의한 `$aTree`와 `$bTree`를 사용한다. Dashboard의 경로 타입은 `next build`가 생성한다. 호스트 빌드 종료 상태와 그 뒤에 별도로 실행한 타입 검사 결과를 각각 기록한다.

```powershell
foreach ($service in @('learning', 'planner')) {
    $serviceDir = Join-Path $aTree "services\$service"
    npm.cmd --prefix $serviceDir ci
    npm.cmd --prefix $serviceDir run typecheck
    npm.cmd --prefix $serviceDir run build
    npm.cmd --prefix $serviceDir test
}

$dashboard = Join-Path $aTree 'services\dashboard'
npm.cmd --prefix $dashboard ci
npm.cmd --prefix $dashboard test
npm.cmd --prefix $dashboard run build
npm.cmd --prefix $dashboard run typecheck

$broker = Join-Path $bTree 'services\hermes-broker'
npm.cmd --prefix $broker ci
npm.cmd --prefix $broker run typecheck
npm.cmd --prefix $broker run build
npm.cmd --prefix $broker test
python -B -m unittest discover -s "$bTree\services\hermes-integration\tests"
node --test "$bTree\services\hermes-integration\tests\configure-hermes.test.mjs"
node --test "$bTree\services\service-map\collect.test.mjs"
```

### 이미지 검증 다시 실행

이미지 빌드는 하나씩 끝낸다. 아래 태그는 운영 서비스의 `:local` 태그와 구분된다.

```powershell
docker build -t personal-ai-learning:codex-l3 "$aTree\services\learning"
docker build -t personal-ai-planner:codex-l3 "$aTree\services\planner"
docker build -t personal-ai-dashboard:codex-l3 "$aTree\services\dashboard"
docker build -t personal_ai-hermes-broker:codex-kelly-learning "$bTree\services\hermes-broker"

$hermesSource = Join-Path $bTree 'services\hermes-integration'
docker run --rm --network none -e PYTHONDONTWRITEBYTECODE=1 `
  --mount "type=bind,source=$hermesSource,target=/src,readonly" `
  --entrypoint /opt/hermes/.venv/bin/python3 personal_ai-hermes:local `
  -B -m unittest discover -s /src/tests
```

## 운영 스택에서 확인한 범위

`stack.ps1 ps`로 원본 `personal_ai` 스택에서 컨테이너 14개가 실행 중임을 확인했다. B worktree의 `stack.ps1 verify-networks`로 이 스택과 비교해 **11/11**, 기존 링크 **21개**, Docker 주소 풀 추정 여유 **2개**를 확인했다. 원본 구버전 검사기는 기존 미사용 연결 수가 줄어들어야 통과했다. B는 새 미사용 연결이 추가되었는지 검사한다.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "$repo\scripts\stack.ps1" ps
powershell -NoProfile -ExecutionPolicy Bypass -File "$bTree\scripts\stack.ps1" verify-networks
```

A·B의 운영 배포, 운영 Learning DB 백업·v3 마이그레이션, 실제 Planner 시안과 Google Calendar 반영, Hermes 재시작과 Kelly 대화는 미검증이다. 이 작업이 남긴 운영 Kelly 대화 기록은 0건이다.

## 통합에 필요한 공통 설정

작업 계획 2절 4번에 따른 `learning-os/l1` 잠금·병합·push 승인과 공통 Compose 반영이 필요하다. 두 네트워크는 모두 `internal: true`이며 표의 서비스만 참여한다. Docker 주소 풀은 적용 직전에 다시 확인한다. 키 파일은 승인된 통합 단계에서 A의 `node services/learning/scripts/init-secrets.mjs`로 생성하고 읽기 전용으로 마운트한다. 키 값은 보고에 포함하지 않는다.

| 연결 | 내부망과 참여 서비스 | 마운트와 환경 변수 |
|---|---|---|
| Learning → Planner | `learning-planner-internal` · `learning`, `planner` | `secrets/learning-planner.key`를 양쪽 `/run/secrets/planner_learning_key`에 마운트. Learning에 `LEARNING_PLANNER_URL=http://planner:8091`과 `LEARNING_PLANNER_KEY_FILE=/run/secrets/planner_learning_key`. Planner에 `PLANNER_LEARNING_KEY_FILE=/run/secrets/planner_learning_key` |
| broker → Learning | `learning-broker-internal` · `hermes-broker`, `learning` | 같은 `secrets/learning-broker.key`를 broker의 `/run/secrets/learning_key`와 Learning의 `/run/secrets/learning_broker_key`에 마운트. broker에 `LEARNING_URL=http://learning:3000`과 `LEARNING_KEY_FILE=/run/secrets/learning_key`. Learning에 `LEARNING_BROKER_KEY_FILE=/run/secrets/learning_broker_key` |

## 승인 후 운영 확인 순서

1. 원본 `D:\personal_ai`에서 최신 `CURRENT_WORK.md`의 스택 잠금과 작업 C 상태, 원격 브랜치를 확인한다. 계획서 2절 4번대로 잠금을 기록하고 공유 브랜치에서 두 작업을 병합한 뒤 테스트한다. 원본의 기존 `.gitignore` 변경이 함께 스테이징되지 않도록 확인한다. [작업 계획](CODEX_PLAN.md)
2. 승인된 공통 Compose와 Dashboard 보안 패치를 반영한다. `scripts\stack.ps1 backup learning`이 성공한 뒤에 Learning v3을 적용한다. 스택 변경은 원본에서 `scripts\stack.ps1`로 필요한 서비스만 하나씩 진행한다. Planner, Learning, Dashboard, broker의 상태와 Hermes 설정 점검을 확인한 뒤 Kelly를 다시 시작한다.
3. 서비스 지도 스냅샷이 갱신되면 `scripts\stack.ps1 verify-networks`를 실행하고 두 새 링크를 확인한다. 운영 Dashboard에서 390px 라이트·다크의 일정 화면과 시안 번호를 확인한다. 소유자가 승인한 경우에만 해당 시안의 할 일과 Kelly 캘린더 일정, 고정 마감 보존까지 확인한다. Kelly 조회·시안 확인은 필요한 최소 대화로 진행하고 남긴 기록을 인계한다.
4. 실제 검증 결과를 `CURRENT_WORK.md`와 ROADMAP 5·17·19·20절에 남기고 계획서에 따라 잠금을 해제한다. Windows 정기 점검 등록은 소유자가 B worktree의 `services/hermes-integration/README.md`에 있는 등록 명령으로 진행한다. 레거시 `secrets/hermes.controller.env` 삭제도 소유자 결정 사항이다.
