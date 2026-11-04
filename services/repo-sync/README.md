# repo-sync

등록된 GitHub 프로젝트를 **읽기 전용**으로 미러링하는 도구입니다. 상시 실행되지 않고(`profiles: [tools]`) 필요할 때만 실행합니다.
Controller·GitHub 인증 정보가 없고, 인터넷 전용 네트워크(`repo-egress`)만 씁니다.

```powershell
# Registry에서 프로젝트를 읽고 → 미러 → syncStatus/lastFetchedAt/cachedHeadSha 기록 (admin 토큰은 호스트에서만 사용)
powershell -ExecutionPolicy Bypass -File services\repo-sync\scripts\sync-project.ps1 -ProjectId hello-world
# 직접 실행
docker compose -f compose.yaml -f compose.workers.yaml -f compose.controller.yaml --profile tools run --rm repo-sync sync --id hello-world --url https://github.com/octocat/Hello-World.git --branch master
```

캐시: named volume `personal_ai_repo-cache` → `/repo-cache/<projectId>.git` (bare). 같은 볼륨을 다른 컨테이너에 같은 경로로
마운트하면 Git 경로가 그대로 유효합니다.

악성 저장소 대비:
- bare 저장소, **checkout 없음** → `.gitattributes` 필터, LFS smudge, submodule, checkout hook이 실행될 여지 없음
- `core.hooksPath=/dev/null`, 시스템/전역 git 설정 무시(`GIT_CONFIG_NOSYSTEM`, `GIT_CONFIG_GLOBAL=/dev/null`), 빈 임시 HOME
- 프로토콜은 https만(`GIT_ALLOW_PROTOCOL`, `protocol.allow=never`), URL은 `https://github.com/<owner>/<repo>`만, 사용자 정보(토큰) 포함 URL 거부
- 받은 객체 fsck 검사(`transfer/fetch.fsckObjects`), 자격 증명 프롬프트 비활성화, 시간 제한(기본 600초), 크기 제한(기본 2GiB)
- 프로젝트 id 정규식 + 캐시 루트 밖 경로 거부, 기존 디렉터리는 같은 URL의 bare 저장소일 때만 재사용
- 비root(node), read-only rootfs, cap_drop ALL, no-new-privileges, 1GB / 1 CPU / 128 pids

```powershell
cd services\repo-sync; npx npm@11 ci; npm run build; npm test   # 6 tests (악성 hook·filter·submodule 포함 저장소로 검증)
```

## Private 저장소와 에이전트별 export (Phase D)

```powershell
# 1) 토큰 준비 후(아래), Controller를 overlay와 함께 재생성 → 인증된 Discovery/메타데이터
docker compose -f compose.yaml -f compose.workers.yaml -f compose.controller.yaml -f compose.github.yaml up -d --no-deps controller
# 2) 등록하면 authMode=token, enabled=false. 동기화 → 상태 기록 → export 갱신
powershell -ExecutionPolicy Bypass -File servicesepo-syncscriptssync-project.ps1 -ProjectId <id>
# 3) 확인 후 활성화하고 export 갱신
#    PATCH /projects/<id> { "enabled": true, "allowedAgents": ["claude"] }
powershell -ExecutionPolicy Bypass -File servicesepo-syncscriptsprovision-exports.ps1
```

- **토큰 전달 방식**: `--auth token`이면 `REPO_SYNC_TOKEN_FILE`(`/run/secrets/github_token`)에서 토큰을 읽습니다. 값은 `http.<origin>/.extraHeader`를 git의 환경변수 설정(`GIT_CONFIG_COUNT/KEY/VALUE`)으로 넘깁니다. 그래서 URL, 명령행 인자, 저장소 config, 출력 어디에도 남지 않습니다. 오류 메시지에서도 토큰과 base64 값을 제거합니다.
- **오류 코드**:
  - `auth_required`: 토큰 없음. 익명 접근으로 대체하지 않습니다.
  - `auth_failed`: 만료되었거나 잘못된 토큰
  - `not_found_or_no_access`: 접근 철회 또는 저장소 없음. 기존 미러는 유지됩니다.
  - `limit_exceeded`
- **제한 (환경변수)**: `REPO_SYNC_MAX_BYTES`(2GiB), `REPO_SYNC_MAX_CACHE_BYTES`(20GiB), `REPO_SYNC_MAX_FILE_BYTES`(100MB)
- **export 동작**: `repo-sync export --agent <a> --projects=<id,...>`는 그 에이전트 볼륨을 정확히 해당 목록으로 맞춥니다. 각 저장소는 독립 복사본으로 넣고, 목록 밖의 저장소는 삭제합니다. Worker는 자기 export만 `/repo-cache`로 읽기 전용 마운트합니다.
