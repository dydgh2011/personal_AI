# 04 — Proposed data model and consistency rules

**가정:** Learning Service가 자체 스키마와 migration을 소유. 실제 DB 종류/ORM 결정은 L0 조사 후. 처음에는 기존 SQLite 운영 경험을 재사용할 수 있으나, Controller DB 직접 쓰기는 피한다.

## 핵심 엔티티

| 엔티티 | 주요 필드(제안) | 중요한 제약 |
|---|---|---|
| LearningDomain | id, parentId?, title, status, priority, createdAt | 계층의 순환 참조 금지 |
| Idea | id, text, domainIds, relatedProjectIds, priority, state, source | 자동 분류는 user-editable |
| LearningGoal | id, domainId, target, targetLevel, constraints, status | 목표와 진행률 구분 |
| Roadmap | id, goalId, currentVersionId?, status | 현행 버전 포인터 |
| RoadmapVersion | id, roadmapId, version, contentHash, proposalId?, approvedBy, approvedAt | 승인 버전 불변, 고유 버전 번호 |
| RoadmapNode | id, versionId, type(stage/topic/skill/milestone), title, estimateMinutes, status | version별 동일 의미의 canonical skill ID 연계 |
| PrerequisiteEdge | versionId, fromNodeId, toNodeId | 같은 버전, DAG 유지 |
| Skill | id, canonicalName, domainIds, aliases | 로드맵 공유 선수지식 표현 |
| SkillMastery | id, skillId, selfRating?, verifiedLevel?, evidenceIds, lastVerifiedAt, confidence | 자가 평가/검증 수준 분리 |
| Milestone | id, nodeId, proposedDeadline?, fixedDeadline?, rubricVersionId, passingCriteria, status | 고정/제안 일정 구분 |
| Assignment | id, milestoneId, kind, instructions, rubricId, status | 과제 정의 버전 유지 |
| Submission | id, assignmentId, revision, artifactRefs, submittedAt, submittedBy | immutable 제출 버전; 실행 파일 업로드 제한 |
| Evaluation | id, submissionId, rubricVersion, outcome, feedback, confidence, createdAt, evaluator | AI 의견 vs 검증 사실 구분 |
| EvaluationEvidence | id, evaluationId, sourceRef, type, hash, score?, limitations | 코드/수학/시뮬레이션의 실행 근거 |
| LearningSession | id, domainId, startedAt, durationMin, notes?, resumePointer? | 추정 시간과 실제 시간 구분 |
| StudySchedule | id, date, timezone, version, proposalStatus, constraintsHash | 사용자 확정 계획과 draft 분리 |
| ReviewTask | id, skillId, dueAt, method, lastResult | 숙련도 재검증과 연계 |
| LearningResource | id, canonicalUrl?, fileRef?, provenance, title | 원본 vs AI 제안 구별 |
| AIProposal | id, type, baseVersion, structuredPayload, modelInfo, cost, state, approvedAt? | 초안/승인/거부 및 diff |
| CrossModuleReference | id, learningEntityId, targetType, externalId | Project Roadmap, Quest, Graph에 대한 느슨한 연결 |
| AuditEvent | id, actor, action, entityType, entityId, timestamp, detailHash | 인증된 주체, 변경 감사 |

## 핵심 데이터 설계

1. **로드맵 승인 원자성:** base version과 current version이 일치할 때만 proposal 적용(optimistic lock). 충돌 시 409와 diff 재생성.
2. **버전 복원:** 과거 버전을 그대로 수정하지 말고 새 버전으로 복원; 기존 제출·평가·수업 기록 유지.
3. **그래프 유효성:** 선수지식 Edge의 toposort 검증, 자체 순환과 간접 순환 모두 422.
4. **데이터 출처:** imported source와 AI-added content에 provenance 기록. hallucinated URLs은 검증 전 추천 자료로만 표시.
5. **삭제/수정:** 실제 삭제 vs Archive, 사용자 정정, GDPR/개인 데이터 제거를 구별. 이벤트 기록에도 원문 비밀 저장 금지.
6. **전문 지식 공통화:** 여러 RoadmapNode가 하나의 canonical Skill을 가리킬 수 있도록 분리.
7. **개인 정보:** 기분/성격 등 추정적 정보는 Learning 평가의 객관적 사실로 승격하지 않음; 사용자 동의/정정 제공.
8. **JSON Export:** schemaVersion 포함, 로드맵 버전·출처·관계를 보존, import id 충돌 규칙 명시.

## 진행률과 숙련도 계산 구분

- Roadmap progress: 가중치가 정의된 완료 마일스톤 비율(정의 없으면 '미산정' 표시).
- Study time: 실제 LearningSession의 합.
- Verified mastery: Rubric+Evidence를 기반으로 검증된 Skill별 level; 단일 종합 % 불필요.
- Freshness: lastVerifiedAt로부터 지난 기간; 복습 예정일은 별도.

## 상태 전환 초안

- `AIProposal`: draft → validated → awaiting_user_approval → applied / rejected / expired
- `Assignment`: planned → available → submitted → evaluated → passed / revision_required
- `StudySchedule`: draft → user_confirmed → active → superseded

상태 전환 구현은 서버에서 enforce하고 UI 문자열만으로 판단하지 않는다.
