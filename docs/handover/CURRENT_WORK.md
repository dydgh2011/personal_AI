# 현재 작업 상태

> 모든 에이전트(Claude Code, Codex)가 **시작할 때 읽고, 끝날 때 갱신**하는 파일이다(`AGENTS.md` 0절).
> 다음 에이전트가 이 파일만 보고 이어서 할 수 있게 쓴다. 오래된 항목은 지우고 최신 상태만 남긴다.

마지막 갱신: 2026-11-26 · Claude Code

## 스택 잠금
- **비어 있음** (2026-11-26 08:14 토론토 Claude Code가 knowledge 기존 데이터 영어 변환 뒤 비움, operator 닫음) ← 실행 중인 스택을 바꾸거나(rebuild, restart, operator, migration) `learning-os/l1`에 합칠 때 여기에 `이름 · 무엇 · 시작 시각`을 적고 커밋·push한다. 끝나면 다시 "비어 있음"으로 바꾸고 push한다. 자세한 절차는 `CODEX_PLAN.md` 2절.

## 지금 진행 중 (맡은 범위는 `docs/handover/CODEX_PLAN.md` 1절)
- **남은 Kelly 수정·대시보드 다국어·지식 영어 저장 · Claude Code + 서브에이전트 4개** (2026-11-26 02:10 토론토 시작, 주인 요청, 주인 자리 비움): ① planner·notifier·broker·planner_client(원래 폴더에서, 커밋 안 함) ② Kelly 안전장치 guard·변경 요약(worktree) ③ dashboard ko/en(worktree) ④ 지식 영어 저장(worktree, 기존 데이터는 목록만 만들고 주인 승인 대기). 합치기·배포·실제 확인은 Claude Code가 원래 폴더에서 하나씩. 결정: 자동 초안은 **기말 날만** 끔(주인).
  - **④ 지식 영어 저장 — 원래 폴더에 합침·knowledge 배포**(02:38 토론토): worktree `.claude/worktrees/knowledge-english`(브랜치 `claude/knowledge-english`, 커밋 없음)의 변경을 patch로 적용. AGENTS.md 1장 규칙 추가, knowledge SKILL·RULES·client 설명 영어 저장, course_brief 영어 정규식, knowledge.ts 기본 문서·정리 문구 영어, review.ts 영어 보강, text.ts 한국어 질문→영어 문서(별칭 확장), 적용 스크립트 `services/knowledge/scripts/english-apply.mjs`(기본 미리보기). 백업 `data/backups/knowledge/knowledge.db.20261126-023633`(integrity ok) → `stack.ps1 rebuild knowledge`(빌드 중 테스트 47 통과, healthy). 실환경: `me` "나 (owner)"→"Me (owner)", `preferences` "취향과 피드백"→"Preferences and feedback", 옛 제목은 별칭, change_log 2666·2667(system, before/after). **hermes 재시작 전**이라 knowledge 플러그인 RULES는 아직 옛것(SKILL은 마운트라 바로 적용).
  - **기존 한국어 데이터 영어 변환 — 완료**(2026-11-26 08:12 토론토, 주인 승인: "번역본으로 바꿔줘 그리고 기존꺼를 백업해놓아줘"). 백업: `data/backups/knowledge/knowledge.db.20261126-081120`(integrity ok) + 읽을 수 있는 원본 내보내기 `data/backups/knowledge/knowledge-before-english.20261126-*.json`(문서 35, 사실 140). 승인 사본 `data/plans/knowledge-english/proposal-20261126-023139.approved.json`(원래 제안은 그대로) → operator open → 미리보기(문서 33·사실 139, 건너뜀 0) → `--apply`(실패 0, 결과 `apply-20261126-131206.json`) → operator close. change_log: operator page update 33, fact supersede 139(옛 한국어 사실은 superseded로 남음). 결과: 한국어 제목은 '용환이 형'만(한국 사람 이름, 일부러 둠), 한국어 요약 0, slug는 그대로(한국어 slug 포함), 옛 한국어 제목은 별칭. Kelly에게 한국어로 "통계 기말 약점" 물으니 영어 사실에서 문항·점수까지 답함.
  - school 확인: knowledge로 가는 것은 학교 원문뿐(`school/clients.py:44-57`, `service.py:180-196`). 한국어 요약은 Discord·school DB로만 감 → 바꾸지 않음.
  - **① 플래너·알림 남은 수정 — 배포 완료**(02:46~02:50 토론토, 원래 폴더에서 서브에이전트가 작업, 커밋 안 함): 기말 날 자동 초안 끔(`noDraftExamWords` ['final','기말']), 알림 묶음(`bundleMinutes` 30)·조용한 일정(`quietEvents` 점심·저녁·아침·간식·쉬기·샤워·기상)·아침 06:00(`sleepEnd`)·밤 초안 22:30(`draftAt` null=sleepStart−30분), 실제 시각 기록 `reports` 표(migration 5)와 Kelly `report`/`pace`, 다가오는 시험·마감 `agenda`, 반복 일정 겹침 120일 검사, 짧은 블록 금지·블록 퍼뜨리기, 자정 넘는 일정 옮기기, block_update 겹침 미리보기, 지난 시각 거절(`allow_past`), 로그 파일(`/var/lib/planner/logs`, `/var/lib/notifier/logs`, 지우지 않음)과 실패 `change_log` `fail`, todo_progress 자동 완료 없음, 시안 한 번짜리↔반복 겹침, confirm 일부 실패 `calendar_partial`, broker dryRun 쓰기 제한 제외, `todo_schedule`, 시험 같은 할 일 경고, `daysBetween` 월 계산 버그 수정. `reminders` 표 7일 삭제 코드 없앰(기록 규칙). 백업 `data/backups/planner/planner.db.20261126-024438.pre-migration5`(integrity ok) → rebuild notifier(28) → planner(52) → hermes-broker(20), 모두 healthy. 실환경: 06:00 `plan:today:2026-11-26` 발송, 06:55 알림 발송, 로그 파일 생김, `reports` 표 있음, 실패 기록 0, Kelly 도구로 `agenda`(첫 기말 STA256 12/10 맞음)·`pace`·새 설정 확인.
  - **② Kelly 안전장치 — 배포 완료**(07:3x 토론토): worktree `.claude/worktrees/kelly-guard-taint`(브랜치 `claude/kelly-guard-taint`, 커밋 없음)를 patch로 적용. 바깥 글(학교·문서·웹·raw·작업 결과)을 읽은 턴은 변경 차단, 확인 게이트 목록 순서 무시·미리보기 파일 저장(`data/hermes/personal-ai/confirmation-previews.json`, 생김 확인)·확인 때 주인 메시지 앞부분 기록, settings_update 항상 확인(guard + planner_client "이전 → 새" 미리보기), 답 끝 🧾 실제 변경 요약·⚠️ 거짓 완료 경고. 실환경에서 찾은 문제를 같이 고침: Kelly가 "기억해 뒀어"라며 Hermes 내장 memory(USER.md)에만 쓰고 지식 저장소에는 안 씀 → SOUL에 "주인 사실은 지식 저장소 fact_add" 규칙, 🧾에 memory 쓰기도 "Hermes 내부 메모(지식 저장소 아님)"로 표시, "기억해 뒀/remembered"도 완료 주장으로 봄. `configure-hermes` 적용·`--check` ok. hermes config 압축 값 변경(백업 `data/backups/hermes/config.yaml.pre-compression.20261126-073350`): threshold_tokens 40000→48000, target_ratio 0.20→0.15, min_tail_user_messages 1→2. hermes 재시작, Discord 연결 확인. 테스트 hermes-integration 156, configure-hermes 5.
  - 실환경 확인(oneshot `hermes chat -Q --oneshot`, 주인이 오늘 정한 실제 사실로): 한국어로 말한 사실이 `me` 문서에 영어 사실("The owner learns almost everything in English, so Korean document titles are hard to recognize.")로 저장되고 답 끝에 🧾 붙음, 한국어 질문으로 그 영어 사실을 찾음. 첫 시도(수정 전)에는 USER.md에만 영어로 남음(그대로 둠).
  - **③ 대시보드 ko/en — 배포 완료**(07:56 토론토): worktree `.claude/worktrees/i18n-dashboard`(브랜치 `claude/i18n-dashboard`, 커밋 없음)를 patch로 적용(`services/dashboard`만, 85개 파일). 사전 `src/i18n/ko|en/*.ts`(ko 모양이 타입, 빠진 키는 컴파일 오류), 쿠키 `pai_lang`(기본 ko, 서버에서 읽어 `<html lang>`), 사이드바·로그인 화면 전환 버튼, route flash·CSRF·세션 문구는 요청 쿠키로 번역(`routeT()`), 날짜·숫자 ko-KR/en-US, 390px 줄바꿈 CSS. tsc 0, vitest 143(원래 폴더와 이미지 빌드 둘 다). `stack.ps1 rebuild dashboard` healthy. 실제 브라우저(390px): 로그인 화면 ko 기본 → English 버튼 → `<html lang="en">`·`pai_lang=en`·가로 넘침 없음, 쿠키 ko로 되돌리면 한국어, 보호된 주소는 로그인으로 감. **확인 못 한 것**: 로그인 뒤 모든 메뉴의 ko/en × 라이트/다크 × 390px(관리자 비밀번호는 에이전트가 입력하지 않음 → 주인이 브라우저 패널에서 로그인 필요). 로그인 화면은 라이트 색 설정에서도 어둡게 보임(테마 쿠키 문제인지 원래 디자인인지 미확인). 남은 섞임(일부러 둠): 상태 코드 배지(running 등), 다른 서비스가 보낸 자유 문장, 제품 이름, JSON API 응답.
  - **확인 못 한 것**: 실제 Discord에서 바깥 글 차단 흐름(학교 공지 → 할 일), 기말 날 초안 건너뛰기(12/9 밤 처음 해당), 묶음 알림 문구, 22:30 밤 초안 문구, 영어 과목 사실의 약점 감지(아직 영어 과목 사실 없음 — 단위 테스트만), `report`/`todo_schedule` 실제 사용.
- **Kelly 초안 버그 1~3 · Claude Code** — **배포 완료**(2026-11-26 01:46 토론토, 원래 폴더 `D:\personal_ai`, 브랜치 `learning-os/l1`, **커밋 안 함**): 점검 보고서([KELLY_SCHEDULE_REVIEW_2026-11-26.md](KELLY_SCHEDULE_REVIEW_2026-11-26.md))의 🔴1~3을 고침. planner(`schedule.ts`, `planner.ts`, `jobs.ts`), `planner_client.py`(표시만), SKILL.md, README. 테스트 planner 35·hermes-integration 112 통과.
  - 배포: 백업 `data/backups/planner/planner.db.20261126-014605.pre-draft-fixes`(integrity ok, todos 11·blocks 55·change_log 480) → `stack.ps1 rebuild planner`(healthy) → `stack.ps1 restart hermes`(Discord 다시 연결).
  - 실환경 확인: planner 시작 직후 "Dropped plan blocks of finished todos count 12" — 11/27~29의 archived "… Final Exam Prep" 자동 블록 12개(캘린더에 없던 초안)가 지워지고 `change_log`에 `system`·`todo archived`로 12건 남음, 남은 닫힌 할 일 블록 0. Kelly 도구(hermes 안 `run_planner_tool` → broker → planner)로 `day`/`week` 읽기: 11/28에 `[마감 지남] FAS Technical Test (마감 2026-11-26, 남은 120분…)`, 주간 보기에서 1번만 나옴.
  - **확인 못 한 것**: "오늘 다시 짜기"와 "끝냄 → 블록 빠짐"은 실제 데이터를 바꾸므로 실환경에서 따로 하지 않음(단위 테스트·재현 스크립트로만 확인). 주인이 Discord에서 쓰면서 확인.
  - 참고: 11/27·11/28에 남은 "New Vision Due"·"CSC207 A3 Submission" 자동 블록(07:00대)은 열린 할 일이라 그대로이고 기말 계획 일정과 겹침 — 전날 23:00 자동 초안이 다시 짬(점검 보고서 🔴6, 주인 결정 대기).
  - **23:00/05:00 Discord 메시지에 마감 지난 할 일 표시 — 배포 완료**(01:52 토론토, 커밋 안 함): notifier `plan-format.ts`가 하루의 선택 칸 `overdue`({title, deadline, minutes})를 받아 "📌 마감이 지나 자동으로 다시 넣지 않는 할 일: …" 한 줄을 붙임(주간은 한 번만). planner `notify.ts`는 그런 할 일이 있을 때만 이 칸을 보냄. notifier는 모르는 칸을 거절하므로 **notifier를 먼저** 배포함(순서 바꾸면 그날 메시지가 400으로 버려짐). 테스트 notifier 25·planner 36 통과. 실환경: 실제 11/28 하루 보기를 배포된 planner `planDay` → 배포된 notifier 파서·포맷에 넣어 📌 줄 확인(Discord에는 보내지 않음). DB 구조·데이터 변경 없어 새 백업 없음. **확인 못 한 것**: 실제 Discord 메시지 — 오늘(11/26) 23:00 내일 초안에 "FAS Technical Test"가 처음 나와야 함.
- **C · Claude Code** (2026-11-24): 커밋 작성자=주인·AI 흔적 차단 배포. 비공개 저장소 실제 확인 완료(PAT로 discovery·동기화·export). GitHub App 연결·실제 게시 켬(대상: dydgh2011/personal-ai-sandbox만). **실제 게시 성공**: sandbox PR #1(draft, 브랜치 changes/6dfcb3df…), 커밋 author·committer = 주인(GitHub 계정 연결), 메시지·PR 본문에 흔적 없음. 승인·게시는 주인이 Dashboard에서 직접(에이전트는 대신 승인하지 않음). 남은 것: CI 결과 읽기(10). 브랜치 claude/publish.
- **공통(2026-11-25, Claude)**: learning·planner·hermes-broker를 내부망 learning-link-internal 하나로 연결(Docker 주소 여유 1개 남음). Dashboard Next.js 16.4.6. 사이드바 순서 편집(임시) 배포.
- **A · Codex** — **합쳐서 배포 완료**(2026-11-25, Claude): Learning L3 일정·복습, learning→planner 시안 연동. learning schema v3(백업 후). 실환경 learning→planner 가용 시간 조회 200. 남은 확인: 실제 시안을 만들어 플래너에서 승인하는 흐름(주인).
- **B · Codex** — **합쳐서 배포 완료**(2026-11-25, Claude): Kelly personal_ai_learning(조회·시안만), broker 호출자 인증 필수, configure-hermes --check(모두 ok), 서비스 지도 dashboard→learning 파서. 실환경: Kelly 도구→broker→learning 200. 2026-11-25 주인이 Hermes 설정 점검을 작업 스케줄러에 등록(`PersonalAI-HermesConfigCheck`, 매일 09:00, 첫 실행 결과 0), 레거시 secrets/hermes.controller.env는 주인 요청으로 삭제.
- **Kelly 지식·활동·미디어 · Codex** — **합쳐서 배포 완료**(2026-11-25, Claude): knowledge schema v4(백업 후), 시작 시 일간·주간 정리 실행 확인, knowledge-media(네트워크 없음) 정상, Kelly review 도구 ok. 남은 것: 받아쓰기 모델 ggml-base.bin(주인), 실제 Discord 이미지·음성 첨부로 확인.
- 각자 자기 줄만 고친다.

## 저장소와 스택
- 브랜치: `learning-os/l1` (origin에 push됨). `main`에는 주인 승인 없이 합치지 않는다. **2026-11-25 주인 요청으로 `main`을 `learning-os/l1`까지 fast-forward**(커밋 61개). **2026-11-25 밤 주인 요청으로 다시 fast-forward**(모델·effort, 학교 마감 → 할 일 후보, 기록 규칙 등 커밋 4개). **2026-11-26 새벽 주인 요청으로 다시 fast-forward**(Kelly 일정 안전장치 d96b016 + 이 기록). `experiment/kelly-course-brief`는 같은 기능이 이미 들어가 있어 합치지 않음(정리 후보).
- 스택: `D:\personal_ai`의 `personal_ai` 프로젝트, 컨테이너 14개. 운영은 `scripts\stack.ps1`.
- 서비스 지도: 1분마다 Windows 작업 스케줄러 `PersonalAI\ServiceMap`이 `services\service-map\collect.mjs`를 돌린다. Dashboard `/services`에서 본다.

## 최근에 끝낸 것 (2026-11-24)
- 사용량 그래프(`/ai-usage`), 사실 종류(62개 채움), 지식 그래프 보기·편집(`/knowledge`), 서비스 지도 1~3단계(`/services`).
- Kelly 일정 목록이 플래너 항목을 놓치던 문제 수정.
- 코딩 자동화 11·12·13(프로젝트별 규칙·금지 경로·스타일, 작성자는 저장만), Learning OS L2와 새 `/learning` 화면, Dashboard 로그인 유지, 네트워크 강화.
- Controller 이미지 빌드 실패(테스트 5초 시간 초과) 수정.

## 확인하지 못한 것 (주인이 실제로 쓰면서 확인 예정)
- 브라우저에서 새 `/learning` 화면, 프로젝트 설정 화면, `/services`의 허용 명령·호출 수.
- Dashboard 로그인 유지: 한 번 로그인한 뒤 Dashboard를 다시 만들어도 유지되는지.
- Learning AI 평가·초안의 실제 AI 호출(키·모델·월 상한 미설정).
- Discord에서 "입력 중" 표시와 답 끝 📌 기록 표시.

## 주인 결정 메모 (2026-11-25)
- **Learning → 플래너 시안 확인은 미룸**(2026-11-25 밤 주인): Learning 기능이 필요해질 때 주인이 직접 확인한다. 먼저 알리지 않는다. 순서: `/learning/planner`에서 가용 시간 저장 → 하루/7일 선택 → Send draft to Planner → Kelly에게 시안 보여 달라고 해서 승인 → 할 일·일정 생성 확인.
- **기록은 최대한 남긴다**(2026-11-25 밤 주인, `AGENTS.md` 1절): 용량·효율보다 나중에 원인을 정확히 알 수 있는 기록이 우선.
- **기말 계획 진행 방식 (2026-11-25 주인 결정)**:
  1. 주인이 관련 정보를 텍스트 파일로 줌 → Claude Code가 정리해서 `kb.mjs`로 지식 저장소에 넣음(운영자 접근은 쓰고 바로 닫음).
  2. Claude Code가 시안을 `data/plans/final-exam-2026/plan-claude.md`에 먼저 씀 → 같은 요청을 Kelly에게 보내 `plan-kelly.md`로 저장(Claude Code는 읽지 않음) → 주인이 비교. **2026-11-25 두 시안 완료 → 주인이 FAS(Sheridan, 화·목 필수, 12/8까지)·도서관 시간·44번 막차·주말 오전 Davis Building 정보를 더 줌 → `plan-claude.md` 수정, Kelly는 같은 추가 정보로 `plan-kelly-v2.md`를 새로 씀(읽지 않음, v1도 남김). 주인 비교·확정 대기.** → **확정(2026-11-25)**: Kelly 시안의 좋은 점(매일 모든 과목=미니 블록, 전날 오답 1개, 3줄 요약)을 합쳐 `plan-claude.md` 확정, 11/26~12/19 일정 363개를 Kelly 캘린더에 반영(플래너 시안 B~Y, Kelly 플래너 도구 코드를 스크립트로 호출, 다시 읽어서 363/363 확인). 생성기 `gen_plan.py`·적용 스크립트·적용한 항목 JSON은 같은 폴더에 있음. 남은 것: 플래너의 기말 준비 할 일 4개와 밤 23:00 자동 초안이 이 계획과 겹침(주인 결정).
  - **Kelly 시안 오류 개선 배포(2026-11-25)**: ① 마감 표시 "마감(이날까지): …"와 도구 설명(마감일 ≠ 일정 날짜), 기존 표시도 다시 씀(실제 확인). ② 3000자 넘는 답에는 "📌 저장소 기록"을 붙이지 않음, `scripts\kelly-draft.ps1`(세션 ID 줄 제거). ③ 플래너 시안 검사기 `services/planner/src/checks.ts`: 수면·막차·이동시간·보호 일정(시험, FAS147)·기간 안 마감. 주인 이동 정보는 플래너 설정에 넣음(places, travel, lastBus, protectedEvents). 실제 시험 시안으로 경고 확인 후 버림(Z). 테스트: planner 28, hermes-integration 103 통과. (파일 이름을 `claude.md`로 하면 Windows에서 CLAUDE.md 설정 파일로 읽혀서 바꿈)
  - 2026-11-25 그 밖: 오늘 19:00–20:00 "CSC207 과제 파악 및 일정 예상"을 Kelly가 캘린더에 넣음. 플래너에 60분 이하 짧은 일정 5분 전 알림 추가(`shortEventMinutes` 60, `shortRemindMinutes` 5, 테스트 25개 통과, 배포함). 이동시간·학습 방식·Kelly 역할(위험하면 고급 모델용 프롬프트를 주인에게 줌)을 지식 저장소에 넣음.
  3. 주인 수정 요청은 Claude Code가 지식 저장소를 보고 반영. 주인이 확정하면 플래너에 실제로 넣고, 필요하면 Kelly를 통해 Google Calendar에 넣음.
  4. 이동시간은 Claude Code가 장소별로 물어보고 주인이 예상 시간을 알려 줌. 수면 23:00~06:00 고정.
  - 1단계 완료(2026-11-25): 주인 파일 5개(TODO, 건강·식단·운동, 이력서 3종)를 원본 메모 5개 + 문서 13개 + 사실 40개 + 연결 13개로 정리. 원본 파일은 `data/knowledge-inbox/me/2026-11-25/`로 옮김. 백업 `data/backups/knowledge/knowledge.db.20261125-101447`.
  - 지식 저장소에 2026-11-25 추가: 수면 23~06(`me`, habit), 문제 풀이·대화형 학습 선호, 공식 문제 → Claude 예상 문제 순서, Kelly 역할, 이동시간 포함(`취향과 피드백`).

## 최근 변경 (2026-11-25 밤)
- **Kelly 일정 실수 바로잡기**(주인 요청, 플래너 변경 기록 04:56:17–04:56:25 UTC의 `hermes` 항목은 Kelly가 아니라 Claude Code가 Kelly 도구 코드로 한 것). 백업: `data/backups/planner/planner.db.20261125-235549`, `data/backups/knowledge/knowledge.db.20261125-235554`.
  - Kelly가 한 일(11-26 04:42–04:47 UTC): HW#4를 12/1 12:00–15:00에 겹침 확인 없이 넣음(이동·점심·A3·구인·S10과 겹침), 기말 종일 일정 요청에 선호만 저장, "넣어줘"에 엉뚱한 날짜로 `confirm`을 스스로 확인 표시 붙여 호출(409로 실패, 변경 없음), "대체해줘"에 같은 시간 초안 블록을 하나 더 만듦.
  - 고친 것: 중복 블록 삭제, HW#4 → 12/1 13:10–16:10 UTM 도서관(주인 선택), 대체된 블록 이동(구인공고 12/1 22:15–22:45, S10 12/6 21:25–22:40, A3 12/2 22:15–23:00, 모두 집, 주인 선택), 기말 종일 일정 4개 "시험(이날): <과목> 기말 <시각>"(12/10·12/11·12/16·12/19), 할 일 이름 "MAT223 HW#4"·메모·earliest 12/01, 선호 사실을 주인 말대로 고침. 다시 읽어서 확인, 12/6 마감 표시도 새 이름으로 바뀜.
  - **코드로 막음 (2026-11-26 새벽 배포, 커밋 안 함)**: planner migration 4(백업 `data/backups/planner/planner.db.20261126-000937.pre-migration4`) 다시 만들고, `configure-hermes.mjs`(SOUL 백업 `data/backups/hermes/SOUL.md.pre-overlap-rules.*`) 뒤 hermes 재시작.
    - 겹침 검사: `event_add`·`event_update`는 planner `dryRun`으로 먼저 보고, `block_add`는 그날을 읽어서 겹치면 쓰지 않고 목록을 주인에게 묻게 함. `replace=true`는 블록·한 번짜리 일정만 지움(수업·시험·이동·반복은 남기고 알림), 지운 일정은 다시 넣을 수 있게 전부 기록.
    - 확인 턴 규칙(`guard.py` `ConfirmationGate`): `confirmed_by_user=true`는 같은 인자의 미리보기가 앞선 턴에 있어야 통과, 한 번만. Hermes `agent.log`에 `personal_ai.guard` 줄로 남음. Hermes 재시작 때 미리보기 기억은 비워짐(다시 미리보기하면 됨). oneshot(`hermes chat -Q`)으로는 확인이 필요한 쓰기를 할 수 없음.
    - 시험 표시: 시험·퀴즈 일정마다 "시험(이날): …" 종일 일정 자동(`exam_markers`). 손으로 넣은 기말 4개는 이어받음(중복 0).
    - 실환경 확인: 12/1 겹침 미리보기 2건 → 쓰기 0건, 실제 Kelly 턴(oneshot, 없는 event_id)에서 같은 턴 확인이 막힘·로그 남음. 테스트: planner 30, hermes-integration 108, configure-hermes 3 통과.
    - **확인 못 한 것**: 주인이 Discord에서 겪는 실제 흐름(미리보기 → 답 → 실행), 새 시험 일정이 생길 때 자동 표시(기존 4개 이어받기만 봄).
    - **Discord 매일 새 대화 (2026-11-26 새벽)**: 주인이 `hermes-session-reset-policy`(카탈로그 커뮤니티, 커밋 0f2ea5ad 고정, 코드 검토: 네트워크·파일·외부 실행 없음)를 설치·켬. Claude Code가 `data/hermes/config.yaml`에 `session_reset: {mode: daily, at_hour: 9}` 추가(백업 `data/backups/hermes/config.yaml.pre-session-reset.20261126-004529`), hermes 재시작. 컨테이너 시계가 UTC라 9 = 토론토 04:00(겨울)/05:00(여름). 플러그인 로드(`armed`), 추가 권한 tools.override는 거부됨, Discord 연결 확인. **확인 못 한 것**: 실제 초기화. 켠 뒤 첫 메시지는 시각만 기록하고, 2026-11-27 04:00(토론토) 뒤 첫 Discord 메시지에서 새 세션이 시작돼야 함 → Hermes `agent.log`의 `session-reset-policy: reset` 줄과 `state.db` sessions의 end_reason으로 확인.
  - 참고: 기말 계획(`gen_plan.py`)은 화·목 UTM 수업·튜토리얼과 겹치게 만들어져 있음(계획 문서 264줄에서 "수업 일정은 그대로 둠"으로 확정한 부분).
- **학교 마감 → 할 일 후보 배포**(주인 요청): school(`deadline_decisions`·`deadline_history` 표 추가, 백업 `data/backups/school/school.db.20261125-230302`), hermes-broker 다시 만들고, `configure-hermes.mjs`로 SOUL 갱신(백업 `data/backups/hermes/SOUL.md.pre-deadline-candidates.*`), hermes 재시작.
  - Quercus 과제 마감 → 후보(UTC를 토론토 날짜로, 00:00 마감은 전날). 새 과제 알림 요약 칸에 코드가 마감 시각을 씀. 일정·할 일 질문이면 결정 전 후보를 코드가 Kelly 답변 재료에 붙임.
  - Kelly `personal_ai_school`: `deadlines`, `deadline_add`(예상 시간 필요, 플래너 할 일 생성, 메모에 `[quercus:id]`로 중복 방지), `deadline_dismiss`, `deadline_reopen`. 쓰기는 모두 `confirmed_by_user` 필요.
  - 실환경 확인: Kelly 도구 → broker → school로 후보 조회(토론토 19:00, 4점), 확인 없는 쓰기 거절, 주인 말대로 CSC236 Week 11 Exercises '안 함' 기록(이유 포함, 이력·로그 남음). 테스트: school 20, broker 20, hermes-integration 106 통과.
  - **확인 못 한 것**: 실제 새 과제 알림 문구(새 과제가 와야 함), 주인이 Discord에서 "넣어줘" 했을 때 실제 할 일 생성(단위 테스트로만 확인). Piazza·메일 속 마감은 다루지 않음.
  - 참고: Week 11 Exercises 마감은 11/26이 아니라 **11/25 19:00 토론토**였음(전에 UTC 날짜로 잘못 읽음).
- **대화 기록**: 메모리 제공자를 켠 뒤 Discord 주인 메시지 8개가 모두 지식 저장소 원본에 있음을 Hermes `state.db`와 비교해 확인. 그 전 대화(11-20~22)는 주인 결정으로 옮기지 않음. 주인 정보를 사실로 정리하는 건 Kelly가 대화 중에 할 때만(자동 추출 없음).
- **Hermes 내장 메모리 고침**: `data/hermes/memories/MEMORY.md`의 "m4a 받아쓰기 불가" 줄을 "media_submit으로 받아쓰기 가능"으로 바꿈. 원본 백업 `data/backups/hermes-memory/MEMORY.md.20261125-224817`. 새 대화부터 적용.
- **Worker 모델·effort 선택 배포** (ROADMAP 12-1): Controller v8(백업 후), controller·claude-worker·codex-worker·hermes-broker·dashboard 다시 만들고 hermes 재시작. 기본값은 둘 다 CLI 기본값(아직 바꾸지 않음). Kelly에게 "opus로, effort high로 …" 하면 그 작업만, "codex 기본 effort를 high로 바꿔줘" 하면 확인 뒤 기본값 변경. 주인 승인으로 sandbox 확인 작업 2개 실행: Claude sonnet·low, Codex low 모두 성공(CLI가 값을 받음, 보고서 `run`에 기록). **확인 못 한 것**: Dashboard `/tasks` 화면(로그인 필요). 커밋 00f4c78.
- **학교 소식 점검(읽기만)**: 학교 항목은 모두 지식 저장소 원본으로 들어가고 검색됨(학교 원본 1,065건, 벡터 누락 0). 문서·사실로 정리되지는 않음.
- **지식 그래프 FAS147 연결**: 11-22 Kelly가 `me`→4과목 `part_of`를 만들었고, 11-23 Claude Code가 FAS147 문서를 만들 때 이 링크를 빠뜨렸음. 2026-11-25 주인 지적으로 `me`→`fas147` `part_of` 추가(운영자 접근 열고 바로 닫음).

## 최근 변경 (2026-11-25 새벽)
- 사이드바 순서를 쿠키(`pai_nav`)로 서버에서 그림(기본 순서 깜빡임 수정). 주인이 브라우저에서 확인 완료.
- 미디어 처리 순서를 작은 파일 먼저로 바꿈: 11-23에 가져온 강의 영상 5개(약 810MB)가 Discord 음성을 막고 있었음. Discord m4a 받아쓰기 실제 완료 확인. 옛 영상 5개는 작은 파일이 없을 때 차례로 처리됨(CPU 2스레드, 오래 걸림).
- Kelly가 음성 첨부에 "받아쓰기 도구가 없다"고 답하던 문제: 모델이 `media_submit`을 부르지 않았음. 고친 것: 음성·영상이 붙은 메시지마다 코드가 정확한 `media_submit` 호출을 안내(prefetch), `media_submit`은 최대 60초 기다려 받아쓴 글을 바로 돌려줌, 지식 서비스는 3초마다 새 미디어를 확인. Hermes 안에서 실제 도구로 m4a 받아쓰기 글 반환 확인. 주인이 Discord에서 새 파일로 전체 흐름 확인 완료(2026-11-25).
- Docker 주소 풀을 `10.210.0.0/16`, /24 단위로 늘림(주인 설정). 새 네트워크부터 이 범위. 네트워크 증명 통과.

## 다음 후보 (주인이 순서를 정함)
- 주인 결정(2026-11-24): 실제 GitHub 게시 진행, **커밋 작성자는 주인 본인으로(AI 흔적 절대 없음, POLICY B 변경)**, 비공개 저장소 확인 진행 → 작업 C.
- Learning AI: 이미 LLM 게이트웨이를 쓴다(`provider: gateway`, 별칭 `batch`, `/status`에서 configured=true). 실제 호출은 아직 0회 — 쓰면서 확인.
- L4-02~04(외부 자료, 프로젝트 연결, 퀘스트·음성)는 아직 아무도 맡지 않았다.
- 정리: 끝난 worktree 8개와 로컬 브랜치(`claude/*`), Codex가 OS 임시 폴더에 남긴 브라우저 검증 폴더, 지식 저장소 볼륨 안 옛 임시 백업 `pre-test-purge*.db` 2개(같은 파일이 `data/backups/knowledge`에 있음), `.gitignore` 줄바꿈 변경(커밋 안 함).
- Docker 네트워크 주소: 2026-11-25 주인이 `10.210.0.0/16`(/24 단위, 256개)을 추가해 여유가 충분하다.

## 인계 기록
- 2026-11-25 · Codex · A·B 커밋, 테스트 재현 명령과 운영 확인 절차를 정리했다. [Learning L3와 Kelly 학습 도구 검증 인계](LEARNING_KELLY_VERIFICATION.md)
- 2026-11-25 · Codex · Kelly 매일 밤 지식 정리, 활동 기록, OCR·강의 받아쓰기의 구현 위치와 실제 격리 Docker 검증, 운영 반영 절차를 기록했다. [Kelly 지식 정리와 미디어 처리 검증 인계](KELLY_KNOWLEDGE_MEDIA_VERIFICATION.md)
- 2026-11-26 · Claude Code · Kelly 일정·비서 실사용 점검(읽기 전용, 코드·스택 변경 없음). 실제 대화·planner DB·재현 스크립트로 확인한 버그·취약점·개선점 정리, 고칠 순서는 주인 결정. [Kelly 일정 실사용 점검](KELLY_SCHEDULE_REVIEW_2026-11-26.md)
- (다음 에이전트가 여기에 날짜·도구·한 줄 요약을 추가한다)
