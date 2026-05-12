import rateLimit from 'express-rate-limit';
import { Request, Response } from 'express';
import { fail } from '../../utils/response.js';
import { securityFeatures } from '../config.js';
import { recordSecurityEvent } from '../audit/events.js';

const keyForRequest = (req: Request, group: string) => {
  const userKey = req.user?.id ? `user:${req.user.id}` : undefined;
  const ipKey = req.securityContext?.ipHash ? `ip:${req.securityContext.ipHash}` : 'ip:unknown';
  return `${group}:${userKey ?? ipKey}`;
};

export const securityRouteLimiter = (group: string, input: { windowMs: number; max: number }) =>
  rateLimit({
    windowMs: input.windowMs,
    max: input.max,
    standardHeaders: true,
    legacyHeaders: false,
    skip: () => !securityFeatures.routeRateLimit,
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

export const securityLimiters = {
  auth: securityRouteLimiter('auth', { windowMs: 15 * 60 * 1000, max: 20 }),
  files: securityRouteLimiter('files', { windowMs: 60 * 60 * 1000, max: 40 }),
  chat: securityRouteLimiter('chat', { windowMs: 60 * 1000, max: 120 }),
  management: securityRouteLimiter('management', { windowMs: 15 * 60 * 1000, max: 120 }),
  admin: securityRouteLimiter('admin', { windowMs: 15 * 60 * 1000, max: 120 }),
  security: securityRouteLimiter('security', { windowMs: 15 * 60 * 1000, max: 240 }),
  api: securityRouteLimiter('api', { windowMs: 15 * 60 * 1000, max: 900 })
};
