# knowledge

주인(사용자)에 대한 모든 것을 쌓아 두는 지식 저장소입니다. 목표는 "말하지 않아도 AI가 알고 있는 것"입니다. LLM 없이 정해진 코드로만 동작하고, Hermes(Kelly)는 broker를 거쳐 정해진 도구(`personal_ai_knowledge`)와 메모리 제공자 플러그인(`personal-ai-knowledge`)으로만 씁니다.

## 4층 구조

| 층 | 무엇 | 누가 쓰나 | 바뀌나 |
|---|---|---|---|
| 0 원본 (`raw_items`) | 모든 대화 한 턴, 첨부 문서(원본 파일 + 뽑은 텍스트), 메모 | 자동 (Hermes 메모리 제공자), `note` | **절대 안 바뀜** (DB 트리거로 수정·삭제 차단) |
| 1 활동 기록 (`activities`) | 언제, 무엇을, 몇 분, 결과, 느낌, 관련 문서 | Kelly `activity_add` | 고치기·숨기기 가능, 기록 남음 |
| 2 위키 문서 (`pages`, `facts`, `links`) | 주제마다 한 장: 요약 + 날짜·출처가 있는 사실 + 다른 문서 링크 | Kelly `page_save`, `fact_add`, `fact_change`, `link` | 사실을 고치면 옛 사실은 `superseded`로 남음 |
| 3 프로필 | `me` 문서(나에 대한 요약과 사실) + 문서 목록 | Kelly | Hermes 시스템 프롬프트에 짧게 들어감 |

모든 변경은 `change_log`에 누가(hermes / operator), 무엇을, 이전 값과 이후 값까지 남습니다.

### 고치기와 지우기

| 요청 | 방법 | 남는 것 |
|---|---|---|
| "틀렸어, 이렇게 바꿔줘" | `fact_change`, `activity_change`, `page_save` | 옛 값은 기록에 남음 |
| "지워줘" (기본) | `remove`/`archived`: 검색·회상에서 숨김 | 기록에 남음 |
| "완전히 지워줘" | `purge` (원본·사실·활동·문서): 행, 검색 조각·벡터, 사실의 옛 버전, 원본 파일, 변경 기록의 내용까지 삭제 | 이유만 적힌 묘비(tombstone) |

원본(0층)은 평소 DB 트리거로 수정·삭제가 막혀 있고, `purge` 코드만 같은 트랜잭션 안에서 허용 목록(`purge_allow`)에 넣어 지울 수 있습니다. Kelly는 주인의 명시적인 OK(`confirmed_by_user`) 없이는 purge를 보내지 못합니다.

문서 종류: course, topic, goal, project, person, habit, place, org, other (+ `me`).
활동 종류: study, class, assignment, exam, project, coding, reading, experiment, exercise, chore, errand, social, work, rest, health, other.

## 검색

- **키워드**: SQLite FTS5. 단어 앞부분 검색이라 "CSC263은", "헬스를"처럼 조사가 붙어도 찾습니다(질문 쪽 조사도 떼어 냅니다).
- **의미**: Ollama(이 PC)의 `bge-m3`로 만든 1024차원 벡터를 int8로 압축해 sqlite-vec(`vec_items`)에 저장하고, 가까운 300개를 C 코드로 찾습니다(수십만 조각까지). 새 항목은 몇 초 안에 백그라운드에서 벡터가 만들어집니다. Ollama가 꺼져 있으면 키워드 검색만 합니다.
- 두 결과를 순위 기준(RRF)으로 합칩니다. 원본은 1,200자 조각으로 나눠 검색하고, 한 원본은 결과에 한 번만 나옵니다.
- **자동 회상** (`/recall`): Kelly가 답하기 전에, 메시지와 분명히 관련된 문서·사실·활동만 최대 6줄(약 1,000자) 붙입니다. 키워드가 맞거나 의미 유사도가 0.5 이상일 때만이고, 관계없는 메시지에는 아무것도 붙지 않습니다.

## Hermes 연결 (`services/hermes-integration/plugins/personal-ai-knowledge`)

Hermes의 메모리 제공자(`memory.provider: personal-ai-knowledge`, `data/hermes/config.yaml`)로 연결됩니다. Hermes 내장 메모(MEMORY.md / USER.md)는 그대로 쓰이고, 이 저장소가 그 옆에 붙습니다.

- `sync_turn`: 대화 한 턴이 끝나면 원본으로 저장 (같은 턴은 한 번만). 메시지에 첨부 파일 경로가 있으면 원본 파일과 텍스트도 저장.
- `prefetch`: 답하기 전 자동 회상.
- `system_prompt_block`: 사용 규칙 + 프로필 + 문서 목록.
- 저장 전에 비밀번호, API 키, 토큰, Discord 웹훅 주소 같은 것은 `[redacted:…]`로 바꿉니다.
- 하위 에이전트, cron 실행은 저장하지 않습니다.

## API (8092, 호스트 포트 없음, `X-Knowledge-Key`)

| 경로 | 내용 |
|---|---|
| `GET /status` | 개수, 벡터 수, 의미 검색 모델 |
| `POST /raw`, `POST /raw/document`, `GET /raw`, `GET /raw/:id` | 원본 저장·목록·읽기 (긴 원본은 8천 자씩) |
| `GET /pages`, `POST /pages`, `GET /page?ref=` | 문서 목록·만들기/고치기·보기 |
| `POST /facts`, `POST /facts/:id` | 사실 추가, 고치기(옛 사실 보존)/빼기 |
| `POST /links` | 문서 연결/해제 |
| `POST /activities`, `POST /activities/:id`, `GET /timeline` | 활동 기록 |
| `GET /profile`, `GET /search`, `GET /recall`, `GET /graph`, `GET /changes` | 프로필, 검색, 자동 회상, 그래프(대시보드용), 변경 기록 |
| `POST /purge` | 영구 삭제 (위 표) |
| `GET /raw/by-sha/:sha`, `POST /raw/file` | **운영자 전용**: 대량 가져오기 (중복 확인, 이미 blob 폴더에 복사된 파일 등록 + 크기·해시 재확인) |

`/graph`는 문서를 점으로, 링크와 "같은 활동에 함께 나온 문서"를 선으로 돌려줍니다(그래프 뷰 단계에서 사용).

## 구성과 보안

- 네트워크: `knowledge-internal`(broker와만), `knowledge-egress`(이 PC의 Ollama, `host.docker.internal:11434`).
- **저장 위치 (모두 D:)**: 원본 파일은 `data/knowledge/blobs/<sha256>.<확장자>`(호스트 폴더), DB는 `knowledge-data` 볼륨(Docker Desktop의 디스크 이미지 위치를 D:로 둬야 D:에 있음), 가져올 자료는 `data/knowledge-inbox/`.
- Hermes의 첨부 폴더(`data/hermes/cache/documents`)만 읽기 전용으로 마운트합니다. Hermes의 다른 파일(.env, auth.json 등)은 보이지 않습니다. 첨부 폴더가 Hermes 사용자 전용(0700)이라 이 서비스도 같은 uid 10000으로 돕니다(root 아님).
- 같은 내용의 파일은 원본을 한 번만 저장합니다(채팅 첨부와 가져오기 사이에도).
- 읽기 전용 루트 파일시스템, 권한 전부 제거, no-new-privileges.

## 설정

```powershell
node services\knowledge\scripts\init-secrets.mjs      # knowledge-broker.key, knowledge-operator.key
docker compose @F up -d --build --no-deps knowledge hermes-broker hermes
```

`data/hermes/config.yaml`의 `memory:` 아래에 `provider: personal-ai-knowledge`가 있어야 합니다. 확인: `docker exec personal_ai-hermes-1 hermes memory status`.

## 대량 가져오기와 Claude Code (운영자)

`compose.knowledge-operator.yaml`을 compose 파일 목록에 넣은 동안에만 열립니다.

```powershell
$F += '-f','compose.knowledge-operator.yaml'
docker compose @F up -d --no-deps knowledge
# 1) 자료를 data\knowledge-inbox\ 에 넣고 (폴더, zip, ChatGPT/Claude 내보내기 zip 그대로)
docker compose @F --profile tools run --rm knowledge-importer scan            # 전체
docker compose @F --profile tools run --rm knowledge-importer scan courses\STA256 --dry-run
# 2) Claude Code가 정해진 명령으로 정리
node services\knowledge\scripts\kb.mjs help
```

- 가져오기(`services/knowledge-importer`): 파일마다 해시 → 이미 있으면 건너뜀(다시 돌려도 이어서 진행) → 원본을 blob 폴더에 복사 → 텍스트 추출(PDF, DOCX, PPTX 슬라이드·노트, XLSX, ipynb, HTML, 코드·텍스트) → 등록. zip은 안의 파일을 하나씩. 이미지는 OCR, 영상·음성은 받아쓰기 대기(`pending`)로 원본만 보관.
- ChatGPT/Claude 내보내기(`conversations.json`): 대화 하나 = 원본 1건(`chatgpt-conversation`, `claude-conversation`), Claude 프로젝트 문서도 1건씩. 내보내기 파일 자체도 원본으로 보관. 메모리 항목은 바로 사실로 넣지 않고 Claude Code가 확인해서 넣습니다.
- `kb.mjs`: `search`, `page`, `pages`, `timeline`, `raw-list`, `raw`, `page-save`, `fact-add`, `fact-change`, `link`, `activity-add`, `activity-change`, `note`, `purge`(`--yes` 필요), `changes`. 본문은 `--json` 또는 `--file`(배열이면 항목마다 한 번).
- 끝나면 `compose.knowledge-operator.yaml`을 빼고 `up -d --no-deps knowledge`로 닫습니다.

## 아직 없는 것 (다음 단계)

- 매일 밤 정리(그날 원본 → 활동·사실 추출 → 일간/주간 요약): 지금은 Kelly가 대화 중에 바로 저장합니다.
- 이미지 OCR, 강의 영상·음성 받아쓰기(로컬 whisper), 판만 다른 파일 묶기.
- 숙련도 모델(`docs/knowledge/LEARNING_MODEL.md`), 대시보드 그래프 뷰, 학교 서비스 수집.

## 테스트

```powershell
cd services\knowledge; npm ci; npm run build; npm test
```

Docker 빌드에서도 테스트가 돌고, 하나라도 실패하면 이미지가 만들어지지 않습니다.
