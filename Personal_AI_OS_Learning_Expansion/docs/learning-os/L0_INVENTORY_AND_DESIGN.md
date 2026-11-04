# L0 — 실제 코드 인벤토리와 통합 설계 (2026-11-04)

- **작성 범위**:
  - `D:\personal_ai`의 실제 소스, 실행 중인 Docker 스택, 설정을 조사했다. 비밀 값은 출력하지 않았다.
  - **기존 시스템은 변경하지 않았다.** 산출물은 이 문서와 `L0_ROADMAP.patch`뿐이며, 패치는 아직 적용하지 않았다.
- **상태 표기 원칙**: 구현과 테스트로 확인한 것만 "있음"으로 적는다.

## 1. 현재 실제 구현 상태 (근거)

| 항목 | 실제 상태 | 근거 |
|---|---|---|
| Git | 커밋은 `1fba350 initial commit` 하나뿐이다. 소스 대부분(`services/`, `docs/`, compose 7개)이 untracked 상태다. | `git log`, `git status` |
| 실행 서비스 | controller, dashboard, claude-worker, codex-worker, hermes, hermes-broker, github-publisher, test-runner. 모두 healthy다(hermes는 healthcheck 없음). | `docker ps` |
| Compose | `compose.yaml`(hermes), `.workers`, `.controller`, `.github`, `.dashboard`, `.publisher`, `.test-runner` | 루트 디렉터리 |
| 네트워크 | ai-internal, default, admin-internal, publisher-internal, publisher-egress, repo-egress, test-internal(internal) | `docker network ls` |
| Controller | NestJS 12, better-sqlite3 13, class-validator. 스키마 v1~v6. 역할: admin(name: admin, dashboard), worker, delegator(hermes), publisher, test-runner | `services/controller/src/auth/principal.ts`, `database/migrations.ts` |
| Controller 모듈 | Tasks, Workers, Health, Projects, Reviews, Publications, TestValidations | `app.module.ts` |
| Dashboard | Next.js 16.4.3, React 19.3.1, BFF 구조, 서버 메모리 세션, CSRF(2026-10-26 Origin 문제 수정), 장치 쿠키 | `services/dashboard` |
| Dashboard 모듈 등록 | **정적 배열**(overview, tasks, projects, reviews)이다. 런타임 플러그인 시스템은 없다. | `src/modules/registry.ts` |
| Hermes Provider | Gemini `gemini-3.5-flash-lite`(provider gemini). 키는 `secrets/hermes.env`의 `GEMINI_API_KEY`(Hermes 컨테이너 전용) | `data/hermes/config.yaml` |
| Hermes 도구 | `personal_ai_task` 하나. 동작: submit, status, result, wait, list, cancel, projects, system_status, review. 브로커 허용 경로: system/status, projects, tasks 조회·생성·취소, diff, review | `hermes-integration/plugins/.../__init__.py`, `hermes-broker/src/broker.ts` |
| Hermes 내장 기능 | `memory_enabled: true`(에이전트 메모와 사용자 프로필), `memories/`, `kanban.db`. **Hermes 제품 자체의 기능**이며 Personal AI의 Memory/Graph가 아니다. | `data/hermes/config.yaml`, `data/hermes/` |
| 자체 AI Provider adapter | **없음.** 우리 서비스 코드에 LLM 호출이 없고 Gemini는 Hermes만 호출한다. | 소스 검색(`generativelanguage`, `@google/genai`, `GEMINI_API_KEY`) |
| Memory/Knowledge Graph | **없음** | 소스 검색(learning, knowledge, quest, mastery, roadmap) 결과 0건 |
| Service Registry | **없음.** 서비스 구성은 compose 파일과 정적 Dashboard 메뉴뿐이다. | 위와 같음 |
| Quest Android / API | **저장소에 없음** | 위와 같음 |
| Learning 관련 테이블·모듈 | **없음** | migrations v1~v6: tasks, projects, reviews, publications, test_validations, publish_authorizations |
| DB 백업·복원 | **스크립트 없음.** 마이그레이션 전에 better-sqlite3 `.backup()`으로 수동 백업했고, 백업 파일은 원본과 **같은 볼륨**에 있다(v1~e2b). 복원 절차는 문서도 테스트도 없다. | `/var/lib/controller` 목록 |
| 테스트(최근 빌드) | controller 108, dashboard 31, publisher 30, test-runner 6, worker 72, repo-sync 16, Dashboard E2E 49, 실제 브라우저 18 | 각 Docker 빌드 단계, 스크립트 |

## 2. 중복, 충돌, 미구현

| 구분 | 내용 | 처리 |
|---|---|---|
| **재사용** | Dashboard 로그인, 세션, CSRF, BFF 패턴, UI 컴포넌트, 감사 로그 | `/learning` 메뉴와 BFF 라우트 추가 |
| **재사용** | Controller의 기술 스택과 패턴(NestJS, better-sqlite3 migration, token-registry, `RequireRole`, 409 code 패턴) | Learning Service가 같은 패턴으로 새로 구현(코드 복사, 공용 라이브러리 아님) |
| **재사용** | 네트워크 격리 패턴(서비스 쌍마다 internal 네트워크), 비root·read-only·cap_drop | `learning-internal` |
| **수정** | Dashboard `modules/registry.ts`(메뉴 1개), `compose.dashboard.yaml`(네트워크 1개 추가, Dashboard 재생성 필요) | L1-05 |
| **수정(L4)** | hermes-broker 허용 경로, Hermes 플러그인에 도구 추가 | L4-01. L1에서는 변경하지 않음 |
| **신규** | Learning Service, Learning DB와 볼륨, Provider adapter(예산, 스키마, 비용 기록), 백업·복원 스크립트 | L1 |
| **미구현(가정 금지)** | Memory/KG, Service Registry, Quest API, 캘린더 | L4 이후에는 연결 계약만 설계 |
| **충돌 1** | Hermes 내장 memory와 kanban에 아이디어가 저장되면 진실 공급원이 둘이 된다. | Learning DB를 유일한 진실 공급원으로 한다. L4 도구가 `capture_idea`를 Learning으로 보내고, Hermes memory에는 학습 데이터를 쓰지 않도록 SOUL 지침에 추가하고 검증한다. |
| **충돌 2** | Controller에도 `completed`, `approved`, `passed` 상태가 있다. | Learning 상태와 엔티티는 별도 DB와 별도 enum으로 둔다. 문자열이 같아도 의미를 공유하지 않는다. |
| **충돌 3** | Test Runner와 Publisher의 테스트 증거 vs 학습 평가 증거 | Test Runner는 "승인된 Git 커밋과 프로젝트 testCommands"에 묶여 있다. 학습 코드 제출에는 그대로 재사용하지 **않고**, 키도 공유하지 않는다. L2에서 별도 격리 실행기를 정한다(결정 D5). |
| **충돌 4** | 개발 로드맵(`docs/ROADMAP.md`, 마크다운 문서)과 학습 로드맵 | 학습 로드맵은 DB 엔티티다. LR-018 "Project link"는 ROADMAP.md가 아니라 **Controller Project Registry id**를 참조하는 것으로 해석한다. |
| **충돌 5** | Provider 키를 Hermes 외의 컨테이너에 둘지 여부 | 결정 D2 |

## 3. 목표 아키텍처와 선택지 (최소 변경안 우선)

```
Browser ─▶ Dashboard (Next BFF, 기존 로그인/CSRF) ──learning-internal──▶ learning (NestJS, learning-data 볼륨)
                                                                          │  Gemini API (learning-egress, 결정 D2)
Hermes ─▶ hermes-broker ──(L4, allowlist)──▶ learning                     │
Controller ◀── 직접 연결 없음 (L4-03에서 Project id 참조만, 읽기 전용) ─────┘
```

- **선택지 A (권장)**: 새 서비스 `services/learning`.
  - 구성: 자체 SQLite DB와 migration, 자체 토큰(Dashboard 전용, L4에서 broker 전용 추가).
  - 장점: 장애가 Controller로 퍼지지 않고, 백업 범위가 분리되며, 기존 서비스 코드 변경이 가장 적다.
  - 비용: 컨테이너 1개, Dashboard 재생성 1회.
- **선택지 B**: Controller 프로세스 안에 Learning 모듈을 두고 SQLite 파일만 분리한다.
  - 장점: 컨테이너가 늘지 않는다.
  - 단점: Controller 재배포 때마다 함께 영향을 받고, 인증 경계가 섞인다. 핸드오프 문서의 "Controller DB 직접 사용 회피" 원칙과도 어긋난다.
- **선택지 C**: Dashboard(Next) 안에서 저장한다. BFF 원칙에 어긋나므로 **비권장**이다.
- **AI 호출 위치**: Learning Service 안의 Provider adapter.
  - Hermes를 경유하지 않는다. Hermes는 LLM 에이전트라 결정적인 저장 경로가 될 수 없다.
  - Gemini의 JSON schema 출력을 사용하고, 서버에서 다시 검증한다(class-validator와 도메인 검증기: DAG, 길이, 개수, 일정 불변).

## 4. 수정·신규 파일과 마이그레이션 설계

- **신규**:
  - `services/learning/`(src: domains, ideas, goals, roadmaps, proposals, provider, export, audit, auth, database / test / Dockerfile / README)
  - `compose.learning.yaml`
  - `services/learning/scripts/{init-secrets,backup,restore}.mjs`
- **수정(L1)**:
  - Dashboard: `src/modules/registry.ts`, `src/lib/learning.ts`(server-only 클라이언트), `src/app/(admin)/learning/**`, `src/app/api/learning/**`, `compose.dashboard.yaml`(네트워크와 토큰 secret)
- **변경 없음(L1)**: Controller, Worker, Test Runner, Publisher, Hermes, broker
- **Learning migration v1 (L1)**:
  - `domains`(parent_id, status 6종, 순환 검사)
  - `ideas`(state, domain_ids, project_ids)
  - `goals`
  - `roadmaps`(current_version_id)
  - `roadmap_versions`(version, content_hash, proposal_id, approved_by, approved_at; UNIQUE(roadmap_id, version); 승인 후 수정하는 UPDATE 경로 없음)
  - `roadmap_nodes`, `prerequisite_edges`(version_id 단위 DAG)
  - `skills`(canonical)
  - `ai_proposals`(base_version_id, payload, model, prompt_version, input_tokens, output_tokens, cost_usd, state, validation_errors)
  - `provider_usage`(월별 합계)
  - `audit_events`
- **원자성**: proposal 적용은 `UPDATE roadmaps SET current_version_id=@new WHERE id=@id AND current_version_id IS @base` 하나로 처리하고, 실패하면 409로 응답한다(Controller의 review 결정과 같은 방식).
- **백업**:
  - `backup.mjs`는 `.backup()`으로 **볼륨 밖** 호스트 경로(예: `data/backups/learning/`)에 저장한다.
  - `restore.mjs`는 서비스를 멈춘 뒤 파일을 교체하고 integrity_check를 실행한다. L1-06에서 복원 테스트까지 한다.

## 5. 화면, API, DB, AI Provider, Broker·Worker 권한 계약

- **화면(L1)**: `/learning`(Overview), `/learning/ideas`, `/learning/roadmaps/[id]`(Explorer, Draft diff, 승인, 복원)
  - Graph는 처음에는 **리스트와 계층 표시**(대체 텍스트 겸용)로 시작한다. React Flow 같은 라이브러리는 번들 영향을 확인한 뒤 결정한다(D6).
- **API**: 05 문서의 경로를 따른다.
  - 모든 쓰기는 Dashboard 토큰이 필요하고, 결정자는 X-Approver 헤더로 기록한다(Controller와 같은 방식).
  - 승인과 복원에는 `baseVersionId`가 필수다.
- **권한**:

  | 주체 | Learning 접근 |
  |---|---|
  | Dashboard 서버(owner 대행) | 전체 |
  | Hermes broker (L4) | query와 propose만(proposal 생성, 아이디어 캡처). 승인, 삭제, 복원, export는 403 |
  | Worker, Publisher, Test Runner | 없음. 네트워크도 분리 |
  | 브라우저 | 토큰 없음(BFF) |

- **Provider**:
  - 월 예산 상한을 넘으면 생성을 거부한다(402 또는 429 코드, 원본 불변).
  - 요청 타임아웃은 30초, 재시도는 1회다.
  - 입력(목표, 사전 지식)은 신뢰하지 않는 데이터로 취급한다. 시스템 지시와 분리하고, 출력에 도구 호출이 없게 한다.

## 6. 우선순위와 수용 기준

`L0_ROADMAP.patch`의 17절 표를 따른다. 순서: L1-01 → (02, 03 병행) → 04 → 05 → 06 → L2 → L3 → L4.

## 7. 위험, 롤백, 백업, 테스트 계획

- **롤백**: L1은 새 컨테이너, 새 볼륨, Dashboard 메뉴 하나만 추가한다. 되돌리려면 `compose.learning.yaml`을 빼고 Dashboard를 이전 이미지로 재생성하면 된다. Controller와 Publisher DB는 건드리지 않으므로 마이그레이션 롤백이 필요 없다.
- **테스트**:
  - 08 문서의 T01~T07, T11~T13을 L1 범위로 단위·e2e 테스트한다.
  - Dashboard E2E 49개와 실제 브라우저 18개 회귀를 다시 실행한다.
  - Learning 컨테이너 재생성, 백업에서 복원 후 상태가 같은지 확인한다.
- **위험**:
  1. Provider 비용과 키 노출 범위가 늘어난다(D2, D3).
  2. 학습 내용(개인 데이터)이 `secrets/` ACL과 같은 문제를 겪지 않도록 볼륨과 백업 위치의 권한이 필요하다.
  3. 소스가 커밋되지 않은 상태라 대규모 추가 전에 기준선을 남기는 것이 안전하다(D1).
  4. Hermes 내장 memory와의 이중 저장(충돌 1).

## 8. 사용자 승인이 필요한 결정

| # | 결정 | 권장 |
|---|---|---|
| D1 | 구현 전에 현재 소스를 Git 기준선으로 커밋할지(로컬 커밋만, push 없음) | 권장. L1 diff를 분리해서 검토할 수 있다. |
| D2 | Learning이 쓸 Gemini 키 | Learning 전용 키를 새로 발급한다(Hermes 키 재사용은 비권장: quota와 폐기 범위가 섞인다). |
| D3 | AI 비용 상한과 모델 | 월 상한(예: USD 5), 모델은 `gemini-3.5-flash-lite`를 기본으로 하고 변경할 수 있게 한다. |
| D4 | 아키텍처 | 선택지 A(별도 `services/learning`) |
| D5 | L2 코드 과제 실행 방식 | 지금은 결정을 보류하고, Test Runner를 그대로 재사용하지 않는다는 원칙만 확정한다. |
| D6 | Roadmap Graph UI | L1은 리스트와 계층 표시, 시각 그래프는 나중 |
| D7 | 학습 데이터 백업 위치와 보존 기간 | `data/backups/learning/`, 최근 14개 보관 |
| D8 | `docs/ROADMAP.md`에 `L0_ROADMAP.patch` 적용 | 승인하면 `git apply`로 적용한다. |
| D9 | L1에서 Hermes 연동 제외(L4로 연기) | 권장 |
