import {
  BadRequestException,
  createParamDecorator,
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';

/**
 * L1 has one caller: the Admin Dashboard server, acting for the owner. Hermes (L4) will get its
 * own, narrower principal; workers, publisher and test runner have no access at all.
 */
export interface OwnerPrincipal {
  role: 'owner';
  name: 'dashboard';
}

export type Principal = OwnerPrincipal;

interface AuthenticatedRequest extends Request {
  principal?: Principal;
}

/** Skips authentication. Only for endpoints that reveal nothing (health). */
export const Public = Reflector.createDecorator<true>({ transform: () => true });

const digest = (token: string) => createHash('sha256').update(token, 'utf8').digest();

@Injectable()
export class AuthGuard implements CanActivate {
  private readonly owner: Buffer;

  constructor(private readonly reflector: Reflector, @Inject(APP_CONFIG) config: AppConfig) {
    this.owner = digest(config.dashboardToken);
  }

  canActivate(context: ExecutionContext): boolean {
    if (this.reflector.getAllAndOverride(Public, [context.getHandler(), context.getClass()])) return true;
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const match = /^Bearer\s+(\S+)\s*$/i.exec(request.headers.authorization ?? '');
    if (!match) throw new UnauthorizedException('Missing bearer token');
    if (!timingSafeEqual(digest(match[1]), this.owner)) throw new UnauthorizedException('Invalid bearer token');
    request.principal = { role: 'owner', name: 'dashboard' };
    return true;
  }
}

const APPROVER = /^[a-z0-9][a-z0-9_.-]{0,31}$/;

/**
 * Who acts: the credential plus the logged-in dashboard user it reports in X-Approver
 * ("dashboard:owner"). Stored as created_by / approved_by / audit actor.
 */
export const Actor = createParamDecorator((_data: unknown, ctx: ExecutionContext): string => {
  const request = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
  if (!request.principal) throw new ForbiddenException();
  const approver = request.headers['x-approver'];
  if (approver === undefined) return request.principal.name;
  if (typeof approver !== 'string' || !APPROVER.test(approver)) throw new BadRequestException('X-Approver must be a short lowercase user name');
  return `${request.principal.name}:${approver}`;
});
