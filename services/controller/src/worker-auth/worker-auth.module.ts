import { Module } from '@nestjs/common';
import { WorkersModule } from '../workers/workers.module.js';
import { WorkerAuthController, WorkerAuthInternalController } from './worker-auth.controller.js';
import { WorkerAuthService } from './worker-auth.service.js';

@Module({
  imports: [WorkersModule],
  controllers: [WorkerAuthInternalController, WorkerAuthController],
  providers: [WorkerAuthService],
  exports: [WorkerAuthService],
})
export class WorkerAuthModule {}
