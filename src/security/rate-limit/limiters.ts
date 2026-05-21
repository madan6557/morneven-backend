import rateLimit from 'express-rate-limit';
import { Request, Response } from 'express';
import { env } from '../../config/env.js';
import { fail } from '../../utils/response.js';
import { securityFeatures } from '../config.js';
import { recordSecurityEvent } from '../audit/events.js';

const keyForRequest = (req: Request, group: string) => {
  const userKey = req.user?.id ? `user:${req.user.id}` : undefined;
  const ipKey = req.securityContext?.ipHash ? `ip:${req.securityContext.ipHash}` : 'ip:unknown';
  return `${group}:${userKey ?? ipKey}`;
};

export const securityRouteLimiter = (
  group: string,
  input: { windowMs: number; max: number; skip?: (req: Request) => boolean }
) =>
  rateLimit({
    windowMs: input.windowMs,
    max: input.max,
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => !securityFeatures.routeRateLimit || Boolean(input.skip?.(req as Request)),
    keyGenerator: (req) => keyForRequest(req as Request, group),
    handler: (req: Request, res: Response) => {
      void recordSecurityEvent(req, {
        action: `rate-limit.${group}`,
        severity: 'medium',
        decision: 'deny',
        metadata: { group }
      });
      return fail(res, 429, 'Too many requests, please try again later.', 'RATE_LIMITED');
    }
  });

const isAuthSessionRead = (req: Request) => req.method === 'GET' && req.path === '/me';

export const securityLimiters = {
  auth: securityRouteLimiter('auth', {
    windowMs: env.authRateLimitWindowMs,
    max: env.authRateLimitMax,
    skip: isAuthSessionRead
  }),
  files: securityRouteLimiter('files', { windowMs: env.rateLimitWindowMs, max: env.rateLimitMax }),
  chat: securityRouteLimiter('chat', { windowMs: 60 * 1000, max: 120 }),
  management: securityRouteLimiter('management', { windowMs: 15 * 60 * 1000, max: 120 }),
  admin: securityRouteLimiter('admin', { windowMs: 15 * 60 * 1000, max: 120 }),
  botManagerRead: securityRouteLimiter('bot-manager-read', { windowMs: 60 * 1000, max: 180 }),
  botManagerWrite: securityRouteLimiter('bot-manager-write', { windowMs: 15 * 60 * 1000, max: 120 }),
  security: securityRouteLimiter('security', { windowMs: 15 * 60 * 1000, max: 240 }),
  api: securityRouteLimiter('api', { windowMs: env.rateLimitWindowMs, max: env.rateLimitMax })
};
