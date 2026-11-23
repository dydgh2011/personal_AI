# llm-gateway

AI 공급자 키(OpenAI Public·Private 프로젝트, Gemini, Groq)를 가진 **유일한 서비스**입니다. 다른 서비스는 자기 전용 키로 이 게이트웨이에 "용도 이름"을 보내고, 게이트웨이가 어느 공급자로 보낼지 정합니다. OpenAI 형식(`/v1/chat/completions`)을 그대로 받으므로 Hermes는 `provider: custom`으로 연결됩니다.

LiteLLM 대신 직접 만든 이유 (2026-11-23 결정):
- LiteLLM은 2026년에 공급망 공격을 두 번 당했습니다(1.82.7·1.82.8, 1.107.0. 1.107.0은 Docker 이미지까지 오염돼 AI 키를 훔쳐 갔습니다).
- 꼭 필요한 "무료 토큰 집계 후 80%에서 멈추기"와 "유료 전 주인 승인"이 LiteLLM 기본 기능에 없습니다.
- 세 공급자 모두 OpenAI 형식이라 작은 서비스로 충분합니다. 의존성 없음(node:sqlite).

## 용도 이름과 경로

| 용도 | 쓰는 곳 | 순서 |
|---|---|---|
| `kelly` | Kelly 대화·도구 | OpenAI Public `gpt-5.4-mini`(무료 한도 80%까지) → Gemini `gemini-3.5-flash-lite` 무료 → OpenAI Private `gpt-5.4-nano` **(그날 `/ai-paid on` 승인 시만)** |
| `kelly-aux` | 제목, 대화 압축, 학교 알림 요약 | Groq `gpt-oss-20b`(프롬프트 6천 토큰 이하) → Gemini 무료 → OpenAI Public `gpt-5.4-nano` |
| `batch` | learning 초안, 밤 정리 | Gemini 무료 → Groq |
| `private` | 민감한 내용 (주인이 직접 고를 때만) | OpenAI Private `gpt-5.4-nano` (승인 없이, 하루 상한 안에서) |

호출자 권한 (`src/config.ts`의 `CLIENT_RIGHTS`):

| 호출자 | 용도 | `/usage` | `/control/paid` |
|---|---|---|---|
| hermes | kelly, kelly-aux, private | ✓ | ✓ (`/ai-paid` 명령) |
| learning | batch, kelly-aux | | |
| school | kelly-aux, batch | | |
| dashboard | 없음 | ✓ | |

## 무료 한도 (2026-11-22 주인 계정에서 확인)

| 묶음 | 한도 | 멈추는 지점 | 날짜 기준 |
|---|---|---|---|
| OpenAI 공유 무료 (gpt-5.4-mini/nano 등) | 하루 250만 토큰 | 80% (200만) | UTC 자정 |
| Gemini 3.5 Flash-Lite 무료 | 하루 500회, 분당 15회, 분당 25만 토큰 | 96% (480회) | 태평양 시간 자정 |
| Groq gpt-oss-20b 무료 | 하루 20만 토큰, 분당 8천 토큰 | 90% | UTC |

- OpenAI 무료 한도를 넘는 요청은 **그 요청 전체가 정가**로 청구됩니다. 그래서 게이트웨이가 사용량을 직접 세고(응답의 `usage`), 요청 전에 "지금까지 + 이번 요청 추정 + 출력 여유 4,096"이 80%를 넘으면 그 경로를 건너뜁니다.
- 분당 한도에 걸린 429는 기다릴 시간이 20초 이하면 한 번 기다렸다가 다시 보내고, 아니면 다음 경로로 넘어갑니다.
- 한도에 가까워지면 Discord로 한 번 알립니다("다음 무료 경로로 넘어가요"). 무료가 모두 막히면 "/ai-paid on으로 오늘만 유료 허용"을 알리고, 승인이 없으면 Kelly는 쉽니다(429).
- 유료는 하루 상한 `LLM_PAID_DAILY_CAP_USD`(기본 $0.30)까지만 씁니다. OpenAI 결제의 자동 충전은 꺼져 있습니다(주인 확인).

## 공급자별 요청 다듬기 (실제 호출로 확인)

- 공급자마다 받는 필드만 보냅니다. Gemini는 `store`, `metadata`를 거부합니다.
- **Gemini 3는 도구 호출 기록마다 thought signature가 필요합니다.** 다른 모델이 만든 기록에는 Gemini가 허용하는 빈 표식(`skip_thought_signature_validator`)을 넣습니다.
- **gpt-5.4-mini/nano는 chat completions에서 도구와 `reasoning_effort`를 함께 쓸 수 없습니다.** 도구가 있으면 `reasoning_effort: none`으로 보냅니다.
- 스트림이면 `stream_options.include_usage`를 켜고, 마지막 사용량 조각을 읽어 기록합니다.
- `private`가 아닌 요청은 보내기 전에 비밀 정보(API 키, Discord 웹훅, Bearer 토큰, `비밀번호: ...`, Luhn 검사를 통과한 카드 번호)를 `[redacted:…]`로 바꿉니다.

## API (8094, 호스트 포트 없음, `Authorization: Bearer <호출자 키>`)

| 경로 | 내용 |
|---|---|
| `POST /v1/chat/completions` | OpenAI 형식. `model` = 용도 이름. 응답 헤더 `X-Gateway-Route`에 실제 경로 |
| `GET /v1/models` | 이 호출자가 쓸 수 있는 용도 이름 |
| `GET /usage?days=7` | 무료 묶음별 오늘 사용량, 유료 승인·지출, 일별 합계, 최근 오류 |
| `POST /control/paid` `{"enable": true\|false}` | 오늘(토론토 날짜) 유료 허용/끄기. hermes만 (Discord `/ai-paid`) |
| `GET /health` | 상태 |

기록(`/var/lib/llm-gateway/gateway.db`, 볼륨 `llm-data`): 호출마다 시간, 호출자, 용도, 공급자·모델, 결과, 토큰(캐시 포함), 비용(유료만), 정가 환산. 메시지 내용은 저장하지 않습니다.

## 설정

```powershell
node services\llm-gateway\scripts\init-secrets.mjs --import secrets\temp\AI_API_keys.txt   # 값은 출력 안 함
docker compose @F up -d --build --no-deps llm-gateway notifier hermes learning dashboard
```

- 공급자 키: `secrets/llm-openai-public.key`, `llm-openai-private.key`, `llm-gemini.key`(hermes.env의 `GEMINI_API_KEY`에서), `llm-groq.key`. 키를 바꾸면 `--replace`.
- 호출자 키: `secrets/llm-hermes.key`(+ Hermes용 `llm-hermes.env`), `llm-learning.key`, `llm-school.key`, `llm-dashboard.key`, `notifier-llm.key`.
- Hermes: `data/hermes/config.yaml`의 `model:`이 `default: kelly`, `provider: custom`, `base_url: http://llm-gateway:8094/v1`, `api_key: ${LLM_GATEWAY_KEY}`. 보조 작업(`auxiliary:`)은 `kelly-aux`.
- Discord 명령(코드가 처리하고 AI를 거치지 않음): `/ai-paid on|off|status`, `/ai-usage`.
- 대시보드: `/ai-usage` 페이지(읽기 전용).

## 테스트

```powershell
cd services\llm-gateway; npm ci; npm run build; npm test
```

Docker 빌드에서도 테스트가 돌고(12개), 실패하면 이미지가 만들어지지 않습니다.
