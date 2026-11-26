import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { AgentType } from '../config.js';
import type { RegistryProject } from '../controller-client.js';

export interface FakeProject extends RegistryProject {
  allowedAgents: AgentType[];
  enabled: boolean;
}

export function localProject(id: string, overrides: Partial<FakeProject> = {}): FakeProject {
  return {
    id, source: 'local', defaultBranch: 'main', allowCodeChanges: true, cachedHeadSha: null, syncStatus: 'not_synced',
    allowedAgents: ['claude', 'codex'], enabled: true, ...overrides,
  };
}

export interface FakeTask {
  id: string;
  agent: AgentType;
  projectId: string | null;
  model?: string | null;
  effort?: string | null;
  instruction: string;
  status: string;
  result: string | null;
  error: string | null;
  claimedBy: string | null;
  leaseExpiresAt: string | null;
  attempt: number;
}

/**
 * In-memory stand-in for the controller's worker API, following the same
 * contract: bearer auth, agent from token, claimedBy ownership checks and
 * 409 for invalid transitions.
 */
export class FakeController {
  readonly tasks = new Map<string, FakeTask>();
  readonly calls: string[] = [];
  readonly tokens = new Map<string, { agent: AgentType; workerId: string }>([
    ['c'.repeat(40), { agent: 'claude', workerId: 'claude-worker' }],
    ['x'.repeat(40), { agent: 'codex', workerId: 'codex-worker' }],
  ]);
  /** When set, every request gets this HTTP status (simulates an outage). */
  failWith: number | null = null;
  /** The project registry, as GET /internal/projects filters it per agent. */
  readonly projects = new Map<string, FakeProject>([
    ['sandbox', localProject('sandbox')],
    ['docs', localProject('docs', { allowCodeChanges: false })],
  ]);
  /** When set, only GET /internal/projects fails with this status. */
  projectsFailWith: number | null = null;
  leaseMs = 60_000;
  private server: Server | null = null;
  url = '';

  get claudeToken(): string {
    return 'c'.repeat(40);
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = null;
  }

  addTask(agent: AgentType, instruction: string, projectId: string | null = 'sandbox', run: { model?: unknown; effort?: unknown } = {}): FakeTask {
    const task: FakeTask = {
      ...(run as { model?: string | null; effort?: string | null }),
      id: randomUUID(),
      agent,
      projectId,
      instruction,
      status: 'queued',
      result: null,
      error: null,
      claimedBy: null,
      leaseExpiresAt: null,
      attempt: 0,
    };
    this.tasks.set(task.id, task);
    return task;
  }

  requestCancel(id: string): void {
    const task = this.tasks.get(id)!;
    if (task.status === 'running') task.status = 'cancel_requested';
  }

  /** What the real controller's lease sweep does. */
  expireLease(id: string): void {
    const task = this.tasks.get(id)!;
    task.status = 'failed';
    task.error = 'lease_expired: test';
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    this.calls.push(`${req.method} ${req.url}`);
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    if (this.failWith) return send(this.failWith, { statusCode: this.failWith, message: 'simulated outage' });
    const token = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '')?.[1];
    const worker = token ? this.tokens.get(token) : undefined;
    if (!worker) return send(401, { statusCode: 401, message: 'Invalid bearer token' });
    const body = raw ? (JSON.parse(raw) as Record<string, string>) : {};

    if (req.method === 'GET' && req.url === '/internal/projects') {
      if (this.projectsFailWith) return send(this.projectsFailWith, { statusCode: this.projectsFailWith, message: 'registry down' });
      const items = [...this.projects.values()]
        .filter((p) => p.enabled && p.allowedAgents.includes(worker.agent))
        .map(({ allowedAgents: _a, enabled: _e, ...view }) => view);
      return send(200, { items });
    }

    if (req.method === 'POST' && req.url === '/internal/workers/claim') {
      const next = [...this.tasks.values()].find((t) => t.status === 'queued' && t.agent === worker.agent);
      if (next) {
        next.status = 'running';
        next.claimedBy = worker.workerId;
        next.attempt++;
        next.leaseExpiresAt = new Date(Date.now() + this.leaseMs).toISOString();
      }
      return send(200, { task: next ?? null });
    }

    const match = /^\/internal\/tasks\/([^/]+)\/(heartbeat|complete|fail|cancel-ack)$/.exec(req.url ?? '');
    const task = match ? this.tasks.get(match[1]) : undefined;
    if (!match || !task || task.agent !== worker.agent) return send(404, { statusCode: 404, message: 'not found' });
    if (task.claimedBy !== worker.workerId) return send(409, { statusCode: 409, message: 'not claimed by you' });

    const action = match[2];
    const claimed = task.status === 'running' || task.status === 'cancel_requested';
    if (action === 'cancel-ack' ? task.status !== 'cancel_requested' : !claimed) {
      return send(409, { statusCode: 409, message: `Cannot ${action} task in status ${task.status}` });
    }
    switch (action) {
      case 'heartbeat':
        task.leaseExpiresAt = new Date(Date.now() + this.leaseMs).toISOString();
        return send(200, { task, cancelRequested: task.status === 'cancel_requested' });
      case 'complete':
        Object.assign(task, { status: 'completed', result: body.result, leaseExpiresAt: null });
        return send(200, { task });
      case 'fail':
        Object.assign(task, { status: 'failed', error: body.error, leaseExpiresAt: null });
        return send(200, { task });
      default:
        Object.assign(task, { status: 'canceled', leaseExpiresAt: null });
        return send(200, { task });
    }
  }
}
