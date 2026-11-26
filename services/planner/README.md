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
| 월~토 `draftAt` (기본: `sleepStart` 30분 전 = 22:30) | 내일 계획 초안을 만들고 Discord에 올림 (이미 확정한 날은 그대로 둠) |
| 일 `draftAt` | 다음 주 월~일 초안을 올림 |
| `sleepEnd` (기본 06:00) | 오늘 계획을 멘션과 함께 올림 (초안이 없으면 그때 만듦). 끝에 실제 알림 설정을 한 줄로 적음 |
| 일정 15분 전 (60분 이하 짧은 일정은 5분 전) | Discord 리마인더 (Kelly 캘린더의 모든 시간 일정, 설정 `remindScope: planner`면 계획 블록만). 짧은 일정 기준은 `shortEventMinutes`(0이면 끔), 그 알림 시점은 `shortRemindMinutes` |
| 상시 | 마감이 있는 할 일마다 종일 "마감(이날까지): …" 일정을 만들고 고치고 지움 (그날 하는 일정이 아니라 그날까지 끝낼 일) |

- 2026-11-26: 05:00 아침 메시지와 23:00 초안은 수면 시간(23:00–06:00) 안이라 옮겼습니다. 작업 키는 예전과 같아서(`proposal:<저녁 날짜>`, `morning:<날짜>`) 시간을 바꾼 날에도 같은 날 두 번 돌지 않습니다.
- planner가 꺼져 있다가 켜지면 같은 날 저녁(`draftAt`~24시)이나 아침(`sleepEnd`부터 4시간) 안에서는 놓친 작업을 이어서 합니다.
- **기말 시험일엔 자동 초안 없음**(주인 결정 2026-11-26): Kelly 캘린더에 제목에 `noDraftExamWords`(기본 `final`, `기말`) 단어가 있는 시험 일정(시험 표시와 같은 기준: `class`·`task`, 공부·이동 일정 제외)이 있는 날은 저녁 초안·주간 초안·아침 대체 초안이 그날 블록을 만들지 않고, 캘린더에 없는 자동 블록은 초안에서 뺍니다(`change_log`에 `skip`과 뺀 블록). 내일이 그날이면 저녁 초안 메시지도 올리지 않습니다. 아침 메시지는 그날 캘린더 일정만 보여 줍니다. Kelly에게 직접 "짜줘"라고 하면(`generate`) 그날도 짭니다. `[]`이면 끔.
- **알림 줄이기**(2026-11-26, 하루 15개 일정 중 다수가 5분 전 알림이었음): 제목에 `quietEvents`(기본 점심·저녁·아침·간식·쉬기·샤워·기상) 단어가 있는 일정은 알리지 않습니다. 알림이 나갈 때 `bundleMinutes`(기본 30분) 안에 시작하는 다음 일정(최대 5개)을 같은 메시지에 "이어서 …"로 적고, 그 일정들은 따로 알리지 않습니다. 0이면 묶지 않음. 보낸 알림 기록(`reminders`)은 더 이상 지우지 않습니다.

## 초안 만드는 방식 (`src/schedule.ts`)

- 하루 범위는 `dayStart`~`dayEnd`(기본 07:00~22:30)이고, 캘린더 일정과 그대로 둔 블록은 비워 둡니다. 앞뒤로 쉬는 시간(`breakMinutes`, 기본 10분)도 둡니다.
- 마감이 있는 일은 남은 날짜에 고르게 나누고, 마감 당일에는 남은 것을 전부 넣습니다. 들어가지 않으면 "못 넣은 일"로 알립니다.
- **마감이 지난 열린 할 일은 다시 넣지 않습니다**(2026-11-26). 하루 보기의 `overdue`에 나오고, Kelly가 끝냈는지·새 마감인지·그만둘지 주인에게 묻습니다. (전에는 매일 남은 시간 전부를 다시 넣어서 수업 중 시험 "FAS Technical Test"가 다음 날마다 돌아왔음)
- **오늘을 다시 짜면 지금 이후만** 짭니다(2026-11-26). 이미 시작한 블록은 기록으로 그대로 두고, 새 블록은 지금 시각(5분 단위 올림) 뒤에만 넣습니다. 지나간 블록 시간은 한 것으로 치지 않습니다.
- **할 일을 끝내거나(done) 보관(archived)하면** 지금 이후의 자동 블록(origin auto)이 초안에서 빠집니다(2026-11-26). 캘린더에 이미 있는 블록은 그날을 다시 confirm할 때 지워집니다(block_remove와 같음). 주인이 직접 넣거나 옮긴 블록(manual)은 남습니다. 1분마다 도는 작업도 같은 정리를 해서 다른 경로로 닫힌 할 일의 블록도 빠집니다. 뺀 블록은 `change_log`에 이유(`todo done`/`todo archived`)와 함께 남습니다.
- 마감 없는 일은 하루 최대 `undatedDailyMinutes`(기본 2시간)까지 넣습니다. 하루 총량은 `maxFocusMinutes`(기본 8시간), 한 블록은 `maxBlockMinutes`(기본 90분) 이하입니다.
- **블록은 `minBlockMinutes`(기본 25분)보다 짧게 만들지 않습니다**(2026-11-26, 실제 5분짜리 "CSC207 A3 Submission" 블록). 남은 일이 그보다 짧은 할 일은 넣지 않고 `change_log`의 generate 기록에 `tooSmall`로 남깁니다(마감 표시는 그대로). 나누다 자투리가 생기면 앞 블록을 줄여 마지막 블록이 최소 길이가 되게 합니다.
- **블록을 퍼뜨립니다**(2026-11-26, 전에는 모두 07:00부터 붙어 있었음): 가장 큰 빈 시간부터 채우고(같으면 이른 쪽), 그 안에서 남는 시간을 블록 앞에 나눠 둡니다(블록마다 최대 60분, 5분 단위). 같은 입력이면 같은 초안입니다.
- 사용자가 직접 바꾼 블록(manual)은 다시 만들어도 남습니다.
- 지난 날의 블록은 끝낸 것으로 치지 않습니다. 사용자가 Kelly에게 "다 했어"라고 말해야(`todo_progress`) 다음 계획에서 빠집니다.
- `todo_progress`는 `done=true`일 때만 끝냄으로 바꿉니다(2026-11-26). 예상 시간에 닿아도 열린 채로 두고, Kelly 표시에 "예상 시간 다 씀 - 끝났는지 물어보기"가 붙습니다.

## 실제 기록과 주인 속도 (2026-11-26, migration 5)

Kelly의 주 목적(AGENTS.md): 주인이 일정마다 실제로 언제 끝났는지, 늦어진 것, 한 양을 말하면 기록하고, 쌓인 기록으로 주인 속도에 맞춰 계획합니다.

- `POST /reports`: 블록(`blockId`), Kelly 캘린더 일정(`eventId`), 또는 계획에 없던 일(`title`+`date`)에 대해 `status`(done | partial | skipped | late), `actualStart`·`actualEnd`, `minutes`, `percent`(한 양 %), `note`(주인이 말한 이유). 계획 시각·분·분류·과목 코드(제목의 STA256 등)도 같이 저장합니다. 앞으로의 날짜는 받지 않습니다.
- `reports` 표는 **고치지 않습니다**. 정정은 `corrects`(정정할 report id)가 있는 새 줄입니다. 할 일에 연결된 블록이면 그 분만큼 할 일 진행이 늘어납니다(정정이면 차이만). 끝냄으로 바꾸지는 않습니다.
- 분이 없으면: 실제 시작·끝으로 계산, 끝만 있으면 계획 시작부터, done이면 계획 분, skipped면 0.
- `GET /pace?days=28`: 기간 안 보고로 과목별·분류별 실제/계획 비율(`ratio`, 일부만 한 일은 `percent`만큼의 계획과 비교), 끝 시각이 평균 몇 분 늦었는지(`endDelayMinutes`), 상태별 개수. 정정된 보고는 마지막 것만 셉니다.
- 하루 보기의 블록·일정에 마지막 보고가 `reported`로 붙습니다(Kelly 표시 `[보고: …]`).

## 다가오는 시험·마감 (`GET /agenda?days=30`)

Kelly 캘린더의 시험 일정(시험 표시와 같은 기준), 짝 일정이 없는 시험 표시, 열린 할 일의 마감과 마감 지난 할 일을 날짜순으로 돌려줍니다(최대 180일). "첫 기말이 언제야" 같은 질문용(2026-11-24에 한 과목만 보고 틀리게 답함).

## 할 일 하나를 정한 시간에 바로 넣기 (`POST /todos/:id/schedule`)

주인이 "내일 2시에 넣어줘"라고 하면: `dryRun: true`로 블록과 겹치는 것을 보여 주고, 주인이 OK하면 그 블록 **하나만** Kelly 캘린더에 쓰고 할 일에 연결합니다(manual 블록이라 다시 짜도 남음). 그날의 다른 초안은 그대로입니다. 열린 할 일만 됩니다.

## 지난 시각 막기 (2026-11-26)

`event_add`, `event_update`(시각을 바꿀 때), `block_add`, `block_update`(옮길 때), 할 일 바로 넣기는 지난 날짜나 이미 지난 시각(15분 여유)이면 `past_time`으로 거절합니다. 주인이 일부러 지난 일을 남기려는 거면 `allowPast: true`. 반복 일정은 시리즈가 이미 끝났을 때만 거절합니다(시작일이 과거인 학기 수업은 됨).

## 기록 남기기 (2026-11-26)

- 로그는 stdout과 함께 `planner-data` 볼륨의 `/var/lib/planner/logs/planner-YYYY-MM-DD.jsonl`(UTC 날짜)에 덧붙입니다. 지우거나 다시 쓰지 않습니다. 위치는 `PLANNER_LOG_DIR`(`off`면 stdout만). compose 변경은 필요 없습니다.
- 실패는 `change_log`에 `action: fail`로 남습니다(단계, 오류 코드, 상태, 짧은 메시지; 비밀 없음): 일정 쓰기(`event_add`·`event_update`·`event_remove`·`proposal_apply`·`todo_schedule`), 계획 확정(`confirm`: 쓴 것·못 쓴 것), 작업(`job`: 같은 오류는 10분에 한 번, 다시 되면 `recover`), notifier가 거절한 메시지(`notify`).
- 확정 중 Google 오류가 나면 `calendar_partial`(502)로 어느 날 무엇을 썼고 무엇을 못 썼는지 알려 줍니다. 같은 날짜로 다시 확정하면 이어서 씁니다.

## 새 설정 (2026-11-26)

| 설정 | 기본 | 뜻 |
|---|---|---|
| `noDraftExamWords` | `["final", "기말"]` | 이 단어가 제목에 있는 시험 일정이 있는 날은 자동 초안 없음 (`[]`이면 끔) |
| `quietEvents` | 점심·저녁·아침·간식·쉬기·샤워·기상 | 제목에 이 단어가 있는 일정은 알림 없음 |
| `bundleMinutes` | 30 | 한 알림에 이 분 안에 시작하는 다음 일정을 같이 적음 (0이면 끔, 최대 180) |
| `draftAt` | `null` (= `sleepStart` 30분 전, 18:00–23:55 밖이면 23:00) | 저녁 초안 시각 (18:00–23:55) |

아침 메시지 시각은 `sleepEnd`(03:00–11:59 밖이면 06:00)입니다.

## 확인 규칙

- 계획 확정(캘린더에 쓰기), 고정 일정 변경·삭제, 가져오기, 마감 변경, 할 일 삭제: 사용자의 명시적인 OK가 필요합니다. 도구 인자 `confirmed_by_user=true`가 없으면 플러그인이 보내지 않습니다.
- 그 밖의 변경(할 일 추가, 예상 시간, 우선순위, 진행 기록, 설정): 바로 적용하고 사용자에게 알립니다.
- 모든 변경은 `change_log`에 누가(hermes / system / calendar), 무엇을, 이전 값과 이후 값까지 남깁니다(`changes`). 일정을 지울 때는 다시 넣을 수 있게 제목·시각·장소·메모·반복 규칙·이유까지 남깁니다(2026-11-25).
- **같은 턴 확인 금지**(2026-11-25, Hermes `guard.py`): `confirmed_by_user=true` 호출은 같은 인자로 확인 없이 부른 미리보기가 **앞선 턴**에 있어야 통과합니다. 주인이 답한 뒤에만 실행된다는 뜻이고, 미리보기 하나는 한 번만 씁니다. 막힌 것과 통과한 것은 Hermes `agent.log`에 남습니다(`personal_ai.guard`).

## 겹침 검사와 대체 (2026-11-25)

- `POST /events`, `POST /events/:id/update`는 `dryRun: true`를 받습니다. 아무것도 쓰지 않고 그 시간에 이미 있는 일정·계획 블록(`overlaps`)만 돌려줍니다.
- Kelly 도구는 시간이 있는 일정을 넣거나 옮기기 전에 항상 `dryRun`을 먼저 부릅니다. 겹치는 게 있으면 쓰지 않고 목록을 주인에게 물어봅니다. `block_add`도 같은 검사를 합니다.
- 반복 일정은 오늘부터 120일 안의 **모든 날짜**를 검사하고(`until`·`count`가 있으면 거기까지), 겹침마다 `date`를 붙입니다(2026-11-26: 첫 날만 봐서 매주 금 일정이 12/11 기말과 겹쳐도 몰랐음).
- `POST /blocks/:id/update`도 새 시각의 겹침(`overlaps`)을 돌려주고 `dryRun`을 받습니다. Kelly 도구는 겹치면 먼저 묻습니다.
- 자정을 넘는 일정의 시작만 옮기면 길이를 그대로 두고 끝을 다음 날로 옮깁니다(전에는 "start must be before end"로 실패).
- 시안 안 겹침 경고는 한 번짜리 항목(날짜)과 반복 항목(요일)도 비교합니다(그 날짜가 반복에 들어가는지).
- `replace: true`는 쓴 뒤에 겹친 것 중 **계획 블록과 한 번짜리 일정만** 지웁니다. 수업(`class`), 시험·퀴즈, 이동, 반복 일정은 지우지 않고 "아직 겹치는 것"으로 알려 줍니다. 지운 것은 `replaced`로 돌려주고 기록에 이유("replaced by event …")를 남깁니다.

## 시험 표시 (2026-11-25, migration 4)

- Kelly 캘린더의 시험·퀴즈 일정(`class`·`task` 분류, 제목에 Final Exam·Midterm·Test N·Quiz·기말·시험·퀴즈 등)마다 종일 일정 **"시험(이날): STA256 기말 17:00–20:00"**을 자동으로 둡니다. 주인이 고른 형식이에요. 공부·이동 일정("지난 시험 풀기", "시험 1시간 전 출발")은 제외합니다.
- 같은 날 같은 제목의 종일 일정이 이미 있으면 새로 만들지 않고 그것을 이어받습니다(adopt).
- 시험이 옮겨지면 표시도 따라가고, 시험이 지워지면 표시도 지워집니다. 지난 시험의 표시는 남깁니다. 표시는 직접 고칠 수 없고(시험 일정을 고침), `exam_markers` 표와 `change_log`(`exam_marker`)에 기록됩니다. 앞으로 120일까지 매 tick 확인합니다.

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
