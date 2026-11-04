# Windows Claude Code — Change Request Handoff

**작업 루트:** `D:\personal_ai`

## 역할과 범위

이 문서와 동봉된 `01`~`08` 파일은 **기존 Personal AI OS에 AI Learning OS를 추가하기 위한 변경 요청/설계 초안**이다. 최상위 원본 요구사항은 사용자가 전달한 `AI Learning OS 기능 추가 및 기존 기획 수정 요청서`이다.

이번 실행에서는 먼저 소스를 조사하고 설계/로드맵 변경안을 제출한다. 사용자 승인 없이 Learning OS를 전체 구현하거나 기존 서비스를 대규모 재구성하지 않는다.

## 반드시 먼저 할 일 — L0

1. 실제 `D:\personal_ai` 코드/기존 `docs/ROADMAP.md`/Compose/Controller auth/API/Dashboard modules/Provider 설정/Memory 구현 여부를 확인한다.
2. 보고된 기능을 실제 소스와 테스트로 확인하고 `Reusable / Modify / New / Not Built` 표를 작성한다. Memory Graph, Service Registry, Quest API는 구현을 추측하지 말 것.
3. 신규 Learning DB/서비스 경계, 브로커 권한, 데이터/마이그레이션/API/AI Provider/코드 평가 격리 설계를 실제 기술 스택에 맞게 조정한다.
4. 기존 `docs/ROADMAP.md`에는 기존 작업을 유지하면서 L0~L4를 추가할 **diff**를 만든다. 개발 프로젝트 로드맵과 Learning Roadmap은 별도 데이터 모델로 유지.
5. 현재 구현·모델/비용·개인정보/보안 위험·API 충돌·변경 파일·개발 순서를 먼저 보고한다.

## 이후 승인되면 L1 구현

1. 학습 Domain 및 Idea Inbox 영구 저장 + 권한 검증.
2. Goal/Roadmap 및 불변 Version/DAG 데이터 모델.
3. AI 구조화 Roadmap Draft 생성(Provider adapter, quota, schema validation), 사용자 승인 전까지 DB 현행 버전 변경 없음.
4. Dashboard Learning Overview/Idea/Explorer + Draft Diff/승인/복원.
5. JSON Export, 컨테이너 재생성 후 유지, 단위·E2E·보안·회귀 테스트.

## 반드시 보존할 보안 정책

- Hermes는 관리 도구로만 작동, 직접 코딩/임의 Shell/DB 쓰기 금지.
- Worker의 Docker·GitHub 권한 및 Repo allowlist/승인 경계 우회 금지.
- 테스트 증거 없는 GitHub Publisher 게시 차단; Worker Commit Author/Committer 보존, Rewrite 금지.
- 실제 GitHub Push/PR/Merge·데이터 삭제·민감 ACL 변경은 별도 승인 없이는 금지.
- 기존 Dashboard 로그인/CSRF, Controller 리뷰·승인·테스트 데이터, Docker 볼륨/토큰은 보존.
- AI-generated 학습 내용은 출처/신뢰도/승인 상태를 저장하고 사용자의 고정 deadline을 자동 변경하지 않는다.

## 완료 보고 형식

1. 현재 실제 구현 상태(코드 파일/커밋/테스트 근거)
2. 새 요구사항과 기존 시스템 사이의 중복·충돌·미구현 영역
3. 목표 아키텍처 및 선택지(최소 변경안 우선)
4. 수정/신규 파일과 마이그레이션 설계
5. 화면, API, DB, AI Provider, Broker와 Worker 권한 계약
6. L0~L4 타임라인 없는 상대 우선순위와 수용 기준
7. 위험·롤백·백업·테스트 계획
8. **사용자 승인이 필요한 결정**

**이번 단계의 성공 기준:** 실제 코드에 근거한 영향분석, 설계, `docs/ROADMAP.md`의 구체적인 패치안을 작성하고, 사용자 승인 전까지 기존 시스템을 유지하는 것.
