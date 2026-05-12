import { Request } from 'express';
import { SecuritySignal } from '../context.js';

const SQLI_PATTERNS = [
  /\bunion\b.{0,40}\bselect\b/i,
  /\bor\b\s+['"]?\d+['"]?\s*=\s*['"]?\d+/i,
  /\bdrop\s+table\b/i,
  /\binformation_schema\b/i
];

const XSS_PATTERNS = [
  /<\s*script\b/i,
  /\bjavascript\s*:/i,
  /\bon(?:error|load|mouseover|focus)\s*=/i,
  /<\s*iframe\b/i
];

const PATH_TRAVERSAL_PATTERNS = [
  /\.\.[/\\]/,
  /%2e%2e%2f/i,
  /%2e%2e%5c/i,
  /%252e%252e/i
];

const COMMAND_PATTERNS = [
  /;\s*(?:cat|curl|wget|bash|sh|cmd|powershell)\b/i,
  /\|\s*(?:cat|curl|wget|bash|sh|cmd|powershell)\b/i,
  /`[^`]*(?:curl|wget|bash|powershell)[^`]*`/i
];

const flattenForScan = (value: unknown, maxLength = 12000): string => {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value.slice(0, maxLength);
  try {
    return JSON.stringify(value).slice(0, maxLength);
  } catch {
    return '';
  }
};

const matchAny = (text: string, patterns: RegExp[]) => patterns.some((pattern) => pattern.test(text));

export const evaluateRequestRisk = (req: Request) => {
  const signals: SecuritySignal[] = [];
  const scanText = [
    req.originalUrl,
    flattenForScan(req.query),
    flattenForScan(req.params),
    flattenForScan(req.body)
  ].join('\n');

  if (matchAny(scanText, SQLI_PATTERNS)) {
    signals.push({ key: 'injection.sql', severity: 'high', score: 45, detail: 'SQL injection probe pattern' });
  }

  if (matchAny(scanText, XSS_PATTERNS)) {
    signals.push({ key: 'injection.xss', severity: 'high', score: 45, detail: 'XSS probe pattern' });
  }

  if (matchAny(scanText, PATH_TRAVERSAL_PATTERNS)) {
    signals.push({ key: 'path.traversal', severity: 'high', score: 45, detail: 'Path traversal probe pattern' });
  }

  if (matchAny(scanText, COMMAND_PATTERNS)) {
    signals.push({ key: 'command.probe', severity: 'critical', score: 70, detail: 'Command injection probe pattern' });
  }

  const hasBearer = req.header('authorization')?.startsWith('Bearer ');
  if (!hasBearer && /\/(?:mgmt|management|settings|command-center|security|files\/upload)/i.test(req.originalUrl)) {
    signals.push({ key: 'anonymous.sensitive-route', severity: 'medium', score: 20 });
  }

  const contentLength = Number(req.header('content-length') ?? 0);
  if (Number.isFinite(contentLength) && contentLength > 1024 * 1024) {
    signals.push({ key: 'request.large-body', severity: 'medium', score: 20 });
  }

  const riskScore = Math.min(100, signals.reduce((total, signal) => total + signal.score, 0));
  return { riskScore, signals };
};
