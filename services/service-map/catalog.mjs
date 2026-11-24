// Hand-written part of the service map: what each service is for, and where it talks to the
// outside world. Everything else (networks, ports, volumes, links between services, live state)
// is read from Compose and Docker by collect.mjs, so it cannot drift from what actually runs.
//
// No URLs, keys or account names here: purposes only.

export const LAYERS = [
  { id: 'entry', label: '입구' },
  { id: 'gateway', label: '중개' },
  { id: 'core', label: '핵심 서비스' },
  { id: 'workers', label: '작업자' },
];

export const SERVICES = {
  dashboard: {
    title: 'Dashboard',
    layer: 'entry',
    description: '관리 화면. 로그인과 CSRF 보호 뒤에서 Controller, Learning, LLM 게이트웨이를 읽고 승인 결정을 기록한다.',
  },
  hermes: {
    title: 'Kelly (Hermes)',
    layer: 'entry',
    description: 'Discord에서 대화하는 비서. 다른 서비스는 hermes-broker의 정해진 명령으로만 부른다.',
    external: [{ name: 'Discord', purpose: 'Kelly 대화 봇' }],
  },
  'hermes-broker': {
    title: 'Hermes Broker',
    layer: 'gateway',
    description: 'Kelly가 쓸 수 있는 명령만 통과시키는 관문. 입력을 검사하고 감사 기록을 남기며, 서비스마다 따로 받은 키를 쓴다.',
  },
  'llm-gateway': {
    title: 'LLM 게이트웨이',
    layer: 'gateway',
    description: 'AI 호출을 한곳으로 모은다. 무료 경로를 먼저 쓰고 유료는 승인 후에만, 호출마다 토큰과 비용을 기록한다.',
    external: [{ name: 'AI 제공자', purpose: '무료·유료 모델 호출' }],
  },
  controller: {
    title: 'Task Controller',
    layer: 'core',
    description: '코딩 작업의 대기열과 상태, 프로젝트 목록, Diff 검토와 승인 기록을 가진다.',
  },
  planner: {
    title: '플래너',
    layer: 'core',
    description: '할 일과 일정. Kelly 전용 Google 캘린더와 맞추고 브리핑·알림 시각을 정한다.',
    external: [{ name: 'Google Calendar', purpose: 'Kelly 캘린더 읽기·쓰기' }],
  },
  knowledge: {
    title: '지식 저장소',
    layer: 'core',
    description: '주인에 대해 아는 것(원본, 활동, 페이지·사실, 프로필). 대화와 첨부는 원본으로 남는다.',
    external: [{ name: '호스트 Ollama', purpose: '검색용 임베딩(꺼져 있으면 키워드 검색)' }],
  },
  school: {
    title: '학교 연결',
    layer: 'core',
    description: 'Quercus, Piazza, UofT 메일, 과목 사이트에서 새 소식과 자료를 가져와 지식 저장소에 넣는다.',
    external: [{ name: '학교 사이트·메일', purpose: 'Quercus, Piazza, UofT 메일, 과목 사이트 읽기' }],
  },
  learning: {
    title: 'Learning OS',
    layer: 'core',
    description: '학습 분야, 아이디어, 로드맵 버전과 선수지식. AI 초안은 LLM 게이트웨이를 거친다.',
  },
  notifier: {
    title: '알림',
    layer: 'core',
    description: '다른 서비스가 보낸 알림을 Discord로 전한다.',
    external: [{ name: 'Discord', purpose: '알림 메시지 보내기' }],
  },
  'claude-worker': {
    title: 'Claude Worker',
    layer: 'workers',
    description: 'Controller에서 코딩 작업을 받아 Claude Code로 실행한다. Docker와 GitHub 권한은 없다.',
    external: [{ name: 'Claude 계정', purpose: '코딩 모델 호출' }],
  },
  'codex-worker': {
    title: 'Codex Worker',
    layer: 'workers',
    description: 'Controller에서 코딩 작업을 받아 Codex로 실행한다. Docker와 GitHub 권한은 없다.',
    external: [{ name: 'OpenAI 계정', purpose: '코딩 모델 호출' }],
  },
  'test-runner': {
    title: 'Test Runner',
    layer: 'workers',
    description: '작업 결과의 테스트를 격리된 곳에서 돌리고 결과를 Controller에 보고한다.',
  },
  'github-publisher': {
    title: 'GitHub Publisher',
    layer: 'workers',
    description: '승인된 작업을 GitHub에 올리는 서비스. 지금은 실제 게시가 꺼져 있다(시험 모드).',
    external: [{ name: 'GitHub', purpose: '게시(비활성)' }],
  },
};
