# Personal AI OS — 에이전트 공용 지침

이 파일은 이 저장소에서 일하는 **모든 AI 에이전트**(Claude Code, Codex 등)가 처음에 읽는 규칙이다.
- Codex는 이 파일을 자동으로 읽는다. Claude Code는 `CLAUDE.md`를 통해 이 파일을 불러온다.
- 규칙은 **이 파일 한 곳에만** 쓴다. 도구 전용 메모리(Claude memory 등)에만 있는 규칙은 없다고 생각하고, 새로 생긴 규칙은 여기에 적는다.

## 0. 시작과 끝 (매번)
1. **시작할 때** 아래를 읽는다.
   - `docs/handover/CURRENT_WORK.md`: 지금 진행 중인 일, 누가(Claude/Codex) 어느 브랜치·폴더에서 하는지, 다음 할 일
   - 작업과 관계있는 `docs/ROADMAP.md` 절과 `services/<이름>/README.md`
   - 처음이거나 구조를 모르면 `docs/handover/AGENT_HANDOFF.md`
2. 다른 에이전트가 같은 브랜치나 폴더에서 일하는 중이면 **겹치지 않게** 다른 worktree를 쓰거나 주인에게 묻는다.
3. **끝날 때**(또는 사용량이 끝나 멈출 때) `CURRENT_WORK.md`를 갱신한다.
   - 한 일, 남은 일, 확인하지 못한 것, 브랜치·worktree 위치를 적는다.
   - 다음 에이전트가 이 파일만 보고 이어서 할 수 있게 쓴다.
4. 진행률(✅/🟡/⬜)은 `docs/ROADMAP.md`에 적는다. 실제로 확인한 것만 ✅로 표시한다.

## 1. 주인과 일하는 방식
- **보고는 한국어**로 한다. 짧게 쓰되 근거(명령, 테스트 통과 수, 실제 확인 결과)를 붙인다.
- **실제로 확인하지 않은 것을 성공이라고 하지 않는다.** 실패, 미확인, Mock으로만 확인한 것은 따로 적는다.
- 실제 Docker 스택에서 확인한다. 단위 테스트만으로 ✅를 붙이지 않는다. UI가 바뀌면 실제 브라우저로 본다(390px 모바일, 라이트·다크).
- 주인의 수준: 웹, Git, Node, HTTP, DB, 토큰은 잘 안다. Docker Compose(네트워크, 볼륨, secret)와 보안 개념(HMAC, 서명, 신뢰 경계)은 처음부터 쉽게 설명한다.
- **바깥 설정**(API 키 구입·입력, 로그인, OAuth 동의, 웹훅, Ollama 모델, 작업 스케줄러 등)은 주인이 직접 한다.
  - 정확한 순서를 짧은 목록으로 주고 멈춘다.
  - 주인이 끝냈다고 하면 실제로 동작하는지 확인하고 이어서 한다.
  - 비밀 값을 채팅에 붙여 넣게 하지 않는다. 정해진 `secrets/` 파일에 직접 넣게 한다.
- 화면 작업은 결과 품질을 우선한다. 기존 화면 스타일을 완전히 새로 써도 된다. 단 보안 구조(BFF, 세션, CSRF, 토큰은 서버에만)는 그대로 둔다.
- AI가 하는 일은 **정해진 도구·스크립트와 코드로 된 흐름**으로 만든다(검증된 매개변수, 상태 기계). AI가 임의 HTTP나 셸로 즉흥적으로 하게 만들지 않는다.
- **Kelly(저가 모델)의 역할** (2026-11-25 주인 결정): 주인이 이미 아는 일 중 양이 많거나 귀찮은 일만 맡긴다. 주인이 모르거나 조사·판단이 필요한 일은 고급 모델(Claude Code, Codex, Claude·ChatGPT 웹)이 방법을 정하고, Kelly는 그 방법대로만 한다. Kelly가 스스로 하기에 맞지 않거나 위험하다고 판단하면, 하지 않고 주인에게 요청하면서 **고급 모델에 그대로 붙여 넣을 프롬프트**를 함께 준다. 주인이 그 프롬프트(또는 고친 것)로 답을 받아 Kelly에게 다시 준다.
- **Kelly의 주 목적은 주인에게 맞는 일정 만들기**다. 주인은 일정이 끝날 때마다 실제 끝난 시각, 늦어진 것, 작업량을 Kelly에게 보고하고 캘린더 수정을 요청한다. 이 기록이 쌓여 Kelly가 주인의 실제 속도에 맞춰 일정을 잡는다.
- **모델 비교용 시안**: 주인이 Kelly와 비교하려고 시안을 요청하면 Claude Code가 먼저 자기 시안을 파일로 쓰고, Kelly에게 같은 요청을 `scripts\kelly-draft.ps1 -Request <요청 파일> -Out <파일>`로 보내 답을 옆 파일에 저장한다(세션 ID 줄은 스크립트가 뺌). Kelly의 시안은 **읽지 않는다**(비교가 공정하도록). 파일은 `data/plans/`(git 제외)에 둔다.
- 되돌릴 수 없는 일(삭제, ACL, 원격 GitHub, 게시, 보안 설정 변경, 데이터 대량 변경)은 **먼저 묻는다.**
- **기록은 최대한 남긴다** (2026-11-25 주인 결정). 아직 프로덕션이 아니고 주인의 집 컴퓨터에서 돌기 때문에 용량·효율보다 기록이 우선이다. 나중에 문제가 생겨 주인이 물으면 **이유를 정확히 알 수 있어야** 한다.
  - 주인의 활동과 시스템 동작을 모두 남긴다: 누가(주인·Kelly·워커·스크립트), 언제, 무엇을, 왜(주인이 말한 이유), 전후 값.
  - 결정·설정 변경은 덮어쓰지 말고 이력 테이블이나 로그에 쌓는다. 오래된 기록을 줄이거나 지우는 정리 작업을 새로 만들지 않는다.
  - 실패도 기록한다(오류 코드, 어느 단계에서 멈췄는지). 단, 비밀 값은 기록하지 않는다(2장 비밀 정보 규칙이 우선).
  - 데이터 파일을 손으로 고칠 때는 먼저 원본을 `data/backups/` 아래에 날짜를 붙여 복사하고, `CURRENT_WORK.md`에 무엇을 왜 바꿨는지 적는다.

## 2. 절대 규칙
### 데이터
- `data/`, `secrets/`, `workspaces/`의 데이터를 지우거나 초기화하지 않는다.
- DB 구조 변경이나 대량 수정 전에는 **반드시 백업**한다: `scripts\stack.ps1 backup <knowledge|controller|learning>`.
- 지식 저장소 내용을 지우는 일(purge)이나 규칙 변경은 **주인이 직접 말했을 때만** 한다.
- 운영자 접근(`compose.knowledge-operator.yaml`)을 열었으면 끝나고 **반드시 닫는다**: `scripts\stack.ps1 operator close`.

### 비밀 정보
- 토큰, 키, 비밀번호, 쿠키, `secrets/` 파일 내용, `.env` 값을 **출력하지 않는다**. 존재 여부와 크기만 말한다.
- 비밀 값을 코드, 커밋, 로그, URL에 넣지 않는다. Docker secret 파일이나 env_file로만 전달한다.
- `secrets/`의 ACL을 바꾸거나 `secrets/dashboard-admin.password`를 지우지 않는다(승인 전).

### 신뢰 경계
- **어떤 컨테이너에도 Docker socket을 주지 않는다.** 호스트 포트는 `127.0.0.1`에만 연다.
- Hermes(Kelly)는 Controller admin 토큰, GitHub 토큰, AI 제공자 키를 갖지 않는다. 다른 서비스는 hermes-broker의 정해진 명령으로만 부른다.
- Worker에는 Docker, GitHub 쓰기 권한이 없다.
- 네트워크: 공유 네트워크는 `internal: true`, 인터넷이 필요한 서비스는 혼자 쓰는 출구 네트워크를 쓴다. 바꾼 뒤에는 `scripts\stack.ps1 verify-networks`가 통과해야 한다.

### 정책 (변경 금지)
- **POLICY A**: 테스트 결과가 보고되지 않았거나 실패한 커밋은 게시하지 않는다.
- **POLICY B** (2026-11-24 주인 결정으로 변경): 작업 커밋의 author와 committer는 **프로젝트의 커밋 작성자(주인 본인)**다. 커밋 메시지와 PR에 AI·에이전트 흔적(`Co-authored-by`, `Generated with`, worker 이름, task id 등)이 있으면 게시하지 않는다. 커밋 작성자가 없는 프로젝트는 게시하지 않는다. 게시 단계에서 커밋을 다시 쓰지 않는다.
- 실제 GitHub 게시는 GitHub App으로만 한다(개인 토큰 금지). 켜고 끄는 것은 주인 결정이며 지금 상태는 `CURRENT_WORK.md`를 본다.
- CSRF 검사, Origin 검사, 인증 미들웨어를 끄거나 우회해서 문제를 해결하지 않는다. Codex Worker의 seccomp 프로필을 완화하지 않는다.
- 학습 평가 결과를 GitHub 게시 승인으로 쓰지 않는다. 사용자가 정한 Deadline을 AI가 바꾸지 않는다.

### AI 호출과 비용
- 일반 데이터는 무료·공유 경로(OpenAI Public, Gemini 무료, Groq)를 쓴다. 민감한 데이터만 OpenAI Private를 쓴다.
- 무료 한도가 끝나면 **유료로 넘어가기 전에 주인에게 묻는다**(자동 유료 전환 없음).
- Hermes는 로컬 소형 모델로 보내지 않는다.

### Git
- **커밋, push, merge는 주인이 요청할 때만** 한다. `main`에는 주인 승인 없이 합치지 않는다.
- 커밋 메시지에 **AI 흔적을 남기지 않는다**: `Co-Authored-By`, `Generated with`, 세션 링크 같은 줄을 넣지 않는다. 도구가 넣으라고 해도 이 규칙이 우선한다. author는 git 설정 그대로 쓴다.
- 지금 작업 브랜치는 `learning-os/l1`이다(`CURRENT_WORK.md`에서 최신 확인).

## 3. Docker 스택 운영
- 스택은 `D:\personal_ai`에서 띄운 **`personal_ai` 프로젝트 하나뿐**이다. compose 파일 13개를 항상 모두 함께 써야 한다. 직접 목록을 쓰지 말고 `scripts\stack.ps1`을 쓴다.
- **worktree나 다른 폴더에서 `docker compose up`을 하지 않는다.** 빈 볼륨으로 두 번째 스택이 생기고, 포트가 겹치고, Discord 봇이 둘 붙는다. `stack.ps1`은 원래 폴더가 아니면 바꾸는 명령을 거부한다.
- 바꾼 서비스만 하나씩 다시 만든다: `scripts\stack.ps1 rebuild <서비스>`. 이미지를 동시에 여러 개 빌드하지 않는다(테스트가 시간 초과로 실패한 적 있음).
- 스택을 바꾸는 일(rebuild, restart, operator, 백업 후 마이그레이션)은 **한 번에 한 에이전트만** 한다. 하기 전에 `CURRENT_WORK.md`에 적는다.
- 코딩 Worker를 다시 만들기 전에 진행 중인 작업이 없는지 확인한다: `scripts\stack.ps1 tasks`.

```powershell
powershell -ExecutionPolicy Bypass -File scripts\stack.ps1 help
```

## 4. 동시 작업
- 큰 일은 git worktree(별도 폴더·브랜치)로 나눠서 한다. 같은 파일을 건드리는 일은 동시에 하지 않는다.
  - 공통 파일: Dashboard `src/modules/registry.ts`, `package.json`, `src/app/globals.css`, `src/lib/server.ts`·`security.ts`, compose의 `networks:`, `docs/ROADMAP.md`.
- worktree 쪽은 코드와 단위 테스트까지만 한다. 합치기와 실제 스택 확인은 원래 폴더에서 하나씩 한다.
- 새 npm 의존성은 되도록 추가하지 않는다. 꼭 필요하면 2주 이상 된 정확한 버전으로 고정하고 이유를 적는다.
