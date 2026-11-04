# 08 — Security, verification, operations

## 신뢰 경계

- **사용자 업로드/외부 URL/로드맵:** 불신 입력. HTML/PDF/Markdown 내 도구 실행 지시는 따르지 않음; 파일 제한/검역/제한된 파싱.
- **AI 출력:** 비검증 제안. 구조화 스키마 + 도메인 검사 + 사용자 승인 후만 mutation.
- **Hermes/Broker:** 기존 권한 축소 원칙 유지. Learning 권한 추가는 URL allowlist, actor, 사용량/호출량 제한 및 감사 로그 포함.
- **평가 코드:** 일반 학습 데이터와 격리. 제출 코드를 실행할 때 Docker/VM sandbox, 네트워크 차단, 서명 키·GitHub 자격 차단, 자원/시간 제한.
- **개인 민감 데이터:** 시간·학업·개인 상황·Mood는 AI의 확정 사실로 저장하지 말 것. 출처, 동의, 편집/삭제, 접근 권한 분리.
- **로그/백업:** 비밀값과 전체 제출물을 로그에 담지 않음. 백업 암호화 및 복원 테스트.

## 핵심 회귀 테스트 매트릭스

| ID | 검증 | 실패 시 처리 |
|---|---|---|
| T01 | AI JSON malformed/누락 필드 | Draft 거부, 원본 그대로 |
| T02 | 선수지식 A→B→C→A | 422, RoadmapVersion 미변경 |
| T03 | 2명이 같은 baseVersion 승인 | 하나만 성공, 409 |
| T04 | 버전 복원 | 새 버전 생성, 과거 Submission/Evidence 보존 |
| T05 | 컨테이너 재시작/DB 백업 복원 | 로드맵·평가·일정 원상 복원 |
| T06 | API 타임아웃/429 | 상태 보존, 제한된 재시도 |
| T07 | 다른 사용자/서비스 토큰 | 401/403, 오브젝트 ID 간접 접근 차단 |
| T08 | 허용되지 않은 GitHub/Publisher 호출 | 차단, 감사 기록 |
| T09 | 평가용 코딩 제출에서 /run/secrets 읽기 | sandbox에서 차단 |
| T10 | 마감일 지난 뒤 자동 계획 | user-fixed date는 유지, 제안만 저장 |
| T11 | 자가평가만 있고 검증 없음 | Verified Mastery는 미검증 표시 |
| T12 | 제출된 자료 안 prompt injection | 시스템 명령 수행 없음 |
| T13 | Dashboard CSRF/session 및 모바일 | 기존 인증/CSRF 회귀 유지 |
| T14 | 시험·실험 평가 실패 | 평가 job 실패 이력만 추가, 원래 제출 보존 |

## 운영

- L1부터 최소 healthcheck/ready/DB migration/backup and restore/metrics를 포함한다.
- AI 호출당 provider/model/prompt version/token·비용 기록, 월별 상한 및 수동 fallback.
- Scheduler의 timezone 명시; DST 영향을 받는 마감일 처리 테스트.
- Import 시 자료 원문과 checksum, 출처 및 AI 추가 내용의 구분 유지.
- 데이터 주인은 사용자; 다른 AI들이 학습 데이터 전체를 자동으로 읽지 못하도록 scope 경계 적용.
- Domain별 진척/숙련/실제시간을 각각 보여주며 의미 없는 단일 '학습 점수'를 만들지 않는다.
