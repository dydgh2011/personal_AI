# Codex 작업 계획 (2026-11-24 시작)

Claude Code와 Codex가 **동시에** 일한다. 이 문서는 누가 어떤 파일을 맡는지, 어떻게 충돌 없이 합치는지, Codex가 맡은 작업 2개를 정한다. 규칙은 `AGENTS.md`를 따른다.

## 1. 맡은 범위 (다른 쪽 범위는 고치지 않는다)

| 작업 | 담당 | 브랜치 / worktree | 맡은 파일 |
|---|---|---|---|
| **C**: 실제 GitHub 게시, PR, CI 확인, 커밋 작성자 = 주인, 비공개 저장소 확인 | Claude | `claude/publish` · `D:\personal_ai-wt\claude-publish` | `services/github-publisher`, `services/controller`, `services/worker`, `images/coding-worker`, `services/test-runner`, `compose.publisher.yaml`, `compose.controller.yaml`, `compose.github.yaml`, `compose.workers.yaml`, Dashboard `app/(admin)/reviews`·`projects`·`tasks`, `src/lib/controller.ts`·`review.ts`·`publishing.ts`, `docs/coding-agent-settings.md` |
| **A**: Learning L3(일정·복습) + Learning ↔ 플래너 연결 | Codex | `codex/learning-l3` · `D:\personal_ai-wt\codex-learning-l3` | `services/learning`, `services/planner`, Dashboard `app/(admin)/learning`·`components/learning`·`src/lib/learning*`, `compose.learning.yaml`·`compose.planner.yaml`의 환경 변수 |
| **B**: Kelly 학습 도구(L4-01) + Hermes 위임 보안 마무리(5) + 서비스 지도 `dashboard → learning` 허용 명령 | Codex | `codex/kelly-learning` · `D:\personal_ai-wt\codex-kelly-learning` | `services/hermes-broker`, `services/hermes-integration`, `services/service-map`, `compose.yaml`의 hermes·broker 부분 |

- **아무도 혼자 고치지 않는 공통 파일**: `docs/ROADMAP.md`, `AGENTS.md`, Dashboard `src/modules/registry.ts`·`package.json`·`src/app/globals.css`·`src/lib/server.ts`·`security.ts`, compose의 `networks:`.
  - 꼭 바꿔야 하면 작업 보고에 "이렇게 바꿔야 함"으로 적고, 합치는 쪽이 반영한다.
- B가 learning 서비스에 새 API가 필요하면 `services/learning`을 직접 고치지 않는다. `CURRENT_WORK.md`에 요청으로 적고, A가 만들거나 A가 합쳐진 뒤에 한다.
- 네트워크를 새로 만들면 Docker 주소 여유(약 2개)를 먼저 확인한다: `scripts\stack.ps1 verify-networks`의 "주소 풀".

## 2. 진행 방식
1. **worktree 만들기**(원래 폴더 `D:\personal_ai`에서):
   ```powershell
   git -C D:\personal_ai fetch origin
   git -C D:\personal_ai worktree add -b codex/learning-l3 D:\personal_ai-wt\codex-learning-l3 origin/learning-os/l1
   git -C D:\personal_ai worktree add -b codex/kelly-learning D:\personal_ai-wt\codex-kelly-learning origin/learning-os/l1
   ```
   - 같은 폴더를 두 에이전트가 같이 쓰지 않는다. `.claude/worktrees` 아래는 Claude 것이니 쓰지 않는다.
2. **worktree 안에서 하는 일**: 코드, 단위 테스트, 이미지 빌드(태그는 겹치지 않게, 예 `personal-ai-learning:codex-l3`)까지만.
   - 실행 중인 스택은 건드리지 않는다. `stack.ps1`도 worktree에서는 스택을 바꾸는 명령을 거부한다.
3. **커밋**: 각자 자기 브랜치에만 커밋한다. 커밋 메시지에 AI 흔적(`Co-Authored-By`, `Generated with` 등)을 넣지 않는다.
4. **합치기와 실제 확인**(원래 폴더에서, 한 번에 한 에이전트만):
   - `CURRENT_WORK.md`의 "스택 잠금"을 확인한다. 비어 있으면 자기 이름을 적고 커밋·push한다.
   - 그다음 순서: `git pull` → 자기 브랜치 merge(`--no-ff`) → 테스트 → 필요한 백업 → `scripts\stack.ps1 rebuild <바꾼 서비스>` → 실제 확인 → push → 잠금을 비우고 push.
   - 잠금이 다른 에이전트 이름이면 기다린다. 30분 넘게 그대로면 주인에게 묻는다.
5. **끝날 때**: `CURRENT_WORK.md`의 자기 줄을 갱신한다(한 일, 남은 일, 확인 못 한 것). ROADMAP은 합친 뒤에 실제로 확인한 것만 고친다.

## 3. 작업 A — Learning L3 + 플래너 연결
- 먼저 읽을 것: `docs/ROADMAP.md` 17절(L3), `Personal_AI_OS_Learning_Expansion/docs/learning-os/` 설계 문서, `services/learning`, `services/planner`의 README.
- **L3-01 가용 시간과 일정 규칙**: 같은 입력이면 같은 결과가 나오는 결정적 계산. timezone은 `America/Toronto`로 명시한다.
- **L3-02 일·주 계획**
  - 끝내지 못한 과제는 다음으로 넘긴다.
  - **사용자가 정한 Deadline은 승인 없이 바꾸지 않는다.**
- **L3-03 복습 일정**: 오래된 숙련도를 다시 검증하도록 복습을 잡는다.
- **플래너 연결**
  - Learning의 과제·복습을 플래너의 할 일과 Kelly 캘린더 일정으로 **제안**한다.
  - 일정·마감 변경은 플래너의 기존 승인 흐름(제안 → 주인 확인)을 그대로 쓴다.
  - Learning은 학습 데이터만, 플래너는 일정만 가진다. 서로의 DB를 직접 읽지 않고 API로만 주고받는다.
  - 새 연결이 필요하면 네트워크 규칙(1절)을 따른다.
- **화면**: Dashboard `/learning`에 일정·복습 화면을 추가한다. 품질은 높게, 390px 모바일과 라이트·다크 모두 확인한다.
- **AI 호출**: 이미 LLM 게이트웨이를 쓴다(`provider: gateway`, 별칭 `batch`, 무료 경로). 새 AI 키는 필요 없다.
- **완료 기준**
  - learning·planner·dashboard 테스트와 타입 검사 통과, 이미지 빌드 통과
  - 합친 뒤 실제 스택에서 학습 DB를 백업하고 migration 적용, 플래너 제안이 실제로 생기는지 확인

## 4. 작업 B — Kelly 학습 도구 + 보안 마무리 + 서비스 지도
- **L4-01 Kelly 학습 도구** `personal_ai_learning`
  - hermes-broker의 허용 목록(`ROUTES`)에 **조회(query)와 제안(propose)만** 넣는다.
  - 학습 데이터를 직접 쓰거나, 셸·임의 HTTP를 쓰는 길은 만들지 않는다.
  - Kelly 플러그인 도구와 SKILL을 `services/hermes-integration`에 추가한다. 기존 `personal_ai_knowledge` 도구 방식을 따른다.
  - broker가 learning에 닿아야 하면 learning 서비스의 호출자 키(Dashboard 키와 다른 키)와 네트워크가 필요하다.
    - 키 파일은 `init-secrets` 스크립트로 만든다. 값은 출력하지 않는다.
    - learning 쪽 인증 변경이 필요하면 1절의 요청 방식을 따른다.
- **5 Hermes 위임 보안 마무리**
  - broker가 호출자를 확인하는 방식을 점검하고, 필요하면 강화한다(ROADMAP 5절 "남은 문제").
  - Hermes 설정 무결성 점검(`configure-hermes.mjs --check`)을 정기적으로 돌릴 방법을 만든다. 호스트 작업 스케줄러에 등록하는 일이면 주인에게 정확한 명령을 준다.
  - 레거시 `secrets/hermes.controller.env` 삭제는 **주인 승인 후에만** 하고, 지금은 보고만 한다.
- **서비스 지도**: `services/service-map/rules.mjs`에 `dashboard → learning` 허용 명령 파서를 추가한다(지금 `link-no-rules`로 표시됨). 테스트도 추가한다.
- **완료 기준**
  - broker·hermes-integration(호스트와 Hermes 이미지)·service-map 테스트 통과
  - 합친 뒤 Kelly를 다시 시작하고, 학습 조회·제안이 실제로 되는지 확인
  - 확인할 때 Kelly 대화 기록이 남는 질문은 최소로 하고, 남긴 기록은 보고한다.

## 5. Codex에 붙여 넣을 프롬프트
작업 폴더를 `D:\personal_ai`로 열고 아래를 붙여 넣는다.

```text
AGENTS.md, docs/handover/CURRENT_WORK.md, docs/handover/CODEX_PLAN.md를 끝까지 읽고 그대로 따라 줘.
CODEX_PLAN.md의 작업 A와 작업 B를 맡아. 서브에이전트(또는 병렬 작업)를 쓸 수 있으면 두 작업을 각각 다른 서브에이전트에게 맡기고, 각자 계획서 2절의 자기 worktree에서만 일하게 해. 서브에이전트를 쓸 수 없으면 A를 먼저 하고 B를 해.
Claude가 작업 C를 동시에 하고 있으니 계획서 1절의 맡은 파일 밖은 절대 고치지 마. 공통 파일은 보고로만 남겨.
실행 중인 Docker 스택은 계획서 2절 4번 절차(스택 잠금)를 지킬 때만 바꿔. 비밀 값은 읽거나 출력하지 마.
커밋은 각자 브랜치에만 하고, 커밋 메시지에 AI 흔적을 절대 넣지 마. 위험한 우회 옵션(--dangerously-bypass-approvals-and-sandbox 등)은 쓰지 마.
각 작업이 끝날 때마다 CURRENT_WORK.md를 갱신하고, 마지막에 한국어로 보고해 줘(바뀐 파일, 실제 테스트 결과, 실제 스택 확인 결과, 확인하지 못한 것, 주인이 결정할 것).
```

- 서브에이전트 대신 터미널을 두 개 열고, 각 worktree에서 작업 하나씩 따로 맡겨도 된다(같은 프롬프트에 "작업 A만" 또는 "작업 B만"이라고 덧붙인다).
