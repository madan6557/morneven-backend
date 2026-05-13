import { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { AccountStatus, Role, Track } from '@prisma/client';
import { prisma } from '../config/prisma.js';
import { env } from '../config/env.js';
import { fail } from '../utils/response.js';
import { AuthUser } from '../types/auth.js';
import { normalizeUserRole } from '../utils/serializers.js';
import { recordSecurityEvent } from '../security/audit/events.js';
import { ensureSessionAllowed } from '../security/sessions/session-service.js';
import { restoreExpiredAccountStatus } from '../modules/personnel/service.js';

const ROLE_ADMIN = 'admin' as Role;
const ROLE_SECURITY = 'security' as Role;

const readCookie = (req: Request, name: string) => {
  const cookie = req.headers.cookie;
  if (!cookie) return undefined;
  const pair = cookie
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`));
  return pair ? decodeURIComponent(pair.slice(name.length + 1)) : undefined;
};

const accountStatusFailure = (res: Response, status: AccountStatus) => {
  if (status === AccountStatus.banned) return fail(res, 403, 'Account is banned', 'ACCOUNT_BANNED');
  if (status === AccountStatus.suspended) return fail(res, 403, 'Account is suspended', 'ACCOUNT_SUSPENDED');
  if (status === AccountStatus.deleted) return fail(res, 403, 'Account has been deleted', 'ACCOUNT_DELETED');
  return fail(res, 403, 'Account is not active', 'ACCOUNT_INACTIVE');
};

export const auth = async (req: Request, res: Response, next: NextFunction) => {
  const header = req.headers.authorization;
  const accessToken = header?.startsWith('Bearer ') ? header.slice(7) : readCookie(req, 'morneven_access_token');
  if (!accessToken) return fail(res, 401, 'Missing token', 'UNAUTHORIZED');

  try {
    const payload = jwt.verify(accessToken, env.jwtAccessSecret) as {
      sub: string;
      username?: string;
      role?: Role;
      level?: number;
      track?: Track;
      sid?: string;
    };

    if (payload.sub === 'guest' && payload.role === Role.guest) {
      req.user = {
        id: 'guest',
        username: payload.username ?? 'guest',
        role: Role.guest,
        accountStatus: AccountStatus.active,
        level: 0,
        track: payload.track ?? Track.executive,
        sessionId: payload.sid
      };
      return next();
    }

    let user = await prisma.user.findUnique({ where: { id: payload.sub } });

    if (!user) return fail(res, 401, 'Invalid token', 'UNAUTHORIZED');
    user = await restoreExpiredAccountStatus(prisma, user);
    if (user.accountStatus !== AccountStatus.active) {
      await recordSecurityEvent(req, {
        action: 'auth.inactive-account',
        severity: 'medium',
        decision: 'deny',
        metadata: { accountStatus: user.accountStatus }
      });
      return accountStatusFailure(res, user.accountStatus);
    }

    const sessionAllowed = await ensureSessionAllowed(req, payload.sid);
    if (!sessionAllowed) return fail(res, 401, 'Invalid token', 'UNAUTHORIZED');

    req.user = {
      id: user.id,
      username: user.username,
      role: normalizeUserRole(user.role, user.level),
      accountStatus: user.accountStatus,
      level: user.level,
      track: user.track,
      sessionId: payload.sid
    };
    return next();
  } catch {
    return fail(res, 401, 'Invalid token', 'UNAUTHORIZED');
  }
};

export const allow = (rule: (u: AuthUser) => boolean) => (req: Request, res: Response, next: NextFunction) => {
  if (!req.user) return fail(res, 401, 'Unauthorized', 'UNAUTHORIZED');
  if (!rule(req.user)) return fail(res, 403, 'Forbidden', 'FORBIDDEN');
  return next();
};

export const isPl7Author = (u: AuthUser) => u.level >= 7 && u.role === Role.author;
export const isPl7Admin = (u: AuthUser) => u.level >= 7 && u.role === ROLE_ADMIN;
export const isSecurityManager = (u: AuthUser) => u.role === ROLE_SECURITY;
export const hasPl7MaintenanceAccess = (u: AuthUser) => isPl7Author(u) || isPl7Admin(u) || isSecurityManager(u);
export const canManageSecurity = (u: AuthUser) => isSecurityManager(u) || isPl7Author(u) || isPl7Admin(u);
export const canRunExtractionJobs = (u: AuthUser) => isPl7Author(u);

export const canWriteNews = (u: AuthUser) => u.level === 7 || (u.level === 6 && u.track === Track.executive);
export const canWriteProjects = (u: AuthUser) =>
  u.level === 7 || (u.level === 6 && (u.track === Track.mechanic || u.track === Track.executive));

export const canWriteLore = (u: AuthUser, category: string) => {
  if (u.level === 7 || (u.level === 6 && u.track === Track.executive)) return true;
  if (u.level !== 6) return false;
  if (category === 'places' || category === 'creatures') return u.track === Track.field;
  if (category === 'technology') return u.track === Track.mechanic;
  return false;
};

export const canModerateDiscussion = (u: AuthUser) => u.level === 7 || (u.level === 6 && u.track === Track.executive);
export const canWriteGallery = (u: AuthUser) => u.level >= 6 && u.role !== Role.guest;
