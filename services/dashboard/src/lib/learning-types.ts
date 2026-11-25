/** Shapes of the learning service API as the dashboard uses them. */
export const DOMAIN_STATUSES = ['exploring', 'planned', 'active', 'paused', 'maintaining', 'archived'] as const;
export const IDEA_STATES = ['inbox', 'triaged', 'promoted', 'archived'] as const;
export const IDEA_PRIORITIES = ['low', 'normal', 'high'] as const;
export const GOAL_STATUSES = ['active', 'paused', 'achieved', 'abandoned'] as const;

export interface Domain {
  id: string;
  parentId: string | null;
  title: string;
  description: string | null;
  status: (typeof DOMAIN_STATUSES)[number];
  priority: number;
  createdAt: string;
  updatedAt: string;
}

export interface Idea {
  id: string;
  text: string;
  domainIds: string[];
  projectIds: string[];
  priority: (typeof IDEA_PRIORITIES)[number];
  state: (typeof IDEA_STATES)[number];
  source: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface Goal {
  id: string;
  domainId: string;
  title: string;
  target: string | null;
  targetLevel: number | null;
  constraints: { weeklyMinutes?: number; deadline?: string; priorKnowledge?: string; equipment?: string };
  status: (typeof GOAL_STATUSES)[number];
  createdAt: string;
  updatedAt: string;
}

export interface RoadmapNode {
  key: string;
  type: 'stage' | 'topic' | 'skill' | 'milestone';
  title: string;
  description: string | null;
  estimateMinutes: number | null;
  parentKey: string | null;
  skill: string | null;
  resources: Array<{ title: string; url: string | null; provenance: 'user' | 'imported' | 'ai_suggested' }>;
}

export interface RoadmapContent {
  nodes: RoadmapNode[];
  edges: Array<{ from: string; to: string }>;
}

export interface Roadmap {
  id: string;
  goalId: string;
  title: string;
  status: 'active' | 'archived';
  currentVersionId: string | null;
  currentVersion: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface RoadmapDetail {
  roadmap: Roadmap;
  current: { version: number; content: RoadmapContent } | null;
}

export interface RoadmapVersion {
  id: string;
  roadmapId: string;
  version: number;
  contentHash: string;
  proposalId: string;
  approvedBy: string;
  approvedAt: string;
}

export interface Proposal {
  id: string;
  roadmapId: string;
  source: 'ai' | 'user' | 'restore' | 'import';
  baseVersionId: string | null;
  state: 'invalid' | 'awaiting_user_approval' | 'applied' | 'rejected';
  payload: unknown;
  validationErrors: string[];
  input: unknown;
  provider: string | null;
  model: string | null;
  promptVersion: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  createdBy: string;
  createdAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
  appliedVersionId: string | null;
}

export interface ProposalDiff {
  proposal: Proposal;
  stale: boolean;
  currentVersionId: string | null;
  diff: {
    nodes: {
      added: Array<{ key: string; title: string; type: string }>;
      removed: Array<{ key: string; title: string; type: string }>;
      changed: Array<{ key: string; fields: Array<{ field: string; from: unknown; to: unknown }> }>;
    };
    edges: { added: Array<{ from: string; to: string }>; removed: Array<{ from: string; to: string }> };
    nodeCount: { from: number; to: number };
    estimateMinutes: { from: number; to: number };
    unchanged: boolean;
  } | null;
}


export type SchedulePeriod = 'day' | 'week';
export interface ScheduleWindow { weekday: number; start: string; end: string }
export interface ScheduleItem {
  id: string;
  kind: 'assignment' | 'review';
  title: string;
  domain: string | null;
  deadline: string | null;
  dueDate: string | null;
}
export interface ScheduleBlock extends ScheduleItem {
  start: string;
  end: string;
  minutes: number;
}
export interface ScheduleDay {
  date: string;
  availableMinutes: number;
  plannedMinutes: number;
  blocks: ScheduleBlock[];
}
export interface ScheduleReview extends ScheduleItem {
  kind: 'review';
  dueDate: string;
  verifiedDate: string;
  minutes: number;
  method: 'practice' | 'revalidate';
}
export interface StudyPlan {
  date: string;
  period: SchedulePeriod;
  timeZone: 'America/Toronto';
  availability: { windows: ScheduleWindow[]; isDefault: boolean };
  calendar: 'connected' | 'disconnected' | 'unconfigured' | 'unavailable';
  reviews: ScheduleReview[];
  days: ScheduleDay[];
  remaining: Array<ScheduleItem & { remainingMinutes: number }>;
}

export interface LearningStatus {
  schemaVersion: number;
  supportedSchema?: number;
  /** The L2 counts are absent while the learning service still runs L1 (schema 1). */
  counts: { domains: number; ideasInbox: number; goals: number; roadmaps: number; pendingProposals: number } & Partial<LearningStatusL2>;
  ai: { provider: string; model: string | null; configured: boolean; missing: string[]; month: string; spentUsd: number; budgetUsd: number | null; calls: number };
  codeExecution?: CodeExecution;
  uploadLimits?: UploadLimits;
}

// ---------------------------------------------------------------- L2

export const MILESTONE_STATUSES = ['planned', 'active', 'completed', 'archived'] as const;
export const ASSIGNMENT_KINDS = ['text', 'file', 'code', 'photo', 'experiment'] as const;
export const ASSIGNMENT_STATUSES = ['planned', 'available', 'submitted', 'evaluated', 'passed', 'revision_required', 'archived'] as const;
export const GAP_STATUSES = ['suggested', 'open', 'addressed', 'dismissed'] as const;
export const EVALUATION_STATUSES = ['pending', 'completed', 'failed'] as const;

export interface LearningStatusL2 {
  milestones: number;
  assignmentsOpen: number;
  awaitingEvaluation: number;
  awaitingDecision: number;
  assignmentsPassed: number;
  evaluationsFailed: number;
  skills: number;
  skillsVerified: number;
  skillsSelfOnly: number;
  gapsOpen: number;
  gapsSuggested: number;
}

export interface RubricCriterion {
  key: string;
  title: string;
  description: string | null;
  maxScore: number;
}

export interface RubricVersion {
  id: string;
  rubricId: string;
  version: number;
  criteria: RubricCriterion[];
  passingScore: number;
  maxScore: number;
  contentHash: string;
  createdBy: string;
  createdAt: string;
}

export interface Rubric {
  id: string;
  title: string;
  status: 'active' | 'archived';
  latestVersion: RubricVersion | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface Milestone {
  id: string;
  roadmapId: string;
  nodeKey: string | null;
  title: string;
  description: string | null;
  passingCriteria: string | null;
  rubricVersionId: string | null;
  skillIds: string[];
  weight: number;
  status: (typeof MILESTONE_STATUSES)[number];
  deadline: {
    fixed: string | null;
    fixedSetBy: string | null;
    fixedSetAt: string | null;
    suggested: string | null;
    suggestedSource: 'ai' | 'planner' | null;
    suggestedReason: string | null;
    suggestedAt: string | null;
  };
  assignments: { total: number; passed: number; open: number };
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface MilestoneProgress {
  weightTotal: number;
  weightCompleted: number;
  percent: number | null;
  milestones: number;
}

export interface Assignment {
  id: string;
  milestoneId: string;
  title: string;
  kind: (typeof ASSIGNMENT_KINDS)[number];
  instructions: string;
  rubricVersionId: string | null;
  definitionVersion: number;
  status: (typeof ASSIGNMENT_STATUSES)[number];
  decidedBy: string | null;
  decidedAt: string | null;
  decisionEvaluationId: string | null;
  submissions: number;
  latestSubmissionId: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface SubmissionFile {
  id: string;
  position: number;
  name: string;
  mediaType: string;
  category: 'text' | 'image' | 'pdf';
  size: number;
  sha256: string;
}

export interface Submission {
  id: string;
  assignmentId: string;
  revision: number;
  definitionVersion: number;
  body: string | null;
  note: string | null;
  contentHash: string;
  files: SubmissionFile[];
  submittedBy: string;
  submittedAt: string;
}

export interface CodeExecution {
  available: boolean;
  reason: string;
}

export interface UploadLimits {
  maxFileBytes: number;
  maxFiles: number;
  maxTotalBytes: number;
  maxBodyChars: number;
  extensions: string[];
}

export interface AssignmentDetail {
  assignment: Assignment;
  definitions: Array<{ version: number; title: string; kind: Assignment['kind']; instructions: string; rubricVersionId: string | null; createdBy: string; createdAt: string }>;
  submissions: Submission[];
  codeExecution: CodeExecution;
  uploadLimits: UploadLimits;
}

export interface CriterionScore {
  criterion: string;
  title: string;
  score: number;
  maxScore: number;
  rationale: string;
}

export interface Evidence {
  id: string;
  type: 'criterion_score' | 'excerpt' | 'owner_check' | 'reference';
  criterion: string | null;
  sourceRef: string;
  excerpt: string | null;
  hash: string | null;
  verified: boolean;
  score: number | null;
  note: string | null;
  limitations: string | null;
  createdAt: string;
}

export interface Evaluation {
  id: string;
  submissionId: string;
  assignmentId: string;
  assignmentTitle: string;
  revision: number;
  rubricVersionId: string | null;
  evaluatorType: 'ai' | 'owner';
  evaluator: string;
  status: (typeof EVALUATION_STATUSES)[number];
  outcome: 'meets_rubric' | 'below_rubric' | 'inconclusive' | null;
  scores: CriterionScore[];
  totalScore: number | null;
  maxScore: number | null;
  passingScore: number | null;
  feedback: string | null;
  confidence: number | null;
  limitations: string[];
  suggestions: {
    gaps?: Array<{ skill: string | null; title: string; description: string | null; gapId: string | null }>;
    levels?: Array<{ skill: string; skillId: string | null; level: number; rationale: string | null }>;
  };
  error: { code: string; message: string | null } | null;
  ai: { provider: string | null; model: string | null; promptVersion: string | null; inputTokens: number | null; outputTokens: number | null; costUsd: number | null } | null;
  evidenceCount: number;
  requestedBy: string;
  createdAt: string;
  completedAt: string | null;
}

export type EvaluationDetail = Evaluation & { evidence: Evidence[] };

export interface SkillMastery {
  self: { level: number; note: string | null; at: string } | null;
  verified: { level: number; at: string; by: string; evaluationId: string; confidence: number | null; ageDays: number; stale: boolean } | null;
}

export interface Skill {
  id: string;
  canonicalName: string;
  displayName: string;
  createdAt: string;
  mastery: SkillMastery;
  openGaps: number;
}

export interface Gap {
  id: string;
  skillId: string | null;
  title: string;
  description: string | null;
  source: 'owner' | 'ai';
  evaluationId: string | null;
  status: (typeof GAP_STATUSES)[number];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface SkillDetail {
  skill: Skill;
  history: Array<{ id: string; kind: 'self' | 'verified'; level: number; evaluationId: string | null; note: string | null; actor: string; at: string }>;
  gaps: Gap[];
  milestones: Array<{ id: string; title: string; roadmapId: string; status: string }>;
  freshDays: number;
}
