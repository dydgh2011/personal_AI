# 현재 작업 상태

> 모든 에이전트(Claude Code, Codex)가 **시작할 때 읽고, 끝날 때 갱신**하는 파일이다(`AGENTS.md` 0절).
> 다음 에이전트가 이 파일만 보고 이어서 할 수 있게 쓴다. 오래된 항목은 지우고 최신 상태만 남긴다.

마지막 갱신: 2026-11-25 · Claude Code

## 스택 잠금
- **비어 있음** ← 실행 중인 스택을 바꾸거나(rebuild, restart, operator, migration) `learning-os/l1`에 합칠 때 여기에 `이름 · 무엇 · 시작 시각`을 적고 커밋·push한다. 끝나면 다시 "비어 있음"으로 바꾸고 push한다. 자세한 절차는 `CODEX_PLAN.md` 2절.

## 지금 진행 중 (맡은 범위는 `docs/handover/CODEX_PLAN.md` 1절)
- **C · Claude Code** (2026-11-24): 커밋 작성자=주인·AI 흔적 차단 배포. 비공개 저장소 실제 확인 완료(PAT로 discovery·동기화·export). GitHub App 연결·실제 게시 켬(대상: dydgh2011/personal-ai-sandbox만). **실제 게시 성공**: sandbox PR #1(draft, 브랜치 changes/6dfcb3df…), 커밋 author·committer = 주인(GitHub 계정 연결), 메시지·PR 본문에 흔적 없음. 승인·게시는 주인이 Dashboard에서 직접(에이전트는 대신 승인하지 않음). 남은 것: CI 결과 읽기(10). 브랜치 claude/publish.
- **공통(2026-11-25, Claude)**: learning·planner·hermes-broker를 내부망 learning-link-internal 하나로 연결(Docker 주소 여유 1개 남음). Dashboard Next.js 16.4.6. 사이드바 순서 편집(임시) 배포.
- **A · Codex** — **합쳐서 배포 완료**(2026-11-25, Claude): Learning L3 일정·복습, learning→planner 시안 연동. learning schema v3(백업 후). 실환경 learning→planner 가용 시간 조회 200. 남은 확인: 실제 시안을 만들어 플래너에서 승인하는 흐름(주인).
- **B · Codex** — **합쳐서 배포 완료**(2026-11-25, Claude): Kelly personal_ai_learning(조회·시안만), broker 호출자 인증 필수, configure-hermes --check(모두 ok), 서비스 지도 dashboard→learning 파서. 실환경: Kelly 도구→broker→learning 200. 2026-11-25 주인이 Hermes 설정 점검을 작업 스케줄러에 등록(`PersonalAI-HermesConfigCheck`, 매일 09:00, 첫 실행 결과 0), 레거시 secrets/hermes.controller.env는 주인 요청으로 삭제.
- **Kelly 지식·활동·미디어 · Codex** — **합쳐서 배포 완료**(2026-11-25, Claude): knowledge schema v4(백업 후), 시작 시 일간·주간 정리 실행 확인, knowledge-media(네트워크 없음) 정상, Kelly review 도구 ok. 남은 것: 받아쓰기 모델 ggml-base.bin(주인), 실제 Discord 이미지·음성 첨부로 확인.
- 각자 자기 줄만 고친다.

## 저장소와 스택
- 브랜치: `learning-os/l1` (origin에 push됨). `main`에는 주인 승인 없이 합치지 않는다. **2026-11-25 주인 요청으로 `main`을 `learning-os/l1`까지 fast-forward**(커밋 61개). `experiment/kelly-course-brief`는 같은 기능이 이미 들어가 있어 합치지 않음(정리 후보).
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
- (다음 에이전트가 여기에 날짜·도구·한 줄 요약을 추가한다)
