import 'server-only';
import { readSecret } from './server';
import type { Domain, Goal, Idea, LearningStatus, Proposal, ProposalDiff, Roadmap, RoadmapContent, RoadmapDetail, RoadmapVersion } from './learning-types';

export class LearningError extends Error {
  constructor(message: string, readonly status: number | null, readonly code: string | null = null, readonly details: unknown = null) {
    super(message);
  }
}

const settings = {
  url: (process.env.LEARNING_URL?.trim() || 'http://learning:3000').replace(/\/+$/, ''),
  tokenFile: process.env.LEARNING_TOKEN_FILE?.trim() || '/run/secrets/learning_token',
};

/** The dashboard's only way to reach the learning service. Server side; the token never reaches the browser. */
async function call<T>(method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown, approver?: string, timeoutMs = 10_000): Promise<T> {
  let token: string;
  try {
    token = readSecret(settings.tokenFile);
  } catch {
    throw new LearningError('Learning service token is not configured', null, 'NOT_CONFIGURED');
  }
  let res: Response;
  try {
    res = await fetch(settings.url + path, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(approver ? { 'X-Approver': approver } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      cache: 'no-store',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new LearningError('Learning service unreachable', null, 'UNREACHABLE');
  }
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    const d = (data ?? {}) as { message?: unknown; code?: unknown; details?: unknown };
    const message = Array.isArray(d.message) ? d.message.join('; ') : typeof d.message === 'string' ? d.message : `Learning service error ${res.status}`;
    throw new LearningError(message, res.status, typeof d.code === 'string' ? d.code : null, d.details ?? null);
  }
  return data as T;
}

const q = (params: Record<string, string | undefined>) => {
  const s = new URLSearchParams(Object.entries(params).filter(([, v]) => v) as [string, string][]).toString();
  return s ? `?${s}` : '';
};
const id = encodeURIComponent;

export const learning = {
  status: () => call<LearningStatus>('GET', '/status'),
  domains: () => call<{ items: Domain[] }>('GET', '/domains').then((r) => r.items),
  createDomain: (body: Record<string, unknown>, by: string) => call<Domain>('POST', '/domains', body, by),
  updateDomain: (d: string, body: Record<string, unknown>, by: string) => call<Domain>('PATCH', `/domains/${id(d)}`, body, by),
  ideas: (f: { q?: string; state?: string; domainId?: string } = {}) => call<{ items: Idea[] }>('GET', `/ideas${q(f)}`).then((r) => r.items),
  createIdea: (body: Record<string, unknown>, by: string) => call<Idea>('POST', '/ideas', body, by),
  updateIdea: (i: string, body: Record<string, unknown>, by: string) => call<Idea>('PATCH', `/ideas/${id(i)}`, body, by),
  goals: () => call<{ items: Goal[] }>('GET', '/goals').then((r) => r.items),
  goal: (g: string) => call<Goal>('GET', `/goals/${id(g)}`),
  createGoal: (body: Record<string, unknown>, by: string) => call<Goal>('POST', '/goals', body, by),
  updateGoal: (g: string, body: Record<string, unknown>, by: string) => call<Goal>('PATCH', `/goals/${id(g)}`, body, by),
  roadmaps: () => call<{ items: Roadmap[] }>('GET', '/roadmaps').then((r) => r.items),
  roadmap: (r: string) => call<RoadmapDetail>('GET', `/roadmaps/${id(r)}`),
  createRoadmap: (body: Record<string, unknown>, by: string) => call<Roadmap>('POST', '/roadmaps', body, by),
  versions: (r: string) => call<{ items: RoadmapVersion[] }>('GET', `/roadmaps/${id(r)}/versions`).then((x) => x.items),
  version: (r: string, v: string) => call<RoadmapVersion & { content: RoadmapContent }>('GET', `/roadmaps/${id(r)}/versions/${id(v)}`),
  proposals: (r: string) => call<{ items: Proposal[] }>('GET', `/roadmaps/${id(r)}/proposals`).then((x) => x.items),
  proposalDiff: (r: string, p: string) => call<ProposalDiff>('GET', `/roadmaps/${id(r)}/proposals/${id(p)}/diff`),
  propose: (r: string, body: { baseVersionId: string | null; content: unknown }, by: string) => call<Proposal>('POST', `/roadmaps/${id(r)}/proposals`, body, by),
  // AI calls can take up to the provider timeout (plus one retry).
  generate: (r: string, body: Record<string, unknown>, by: string) => call<Proposal>('POST', `/roadmaps/${id(r)}/proposals/generate`, body, by, 90_000),
  apply: (r: string, p: string, baseVersionId: string | null, by: string) => call<{ version: RoadmapVersion }>('POST', `/roadmaps/${id(r)}/proposals/${id(p)}/apply`, { baseVersionId }, by),
  reject: (r: string, p: string, by: string) => call<Proposal>('POST', `/roadmaps/${id(r)}/proposals/${id(p)}/reject`, {}, by),
  restore: (r: string, versionId: string, baseVersionId: string, by: string) => call<{ version: RoadmapVersion }>('POST', `/roadmaps/${id(r)}/restore`, { versionId, baseVersionId }, by),
  export: (by: string) => call<Record<string, unknown>>('GET', '/export', undefined, by, 30_000),
};
