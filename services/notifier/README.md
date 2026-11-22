# Notifier (Discord)

시스템에서 **Discord에 메시지를 보낼 수 있는 유일한 서비스**다. 호출자는 정해진 형식(typed event)만 보낼 수 있고, 메시지 문구는 이 서비스의 템플릿([src/format.ts](src/format.ts))이 만든다. 그래서 호출자나 그 뒤에 있는 LLM이 임의의 문장을 봇 이름으로 게시할 수 없다.

```
controller ◀─(delegator 토큰, 조회만)── hermes-broker [task watcher] ──notify-internal──▶ notifier ──notify-egress──▶ discord.com webhook
```

## 이벤트
| type | 보내는 쪽 | 내용 |
|---|---|---|
| `task_finished` | hermes-broker (15초마다 확인) | Hermes가 만든 작업이 completed / failed / canceled가 되면 결과 요약, 변경 파일, 브랜치, PC 경로, 리뷰 링크 |

앞으로 브리핑·리마인더도 새 type으로 추가한다. 자유 텍스트 type은 만들지 않는다.

## 규칙
- 웹훅 URL은 `secrets/discord-webhook.url`(Docker secret)에만 있다. 로그·응답에 남기지 않는다. Discord 웹훅 형식이 아니면 시작을 거부한다.
- 멘션은 `DISCORD_MENTION_USER_ID` 한 명만 가능하다(`allowed_mentions`). `@everyone`은 울리지 않는다.
- 같은 `key`는 한 번만 보낸다(`notifier-data` 볼륨에 30일 보관). broker가 재시작해도 최근 2시간 안에 끝난 작업만 다시 보내고, notifier가 중복을 거른다.
- Discord가 실패하면 기록하지 않고 호출자에게 502/503을 돌려준다. broker는 다음 주기에 다시 시도한다.
- 분당 20건으로 제한한다.

## 설치
```powershell
node services/notifier/scripts/init-secrets.mjs
# secrets/notifier-broker.key(생성), secrets/notifier.env(멘션할 사용자 id, Hermes Discord 설정에서 가져옴)
# secrets/discord-webhook.url 은 소유자가 직접 만든다: Discord 채널 설정 → 연동 → 웹후크 → URL 복사 → 파일에 한 줄로
$F = "-f compose.yaml -f compose.workers.yaml -f compose.controller.yaml -f compose.github.yaml -f compose.dashboard.yaml -f compose.publisher.yaml -f compose.test-runner.yaml -f compose.learning.yaml -f compose.notifier.yaml -f compose.planner.yaml".Split(' ')
docker compose @F up -d --build --no-deps notifier hermes-broker
```

## 테스트
- `npm test` (Docker 빌드 중 실행): 1회 전달·중복 차단, 키 없는 호출 거부, 자유 텍스트·알 수 없는 필드 거부, Discord 실패 시 재시도 가능, 분당 제한, 템플릿(로그인 만료 안내, 2000자 제한, 코드블록 탈출 방지), 상태 파일 유지
- broker 쪽: `services/hermes-broker/src/watcher.test.ts`
