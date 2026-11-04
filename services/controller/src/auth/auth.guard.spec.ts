import { Controller, ForbiddenException, Get, UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { testConfig } from '../../test/helpers.js';
import { Public, RequireRole } from './auth.decorators.js';
import { AuthGuard } from './auth.guard.js';
import type { AuthenticatedRequest } from './principal.js';
import { TokenRegistry } from './token-registry.js';

@Controller()
class ExampleController {
  @Public()
  @Get()
  open() {}

  @Get()
  defaultRole() {}

  @RequireRole('worker')
  @Get()
  workerOnly() {}
}

describe('AuthGuard', () => {
  const config = testConfig();
  const guard = new AuthGuard(new Reflector(), new TokenRegistry(config));
  const [claude, codex] = config.workers;

  function contextFor(handler: keyof ExampleController, authorization?: string) {
    const request = { headers: { authorization }, method: 'GET', path: '/', ip: '127.0.0.1' } as AuthenticatedRequest;
    const context = {
      getHandler: () => ExampleController.prototype[handler],
      getClass: () => ExampleController,
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;
    return { context, request };
  }

  it('allows public routes without a token', () => {
    expect(guard.canActivate(contextFor('open').context)).toBe(true);
  });

  it('rejects missing, malformed and unknown tokens with 401', () => {
    expect(() => guard.canActivate(contextFor('defaultRole').context)).toThrow(UnauthorizedException);
    expect(() => guard.canActivate(contextFor('defaultRole', config.adminToken).context)).toThrow(UnauthorizedException);
    expect(() => guard.canActivate(contextFor('defaultRole', 'Bearer nope').context)).toThrow(UnauthorizedException);
  });

  it('defaults to admin-only when no role is declared', () => {
    const { context, request } = contextFor('defaultRole', `Bearer ${config.adminToken}`);
    expect(guard.canActivate(context)).toBe(true);
    expect(request.principal).toEqual({ role: 'admin', name: 'admin' });
    expect(() => guard.canActivate(contextFor('defaultRole', `Bearer ${claude.token}`).context)).toThrow(
      ForbiddenException,
    );
  });

  it('identifies each worker by its own token', () => {
    const asClaude = contextFor('workerOnly', `Bearer ${claude.token}`);
    expect(guard.canActivate(asClaude.context)).toBe(true);
    expect(asClaude.request.principal).toEqual({ role: 'worker', agent: 'claude', workerId: 'claude-worker' });

    const asCodex = contextFor('workerOnly', `bearer ${codex.token}`);
    expect(guard.canActivate(asCodex.context)).toBe(true);
    expect(asCodex.request.principal).toMatchObject({ agent: 'codex' });

    expect(() => guard.canActivate(contextFor('workerOnly', `Bearer ${config.adminToken}`).context)).toThrow(
      ForbiddenException,
    );
  });
});
