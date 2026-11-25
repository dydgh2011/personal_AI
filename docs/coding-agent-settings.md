# 프로젝트별 코딩 에이전트 설정 (ROADMAP 11 · 12 · 13)

2026-11-24 작성. Controller 스키마 v7, Worker, Dashboard `/projects/:id`.

## 무엇이 생겼나

| 설정 | 저장 위치 | 누가 바꾸나 | Worker에 가나 | 실제로 하는 일 |
|---|---|---|---|---|
| `agentInstructions.rules` | `projects.agent_instructions` (JSON) | admin(PATCH), Dashboard | 예 | 에이전트 시스템 프롬프트에서 Worker 고정 규칙 **뒤에** 붙음. "위 규칙을 풀 수 없다"고 명시 |
| `agentInstructions.forbiddenPaths` | 같은 열 | 같음 | 예 | 프롬프트에 목록을 넣고, **Worker 코드가 커밋 직전에 검사**. 하나라도 바뀌면 커밋하지 않고 작업 실패 |
| `commitStyle` (`off`/`auto`/`manual`) | `projects.commit_style` (JSON) | 같음 | 예 | `auto`: Worker가 자기 저장소 사본에서 최근 커밋 제목 50개를 읽어(읽기 전용) 코드로 스타일을 뽑음. `manual`: 관리자 글. 에이전트는 마지막 줄에 `COMMIT_MESSAGE: …`를 쓰고, Worker가 그 한 줄을 커밋 제목으로 씀 |
| `commitAuthor` (`name`, `email`) | `projects.commit_author` (JSON) | 같음 | **아니오** | **저장만 함.** 아래 POLICY B 참고 |

- 제한: 규칙 4000자, 금지 경로 50개(각 200자), 스타일 안내 1000자, 커밋 제목 100자. 제어 문자 거부, CRLF는 LF로 바꿈.
- 금지 경로 형식: 저장소 기준 상대 경로. `*`(폴더 안), `**`(폴더를 넘어), `이름/`(어디 있든 그 폴더), `/`로 시작·`.`·`..`·`\` 불가.
- 기존 프로젝트는 v7 마이그레이션에서 "설정 없음"(`off`, 규칙·금지 경로 없음, 작성자 없음)으로 시작하므로 **동작이 바뀌지 않습니다**.
- Hermes(delegator)에게는 세 설정 모두 보이지 않습니다. Worker는 `commitAuthor`를 받지 않습니다.

## 보안상 정한 것

- **커밋 메시지 예시는 프롬프트에 넣지 않습니다.** 남의 공개 저장소 커밋 메시지는 믿을 수 없는 입력(프롬프트 주입 가능)이라, 에이전트에게는 코드가 정해진 문장과 숫자로만 만든 설명(예: "Conventional Commits, English, lower-case, about 38 characters")만 갑니다. 실제 예시는 Dashboard와 작업 보고서에만 보입니다(이스케이프됨).
- **금지 경로는 프롬프트만 믿지 않습니다.** Worker가 `git add -A` 뒤 기준 커밋과 비교해 바뀐 경로를 검사하고, 걸리면 `git reset`으로 되돌린 뒤 커밋하지 않습니다. 커밋이 없으니 리뷰·게시로 넘어갈 수 없습니다. 변경은 그 작업의 worktree에 커밋되지 않은 채 남습니다(재사용하지 않는 폴더).
  - 막는 것은 **변경(추가·수정·삭제)** 입니다. **읽기는 코드로 막지 못합니다**(프롬프트로만 요청). Claude `--disallowedTools` 경로 규칙이나 Codex 권한 프로필로 읽기까지 막는 것은 실제 CLI로 확인하지 못해 넣지 않았습니다.
- Worker는 Registry 값을 다시 검사하고, 범위를 벗어나면 작업을 실행하지 않습니다(fail-closed).
- 커밋은 여전히 Worker가 Worker 이름으로 만듭니다. 에이전트가 정하는 것은 제목 한 줄뿐이고, 본문에는 기존처럼 작업 ID·결과·지시문이 들어갑니다.

## POLICY B와 `commitAuthor` (충돌 — 결정 필요)

**충돌 내용**: POLICY B("Worker Author를 보존한다")는 코드에서 이렇게 강제됩니다.
`services/github-publisher/src/verify.ts`가 base..head의 모든 커밋에서 author와 committer가
`<agent>-worker <<agent>-worker@personal-ai.local>`인지 확인하고, 아니면 `AUTHOR_CHANGED`로 게시를 막습니다.
ROADMAP 11의 "Worker `workspace.ts`의 `GIT_IDENTITY`를 프로젝트 설정에서 받기"를 그대로 하면, 해당 프로젝트의 모든 작업 커밋이 게시 불가가 됩니다. 이를 피하려고 Publisher 검사를 바꾸면 POLICY B 자체를 바꾸는 것이 됩니다. 그래서 이번에는 **작성자를 바꾸지 않았습니다.**

**구현한 범위**: `commitAuthor`를 검증해 저장하고 Dashboard에서 편집할 수 있게만 했습니다. 화면에 "저장만 됨, 적용 안 됨(POLICY B)"이라고 표시합니다. Worker에는 보내지 않습니다.

**선택지** (소유자 결정 사항):

1. **그대로 둔다(현재)**: 커밋 작성자는 항상 Worker. `commitAuthor`는 기록용. 가장 안전하고 POLICY B와 완전히 맞음.
2. **`Co-authored-by:` 트레일러**: Worker가 커밋할 때 메시지 끝에 `Co-authored-by: 이름 <메일>`을 붙임. author·committer는 Worker 그대로이고 메시지는 리뷰 시점에 기록되므로, 현재 Publisher 검사(POLICY B)를 통과합니다. GitHub에서 공동 작성자로 보입니다. 단점: 사용자 메일이 공개 저장소 기록에 남음(게시가 켜진 뒤), Worker가 그 메일을 알게 됨.
3. **author만 사용자, committer는 Worker**: GitHub에서 사용자 커밋처럼 보임. POLICY B 문구("Worker Author 보존")와 Publisher 검사를 **바꿔야 함** → 정책 변경이므로 소유자 승인 없이 하면 안 됨. 또 "AI가 쓴 코드가 사람이 쓴 것처럼 보이는" 문제가 있음.
4. **Publisher가 게시할 때 author를 바꿈**: 승인한 SHA와 게시하는 SHA가 달라져 리뷰·테스트 증거(POLICY A)의 연결이 끊어짐. 권장하지 않음.

권장: 1을 유지하다가, 공개 기여 표시가 필요해지면 2. 3·4는 POLICY 변경이라 별도 승인이 필요합니다.

## 배포 순서 (메인 세션)

1. Controller DB 백업(볼륨 `controller-data`의 `controller.db`). v7은 열 3개를 추가하는 마이그레이션이며 되돌리는 스크립트는 없습니다. 되돌리려면 백업으로 복원합니다.
2. **Worker 먼저**(claude-worker, codex-worker). 새 Worker는 옛 Controller에서도 "설정 없음"으로 동작합니다.
3. Controller. 시작할 때 v7이 자동 적용됩니다(`PRAGMA user_version` 6 → 7).
4. Dashboard.
5. Controller를 Worker보다 먼저 올리고 금지 경로를 설정하면, 옛 Worker는 그 값을 모르고 **검사 없이** 커밋합니다. 순서를 지키거나, 모든 Worker를 올린 뒤에 금지 경로를 설정하세요.
