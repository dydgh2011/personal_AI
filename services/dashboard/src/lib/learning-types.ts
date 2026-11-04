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

export interface LearningStatus {
  schemaVersion: number;
  counts: { domains: number; ideasInbox: number; goals: number; roadmaps: number; pendingProposals: number };
  ai: { provider: string; model: string | null; configured: boolean; missing: string[]; month: string; spentUsd: number; budgetUsd: number | null; calls: number };
}
