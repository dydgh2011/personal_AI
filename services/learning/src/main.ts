import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';
import { configureApp } from './app.setup.js';
import { ConfigError, loadConfig, type AppConfig } from './config/app-config.js';

async function bootstrap(): Promise<void> {
  let config: AppConfig;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }
  const app = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(config));
  configureApp(app);
  app.enableShutdownHooks();
  await app.listen(config.port, config.host);
  const logger = new Logger('Bootstrap');
  logger.log(`Learning service listening on ${config.host}:${config.port} | database: ${config.databasePath}`);
  logger.log(`AI provider: ${config.ai.provider}${config.ai.model ? ` (${config.ai.model})` : ''}${config.ai.provider === 'none' ? ' - AI drafts disabled until configured' : ''}`);
}

void bootstrap();
