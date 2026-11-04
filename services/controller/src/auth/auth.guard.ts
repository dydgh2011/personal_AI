import {
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Public, RequireRole } from './auth.decorators.js';
import type { AuthenticatedRequest, Role } from './principal.js';
import { TokenRegistry } from './token-registry.js';

/**
 * Global guard: every route requires a bearer token unless marked @Public().
 * Routes without @RequireRole() default to admin-only, so a forgotten
 * decorator fails closed.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  private readonly logger = new Logger(AuthGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenRegistry,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride(Public, targets)) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = extractBearerToken(request.headers.authorization);
    if (!token) {
      throw new UnauthorizedException('Missing bearer token');
    }

    const principal = this.tokens.resolve(token);
    if (!principal) {
      this.logger.warn(`Rejected invalid token: ${request.method} ${request.path} from ${request.ip}`);
      throw new UnauthorizedException('Invalid bearer token');
    }

    const required = this.reflector.getAllAndOverride(RequireRole, targets) ?? 'admin';
    const allowed: readonly Role[] = typeof required === 'string' ? [required] : required;
    if (!allowed.includes(principal.role)) {
      throw new ForbiddenException(`This endpoint requires the ${allowed.join(' or ')} role`);
    }

    request.principal = principal;
    return true;
  }
}

function extractBearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return match ? match[1] : null;
}
