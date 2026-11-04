import { ValidationPipe } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';

/** Settings shared by main.ts and the e2e tests so both exercise the same HTTP behaviour. */
export function configureApp(app: NestExpressApplication): NestExpressApplication {
  app.disable('x-powered-by');
  // Roadmap content and imports can be large; DTOs cap individual fields.
  app.useBodyParser('json', { limit: '16mb' });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  return app;
}
