# 03 — Functional requirements (traceable)

모든 요구의 범위는 처음 제공된 변경 요청서에 따른다. `P0 = L1`, `P1 = L2`, `P2 = L3`, `P3 = L4`.

| ID | 기능 | 단계 | 최소 수용 기준 |
|---|---|---|---|
| LR-001 | Idea Inbox 자연어 등록·검색·분류 | L1 | 한 줄 아이디어를 생성·편집·보관, 자동 분류는 수정 가능 |
| LR-002 | Domain/하위 Domain 상태 | L1 | 여러 분야 관리, status 6종, 삭제 시 기록 보호 |
| LR-003 | AI Roadmap Draft 생성 | L1 | 목표·사전 지식·시간 입력, 구조화 출력 검증, 승인 전 적용 안 함 |
| LR-004 | 선수지식 그래프 | L1 | DAG 순환 거부, 공통 선수지식 중복 저장 회피 |
| LR-005 | Roadmap 편집·버전·Diff·복원 | L1 | 노드 변경안 비교, 이전 기록 보존하며 복원 |
| LR-006 | Learning Overview/Explorer | L1 | 브라우저 재접속 후 상태 동일, 모바일 반응형 |
| LR-007 | 외부 로드맵 원본 보존/구조화 | L4 (기본 가져오기 L1 선택) | JSON/CSV/MD/PDF/URL, provenance 및 AI 추가 항목 구분 |
| LR-008 | Milestone + Deadline + Rubric | L2 | user-fixed / AI-suggested 구분, 평가 기준 저장 |
| LR-009 | Assignment 타입별 제출 | L2 | 텍스트·파일·코드·사진·실험 결과 등록 및 재제출 |
| LR-010 | Evaluation + Evidence | L2 | 근거/신뢰도/한계/재평가 이력, 장애 시 원본 보존 |
| LR-011 | SkillMastery/Gap | L2 | 0~4, 자가평가 vs 검증 숙련도 별도, 약점 제안 |
| LR-012 | Spaced review / Recheck | L2-L3 | 복습 예정, 오래된 검증 구별 |
| LR-013 | Adaptive daily/weekly scheduler | L3 | 실가용 시간/우선순위/Deadline 기반 계획 제안 |
| LR-014 | 계획 변경과 이월 | L3 | 미완료 이월, 사용자 확정 Deadline 자동 변경 금지 |
| LR-015 | 여러 분야 병행·재개 | L3 | 분야별 목표 시간, 장기 중단 상태 복원 |
| LR-016 | Learning-Hermes interaction | L4 (L1 제한적 호출 가능) | 허용된 query/propose 동작만 제공, 무단 직접 코드 실행 불가 |
| LR-017 | Knowledge Graph link | L4 | 기존 Graph 존재 여부 확인, 근거 링크/수정 범위 유지 |
| LR-018 | Project Roadmap link | L4 | 서로 다른 상태·마일스톤을 cross-reference로 연결 |
| LR-019 | Quest API integration | L4 optional | 제한된 요약 동기화, 별도 허가 없으면 쓰기 차단 |
| LR-020 | AI Provider 비용·교체 | L1 기반 | 모델명/토큰/비용/실패/스키마 검사 기록, quota 설정 |
| LR-021 | Export/Import | L1 JSON, L4 expanded | 식별자/버전/근거 보존, 역직렬화 검증 |
| LR-022 | Audit & data rights | 모든 단계 | 생성·변경 주체/시각, 다운로드·수정·삭제·복원 가능 |

## 중요 도메인 불변식

- Roadmap **진행률 ≠ 숙련도 ≠ 학습시간 ≠ 검증 최신성**; 개별 지표로 저장/표시.
- `draft` AI 제안은 명시적 승인까지 현행 버전에 영향을 주지 않음.
- 모든 승인된 RoadmapVersion은 불변이고, 기존 과제 제출과 평가 기록은 삭제하지 않음.
- User-fixed Deadline은 AI가 조용히 변경하지 않음.
- 통과 상태는 AI 요약문 하나로만 확정 불가: 적절한 Evidence와 Rubric 필요.
- 아이디어 등록은 자동으로 Active 학습 로드맵/오늘 일정에 편성하지 않음.
- 다중 분야를 지원하되 모든 분야를 매일 공부하게 하지 않음.
- 물리 실험 안전성/주식 투자 성과 등은 AI 평가만으로 확정하지 않음.

## 범위 밖(L1)

완전 자동 투자 추천, 물리 하드웨어 자동 실험, 범용 개인 Graph 재구축, Quest 실시간 양방향 연결, 모든 외부 PDF/URL 파서의 완벽성, 대규모 LLM 다중 인프라, 기존 AI OS 전면 개편.
