# 현재 작업 상태

> 모든 에이전트(Claude Code, Codex)가 **시작할 때 읽고, 끝날 때 갱신**하는 파일이다(`AGENTS.md` 0절).
> 다음 에이전트가 이 파일만 보고 이어서 할 수 있게 쓴다. 오래된 항목은 지우고 최신 상태만 남긴다.

마지막 갱신: 2026-11-24 · Claude Code

## 스택 잠금
- **Claude Code · GitHub App 연결, sandbox 등록, 게시 시험 · 2026-11-24 22:00** ← 실행 중인 스택을 바꾸거나(rebuild, restart, operator, migration) `learning-os/l1`에 합칠 때 여기에 `이름 · 무엇 · 시작 시각`을 적고 커밋·push한다. 끝나면 다시 "비어 있음"으로 바꾸고 push한다. 자세한 절차는 `CODEX_PLAN.md` 2절.

## 지금 진행 중 (맡은 범위는 `docs/handover/CODEX_PLAN.md` 1절)
- **C · Claude Code**: 1부 완료·배포(2026-11-24): 커밋 작성자 = 주인, AI 흔적 차단, GitHub App 게시 경로(아직 꺼짐). 남은 것: 주인의 GitHub App·토큰 설정 → App 연결과 실제 게시 시험, CI 결과 읽기(10), 비공개 저장소 확인(14). 브랜치 `claude/publish`, `D:\personal_ai-wt\claude-publish`.
- **A · Codex**: Learning L3 + 플래너 연결 — 브랜치 `codex/learning-l3`, `D:\personal_ai-wt\codex-learning-l3`. (시작 전)
- **B · Codex**: Kelly 학습 도구 + Hermes 보안 마무리 + 서비스 지도 파서 — 브랜치 `codex/kelly-learning`, `D:\personal_ai-wt\codex-kelly-learning`. (시작 전)
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
- (다음 에이전트가 여기에 날짜·도구·한 줄 요약을 추가한다)
