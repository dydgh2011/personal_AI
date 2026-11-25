# Kelly 지식 정리와 미디어 처리 검증 인계

2026-11-25 기준으로 Kelly의 일간·주간 정리, 활동 기록, 이미지 OCR, 강의 음성·영상 받아쓰기를 구현했다. 변경은 `codex/kelly-knowledge-media` 작업 브랜치의 작업 디렉터리에 있다. 기준 커밋은 `dfae0a4`이며 변경 파일을 검토할 때는 아래 worktree에서 `git status --short`와 `git diff`를 실행한다.

```text
C:\Users\dydgh\.codex\worktrees\kelly-knowledge-media\personal_ai
```

## 동작과 변경 파일

- `services/knowledge/src`의 `db.ts`, `knowledge.ts`, `main.ts`, `review.ts`, `media.ts`, `knowledge.test.ts`와 `services/knowledge/README.md`. Toronto 시간 `00:15`부터 전날 기록을 정리한다. 마지막으로 끝난 월요일~일요일은 주간 정리에서 조회한다. 대화에서 실제로 끝냈다고 보고한 공부·운동 등을 활동으로 기록하고 원본을 연결한다. `사실 [CSC207]: 시험은 강의실에서 본다`처럼 명시한 사실은 기존 주제 페이지에 연결한다. 보고된 활동이나 사실이 나중에 수정되면 정리 조회에 반영된다.
- `services/knowledge-media`의 `.dockerignore`, `Dockerfile`, `worker.py`, `test_worker.py`, `README.md`와 `compose.knowledge.yaml`. 별도 컨테이너가 읽기 전용 원본을 Tesseract로 OCR하고 FFmpeg와 whisper.cpp로 영상·음성의 받아쓰기를 만든다. 컨테이너는 네트워크 없이 실행하며 전용 Unix 소켓으로 결과를 돌려준다. 지식 DB v4는 원본과 별도로 처리 결과를 보관하고 같은 원본 ID로 검색에 연결한다. 최대 크기, 처리 시간, 모델 설치 경로는 서비스 README에 있다.
- `services/hermes-integration`의 지식 플러그인 `__init__.py`·`knowledge_client.py`, `skills/personal-ai-knowledge/SKILL.md`, `tests/test_knowledge.py`. Kelly가 `review`로 일간·주간 정리를 열고 `media_submit`으로 첨부를 접수한다. `raw`로 같은 ID의 처리 상태·내용을 읽는다. 기존 broker 지식 경로를 사용한다. 같은 유형의 최근 첨부가 여러 개면 파일 선택이 필요하다.
- `services/service-map`의 `catalog.mjs`, `collect.mjs`, `network-mode.test.mjs`. `network_mode: none`인 컨테이너를 기본 Compose 네트워크에 속하지 않는 것으로 표시한다.

## 검증 결과

| 검증 | 결과 |
| --- | --- |
| Knowledge Docker 이미지 | TypeScript 빌드 및 테스트 39/39 통과. 동시 첨부 중복 방지, Toronto 날짜 경계, v3 가져오기 호환, 원본 보존을 포함했다. |
| 미디어 처리 Docker 이미지 | 이미지 빌드와 작업자 테스트 4/4 통과. 파일 내용을 확인해 이미지 형식을 검증한다. |
| 격리 Hermes 이미지와 호스트 | 전체 Python 테스트 96/96 통과. 변경한 지식 플러그인의 호스트 테스트도 35/35 통과했다. |
| 서비스 지도와 기존 가져오기 도구 | 서비스 지도 23/23, 가져오기 도구 5/5 통과. |
| 실제 엔진과 지식 API 연결 | 네트워크 `none`인 Docker 컨테이너 두 개에서 한·영 PNG, WAV, MP4를 지식 API로 접수했다. OCR 글자, 영상 음성 트랙의 타임스탬프, 음성 받아쓰기와 키워드 검색을 확인했다. 이미지는 합성 슬라이드였고, 음성은 공개 영어 샘플이었다. 받아쓰기는 격리 환경의 다국어 tiny 모델로 실행했다. |
| 실제 지식 서비스 시작 | 임시 SQLite DB의 스키마가 v3에서 v4로 올라갔다. 서비스 시작 시 일간·주간 정리, 원본에 연결된 30분 운동 1건, 사실 1건을 확인했다. 미디어 세 건의 원본과 저장된 추출 결과를 각각 확인했다. |
| 운영 Docker 읽기 전용 확인 | `scripts\stack.ps1 ps`에서 `personal_ai` 컨테이너 14개가 실행 중이었다. 후보 구성에서 기존 서비스 연결 21개, 브리지 네트워크, 포트 바인딩, 주소 여유 2개가 유지됐다. 새 처리 서비스에는 네트워크, 호스트 포트, 자격 증명 마운트가 없다. |

공유 체크아웃과 후보의 기존 `verify-networks`는 모두 10/11이었다. 기존 `controller ↔ hermes` 상태 확인을 미사용 연결로 셌고, 그 수가 `1 → 1`이면 실패하는 비교였다. 같은 전후 구성을 작업 B의 `6b9e323`에 들어 있는 비교 함수로 검증했을 때는 11/11이었다.

격리 검증을 다시 실행할 때는 작업 폴더에서 다음 명령을 순서대로 사용한다. 실제 OCR·받아쓰기 확인에는 새 임시 DB, 한·영 텍스트를 그린 PNG, 공개 WAV 및 그 음성을 넣어 만든 짧은 MP4를 사용한다. [공개 WAV 샘플](https://raw.githubusercontent.com/ggml-org/whisper.cpp/v1.8.3/samples/jfk.wav)

```powershell
docker build -t personal-ai-knowledge:codex-media-verify services/knowledge
docker build -t personal-ai-knowledge-media:codex-verify services/knowledge-media
node --test services/service-map/collect.test.mjs services/service-map/network-mode.test.mjs
python -B -m unittest discover -s services/knowledge-importer/tests
$repository = (Get-Location).Path
docker run --rm --network none --mount "type=bind,source=$repository/services/hermes-integration,target=/integration,readonly" --entrypoint python3 personal_ai-hermes:local -B -m unittest discover -s /integration/tests
```

실제 엔진을 확인할 때는 테스트용 Knowledge와 미디어 컨테이너를 `--network none`으로 실행하고, 임시 원본 폴더와 Unix 소켓 볼륨을 두 컨테이너에서 공유한다. 테스트 키로 `POST /raw/document`에 표의 첨부 세 건을 접수한다. `GET /raw/:id`가 `complete`를 반환하면 본문과 타임스탬프를 확인하고 `GET /search`의 결과가 같은 원본 ID인지 확인한다. 테스트 DB에서 `schema_version`, `raw_items`와 `media_extractions`를 확인한다.

한·영 합성 PNG, 공개 WAV·MP4, 테스트 모델은 `C:/Users/dydgh/AppData/Local/Temp/pai-knowledge-media-test-5c75c388a6e7473e8e633286061623b5`에 있다. 임시 파일 삭제 명령은 자동 정책에 의해 차단됐다. 검증 컨테이너는 종료됐다.

## 운영 반영과 확인

1. 주인이 작업 커밋·공유 브랜치 반영·push 및 운영 적용을 승인하면 `CODEX_PLAN.md` 2절 4번의 스택 잠금 절차를 사용한다. 기존 네트워크 검증의 `1 → 1` 실패는 작업 B의 비교 수정과 함께 해결 여부를 확인한다.
2. 강의 받아쓰기를 운영에서 사용하려면 주인이 다국어 base 모델을 `D:\personal_ai\data\knowledge\models\ggml-base.bin`에 둔다. 2026-11-25 경로 확인에서 파일이 없었다. OCR은 모델 파일 없이 작동한다. [공식 모델 파일](https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin)
3. `D:\personal_ai`의 승인된 스택 잠금에서 `scripts\stack.ps1 backup knowledge`로 백업한다. `rebuild knowledge-media`, `rebuild knowledge`, `restart hermes`를 순서대로 실행한 뒤 `ps`와 `verify-networks`를 확인한다.
4. 실제 Discord에서 개인정보가 없는 이미지, 짧은 강의 음성·영상을 하나씩 올려 보고 접수·상태·본문·검색을 확인한다. 완료 활동 보고와 다음 Toronto `00:15` 이후의 정리 조회를 확인한다. 운영 DB 마이그레이션, 실제 Discord, 운영 base 모델과 다음 정기 실행은 검증 대기 상태다. 운영 확인 후 담당자가 ROADMAP 19절의 해당 항목을 갱신한다.
