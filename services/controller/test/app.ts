import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { Clock } from '../src/common/clock.js';
import type { AppConfig } from '../src/config/app-config.js';

/** Boots the real application module in-process, configured exactly like main.ts. */
export async function createTestApp(config: AppConfig, clock?: Pick<Clock, 'now'>): Promise<INestApplication> {
  const builder = Test.createTestingModule({ imports: [AppModule.forRoot(config)] });
  if (clock) builder.overrideProvider(Clock).useValue(clock);
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
  configureApp(app);
  await app.init();
  return app;
}
