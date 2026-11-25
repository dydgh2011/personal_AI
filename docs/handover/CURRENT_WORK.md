# 현재 작업 상태

> 모든 에이전트(Claude Code, Codex)가 **시작할 때 읽고, 끝날 때 갱신**하는 파일이다(`AGENTS.md` 0절).
> 다음 에이전트가 이 파일만 보고 이어서 할 수 있게 쓴다. 오래된 항목은 지우고 최신 상태만 남긴다.

마지막 갱신: 2026-11-24 · Claude Code

## 스택 잠금
- **비어 있음** ← 실행 중인 스택을 바꾸거나(rebuild, restart, operator, migration) `learning-os/l1`에 합칠 때 여기에 `이름 · 무엇 · 시작 시각`을 적고 커밋·push한다. 끝나면 다시 "비어 있음"으로 바꾸고 push한다. 자세한 절차는 `CODEX_PLAN.md` 2절.

## 지금 진행 중 (맡은 범위는 `docs/handover/CODEX_PLAN.md` 1절)
- **C · Claude Code** (2026-11-24): 커밋 작성자=주인·AI 흔적 차단 배포. 비공개 저장소 실제 확인 완료(PAT로 discovery·동기화·export). GitHub App 연결·실제 게시 켬(대상: dydgh2011/personal-ai-sandbox만). **실제 게시 성공**: sandbox PR #1(draft, 브랜치 changes/6dfcb3df…), 커밋 author·committer = 주인(GitHub 계정 연결), 메시지·PR 본문에 흔적 없음. 승인·게시는 주인이 Dashboard에서 직접(에이전트는 대신 승인하지 않음). 남은 것: CI 결과 읽기(10). 브랜치 claude/publish.
- **공통(2026-11-25, Claude)**: learning·planner·hermes-broker를 내부망 learning-link-internal 하나로 연결(Docker 주소 여유 1개 남음). Dashboard Next.js 16.4.6. 사이드바 순서 편집(임시) 배포.
- **A · Codex** — **합쳐서 배포 완료**(2026-11-25, Claude): Learning L3 일정·복습, learning→planner 시안 연동. learning schema v3(백업 후). 실환경 learning→planner 가용 시간 조회 200. 남은 확인: 실제 시안을 만들어 플래너에서 승인하는 흐름(주인).
- **B · Codex** — **합쳐서 배포 완료**(2026-11-25, Claude): Kelly personal_ai_learning(조회·시안만), broker 호출자 인증 필수, configure-hermes --check(모두 ok), 서비스 지도 dashboard→learning 파서. 실환경: Kelly 도구→broker→learning 200. 남은 것(주인): Hermes 설정 점검 정기 등록, 레거시 secrets/hermes.controller.env 삭제 결정.
- **Kelly 지식·활동·미디어 · Codex** — **합쳐서 배포 완료**(2026-11-25, Claude): knowledge schema v4(백업 후), 시작 시 일간·주간 정리 실행 확인, knowledge-media(네트워크 없음) 정상, Kelly review 도구 ok. 남은 것: 받아쓰기 모델 ggml-base.bin(주인), 실제 Discord 이미지·음성 첨부로 확인.
- 각자 자기 줄만 고친다.

## 저장소와 스택
- 브랜치: `learning-os/l1` (origin에 push됨). `main`에는 주인 승인 없이 합치지 않는다.
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

## 다음 후보 (주인이 순서를 정함)
- 주인 결정(2026-11-24): 실제 GitHub 게시 진행, **커밋 작성자는 주인 본인으로(AI 흔적 절대 없음, POLICY B 변경)**, 비공개 저장소 확인 진행 → 작업 C.
- Learning AI: 이미 LLM 게이트웨이를 쓴다(`provider: gateway`, 별칭 `batch`, `/status`에서 configured=true). 실제 호출은 아직 0회 — 쓰면서 확인.
- L4-02~04(외부 자료, 프로젝트 연결, 퀘스트·음성)는 아직 아무도 맡지 않았다.
- 정리: 끝난 worktree 8개와 로컬 브랜치(`claude/*`), Codex가 OS 임시 폴더에 남긴 브라우저 검증 폴더, 지식 저장소 볼륨 안 옛 임시 백업 `pre-test-purge*.db` 2개(같은 파일이 `data/backups/knowledge`에 있음), `.gitignore` 줄바꿈 변경(커밋 안 함).
- 주의: Docker 네트워크 주소 여유가 적다. 새 네트워크를 만들기 전에 `scripts\stack.ps1 verify-networks`의 "주소 풀"을 본다.

## 인계 기록
- 2026-11-25 · Codex · A·B 커밋, 테스트 재현 명령과 운영 확인 절차를 정리했다. [Learning L3와 Kelly 학습 도구 검증 인계](LEARNING_KELLY_VERIFICATION.md)
- 2026-11-25 · Codex · Kelly 매일 밤 지식 정리, 활동 기록, OCR·강의 받아쓰기의 구현 위치와 실제 격리 Docker 검증, 운영 반영 절차를 기록했다. [Kelly 지식 정리와 미디어 처리 검증 인계](KELLY_KNOWLEDGE_MEDIA_VERIFICATION.md)
- (다음 에이전트가 여기에 날짜·도구·한 줄 요약을 추가한다)
