# 다음 세션 지시서: 기말 대비 자료 주입 → Kelly와 일정 짜기

이 파일은 새 Claude Code 세션에 그대로 주는 지시서입니다. (작성 2026-11-23)

---

## 너의 역할과 목표

너는 `D:\personal_ai`의 Personal AI OS를 운영하는 Claude Code다. 주인(학생, UTM 컴퓨터과학)의 기말고사가 **2~3주 뒤**다.
이번 세션의 목표:

1. 주인이 주는 **강의 자료, 시험 성적·채점된 시험지, 기본 정보**를 지식 저장소(knowledge)에 넣고, 과목별로 정리한다.
2. 그러면 주인이 Discord에서 Kelly(Hermes)와 논의해 **일별 공부량**(예: "MAT223 문제 10개", "지난 강의 복습")을 정하고 이번 주 일정을 planner와 Google Calendar에 잡는다.
3. Kelly가 말을 잘 못 알아듣거나, 주인이 하지 말라고 한 것을 하면, 주인이 너에게 말한다. 너는 원인을 찾아 고친다.

이번 학기 과목: **CSC207, CSC236, MAT223, STA256, FAS147**(사진 실기, 기말 시험 없음).

기말 일정 (`data/knowledge-inbox/courses/final_schedule.txt`, 모두 RA Gym A/B):

| 날짜 | 시간 | 과목 |
|---|---|---|
| 12월 10일 (목) | 17:00–20:00 | STA256 |
| 12월 11일 (금) | 17:00–20:00 | CSC207 (양면 메모 시트 허용, Piazza @549) |
| 12월 16일 (수) | 09:00–12:00 | CSC236 |
| 12월 19일 (토) | 09:00–12:00 | MAT223 |

학교 자료는 Kelly뿐 아니라 **주인이 다른 AI 서비스에 zip으로 건네 복습·퀴즈에 쓴다.** 영상과 외부 읽기 자료 본문까지 모으는 이유다. 자료를 바꾸면 `python -I services\school\scripts\pack-course.py all`로 `data\exports\`의 묶음을 다시 만든다.

## 먼저 읽을 것

1. `docs/handover/AGENT_HANDOFF.md`: 전체 구조, 서비스, 보안 원칙
2. `services/knowledge/README.md`: 4층 구조, 운영자 CLI `kb.mjs`, 가져오기(importer)
3. `docs/knowledge/LEARNING_MODEL.md`: 자료와 개념 분리, `covers` 링크, 숙련도와 망각 설계
4. `services/planner/README.md`와 `services/hermes-integration/skills/personal-ai-planner/SKILL.md`: Kelly가 할 일·계획을 다루는 방법
5. `services/school/README.md`, `services/llm-gateway/README.md`: 학교 소식 수집과 AI 모델 경로 (이번 세션에서 바꿀 일은 거의 없음)
6. `services/hermes-integration/skills/personal-ai-knowledge/SKILL.md`: 특히 "Feedback and preferences" 절

## 반드시 지킬 규칙 (주인의 요구)

- **보고는 한국어로.** 확인하지 않은 것을 성공이라고 말하지 않는다. 실패는 그대로 보고한다. 검증은 실제 Docker에서 한다.
- **비밀 값은 절대 출력하지 않는다** (토큰, 키, 비밀번호, 웹훅). 존재 여부와 길이만 말한다. `secrets/` 파일 내용은 키 이름만 보고 값은 가린다.
- `secrets/temp/mark_memory.md`는 주인이 쓰던 메모리 초안이다. **주인이 넣으라고 할 때만** 읽고 넣는다.
- **커밋은 주인이 요청할 때만** 한다. 커밋에 AI 흔적(Co-Authored-By 등)을 남기지 않는다. push, PR, merge는 하지 않는다.
- `data/`, `secrets/`, `workspaces/`는 지우거나 초기화하지 않는다. DB 구조를 바꾸기 전에는 백업한다.
- Kelly 관련 데이터는 **D: 드라이브에만** 둔다.
- 영구 삭제(`purge`)는 주인의 명시적인 OK가 있을 때만 한다.
- 호스트 포트는 127.0.0.1에만 연다. 컨테이너에 Docker 소켓을 주지 않는다. Hermes에 컨트롤러·GitHub·공급자 키를 주지 않는다.
- 필요한 서비스만 다시 만든다(`up -d --no-deps <서비스>`).
- 파이썬 패치 스크립트를 heredoc으로 쓰면 `\b`가 백스페이스 문자가 되는 사고가 있었다. 정규식이 든 수정은 Edit 도구로 하고, 수정 뒤 제어문자를 검사한다.

## compose 파일 목록

```powershell
$F = "-f compose.yaml -f compose.workers.yaml -f compose.controller.yaml -f compose.github.yaml -f compose.dashboard.yaml -f compose.publisher.yaml -f compose.test-runner.yaml -f compose.learning.yaml -f compose.notifier.yaml -f compose.planner.yaml -f compose.knowledge.yaml -f compose.llm.yaml -f compose.school.yaml".Split(' ')
```

(bash에서는 같은 목록을 `F="..."`로 쓰고 `docker compose $F ...`)

## 1단계: 자료 확인과 가져오기

이미 들어와 있는 것 (2026-11-23):
- `courses\CSC236`(31개), `MAT223`(65개), `STA256`(58개), `FAS147`(27개): 주인이 넣은 강의 자료. 시험지·채점지가 어디 섞여 있는지 목록을 보고 확인한다.
- `courses\CSC207\site\`: 강의 사이트 전체 사본(230개, 영상 5개 포함). **`site\INDEX.md`가 주차별 목차**(랩, 읽기 자료, 강사별 슬라이드)이고, 지난 기말 19F(정답 포함)·22F와 중간고사 정답이 `finals\`, `midterm\`에 있다. Oracle 튜토리얼 등 읽기 자료는 `external\`에 텍스트로.
- `courses\final_schedule.txt`: 위 기말 일정.
- Piazza 4과목 글 851개(답변·후속 질문 포함): **이미 지식 저장소에 있다**(`school:piazza:<nid>:<nr>:backfill`). 다시 넣지 않는다.
- `me\`에는 `mark_memory.md`뿐이다. 주인이 넣으라고 할 때만 가져온다. 다른 기본 정보는 주인에게 묻는다.

주의:
- FAS147의 옛 형식 `.doc`·`.ppt` 8개는 importer가 글자를 뽑지 못한다(파일로만 저장). 필요하면 직접 열어 보고 요약을 `note`로 남긴다. `.webloc`은 링크 바로가기다.
- 영상(`.mp4`, `.mov`)은 파일로만 저장되고 내용은 검색되지 않는다. 자막(.srt)이 생기면 그때 넣는다.

순서:
1. 운영자 접근을 연다. **지금은 닫혀 있다.** knowledge가 운영자 overlay 없이 다시 만들어졌기 때문이다.
   ```powershell
   $O = $F + @('-f','compose.knowledge-operator.yaml')
   docker compose @O up -d --no-deps knowledge
   node services\knowledge\scripts\kb.mjs status
   ```
2. 무엇이 있는지 목록을 보고 주인에게 요약한다(과목별 파일 수, 종류).
3. 미리보기 후 가져온다. 해시가 같은 파일은 건너뛴다.
   ```powershell
   docker compose @O --profile tools run --rm knowledge-importer scan courses --dry-run
   docker compose @O --profile tools run --rm knowledge-importer scan courses
   docker compose @O --profile tools run --rm knowledge-importer scan me
   ```
4. **스캔본·손글씨 시험지는 글자가 뽑히지 않는다** (OCR 없음. 이미지는 `pending:ocr`). 그런 PDF와 이미지는 네가 직접 열어 보고(Read 도구로 PDF·이미지 읽기) 문항별 점수, 틀린 문제, 문제 주제를 정리한다. 결과는 `kb.mjs note`로 원본으로 남기고, 사실은 과목 문서에 넣는다.
5. 학교 글 `.jsonl`(`knowledge-inbox\school\`)은 이미 넣었다. 새로 모은 것이 생기면 같은 명령으로 넣는다(같은 id는 건너뜀): `docker exec personal_ai-school-1 python -m school import /import` (Git Bash에서는 앞에 `MSYS_NO_PATHCONV=1`). 형식: `docs/knowledge/SCHOOL_BACKFILL.md`

## 2단계: 과목별 정리 (Kelly가 계획을 세울 재료)

`kb.mjs`(`page-save`, `fact-add`, `link`, `--file`로 여러 개)로 과목마다 만든다.
- **과목 문서**(type `course`, 제목 = 과목 코드, 별칭에 과목 이름)
  - 요약: 기말 날짜·시간·장소, 기말 범위, 배점(강의계획서 기준)
  - 사실: 지금까지의 시험·과제 점수(날짜, 출처), 강의 주차별 주제
- **약한 주제**: 지난 시험에서 점수를 잃은 문항 → 해당 주제(type `topic` 문서)에 "Test 1 3번 4/10 (2026-10-15)" 같은 사실을 넣고, 과목과 `covers` 또는 `part_of` 링크로 잇는다. 숙련도 엔진은 아직 없다. 증거를 사실로 남기는 것까지만 한다.
- **문제 출처와 개수**: 과목 문서에 "연습문제 출처: 교재 4.2절 25문제, 지난 기말 2개(2023, 2024), Quiz 1~5" 같은 사실을 남긴다. Kelly가 "하루 MAT223 10문제"를 정할 때 쓴다.
- **기본 정보** → `me` 문서(요약, 사실). 공부 습관이나 원하는 방식("아침에 집중이 잘 됨", "한 번에 90분 이하") → **`preferences` 문서**("취향과 피드백")에 사실로. 이 문서의 사실은 Kelly의 모든 대화에 항상 들어간다.
- 정리가 끝나면 주인에게 과목별로 한 화면 요약을 보여주고, 틀린 곳을 고친다.

## 3단계: 주인이 Kelly와 계획 (너는 대기 + 확인)

- 주인이 Discord에서 Kelly와 이번 주 일정을 짠다. Kelly는 `personal_ai_planner`(할 일·예상 시간·마감·하루 계획·캘린더)와 `personal_ai_knowledge`(과목 정보 검색)를 쓴다.
- 시작 전에 Kelly가 재료를 찾는지 한 번 확인한다:
  ```powershell
  docker exec personal_ai-hermes-1 hermes -z "시험 대비 준비 확인이야. MAT223 기말 날짜와 내가 약한 주제를 지식 저장소에서 찾아서 알려줘."
  ```
  (실제 대화 기록과 지식 저장소에 남는 one-shot이다. 꼭 필요할 때만.)

## 4단계: Kelly가 잘못할 때 고치는 방법

주인이 "Kelly가 이렇게 했어"라고 하면:
1. **무엇을 했는지 본다**
   - Hermes 대화 기록: `data/hermes/state.db`의 `messages`, `sessions` 테이블(읽기 전용으로 열 것). 도구 호출 이름과 인자, 결과를 확인한다.
   - 어느 모델이 답했는지: `docker logs personal_ai-llm-gateway-1`의 `"route"`, 또는 대시보드 AI usage.
   - 피드백이 저장돼 있었는지: `kb.mjs page preferences`.
2. **원인을 분류한다**: 지시가 약함(SOUL, 스킬) / 도구 설명이나 동작 문제 / 피드백이 저장되지 않음 / 모델 한계(Gemini로 넘어간 경우 등).
3. **고친다**
   - SOUL은 두 곳(`data/hermes/SOUL.md`, `services/hermes-integration/hermes-config/SOUL.personal-ai.md`)을 같이 고친다. 그 전에 `data/hermes/backups/soul/`에 백업한다.
   - 스킬과 도구: `services/hermes-integration/...`을 고치고 `python -m unittest discover -s services/hermes-integration/tests`를 돌린 뒤 `docker restart personal_ai-hermes-1`.
   - 빠진 선호는 주인 확인 후 `preferences` 문서에 넣는다.
4. 고친 뒤 같은 상황을 다시 시험하고, 무엇을 왜 바꿨는지 한국어로 보고한다.

## 현재 상태 (2026-11-23)

- 컨테이너 14개 정상. Kelly 모델: `llm-gateway`의 `kelly`(OpenAI 공유 무료 gpt-5.4-mini → Gemini 무료 → 유료는 주인의 `/ai-paid on`).
- 오늘 무료 사용량은 Discord `/ai-usage` 또는 대시보드 `http://127.0.0.1:8710/ai-usage`에서 본다. 일정 짜기처럼 긴 대화는 OpenAI 하루 무료 200만 토큰(80% 기준) 안에서 충분하다.
- school 서비스: Quercus·Piazza 20분마다, 메일은 IMAP IDLE로 즉시. 학교 글(Piazza 전체 포함)이 이미 지식 저장소에 있다(source `school`, 원문 993개). Quercus 토큰 만료일은 2026-12-22.
- Kelly는 검색 결과의 원문 조각만 보고 답하지 않도록 고쳐져 있다(검색 결과 note → `raw`로 원문 읽기). 지식 저장소 백업: `data/backups/knowledge/knowledge.db.pre-piazza-snippet-purge.20261123`.
- 학교 자료 스크립트: `services/school/scripts/` (`course-site-crawl.py`, `piazza-to-jsonl.py`, `pack-course.py`). 사용법은 `services/school/README.md`.
- 없는 것: OCR, 숙련도 엔진(`LEARNING_MODEL.md`는 설계만), planner 할 일의 외부 ID 중복 방지.
- 운영자 접근은 작업이 끝나면 닫는다: `docker compose @F up -d --no-deps knowledge` (overlay 없이).
