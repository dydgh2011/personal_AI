import { readFileSync } from 'node:fs';
import type { PublicationJob, PublicationReport } from './verify.js';

export class ControllerError extends Error {
  constructor(message: string, readonly status: number | null) {
    super(message);
  }
}

/** The publisher's only controller calls: claim a request, report its result. */
export class ControllerClient {
  constructor(private readonly baseUrl: string, private readonly tokenFile: string) {}

  async claim(): Promise<PublicationJob | null> {
    const body = (await this.post('/internal/publisher/claim', {})) as { job: PublicationJob | null };
    return body.job;
  }

  async report(publicationId: string, status: 'ready' | 'failed' | 'published' | 'pr_created', report: PublicationReport | Record<string, unknown>): Promise<void> {
    await this.post(`/internal/publisher/publications/${encodeURIComponent(publicationId)}/result`, { status, report });
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    let token: string;
    try {
      token = readFileSync(this.tokenFile, 'utf8').trim();
    } catch {
      throw new ControllerError('publisher token file is missing', null);
    }
    let res: Response;
    try {
      res = await fetch(this.baseUrl + path, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new ControllerError('controller unreachable', null);
    }
    const text = await res.text();
    if (!res.ok) {
      let message = `controller answered ${res.status}`;
      try {
        const m = (JSON.parse(text) as { message?: unknown }).message;
        if (typeof m === 'string') message = m;
      } catch {
        // keep the status message
      }
      throw new ControllerError(message, res.status);
    }
    return text ? JSON.parse(text) : null;
  }
}
