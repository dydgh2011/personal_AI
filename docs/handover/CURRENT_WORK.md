# 현재 작업 상태

> 모든 에이전트(Claude Code, Codex)가 **시작할 때 읽고, 끝날 때 갱신**하는 파일이다(`AGENTS.md` 0절).
> 다음 에이전트가 이 파일만 보고 이어서 할 수 있게 쓴다. 오래된 항목은 지우고 최신 상태만 남긴다.

마지막 갱신: 2026-11-24 · Claude Code

## 스택 잠금
- **Claude Code · 사이드바 배포, Codex C·A·B 합치기와 배포 · 2026-11-25** ← 실행 중인 스택을 바꾸거나(rebuild, restart, operator, migration) `learning-os/l1`에 합칠 때 여기에 `이름 · 무엇 · 시작 시각`을 적고 커밋·push한다. 끝나면 다시 "비어 있음"으로 바꾸고 push한다. 자세한 절차는 `CODEX_PLAN.md` 2절.

## 지금 진행 중 (맡은 범위는 `docs/handover/CODEX_PLAN.md` 1절)
- **C · Claude Code** (2026-11-24): 커밋 작성자=주인·AI 흔적 차단 배포. 비공개 저장소 실제 확인 완료(PAT로 discovery·동기화·export). GitHub App 연결·실제 게시 켬(대상: dydgh2011/personal-ai-sandbox만). **실제 게시 성공**: sandbox PR #1(draft, 브랜치 changes/6dfcb3df…), 커밋 author·committer = 주인(GitHub 계정 연결), 메시지·PR 본문에 흔적 없음. 승인·게시는 주인이 Dashboard에서 직접(에이전트는 대신 승인하지 않음). 남은 것: CI 결과 읽기(10). 브랜치 claude/publish.
- **A · Codex** (2026-11-24): Toronto 일·주 계획, 가용시간, 미완료 과제 이월·복습, `/learning/planner` 및 승인 후 Planner 할 일·Kelly 일정 연동 구현. 로컬 커밋 `99cbddf` (`codex/learning-l3`, `D:\personal_ai-wt\codex-learning-l3`). 호스트 테스트·타입 검사 Learning 51/51, Planner 23/23, Dashboard 133/133. Learning·Planner·Dashboard 별도 Docker 이미지 빌드 통과(각 51/51·23/23·133/133). Dashboard 호스트 `next build`는 기존 Next.js 16.4.3의 `SecurityFatalError`로 종료 1. 임시 DB v2→v3 보존, Google 대역 교차 확인 9건(Edge 390px 라이트·다크, 1280px, CSRF, 승인 전 쓰기 0건, 승인 후 고정 마감 보존). 공통 Compose에서 `learning-planner-internal`(Learning·Planner, `internal: true`)과 `secrets/learning-planner.key` 마운트 및 env 활성화, B 링크, 공통 Dashboard 보안 패치 결정 필요. 계획서 2절 4번 통합 승인, 운영 DB 백업·v3 마이그레이션·실제 제안 검증 대기. 운영 확인 후 ROADMAP 17·19절 반영.
- **B · Codex** (2026-11-24): Kelly 학습 조회·일정 시안, broker 호출자 인증 필수화, Hermes 설정 점검, 서비스 지도 파서 구현. 로컬 커밋 `6b9e323` (`codex/kelly-learning`, `D:\personal_ai-wt\codex-kelly-learning`). 호스트 broker 19/19, Python 95 통과·2 건너뜀, 설정 점검 3/3, 서비스 지도 24/24. 별도 Docker 이미지 broker 19/19, 격리 Hermes 이미지 97/97. 원본 스택 읽기 전용 네트워크 검사 11/11(기존 링크 21개, 주소 여유 2개). A의 학습 조회·시안 API와 별도 키는 합성 데이터로 연결 확인. 통합 전 `learning-broker-internal`(Learning·broker, `internal: true`), `secrets/learning-broker.key` 마운트, `LEARNING_URL`·키 경로 활성화 필요. 배포·Kelly 재시작·실제 대화는 확인 대기. Windows 정기 점검 등록은 `services/hermes-integration/README.md` 절차를 주인이 실행하며 레거시 `secrets/hermes.controller.env` 삭제도 주인 결정. 운영 확인 후 ROADMAP 5·17·20절 반영.
- **Kelly 지식·활동·미디어 · Codex** (2026-11-25) · Toronto 00:15 일간·주간 정리, 원본에 연결된 활동·사실 기록, 로컬 OCR·강의 받아쓰기 구현. `codex/kelly-knowledge-media` · `C:/Users/dydgh/.codex/worktrees/kelly-knowledge-media/personal_ai` · 로컬 변경 보관 중. Knowledge 39/39, 미디어 4/4, Hermes 96/96, 서비스 지도 23/23, 가져오기 도구 5/5 통과. 격리 Docker에서 임시 DB v3→v4, 한·영 이미지 OCR, WAV·MP4 받아쓰기, 검색 및 원본 보존 확인. 운영 14개 실행 상태 확인. 공유 브랜치 반영·스택 잠금 승인, 모델 파일 설치, 백업 및 운영 Discord 검증 대기. [검증과 재현 절차](KELLY_KNOWLEDGE_MEDIA_VERIFICATION.md)
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
