# Personal AI OS — AI Learning OS 변경 패키지

- 기준: 2026-11-03 사용자 제공 `AI Learning OS 기능 추가 및 기존 기획 수정 요청서`와 이 대화에서 전달된 Claude Code 작업 보고
- 성격: **기획·설계 제안 및 실행 핸드오프**. Windows `D:\personal_ai` 실제 소스·볼륨·설정은 열람하지 못했으므로 **실제 통합 완료나 배포를 의미하지 않음**.
- 목적: 기존 Personal AI OS를 유지한 채 AI Learning OS를 모듈로 추가. 개발 프로젝트 로드맵과 학습 로드맵은 별도로 관리.

## 문서 지도

| 파일 | 주요 내용 |
|---|---|
| 01_CURRENT_STATE_AND_GAPS.md | 기존 기능의 보고 기반 상태, 재사용/미구현/가정 분류 |
| 02_ARCHITECTURE.md | 서비스 경계, Docker, 인증, AI 호출, 데이터 흐름 |
| 03_REQUIREMENTS.md | 사용자 스토리, 요구사항 ID, 우선순위/수용 기준 |
| 04_DATA_MODEL.md | 엔티티, 관계, 버전, 증거, 일관성 규칙 |
| 05_APIS_AND_AGENTS.md | API 계약 초안, Hermes 도구, AI 역할, 접근 권한 |
| 06_DASHBOARD_SPEC.md | Learning 대시보드 화면 및 UI 상태 |
| 07_ROADMAP_AMENDMENT.md | L0~L4 작업 목록, 선행 조건, 완료/검증 기준, 기존 로드맵과 통합 방법 |
| 08_SECURITY_TESTS_OPERATIONS.md | 프롬프트 주입/코드 실행/개인정보/백업/테스트 |
| 09_CLAUDE_CODE_HANDOFF.md | Windows Claude Code에 전달할 실행 프롬프트 |

## 제안 실행 순서

1. `09_CLAUDE_CODE_HANDOFF.md`의 요청을 Claude Code에 전달해 **실제 코드 인벤토리 및 Gap Analysis**부터 수행.
2. 검토된 설계와 `docs/ROADMAP.md`에 대한 **diff를 먼저 보고**하고, 사용자 승인 후 통합.
3. L1을 Idea Inbox → Domains → Roadmap Draft → 편집·버전·저장·재접속 순서로 구현.
4. L2 과제/증거/AI 평가, L3 스케줄링, L4 장기 기억과 프로젝트 연동을 차례로 검증.

> 모든 기획 항목의 기본 상태는 `planned`이다. 구현을 확인하지 않은 단계에 `done`을 부여하지 않는다.
