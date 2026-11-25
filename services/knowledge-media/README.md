# 로컬 OCR과 강의 받아쓰기

지식 저장소에 보관된 이미지·음성·영상의 글자를 뽑아 같은 원본 항목에 연결한다. Tesseract는 한국어·영어를 함께 읽는다. FFmpeg는 영상의 첫 번째 음성 트랙을 추출하고, whisper.cpp는 언어를 감지해 원어와 타임스탬프를 기록한다. 원본 파일과 원본 DB 행은 그대로 보관되고, 결과는 지식 저장소 검색과 Kelly의 `raw` 조회에서 읽을 수 있다. [Tesseract](https://tesseract-ocr.github.io/tessdoc/Command-Line-Usage.html) · [whisper.cpp](https://github.com/ggml-org/whisper.cpp)

## Kelly에서 사용

- Discord에 이미지를 올리고 글자를 읽어 달라고 요청한다. 강의 파일은 올린 뒤 받아쓰기를 요청한다. Kelly의 `media_submit`은 첨부 원본을 저장하고 조회에 사용할 ID를 받는다. 같은 종류의 최근 파일이 여러 개면 파일을 고른다.
- 지식 가져오기로 이미 등록된 `pending:ocr`·`pending:transcription` 파일과 새 파일은 지원 형식에 해당하면 자동으로 한 건씩 처리한다. 강의 파일은 대기 및 처리 시간이 길 수 있다. Kelly에게 같은 파일의 상태나 받아쓰기 내용을 다시 물어볼 수 있다.
- 상태는 `pending`, `waiting_model`, `retrying`, `complete`, `empty`, `failed`다. 사람이 검토해야 할 글자나 소리 인식 오류가 있을 수 있다. 이미지 최대 50MB, 음성·영상 최대 4GB·3시간이다. 한 작업의 받아쓰기 시간 제한은 1시간이다.
- OCR은 PNG, JPEG, GIF, WebP, BMP, TIFF를 지원한다. 강의 음성은 WAV, MP3, M4A, AAC, FLAC, Ogg, Opus를, 영상은 MP4, MOV, MKV, AVI, WebM, M4V, WMV를 지원한다.

## 운영에 적용

1. 소유자가 [whisper.cpp의 다국어 base 모델](https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin)을 다운로드한다. 다운로드가 끝난 파일을 `D:\personal_ai\data\knowledge\models\ggml-base.bin`에 둔다. OCR은 바로 사용할 수 있다. 음성·영상은 모델이 들어오기 전 `waiting_model`로 보인다.
2. 승인된 스택 잠금에서 원본 `D:\personal_ai`의 `scripts\stack.ps1 backup knowledge`로 운영 DB를 백업한다. `rebuild knowledge-media`와 `rebuild knowledge`를 차례로 실행하고, Hermes의 새 도구 코드를 읽도록 `restart hermes`를 실행한다.
3. `scripts\stack.ps1 ps`에서 서비스 상태를 확인한 뒤, 개인정보가 없는 이미지와 짧은 음성으로 Kelly의 접수와 조회를 확인한다. `waiting_model`로 보이면 지정된 모델 경로를 확인한다.

새 처리 컨테이너는 네트워크와 서비스 자격 증명이 분리돼 있다. 읽기 전용 원본·모델 폴더와 전용 Unix 소켓을 사용하고, 임시 오디오와 자막은 컨테이너의 메모리 파일시스템에 둔다. 지식 서비스만 DB와 검색 색인을 갱신한다.

## 테스트

```powershell
python -B -m unittest discover -s services/knowledge-media
docker build -t personal-ai-knowledge-media:verify services/knowledge-media
```
