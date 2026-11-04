# 06 — Learning Dashboard specification

**기존 Next.js Admin Dashboard의 하위 메뉴 `/learning`**로 제공. 기존 로그인/세션/CSRF/BFF와 모바일 반응형 규칙을 재사용하고, 브라우저에서 내부 서비스 인증 토큰을 노출하지 않는다.

## Navigation

- Learning Overview `/learning`
- Roadmap Explorer `/learning/roadmaps/[id]`
- Milestones & Assignments `/learning/milestones`
- Skill Profile `/learning/skills`
- Planner `/learning/planner`
- Idea Inbox `/learning/ideas`

## L1 페이지 및 UI 동작

### Overview

활성 Domain/Goal, Roadmap 진행률(숙련도와 **분리**), 계속할 위치, 가까운 Milestone, 아이디어 최근 항목, 오늘의 예정/추천 학습 과제. 미구현 위젯은 N/A 표기, 가짜 수치 표시 금지.

### Idea Inbox

어느 화면에서나 빠른 등록, Domain/Project 태그, 상태/우선순위, 검색·수정·보관. 아이디어 등록은 자동 일정 등록이 아님.

### Roadmap Explorer

Stage/Topic/Skill/Milestone 노드 및 선수지식 Edge, 상태 배지, 확대/축소, 상세 Inspector, Draft vs Published, Graph edit, 변경 영향(diff)/버전 복원. React Flow 등 선택은 기존 bundle 크기와 유지보수 검토 후. 순환 연결 즉시 검증.

### AI Roadmap Generation flow

Goal → 현재 수준/주간 시간/장비/마감 입력 → 생성 중 상태 → Schema validation → Draft preview → 영향/추정치 확인 → Approve → Current Version. 실패 시 원본 불변, 오류 재시도 제공.

## L2/L3 페이지

- **Milestone Manager**: 과제, Rubric, fixed/proposed deadline, 제출물 버전, 재평가/피드백/근거.
- **Skill Profile**: 자가 수준 vs 검증 Level 0–4, 근거와 마지막 검증 시각, 취약 개념과 복습.
- **Planner**: 하루 과제 30–60분 단위 구체 활동, 여러 분야의 주간 배분, 예상/실제 시간, 사용자 fixed deadline 보호.

## 접근성 및 오류 상태

- PC/태블릿/390px 모바일 레이아웃, 키보드 탐색, 읽기 쉬운 그래프 대체 리스트, 색상 외 상태 텍스트.
- `loading / error / empty / draft / awaiting approval / conflict / archived` 명시.
- 버전 충돌(409), 순환 관계(422), 모델 출력 스키마 오류, API 예산 소진, 인증 만료 처리.
- 민감한 학습 내용은 `no-store`와 권한 검사; URL에 개인 정보나 토큰 포함 금지.
- 승인/영구 삭제는 CSRF 검증 및 사용자 확인을 거친다.

## 모듈 등록

현재 Dashboard의 `modules/registry` 구조를 확인해 Learning 네비게이션을 추가한다. 이것이 정적 메뉴 구성만 제공한다면 **런타임 플러그인 설치 시스템으로 과장하지 않는다**.
