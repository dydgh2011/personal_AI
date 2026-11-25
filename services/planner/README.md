# planner

할 일(todo)과 하루 계획을 관리하는 서비스입니다. planner가 직접 만든 Google 캘린더 **Kelly** 하나에 모든 것을 넣습니다: 고정 일정(수업, 약속, 루틴, 생일), 확정한 계획 블록, 마감 표시. 사용자는 이 캘린더만 보고, 기존 캘린더들은 처음 한 번 가져오기(import)할 때만 읽습니다. Kelly 캘린더가 원본이라서, 사용자가 거기서 옮기거나 지운 계획 일정은 planner가 그대로 따라갑니다. LLM 없이 정해진 코드로만 동작하고, Hermes(Kelly)는 broker를 거쳐 정해진 도구(`personal_ai_planner`)로만 씁니다.

## 분류와 색

일정마다 분류가 하나 있고, planner가 그 분류의 Google 일정 색을 정합니다 (`src/google.ts`의 `CATEGORY_COLOR`, 한 곳에서만 정의).

| 분류 | 뜻 | 색 |
|---|---|---|
| class | 수업·강의·학교 고정 일정 | 파랑 (Blueberry) |
| study | 공부·과제 시간 (계획 블록) | 청록 (Peacock) |
| task | 그 밖의 할 일 시간 (계획 블록) | 노랑 (Banana) |
| deadline | 마감 표시 (종일, 할 일에서 자동) | 빨강 (Tomato) |
| routine | 운동·식사 등 루틴 | 초록 (Sage) |
| personal | 약속·개인 일정 | 보라 (Grape) |
| birthday | 생일·기념일 | 분홍 (Flamingo) |

Discord 메시지에도 같은 색 점(🔵🩵🟡🔴🟢🟣🩷)이 붙습니다.

## Google 권한 (최소)

- `calendar.app.created`: planner가 만든 캘린더(Kelly)만 쓰기. 기존 캘린더는 바꾸거나 지울 수 없습니다.
- `calendar.calendarlist.readonly`, `calendar.events.readonly`: 기존 캘린더 목록과 일정 읽기 (처음 가져오기용).

## 기존 캘린더 = 참고 정보 (reference)

기존 캘린더는 관리되지 않아 현실과 다르거나 분류가 틀린 일정이 많습니다. 그래서 Kelly 캘린더로 그대로 복사하지 않습니다.

- `reference_sync`: 고른 캘린더의 일정(기본 1년 전~1년 뒤)을 planner DB의 `reference_events`에 원본 그대로 저장합니다. 다시 실행하면 갱신되고 중복되지 않습니다. Kelly 캘린더에는 아무것도 쓰지 않습니다.
- `reference_search`: 캘린더·제목 단어·날짜·반복 여부로 찾아 봅니다. 사용자를 이해하고 시안을 만들 때 참고합니다.

## 시안 (proposals)

고정 일정(수업, 루틴, 약속 등)은 Kelly가 시안을 만들고 사용자가 고르고 고치는 방식으로 다시 세웁니다.

1. `proposal_create`: 이름 붙은 시안(A, B, ...)과 항목들. 항목마다 event_add와 같은 검사를 거치고, 서로 겹치는 항목은 `[주의]`로 표시됩니다.
2. `proposal_edit`: 항목 고치기(`update_items`), 빼기(`remove_items`), 더하기(`add_items`).
3. `proposal_apply` (사용자 OK 필요): 고른 항목만 Kelly 캘린더에 씁니다. 쓴 항목은 ✅로 표시되고 더는 시안에서 고칠 수 없습니다(그 뒤에는 event_update).
4. `proposal_discard`: 고르지 않은 시안을 버립니다.

### 시안 검사 (`src/checks.ts`)

시안을 만들거나 보거나 고치면 코드가 아직 캘린더에 쓰지 않은 항목을 검사해 `warnings`로 돌려줍니다. Kelly는 경고를 고치거나 왜 그대로 두는지 주인에게 말합니다. (2026-11-25: 저가 모델이 글로 쓴 계획에서 시험 뒤 공부 배치, 이동시간 혼동, 마감 누락이 나와서 추가)

| 검사 | 설정 |
|---|---|
| 수면 시간과 겹침 | `sleepStart`, `sleepEnd` (기본 23:00–06:00) |
| 집 밖 일정이 막차 뒤에 끝남 | `lastBus` {weekday, saturday, sunday}, `homePlace`, `places` |
| 장소가 바뀌는데 이동시간이 모자람 | `places` [{name, match[]}], `travel` [{from, to, minutes}] (표에 없는 구간은 검사 안 함) |
| 꼭 지킬 일정(시험·필수 수업)과 겹침, 수업이 아닌 기존 일정과 겹침 | `protectedEvents` (제목에 들어간 단어, 기본 exam·test·시험·기말). 보호하지 않은 수업은 무시(안 가는 수업) |
| 기간 안에 마감인 할 일이 시안에 없음 | 열린 할 일의 마감 |

### Learning 시안

Learning은 전용 키로 기간별 바쁜 시간과 이미 배치한 학습 시간만 조회하고, 과제·복습 블록을 시안으로 저장합니다. Kelly에서 기존 시안 목록에 표시하며, 주인이 고른 블록을 승인하면 관련 할 일과 연결된 캘린더 일정이 생깁니다. 같은 학습 항목의 블록은 할 일 하나를 공유합니다. 이미 생성한 할 일의 마감일은 새 시안을 적용해도 유지됩니다.

Learning의 `learning-planner.key`를 Planner에 읽기 전용으로 마운트한 후 `PLANNER_LEARNING_KEY_FILE`에 경로를 지정합니다. 이 키에 허용되는 API는 `GET /learning/availability`와 `POST /learning/proposals`입니다.

## 반복 규칙

`repeat`(daily, weekdays, weekly, biweekly, monthly, yearly)에 `interval`(N마다), `repeatDays`(요일), `monthlyBy`(date: 같은 날짜 / weekday: 둘째 화요일처럼, 마지막 주면 "마지막 화요일"), `until`(끝 날짜) 또는 `count`(횟수)를 더합니다. RRULE은 코드가 만들고, LLM은 이 선택지만 고릅니다.

## 하는 일

| 언제 | 무엇 |
|---|---|
| 월~토 23:00 | 내일 계획 초안을 만들고 Discord에 올림 (이미 확정한 날은 그대로 둠) |
| 일 23:00 | 다음 주 월~일 초안을 올림 |
| 05:00 | 오늘 계획을 멘션과 함께 올림 (초안이 없으면 그때 만듦) |
| 일정 15분 전 (60분 이하 짧은 일정은 5분 전) | Discord 리마인더 (Kelly 캘린더의 모든 시간 일정, 설정 `remindScope: planner`면 계획 블록만). 짧은 일정 기준은 `shortEventMinutes`(0이면 끔), 그 알림 시점은 `shortRemindMinutes` |
| 상시 | 마감이 있는 할 일마다 종일 "마감(이날까지): …" 일정을 만들고 고치고 지움 (그날 하는 일정이 아니라 그날까지 끝낼 일) |

planner가 꺼져 있다가 켜지면 같은 날 저녁(23~24시)이나 아침(5~9시) 안에서는 놓친 작업을 이어서 합니다.

## 초안 만드는 방식 (`src/schedule.ts`)

- 하루 범위는 `dayStart`~`dayEnd`(기본 07:00~22:30)이고, 캘린더 일정과 그대로 둔 블록은 비워 둡니다. 앞뒤로 쉬는 시간(`breakMinutes`, 기본 10분)도 둡니다.
- 마감이 있는 일은 남은 날짜에 고르게 나누고, 마감 당일이나 지난 일은 그날 전부 넣습니다. 들어가지 않으면 "못 넣은 일"로 알립니다.
- 마감 없는 일은 하루 최대 `undatedDailyMinutes`(기본 2시간)까지 넣습니다. 하루 총량은 `maxFocusMinutes`(기본 8시간), 한 블록은 `maxBlockMinutes`(기본 90분) 이하입니다.
- 사용자가 직접 바꾼 블록(manual)은 다시 만들어도 남습니다.
- 지난 날의 블록은 끝낸 것으로 치지 않습니다. 사용자가 Kelly에게 "다 했어"라고 말해야(`todo_progress`) 다음 계획에서 빠집니다.

## 확인 규칙

- 계획 확정(캘린더에 쓰기), 고정 일정 변경·삭제, 가져오기, 마감 변경, 할 일 삭제: 사용자의 명시적인 OK가 필요합니다. 도구 인자 `confirmed_by_user=true`가 없으면 플러그인이 보내지 않습니다.
- 그 밖의 변경(할 일 추가, 예상 시간, 우선순위, 진행 기록, 설정): 바로 적용하고 사용자에게 알립니다.
- 모든 변경은 `change_log`에 누가(hermes / system / calendar), 무엇을, 이전 값과 이후 값까지 남깁니다(`changes`).

## 구성과 보안

- API: 8091, 호스트 포트 없음. `X-Planner-Key`가 있는 호출자(hermes-broker)만 받습니다.
- Google 로그인 복귀: `127.0.0.1:8720/oauth/callback`만 호스트에 열려 있습니다. 15분 안에 planner가 발급한 state(PKCE)만 받습니다.
- 네트워크: `planner-internal`(broker와만), `notify-internal`(notifier), `planner-egress`(Google). controller에는 닿지 않습니다.
- Google 토큰은 `planner-data` 볼륨의 SQLite에만 있고, API 응답이나 로그에는 나오지 않습니다.
- planner가 넣은 일정은 Google 팝업 알림을 끕니다(Discord 리마인더와 겹치지 않게).

## 설정

```powershell
node services\planner\scripts\init-secrets.mjs
# secrets\google-oauth-client.json : Google Cloud의 "데스크톱 앱" OAuth 클라이언트 JSON
docker compose @F up -d --build --no-deps planner notifier hermes-broker
docker restart personal_ai-hermes-1
```

캘린더 연결: Kelly에게 "캘린더 연결해줘"라고 보내면 Discord로 링크가 옵니다. **이 PC의 브라우저**에서 열어야 합니다(로그인 후 127.0.0.1로 돌아오기 때문).

## 테스트

```powershell
cd services\planner; npm ci; npm run build; npm test
```

Docker 빌드에서도 테스트가 돌고, 하나라도 실패하면 이미지가 만들어지지 않습니다.
