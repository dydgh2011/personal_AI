# 02 — Target architecture & integration

## 권장 최소 구조

```text
Windows / Mac / Android / iPad
          |
  Existing Dashboard (Next.js BFF)  <--- 로그인·CSRF·관리자 권한 유지
          |                           |
          v                           v
    Learning API (new service)     Existing NestJS Controller
          |                           |
  Learning-owned DB / volume        Task API / agent jobs
          |                           |
 AI Provider adapter  <---- limited tool/broker ----> Hermes
          |
  Roadmap draft / Assessment proposal / Planner explanation

Code assignment (later): Learning API -> approved Controller task
                         -> isolated worker/test runner -> evaluation evidence
```

### 서비스 경계

- **Learning Service** (새 별도 Docker 서비스 권장): Domain, Idea, Goal, Roadmap, Milestone, Submission, Evidence, Mastery, Schedule 데이터의 소유자. CRUD, 승인, 버전/일정 계산은 결정적인 코드.
- **Dashboard**: `/learning/*` 페이지와 BFF API; 기존 로그인·세션·CSRF 검증 재사용. 브라우저에는 Controller/Admin/AI API 토큰 전달하지 않음.
- **Hermes**: 의도 해석과 읽기/제안 요청만 수행. 별도 `personal_ai_learning` 도구 → 최소 권한 Broker → Learning API. Hermes가 Learning DB에 직접 쓰지 않음.
- **Provider Adapter**: Gemini 등의 모델 교체/비용·사용량·스키마 검증·타임아웃·재시도. 기존 Provider 공용 서비스를 코드에서 찾으면 재사용; 없으면 L1 범위의 간단한 어댑터.
- **Assessment**: L2에서 별도 논리 모듈로 시작. 코드 실행이 필요한 경우에만 승인된 실행 브리지 사용. 단순 평가를 위해 기존 Publisher/Worker에 추가 권한을 주지 않음.
- **Knowledge Graph**: 구현 확인 전에는 논리적인 `knowledge_entity_ref`만 사용. 공유 Graph 서비스가 실재하면 읽기/링크로 연동.

### 최소 Docker 연동 원칙

- 신규 `compose.learning.yaml` 같은 분리된 overlay; 실제 Compose 네트워크 이름은 L0 확인 후 설정.
- 비root, read-only rootfs가 가능하면 사용, healthcheck, restart policy, 자원/로그 제한.
- Learning 전용 DB/볼륨과 백업; 현재 Controller DB에 임의 테이블을 추가하지 않음.
- 컨테이너에 Docker Socket, GitHub App 키, Codex/Claude 인증 볼륨, Publisher 서명키를 전달하지 않음.
- Dashboard BFF ↔ Learning API는 인증된 서버간 연결. Hermes ↔ Learning은 제한된 Broker 경유. 원격 공개 포트는 기본 없음.

## 도메인 이벤트와 동기화

Learning은 자체 DB 트랜잭션을 진실 공급원으로 사용하고 이벤트를 발행할 수 있음:
`roadmap.proposed`, `roadmap.approved`, `assignment.submitted`, `evaluation.completed`, `schedule.proposed`.
이벤트는 향후 알림/Quest/Graph 연동을 위한 계약이며, **초기에는 기존 메시지 버스나 작업 API 재사용 가능 여부 확인 후 채택**.

## 데이터 단방향 흐름

1. 사용자가 목표 등록 → Learning Service 저장.
2. AI 생성 → 구조화 초안 저장 (`draft`, source, model, 비용, 검증 결과).
3. UI에서 diff + 시간/선수지식 영향 확인 → 사용자 승인 → 새 RoadmapVersion 생성.
4. 과제 제출 → Evidence 기록 → 룰 기반 자동 테스트/AI 평가 → 근거와 신뢰도 보존.
5. Planner가 결정적인 일정 제약 계산 → 제안 저장 → 사용자 확인 → 확정된 계획 반영.

금지: AI 출력 그대로 DB 업데이트, 자동 Deadline 확정 변경, 일치하지 않는 Git Artifact를 학습 통과로 처리.
