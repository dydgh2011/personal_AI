# GitHub 설정 (주인이 직접 할 일)

실제 게시(8·15), PR(9), CI 확인(10), 비공개 저장소 확인(14)에 필요한 설정이다.
**비밀 값(토큰, `.pem` 내용)은 채팅에 붙여 넣지 말고 아래 파일에 직접 저장한다.**

## 1. 시험용 비공개 저장소 만들기
1. GitHub에서 새 저장소를 만든다.
   - 이름 예: `personal-ai-sandbox`
   - **Private** 선택, "Add a README file" 체크
2. 처음 게시 시험은 이 저장소에만 한다. 실제 프로젝트 저장소는 시험이 끝난 뒤 추가한다.

## 2. 읽기 토큰에 비공개 저장소 추가 (비공개 저장소 확인용)
지금 쓰는 읽기 전용 토큰(`secrets\github-readonly.token`)에 새 저장소를 추가한다.
1. GitHub → Settings → Developer settings → Personal access tokens → **Fine-grained tokens**
2. 지금 쓰는 토큰을 열고 **Repository access**에 `personal-ai-sandbox`를 추가한다. 다른 비공개 저장소도 Kelly가 읽게 하려면 같이 추가한다.
3. 권한은 그대로 **Contents: Read-only, Metadata: Read-only**만 둔다. 쓰기 권한은 주지 않는다.
4. 저장한다.
   - 토큰을 편집만 하면 값은 그대로라 파일을 바꿀 필요가 없다.
   - "Regenerate"를 눌렀다면 새 값을 `D:\personal_ai\secrets\github-readonly.token`에 저장한다.

## 3. 게시용 GitHub App 만들기
1. GitHub → Settings → Developer settings → **GitHub Apps** → **New GitHub App**
2. 다음과 같이 입력한다.
   - GitHub App name: 겹치지 않는 이름. 예: `personal-ai-publisher-<아무 문자>`
   - Homepage URL: `https://github.com/<내 계정>`
   - **Webhook: Active 체크 해제**
3. **Repository permissions**를 다음과 같이 고른다. 이 밖에는 모두 No access로 둔다.
   - Contents: **Read and write** (브랜치 push)
   - Pull requests: **Read and write** (draft PR 만들기)
   - Checks: **Read-only** (CI 결과 읽기)
   - Commit statuses: **Read-only**
   - Metadata: Read-only (자동)
4. "Where can this GitHub App be installed?": **Only on this account**
5. **Create GitHub App**을 누르고, 화면 위의 **App ID**(숫자)를 적어 둔다.
6. 같은 화면 아래 **Private keys → Generate a private key**를 누르면 `.pem` 파일이 내려받아진다.
   - 그 파일을 **`D:\personal_ai\secrets\github-app.pem`**으로 옮긴다.
   - 내용을 열어 보거나 다른 곳에 붙여 넣지 않는다.
7. 왼쪽 **Install App** → 내 계정 **Install** → **Only select repositories** → `personal-ai-sandbox`만 고른다 → Install.
8. 설치가 끝난 화면 주소 끝의 숫자(`.../installations/<숫자>`)가 **Installation ID**다.

## 4. Claude(또는 Codex)에게 알려 줄 것
아래 값은 비밀이 아니라서 채팅으로 알려 줘도 된다.
- App ID
- Installation ID
- 저장소 이름(예: `<계정>/personal-ai-sandbox`)
- 2번 토큰을 편집했는지, 다시 만들었는지

## 5. 커밋 작성자 (나중에 Dashboard에서)
- 게시가 준비되면 Dashboard → Projects → 해당 프로젝트 설정에서 **커밋 작성자 이름과 이메일**을 넣는다.
- 이메일은 공개 커밋 기록에 남는다. 개인 메일을 숨기려면 GitHub의 noreply 주소를 쓴다.
  - 확인 위치: GitHub → Settings → Emails의 `...@users.noreply.github.com`
- 작업 커밋은 author와 committer 모두 이 이름으로 만들어지고, 메시지에 AI 흔적이 있으면 게시를 막는다(Claude가 구현 중).
