# 학교 자료 초기 수집 안내서 (한 번만, 주인 + 다른 Claude)

목적: 실시간 감시(school 서비스)가 시작되기 **전**의 학교 자료를 한 번에 모아 지식 저장소에 넣습니다.
실시간 감시는 최근 것만 봅니다(Piazza 과목당 최근 50개, 메일 최근 60통, Quercus 활동 흐름). 그보다 오래된 것은 이 안내서대로 모아 주세요.
이 문서는 **수집을 맡은 Claude에게 그대로 주는 지시서**입니다.

## 0. 지켜야 할 것

- 토큰, 비밀번호, 쿠키 값은 **결과 파일에 절대 넣지 않습니다.** (본문에 우연히 들어간 것도 지웁니다.)
- 읽기만 합니다. 제출, 메시지 보내기, 글 쓰기, 읽음 처리는 하지 않습니다. (Gmail은 IMAP `EXAMINE`/읽기 전용으로 여세요.)
- 결과는 아래 두 폴더에만 씁니다.
  - 글(공지, 게시글, 메일, 성적 기록): `D:\personal_ai\data\knowledge-inbox\school\*.jsonl`
  - 파일(강의 슬라이드, PDF, 과제 설명 파일): `D:\personal_ai\data\knowledge-inbox\courses\<과목코드>\...`
- 수집에 쓰는 자격 정보는 주인의 `C:\Users\dydgh\.school-connectors\.env`에 있습니다. 그 파일을 복사하거나 다른 곳에 옮기지 마세요.

## 1. 무엇을 모으나

| 서비스 | 모을 것 | 방법 |
|---|---|---|
| Quercus | 과목마다: 공지 전부, 과제(설명·마감·점수), 성적, 모듈/페이지(강의계획서 포함), 받은 메시지 | Canvas REST API (`https://q.utoronto.ca/api/v1`, GET만, `Link` 헤더로 페이지 넘김) |
| Quercus Files | 강의 슬라이드, PDF, 과제 PDF | 파일 그대로 `courses\<과목코드>\` 아래에 (폴더 구조 유지) |
| Piazza | 이번 학기(원하면 지난 학기도) 과목의 글 전부 + 답변 + 후속 질문 | `piazza-api`: `get_feed(limit, offset)`로 목록, 글마다 `get_post(nr)` (요청 사이 1초 이상 쉬기) |
| UofT 메일 | Gmail로 전달된 UofT 메일 (school 서비스와 같은 판별 규칙) | Gmail IMAP 읽기 전용 |
| ACORN, Crowdmark | 모으지 않음 | Crowdmark 채점 PDF는 주인이 받아서 Kelly에게 줍니다 |

## 2. 글 파일 형식 (`.jsonl`: 한 줄에 JSON 하나)

```json
{"service":"piazza","id":"mt1qu7tffk56ae:849:2026-11-22T17:20:00Z","kind":"post","title":"@849 Midterm marks released [instructor]","url":"https://piazza.com/class/mt1qu7tffk56ae/post/849","date":"2026-11-22T17:20:00Z","course":"CSC 207","body":"질문/공지 본문...\n\n[강사 답변] ...\n\n[후속 질문] ...","extra":{"instructor":true,"tags":["instructor-note"]}}
```

| 필드 | 필수 | 내용 |
|---|---|---|
| `service` | ✓ | `quercus` · `piazza` · `outlook`(UofT 메일) |
| `id` | ✓ | 아래 3절 규칙 그대로 (1~300자) |
| `kind` | ✓ | `announcement` `assignment` `grade` `submission` `page` `message` `discussion` `post` `email` |
| `title` | ✓ | 제목 한 줄 (300자까지) |
| `body` | | **전체 본문, 일반 텍스트** (HTML은 텍스트로 바꾸고 줄바꿈 유지) |
| `date` | | ISO 8601 (`2026-11-22T17:20:00Z`) |
| `course` | | 과목 코드 (`CSC207`, `STA 256` 등) |
| `url` | | 원본 주소 |
| `extra` | | 그 밖의 정보 (점수, 마감, 보낸 사람 등). 비밀 정보 금지 |

이 밖의 필드가 있거나 형식이 틀린 줄이 하나라도 있으면 **파일 전체를 거부**합니다(아무것도 저장 안 함). 파일 이름은 자유(`quercus-CSC207.jsonl` 등)입니다.

## 3. `id` 규칙 (실시간 감시와 겹치지 않게)

같은 `service` + `id`는 한 번만 저장됩니다. **실시간 감시와 같은 규칙**을 써야 최근 글이 두 번 들어가지 않습니다.

| 대상 | `id` |
|---|---|
| Piazza 글 | `<class nid>:<nr>:<피드의 modified 값 그대로>` (실시간과 동일) |
| UofT 메일 | 메일 헤더 `Message-ID` 그대로 (`<...@...>` 꺾쇠 포함, 실시간과 동일) |
| Quercus 공지 | `announcement:<id>:<posted_at>` |
| Quercus 과제 | `assignment:<id>:<due_at 또는 none>` |
| Quercus 성적 | `submission:<assignment id>:<graded_at>` (점수는 `extra.score`, `extra.points_possible`) |
| Quercus 페이지·강의계획서 | `page:<course id>:<page url>:<updated_at>` |
| Quercus 받은 메시지 | `conversation:<id>:<last_message_at>` |

Quercus 실시간 감시는 "활동 흐름" id(`stream:...`)를 쓰므로, **최근 몇 주의 공지·성적은 두 번 저장될 수 있습니다**(내용은 같고 출처 표시만 다름). 지식 저장소에서는 문제가 되지 않습니다.

메일은 school 서비스와 같은 규칙으로 UofT 메일만 고릅니다: `To`, `Cc`, `X-Original-To`, `Resent-*`, `X-Forwarded-*`, `ARC-Authentication-Results`, `X-MS-Exchange-CrossTenant-Id`, `Received` 중 하나에 `utoronto.ca`, 주인의 UofT 주소, 또는 테넌트 ID `78aac226-2f03-4b4d-9037-b46d56c55210`가 있으면 UofT 메일입니다. 개인 메일은 넣지 않습니다.

## 4. 넣기 (Claude Code가 실행)

```powershell
# 글: school 서비스가 읽어서 지식 저장소에 넣음 (알림 없음, 같은 id는 건너뜀)
docker exec personal_ai-school-1 python -m school import /import
# 파일: 지식 저장소 가져오기 (해시로 중복 건너뜀)
$F += '-f','compose.knowledge-operator.yaml'
docker compose @F --profile tools run --rm knowledge-importer scan courses --dry-run
docker compose @F --profile tools run --rm knowledge-importer scan courses
```

결과 예: `{"items": 812, "added": 640, "alreadyKnown": 172, "savedToKnowledge": 640, "notYetSaved": 0}`.
`notYetSaved`가 0이 아니면 지식 저장소가 잠시 응답하지 않은 것이므로 같은 명령을 다시 실행하면 됩니다.

## 5. 그다음 (Claude Code가 정리)

넣은 뒤에는 `node services\knowledge\scripts\kb.mjs`로 과목·개념 문서를 정리합니다(강의계획서 → 과목 문서의 사실, 주차별 주제 → 개념 문서와 `covers` 링크). 방법은 `docs/knowledge/LEARNING_MODEL.md`.
