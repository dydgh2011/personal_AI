# 05 — API proposals, auth & AI responsibilities

아래는 **실제 구현된 경로가 아니라 초안**. 기존 Controller/Dashboard의 라우트 및 인증 패턴을 L0에서 확인 후 명명·통합한다.

## API (Learning Service)

| Method | Route (proposed) | Permission | Notes |
|---|---|---|---|
| GET/POST | `/learning/domains` | owner read/write | 상태/하위 분야 |
| GET/POST | `/learning/ideas` | owner read/write | Quick capture |
| GET/POST | `/learning/goals` | owner read/write | 목표 및 제약 |
| GET/POST | `/learning/roadmaps` | owner read/write | version metadata |
| POST | `/learning/roadmaps/:id/proposals/generate` | owner create-proposal | AI 생성은 draft만 |
| GET | `/learning/roadmaps/:id/proposals/:proposalId/diff` | owner read | 변경/일정/선수지식 영향 |
| POST | `/learning/roadmaps/:id/proposals/:proposalId/apply` | owner approve | If-Match base version; 충돌 409 |
| GET | `/learning/roadmaps/:id/versions` | owner read | immutable history |
| POST | `/learning/roadmaps/:id/restore` | owner approve | 새 버전으로 복원 |
| GET/POST | `/learning/milestones` | owner read/write | L2 |
| POST | `/learning/assignments/:id/submissions` | owner submit | L2, 업로드 스캔 |
| GET | `/learning/submissions/:id/evaluations` | owner read | Evidence 기반 |
| POST | `/learning/submissions/:id/evaluate` | owner evaluate-request | L2, async job |
| GET | `/learning/skills/:id/mastery` | owner read | self vs verified |
| POST | `/learning/schedule/propose` | owner create-proposal | L3 결정적 제약 계산 |
| POST | `/learning/schedule/:id/confirm` | owner approve | fixed deadlines unchanged |
| GET | `/learning/export` | owner read | JSON schemaVersion |

## Hermes 도구 (제안)

`personal_ai_learning`의 **허용된** 동작: `capture_idea`, `list_domains`, `get_roadmap`, `request_roadmap_draft`, `get_learning_status`, `get_today_plan`, `request_schedule_proposal`.

- 수정/마감일 변경은 `proposal`을 생성하고 승인 화면으로 보내는 것이 기본.
- 직접 GitHub Push/Publisher 호출, Shell 실행, 임의 HTTP 프록시, DB 직접 접근 금지.
- Hermes Broker는 Learning 경로 allowlist, 호출자 인증/감사, 크기 제한 및 속도 제한을 포함.
- User intent→Hermes→Broker→Learning, Learning→AI Provider→schema validated proposal; LLM이 직접 Learning DB 수정하지 않음.

## 역할별 Agent

| 역할 | 책임 | 해서는 안 되는 일 | MVP 방법 |
|---|---|---|---|
| Roadmap Agent | 목표·선수지식·단계 제안 및 자료 제안 | 승인 없는 로드맵 교체 | AI Provider adapter + prompt + typed output |
| Assessment Agent | 루브릭 평가, 추가 문제, Gap 제안 | 물리 실험 안전성 보증·숙련도 무근거 확정 | L2 평가 서비스의 한 역할 |
| Planning Agent | 일정·우선순위·지연 영향 설명 | 사용자 확정 마감일 몰래 변경 | L3 제약 계산에 설명 기능 연결 |
| Learning Memory | 이전 학습 이력/평가 검색 | 개인 전체 대화 원문 무조건 노출 | L2~L4 Learning DB 조회, 장기 Memory 서비스는 나중 |
| Hermes Manager | 요청 라우팅/상태 보고 | 직접 DB 수정, 범용 터미널 권한 복원 | 기존 broker 패턴 확장 |
| Claude/Codex | 코드 평가/코딩 작업(조건부) | 평가 권한으로 Publisher 우회 | 승인된 작업 타입과 격리 컨테이너 |

## AI API 프로세스

1. User inputs and accepted context sanitized; reference sources attached.
2. Provider cost/budget gate; model + prompt template version recorded.
3. Structured JSON output parsed with schema validator (Zod/JSON schema as existing stack supports).
4. Domain validators: DAG, allowed types, duration bounds, no auto-fixed deadline overwrite.
5. AI result stored as proposal with source / provenance and cost info.
6. User reviews impact and approves; deterministic transaction applies.

입력 파일/URL은 **신뢰하지 않는 자료**로 취급하고 프롬프트 주입 지시를 실행하지 않는다.
