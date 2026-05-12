import { createHash } from 'node:crypto';
import { Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { env } from '../config/env.js';
import { securityEnabled, securityLevel } from './config.js';

export type SecuritySignal = {
  key: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  score: number;
  detail?: string;
};

export type SecurityContext = {
  enabled: boolean;
  level: number;
  requestId?: string;
  ip?: string;
  ipHash?: string;
  userAgent?: string;
  userAgentHash?: string;
  method: string;
  path: string;
  origin?: string;
  routeGroup: string;
  sessionId?: string;
  riskScore: number;
  signals: SecuritySignal[];
};

export const hashSecurityValue = (value?: string | null) => {
  if (!value) return undefined;
  return createHash('sha256').update(`${env.securityHashPepper}:${value}`).digest('hex');
};

export const getRequestIp = (req: Request) => {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0]?.trim();
  }
  if (Array.isArray(forwarded) && forwarded[0]) return forwarded[0];
  return req.ip || req.socket.remoteAddress || undefined;
};

export const determineRouteGroup = (path: string) => {
  const normalized = path.toLowerCase();
  if (normalized.includes('/auth')) return 'auth';
  if (normalized.includes('/files')) return 'files';
  if (normalized.includes('/chat')) return 'chat';
  if (normalized.includes('/management') || normalized.includes('/mgmt')) return 'management';
  if (normalized.includes('/security')) return 'security';
  if (normalized.includes('/settings') || normalized.includes('/command-center')) return 'admin';
  if (normalized.includes('/lore')) return 'lore';
  if (normalized.includes('/gallery')) return 'gallery';
  if (normalized.includes('/projects')) return 'projects';
  return 'api';
};

export const createSecurityContext = (req: Request, res?: Response): SecurityContext => {
  const requestId = req.header('x-request-id') || String(res?.getHeader('x-request-id') ?? '');
  const ip = getRequestIp(req);
  const userAgent = req.header('user-agent') ?? undefined;
  const origin = req.header('origin') ?? undefined;

  return {
    enabled: securityEnabled,
    level: securityLevel,
    requestId: requestId || undefined,
    ip,
    ipHash: hashSecurityValue(ip),
    userAgent,
    userAgentHash: hashSecurityValue(userAgent),
    method: req.method,
    path: req.originalUrl || req.url,
    origin,
    routeGroup: determineRouteGroup(req.path || req.originalUrl || req.url),
    sessionId: undefined,
    riskScore: 0,
    signals: []
  };
};

export const toSafeMetadata = (value: Record<string, unknown> = {}): Prisma.InputJsonValue => {
  const redactedKeys = new Set(['password', 'newPassword', 'confirmPassword', 'token', 'refreshToken', 'authorization', 'cookie']);

  const redact = (input: unknown): unknown => {
    if (input === null || input === undefined) return input;
    if (Array.isArray(input)) return input.slice(0, 20).map(redact);
    if (typeof input === 'object') {
      const output: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(input as Record<string, unknown>)) {
        if (redactedKeys.has(key.toLowerCase())) {
          output[key] = '[redacted]';
          continue;
        }
        output[key] = redact(item);
      }
      return output;
    }
    if (typeof input === 'string') return input.length > 500 ? `${input.slice(0, 500)}...` : input;
    return input;
  };

  return redact(value) as Prisma.InputJsonValue;
};
