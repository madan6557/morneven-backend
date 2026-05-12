import { env } from '../config/env.js';

export const SECURITY_LEVEL_MAX = 5;

export const securityLevel = Math.max(0, Math.min(SECURITY_LEVEL_MAX, env.securityLevel));

export const securityEnabled = securityLevel > 0;

export const securityFeatures = {
  observe: securityLevel >= 1,
  audit: securityLevel >= 1,
  routeRateLimit: securityLevel >= 2,
  blockHighRiskRequests: securityLevel >= 3,
  activeDefense: securityLevel >= 4,
  full: securityLevel >= SECURITY_LEVEL_MAX
};

export const securityLevelLabels: Record<number, string> = {
  0: 'off',
  1: 'observe',
  2: 'audit-and-rate-limit',
  3: 'block-high-risk',
  4: 'active-defense',
  5: 'full'
};

export const getSecurityStatus = () => ({
  enabled: securityEnabled,
  level: securityLevel,
  maxLevel: SECURITY_LEVEL_MAX,
  label: securityLevelLabels[securityLevel] ?? 'custom',
  features: securityFeatures,
  retentionDays: env.securityRetentionDays,
  fileScanProvider: env.fileScanProvider,
  authCookieEnabled: env.authCookieEnabled
});
