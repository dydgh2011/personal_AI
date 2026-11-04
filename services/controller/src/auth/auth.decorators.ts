import { createParamDecorator, ForbiddenException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AuthenticatedRequest, PublisherPrincipal, Role, TaskActor, TestRunnerPrincipal, WorkerPrincipal } from './principal.js';

/** Skips authentication. Use only for endpoints that expose nothing sensitive. */
export const Public = Reflector.createDecorator<true>({ transform: () => true });

/** Role(s) allowed on a controller or handler. Handlers without it require 'admin'. */
export const RequireRole = Reflector.createDecorator<Role | readonly Role[]>();

/** Injects the authenticated worker; only valid on handlers guarded by RequireRole('worker'). */
export const CurrentWorker = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): WorkerPrincipal => {
    const principal = ctx.switchToHttp().getRequest<AuthenticatedRequest>().principal;
    if (principal?.role !== 'worker') throw new ForbiddenException();
    return principal;
  },
);

/** Injects the admin or delegator a task-management request acts for. */
export const CurrentActor = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): TaskActor => {
    const principal = ctx.switchToHttp().getRequest<AuthenticatedRequest>().principal;
    if (principal?.role !== 'admin' && principal?.role !== 'delegator') throw new ForbiddenException();
    return principal;
  },
);

/** Injects the authenticated publisher; only valid on handlers guarded by RequireRole('publisher'). */
export const CurrentPublisher = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): PublisherPrincipal => {
    const principal = ctx.switchToHttp().getRequest<AuthenticatedRequest>().principal;
    if (principal?.role !== 'publisher') throw new ForbiddenException();
    return principal;
  },
);

/** Injects the authenticated test runner; only valid on handlers guarded by RequireRole('test-runner'). */
export const CurrentTestRunner = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): TestRunnerPrincipal => {
    const principal = ctx.switchToHttp().getRequest<AuthenticatedRequest>().principal;
    if (principal?.role !== 'test-runner') throw new ForbiddenException();
    return principal;
  },
);
