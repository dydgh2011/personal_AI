# 07 — Roadmap amendment: AI Learning OS

이 문서는 기존 Windows 프로젝트 `docs/ROADMAP.md`에 **병합할 변경안**이다. 기존 파일을 읽지 못했으므로 직접 대체하지 않는다. 상태는 모두 `planned`이며, `L0` 완료 후 실제 현황을 갱신한다.

## 기존 로드맵 보호

기존 Publisher/보안/실제 Private Repo 검증/원격 운영 미완료 과제는 그대로 유지한다. 신규 Learning OS를 도입하더라도 테스트 미보고 게시 차단, Worker Author 보존, GitHub 별도 승인이라는 정책을 변경하지 않는다.

## 작업 계획 (한 줄 = 완료 검증 가능한 작업)

| ID | 단계 | 우선순위 | 선행 | 난이도 | 담당 | 수용 기준 및 검증 |
|---|---|---|---|---|---|---|
| L0-01 | Inventory | P0 | 없음 | S | Claude Code | 소스·Compose·DB·Dashboard/Controller/Provider 현황 + evidence 표 |
| L0-02 | Integration design | P0 | L0-01 | M | Claude Code + 사용자 검토 | API/Schema/네트워크/권한/마이그레이션 diff 승인 |
| L1-01 | Learning Service skeleton | P0 | L0-02 | M | Claude | Docker health, DB migration, BFF auth regression |
| L1-02 | Domain + Idea CRUD | P0 | L1-01 | M | Codex/Claude | create/edit/archive/restart persistence tests |
| L1-03 | Goal + Roadmap entities | P0 | L1-01 | M | Claude | immutable versions, stale base 409, DAG cycle rejection |
| L1-04 | AI roadmap draft adapter | P0 | L1-03 | M | Claude | schema validation, quota/error fallback, no unapproved writes |
| L1-05 | Explorer and editing UI | P0 | L1-02,03,04 | L | Claude | desktop/mobile DAG view, editor, diff and approval |
| L1-06 | Export / backup / E2E | P0 | L1-05 | M | Codex | JSON round-trip, DB restore, new login and reload persistence |
| L2-01 | Milestone, Rubric, Deadline | P1 | L1-06 | M | Claude | user-fixed/proposed distinction; state transitions |
| L2-02 | Assignment, Submission | P1 | L2-01 | M | Claude | immutable revisions, safe upload, stored metadata |
| L2-03 | Evaluation & Evidence | P1 | L2-02 | L | Claude + Codex audit | rubric, evidence, confidence, failed evaluation rollback |
| L2-04 | SkillMastery & Gap | P1 | L2-03 | M | Claude | verified/self ratings separated, gap proposal |
| L3-01 | Learning availability & schedule rules | P2 | L2-01 | M | Claude | deterministic priority/deadline constraint tests |
| L3-02 | Daily/weekly Planner | P2 | L3-01, L2-04 | M | Claude | precise tasks, defer/resume, no silent deadline changes |
| L3-03 | Review scheduling | P2 | L3-02 | M | Codex | stale mastery, spaced vs performance revalidation |
| L4-01 | Hermes Learning tool | P3 | L1-06, L0-02 | M | Claude | restricted broker API, no raw shell, ownership tests |
| L4-02 | Source/roadmap imports | P3 | L1-06 | L | Claude | JSON/MD/CSV/PDF/URL provenance and user review |
| L4-03 | Project Roadmap/Graph links | P3 | L1-06 | M | Claude | explicit references, no shared write conflicts |
| L4-04 | Quest/voice optional adapters | P3 | L3-02 | M | Claude | optional API only; failure not affect core |

`S/M/L`은 상대 복잡도이지 시간·실제 진행률이 아니다. 실제 진행도는 테스트 증거가 연결된 완료 마일스톤 수와 진척도의 의미를 분리한다.

## 단계별 완료 게이트

- **L0:** 실제 저장소 검사 및 요구사항 충돌표 + 변경 diff 작성; 사용자 승인. **기능 구현 시작 전 게이트**.
- **L1:** Idea 등록 → 학습 Domain/Goal → AI Roadmap Draft → 사용자가 Diff 검토/승인 → 수정/버전 복구 → 컨테이너 재생성 후 유지.
- **L2:** 과제 정의 → 제출 → 근거 포함 평가 → 피드백/수정 → 재평가 → 검증된 숙련도 업데이트.
- **L3:** 고정 일정/사용 가능 시간 입력 → 하루/주간 제안 → 3일 결석 시 새로운 제안 → 고정 Deadline은 사용자 승인 없이 그대로.
- **L4:** Hermes에서 허용된 Learning 요청 → Learning API 상태 조회/제안 → Dashboard 승인/변경; Cross-module Source 링크.

## 추가적으로 필요한 결정 (L0)

- 실제 현재 DB/ORM 및 마이그레이션 패턴과 Learning 별도 DB 여부.
- 신규 AI Provider 서비스가 있는지, Hermes 비용/모델 설정을 재사용하는 방법.
- 학습 시간·업로드 파일의 보존 정책 및 백업 범위.
- 실험·코드 평가에 필요한 테스트 런타임의 권한 정책.
- Quest 앱/캘린더는 필수 연동 없이 유지.
