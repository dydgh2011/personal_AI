import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { Clock } from '../src/common/clock.js';
import type { AppConfig } from '../src/config/app-config.js';

export const randomToken = () => randomBytes(32).toString('base64url');

export function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    host: '127.0.0.1',
    port: 0,
    databasePath: ':memory:',
    dashboardToken: randomToken(),
    ai: { provider: 'none', model: null, keyFile: null, apiUrl: 'http://127.0.0.1:9', monthlyBudgetUsd: null, inputUsdPerMTok: null, outputUsdPerMTok: null, timeoutMs: 5000 },
    ...overrides,
  };
}

export class FakeClock {
  constructor(private current = new Date('2026-11-04T00:00:00.000Z')) {}
  now(): Date {
    return new Date(this.current);
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

export async function createTestApp(config: AppConfig, clock?: Pick<Clock, 'now'>): Promise<INestApplication> {
  const builder = Test.createTestingModule({ imports: [AppModule.forRoot(config)] });
  if (clock) builder.overrideProvider(Clock).useValue(clock);
  const app = (await builder.compile()).createNestApplication<NestExpressApplication>({ logger: false });
  configureApp(app);
  await app.init();
  return app;
}

/** Gemini generateContent stand-in: records requests, answers what the test queues. */
export class FakeGemini {
  readonly requests: Array<{ url: string; key: string | undefined; auth?: string; body: any }> = [];
  replies: Array<{ status: number; text?: string; raw?: unknown; delayMs?: number }> = [];
  url = '';
  private server: Server | null = null;

  async start() {
    this.server = createServer((req: IncomingMessage, res) => {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', async () => {
        this.requests.push({ url: req.url!, key: req.headers['x-goog-api-key'] as string | undefined, auth: req.headers.authorization, body: body ? JSON.parse(body) : null });
        const reply = this.replies.shift() ?? { status: 500 };
        if (reply.delayMs) await new Promise((r) => setTimeout(r, reply.delayMs));
        res.writeHead(reply.status, { 'content-type': 'application/json' });
        // The LLM gateway speaks the OpenAI chat format.
        if (req.url!.endsWith('/chat/completions')) {
          res.end(JSON.stringify(reply.raw ?? {
            choices: reply.text === undefined ? [] : [{ message: { role: 'assistant', content: reply.text } }],
            usage: { prompt_tokens: 1500, completion_tokens: 600 },
          }));
          return;
        }
        res.end(JSON.stringify(reply.raw ?? {
          candidates: reply.text === undefined ? [] : [{ content: { parts: [{ text: reply.text }] } }],
          usageMetadata: { promptTokenCount: 1200, candidatesTokenCount: 800 },
        }));
      });
    });
    await new Promise<void>((r) => this.server!.listen(0, '127.0.0.1', r));
    this.url = `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}`;
  }

  async stop() {
    await new Promise((r) => this.server?.close(r));
  }
}
