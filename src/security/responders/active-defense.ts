import { prisma } from '../../config/prisma.js';
import { env } from '../../config/env.js';
import { securityFeatures } from '../config.js';
import { SecurityContext, hashSecurityValue } from '../context.js';

export type BlockSubjectType = 'ip' | 'user' | 'session' | 'custom';

export const findActiveBlock = async (subjectType: BlockSubjectType, subjectHash?: string) => {
  if (!securityFeatures.activeDefense || !subjectHash) return null;

  return prisma.securityBlock.findFirst({
    where: {
      subjectType,
      subjectHash,
      revokedAt: null,
      expiresAt: { gt: new Date() }
    },
    orderBy: { createdAt: 'desc' }
  });
};

export const findActiveRequestBlock = async (ctx: SecurityContext) => findActiveBlock('ip', ctx.ipHash);

export const createSecurityBlock = async (input: {
  subjectType: BlockSubjectType;
  subjectValue?: string;
  subjectHash?: string;
  reason: string;
  severity?: string;
  ttlMs?: number;
  createdBy?: string;
}) => {
  if (!securityFeatures.activeDefense) return null;
  const subjectHash = input.subjectHash ?? hashSecurityValue(input.subjectValue);
  if (!subjectHash) return null;

  return prisma.securityBlock.create({
    data: {
      subjectType: input.subjectType,
      subjectHash,
      reason: input.reason,
      severity: input.severity ?? 'medium',
      expiresAt: new Date(Date.now() + (input.ttlMs ?? env.securityBlockTtlMs)),
      createdBy: input.createdBy
    }
  });
};

export const revokeSecurityBlock = async (id: string, revokeReason: string) =>
  prisma.securityBlock.update({
    where: { id },
    data: {
      revokedAt: new Date(),
      revokeReason
    }
  });
