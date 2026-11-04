# 01 — Existing system audit & gap analysis

## 상태 근거 및 한계

이 문서는 사용자 대화에 공유된 Claude Code 작업 보고와 실제 사용자 브라우저 승인 결과를 참고한다. **소스 저장소 및 실행 중인 Docker 스택에 직접 접근하지 않았음**. 구현 사실을 코드·실제 동작·테스트로 L0에서 재확인해야 한다.

| 구성요소 | 보고 기반 상태 | Learning OS에서 재사용 | 주의 사항 / 검증 항목 |
|---|---|---|---|
| Hermes | Docker에서 Gemini 모델로 실행, Personal AI 전용 브로커와 도구 | 명령 해석, 학습 목표/계획 요청 진입점 | 현재 Hermes의 임의 파일/터미널 권한 제한 유지; Learning 전용 허용 도구 추가 필요 |
| NestJS Controller | 작업·리뷰·승인·역할·SQLite 마이그레이션 운영 | 작업 이벤트, 사용자 인증·서비스 접근 관리 패턴 | Learning 데이터를 Controller DB에 직접 섞을지 별도 저장할지 코드 근거로 결정 |
| Claude/Codex Worker | Git 별도 worktree에서 코딩 작업 실행/테스트 기록 | **코드 과제**의 제한된 실행에만 조건부 활용 | 학습 과제와 GitHub Publisher 승인 정책 혼합 금지; 새 작업 타입과 별도 ACL 필요 |
| Repository Registry / Sync | 공개 Repo 및 Private Repo용 설계, export 격리 | 프로젝트-학습 연결(참조) | 실제 Private Repo 접근 종단 검증은 아직 미완료 보고 |
| Publisher | 테스트 증거, Review, 별도 Publish Authorization; 실제 게시 기본 차단 | 기존 배포 정책 그대로 적용 | Learning 평가를 GitHub 게시 승인으로 사용하지 않음 |
| Admin Dashboard | Next.js 화면: Overview, Tasks, Projects, Code Reviews; 실제 브라우저 CSRF 수정 보고 | 로그인/BFF, 레이아웃, UI 패턴 | Learning 화면/권한은 새로 구현 필요; `modules/registry`는 정적 메뉴 구성일 수 있음 |
| Memory / Knowledge Graph | 장기 구상, 명확한 실제 구현 근거 없음 | 향후 연결 계약만 설계 | **존재한다고 가정하지 말 것** |
| Project Roadmap | `docs/ROADMAP.md`에 개발 단계 기록 보고 | Learning 로드맵과 링크 가능 | 프로젝트 로드맵은 개발 일정, Learning 로드맵은 지식/숙련도; 상태 및 데이터 모델 분리 |
| Personal Assistant / Calendar | 계획 상태 | 향후 일정 연동 | L1 필수 아님 |
| JARVIS TTS | Windows 로컬 TTS 사용 경험 보고 | 향후 음성 알림 | L1 필수 아님 |
| Quest Android | 별도 앱 기획 | 향후 공개된 Learning API와 연결 | 현재 구현 여부와 API 실제 상태를 확인할 것 |

## 기존 기획과 충돌할 수 있는 지점

1. Hermes 도구 최소 권한 vs Learning OS 자연어 CRUD: 임의 셸을 복구하지 말고 **Learning Broker의 제한된 동작**을 추가.
2. Controller 작업/리뷰 상태 vs Learning 마일스톤/평가 상태: 같은 `completed/approved` 문자열이라도 의미가 다르므로 엔티티를 분리.
3. Publisher 테스트 증거 vs 숙련도 증거: Test Runner의 코드 테스트 결과는 학습 평가의 **한 근거**일 뿐 숙련도를 자동 확정하지 않음.
4. Learning Graph vs 개인 Knowledge Graph: Learning 내부 선수지식 DAG를 우선 구축하고 범용 개인 Graph는 나중에 링크; 중복 저장 회피.
5. AI 생성 초안 vs 사용자 승인: 일정·로드맵/마감일 변경은 변경안을 저장하고 사용자 승인 전까지 원본 유지.
6. Docker/토큰/ACL: 보고된 Windows `secrets` ACL 문제와 Private Repository 검증 미완료 항목은 별도 보안 과제로 유지.

## L0에서 수집할 실제 증거

- `git status --short`, `docs/ROADMAP.md`, Compose 오버레이 목록 및 실행 서비스/네트워크/볼륨(비밀값 제외)
- Controller 실제 API/인증·마이그레이션 및 Dashboard BFF 모듈 구조
- Hermes native tool와 Broker API 허용 목록, 현재 Provider 설정
- 코드 실행/리포트 구조, DB 백업/복원 절차
- 기존 Learning 관련 모듈·테이블이 우연히 존재하는지 여부

L0 결과: **Reuse / Modify / Build / Postpone** 4열 표와 파일 단위 변경 계획을 사용자에게 제출.
