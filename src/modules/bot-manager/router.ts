import { NextFunction, Request, Response, Router } from 'express';
import bcrypt from 'bcryptjs';
import multer from 'multer';
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { EntityType, Prisma } from '@prisma/client';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { prisma } from '../../config/prisma.js';
import { createReadStreamFromStorage, deleteFileFromStorage, readFileWithMetadataFromStorage, saveFileToStorage } from '../../config/storage.js';
import { auth, isPl7Admin, isPl7Author } from '../../middleware/auth.js';
import { scanUploadBuffer } from '../../security/files/scanner.js';
import { securityLimiters } from '../../security/rate-limit/limiters.js';
import { fail, ok } from '../../utils/response.js';
import { writeAudit } from '../../utils/audit.js';
import { makeZip, ZipFile } from '../../utils/zip.js';

export const botManagerRouter = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }
});

const providers = ['openai', 'anthropic', 'gemini', 'groq', 'openrouter', 'deepseek', 'zhipu', 'vllm'] as const;
const fileKinds = ['identity', 'memory', 'cron', 'skill', 'session', 'tool', 'user', 'system', 'other'] as const;

const credentialGateSchema = z.object({
  password: z.string().min(1),
  botManagerKey: z.string().min(1),
  confirmText: z.literal('CREDENTIALS')
});

const credentialSchema = credentialGateSchema.extend({
  provider: z.enum(providers),
  apiKey: z.string().trim().min(1).max(4096),
  apiBase: z.string().trim().url().optional().or(z.literal('')),
  modelId: z.string().trim().min(1).max(160)
});

const openRouterProfileSchema = credentialGateSchema.extend({
  name: z.string().trim().min(2).max(80),
  apiKey: z.string().trim().min(1).max(4096),
  apiBase: z.string().trim().url().optional().or(z.literal('')),
  modelId: z.string().trim().min(1).max(160),
  tags: z.array(z.string().trim().min(1).max(40)).max(12).optional().default([]),
  notes: z.string().trim().max(800).optional().default('')
});

const providerActivationSchema = credentialGateSchema;

const generalConfigSchema = z.object({
  config: z.record(z.unknown()).default({})
});

const identitySchema = z.object({
  name: z.string().trim().min(2).max(80),
  roleTitle: z.string().trim().min(2).max(120),
  description: z.string().trim().max(1200).optional().default(''),
  channels: z.record(z.unknown()).optional().default({}),
  settings: z.record(z.unknown()).optional().default({}),
  loreCharacterId: z.string().trim().min(1).optional().or(z.literal(''))
});

const identityUpdateSchema = identitySchema.partial();

const fileSchema = z.object({
  path: z.string().trim().min(1).max(240),
  kind: z.enum(fileKinds).default('other'),
  content: z.string().max(500000),
  contentType: z.string().trim().min(3).max(120).optional()
});

const fileDeleteSchema = z.object({
  path: z.string().trim().min(1).max(240)
});

const backupSchema = z.object({
  mode: z.enum(['full', 'custom']),
  identityIds: z.array(z.string()).optional().default([]),
  confirmText: z.literal('PERSONALITY'),
  password: z.string().min(1),
  secretKey: z.string().min(16)
});

const clearBackupSchema = z.object({
  ids: z.array(z.string()).optional()
});

const backupDownloadTicketSchema = z.object({
  secretKey: z.string().min(16)
});

const syncTokenSchema = z.object({
  token: z.string().optional()
});

const runtimeActionSchema = z.enum(['start', 'stop', 'restart']);

type IdentityWithFiles = Prisma.BotManagerIdentityGetPayload<{ include: { files: true } }>;
type IdentityRecord = {
  id: string;
  slug: string;
  name: string;
  roleTitle: string;
  description: string;
  isActive: boolean;
  profileImageObjectPath: string | null;
  profileImageUrl: string | null;
  channels: Prisma.JsonValue;
  settings: Prisma.JsonValue;
  createdAt: Date;
  updatedAt: Date;
  files?: Array<unknown>;
};

const defaultGeneralConfig = {
  runtimeMode: 'single-active-personality',
  timezone: 'Asia/Singapore',
  globalRules: 'Follow Morneven website policy and active personality files.',
  gateway: {
    restartAfterSync: true
  }
};

const runtimeSyncConfigKey = '__runtimeSync';

const defaultRuntimeSyncState = {
  runtimeDirty: false,
  runtimeDirtySince: null as string | null,
  runtimeDirtyReason: null as string | null,
  lastRuntimeSyncAt: null as string | null,
  lastRuntimeSyncError: null as string | null
};

const defaultIdentityFiles = (name: string, roleTitle: string) => [
  {
    path: 'AGENTS.md',
    kind: 'identity',
    content: `# ${name}\n\nRole: ${roleTitle}\n\nFollow the active Morneven Bot Manager identity and workspace rules.\n`
  },
  {
    path: 'SOUL.md',
    kind: 'identity',
    content: `# ${name} Soul\n\nDefine personality, tone, boundaries, and behavior here.\n`
  },
  {
    path: 'MEMORY.md',
    kind: 'memory',
    content: `# ${name} Memory\n\nLong-term memory summary for this personality.\n`
  },
  {
    path: 'TOOLS.md',
    kind: 'tool',
    content: '# Tools\n\nAllowed tools and usage notes for this personality.\n'
  },
  {
    path: 'USER.md',
    kind: 'user',
    content: '# User Profile\n\nAudience and user preference notes.\n'
  },
  {
    path: 'HEARTBEAT.md',
    kind: 'system',
    content: '# Heartbeat\n\nPeriodic task notes for this personality.\n'
  },
  {
    path: 'memory/history.jsonl',
    kind: 'memory',
    content: ''
  }
] as const;

const protectedWorkspacePaths = new Set([
  'agents.md',
  'soul.md',
  'memory.md',
  'tools.md',
  'user.md',
  'heartbeat.md',
  'lore.md',
  'memory/history.jsonl'
]);

const readOnlyWorkspacePaths = new Set(['lore.md', 'memory/history.jsonl']);
const nanobotStatusCacheMs = 30_000;

let nanobotStatusCache: { payload: unknown; cachedAt: number } | null = null;

const safeEquals = (left: string, right: string) => {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
};

const normalizeWorkspacePath = (value: string) => {
  const normalized = value.trim().replace(/\\/g, '/').replace(/^\/+/, '');
  const segments = normalized.split('/');
  if (!normalized || normalized.length > 240) return null;
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) return null;
  if (!/^[a-zA-Z0-9._/-]+$/.test(normalized)) return null;
  return normalized;
};

const isReadOnlyWorkspacePath = (value: string) => readOnlyWorkspacePaths.has(value.toLowerCase());
const isProtectedWorkspacePath = (value: string) => protectedWorkspacePaths.has(value.toLowerCase());

const slugify = (value: string) => {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || `bot-${randomUUID().slice(0, 8)}`;
};

const createUniqueSlug = async (name: string) => {
  const base = slugify(name);
  let slug = base;
  let index = 2;
  while (await prisma.botManagerIdentity.findUnique({ where: { slug } })) {
    slug = `${base}-${index}`;
    index += 1;
  }
  return slug;
};

const getEncryptionKey = () => {
  if (!env.botManagerEncryptionKey) throw new Error('BOT_MANAGER_ENCRYPTION_KEY is not configured');
  return createHash('sha256').update(env.botManagerEncryptionKey).digest();
};

const encryptJson = (value: unknown) => {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', getEncryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`;
};

const decryptJson = <T>(value: string): T => {
  const [version, ivRaw, tagRaw, encryptedRaw] = value.split(':');
  if (version !== 'v1' || !ivRaw || !tagRaw || !encryptedRaw) throw new Error('Invalid encrypted value');
  const decipher = createDecipheriv('aes-256-gcm', getEncryptionKey(), Buffer.from(ivRaw, 'base64'));
  decipher.setAuthTag(Buffer.from(tagRaw, 'base64'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encryptedRaw, 'base64')),
    decipher.final()
  ]);
  return JSON.parse(decrypted.toString('utf8')) as T;
};

const maskSecret = (value?: string) => {
  if (!value) return '';
  if (value.length <= 8) return '***';
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
};

const keyPreview = (value: string) => maskSecret(value);

const hasBotManagerAccess = (req: Request) => Boolean(req.user && (isPl7Author(req.user) || isPl7Admin(req.user)));

const requireBotManagerAccess = (req: Request, res: Response) => {
  if (!hasBotManagerAccess(req)) {
    fail(res, 403, 'PL7 author or admin access required', 'FORBIDDEN');
    return false;
  }
  return true;
};

const botManagerRateLimiter = (req: Request, res: Response, next: NextFunction) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    return securityLimiters.botManagerRead(req, res, next);
  }
  return securityLimiters.botManagerWrite(req, res, next);
};

const verifyCredentialGate = async (req: Request, password: string, botManagerKey: string) => {
  if (!env.botManagerKey) throw new Error('BOT_MANAGER_KEY is not configured');
  if (!env.botManagerEncryptionKey) throw new Error('BOT_MANAGER_ENCRYPTION_KEY is not configured');
  if (!safeEquals(botManagerKey, env.botManagerKey)) throw new Error('Bot manager key is invalid');
  const user = await prisma.user.findUnique({ where: { id: req.user!.id } });
  if (!user) throw new Error('Invalid user');
  const passwordOk = await bcrypt.compare(password, user.passwordHash);
  if (!passwordOk) throw new Error('Password confirmation failed');
};

const verifyAccountPassword = async (req: Request, password: string) => {
  const user = await prisma.user.findUnique({ where: { id: req.user!.id } });
  if (!user) throw new Error('Invalid user');
  const passwordOk = await bcrypt.compare(password, user.passwordHash);
  if (!passwordOk) throw new Error('Password confirmation failed');
};

const requireExtractionKey = (key?: string | null) => {
  if (!env.extractionKey) throw new Error('EXTRACTION_KEY is not configured on this backend');
  if (!key || !safeEquals(key, env.extractionKey)) throw new Error('Invalid extraction key');
};

const asJsonRecord = (value: Prisma.JsonValue | Record<string, unknown> | null | undefined): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return { ...(value as Record<string, unknown>) };
};

const asStringArray = (value: Prisma.JsonValue | unknown): string[] => Array.isArray(value)
  ? value.filter((item): item is string => typeof item === 'string')
  : [];

const getRuntimeSyncState = (config: Prisma.JsonValue | Record<string, unknown> | null | undefined) => {
  const raw = asJsonRecord(asJsonRecord(config)[runtimeSyncConfigKey] as Prisma.JsonValue | null | undefined);
  return {
    ...defaultRuntimeSyncState,
    runtimeDirty: typeof raw.runtimeDirty === 'boolean' ? raw.runtimeDirty : defaultRuntimeSyncState.runtimeDirty,
    runtimeDirtySince: typeof raw.runtimeDirtySince === 'string' ? raw.runtimeDirtySince : null,
    runtimeDirtyReason: typeof raw.runtimeDirtyReason === 'string' ? raw.runtimeDirtyReason : null,
    lastRuntimeSyncAt: typeof raw.lastRuntimeSyncAt === 'string' ? raw.lastRuntimeSyncAt : null,
    lastRuntimeSyncError: typeof raw.lastRuntimeSyncError === 'string' ? raw.lastRuntimeSyncError : null
  };
};

const stripInternalGeneralConfig = (config: Prisma.JsonValue | Record<string, unknown> | null | undefined) => {
  const record = asJsonRecord(config);
  delete record[runtimeSyncConfigKey];
  return record;
};

const attachRuntimeSyncState = (
  config: Prisma.JsonValue | Record<string, unknown> | null | undefined,
  runtimeSync: typeof defaultRuntimeSyncState
) => ({
  ...stripInternalGeneralConfig(config),
  [runtimeSyncConfigKey]: runtimeSync
});

const setRuntimeProviderConfig = async (
  actor: string,
  input: { provider: string; openRouterProfileId?: string | null }
) => {
  const current = await ensureGeneralConfig();
  const publicConfig = stripInternalGeneralConfig(current.config);
  const nextConfig = {
    ...publicConfig,
    activeProvider: input.provider,
    activeOpenRouterProfileId: input.openRouterProfileId ?? null
  };
  const runtimeSync = createDirtyRuntimeSyncState(
    getRuntimeSyncState(current.config),
    input.provider === 'openrouter' ? 'OpenRouter profile activated' : `Provider activated: ${input.provider}`
  );
  await prisma.botManagerGeneralConfig.update({
    where: { id: 'default' },
    data: {
      config: attachRuntimeSyncState(nextConfig, runtimeSync) as Prisma.InputJsonValue,
      updatedBy: actor
    }
  });
  return { config: nextConfig, runtimeSync };
};

const createDirtyRuntimeSyncState = (
  previous: typeof defaultRuntimeSyncState,
  reason: string,
  now = new Date().toISOString()
) => ({
  ...previous,
  runtimeDirty: true,
  runtimeDirtySince: previous.runtimeDirty ? previous.runtimeDirtySince ?? now : now,
  runtimeDirtyReason: reason,
  lastRuntimeSyncError: null
});

const markRuntimeDirty = async (actor: string, reason: string) => {
  const current = await ensureGeneralConfig();
  const previous = getRuntimeSyncState(current.config);
  const runtimeSync = createDirtyRuntimeSyncState(previous, reason);
  await prisma.botManagerGeneralConfig.update({
    where: { id: 'default' },
    data: {
      config: attachRuntimeSyncState(current.config, runtimeSync) as Prisma.InputJsonValue,
      updatedBy: actor
    }
  });
  return runtimeSync;
};

const markRuntimeSynced = async (actor: string) => {
  const current = await ensureGeneralConfig();
  const runtimeSync = {
    ...getRuntimeSyncState(current.config),
    runtimeDirty: false,
    runtimeDirtySince: null,
    runtimeDirtyReason: null,
    lastRuntimeSyncAt: new Date().toISOString(),
    lastRuntimeSyncError: null
  };
  await prisma.botManagerGeneralConfig.update({
    where: { id: 'default' },
    data: {
      config: attachRuntimeSyncState(current.config, runtimeSync) as Prisma.InputJsonValue,
      updatedBy: actor
    }
  });
  return runtimeSync;
};

const markRuntimeSyncFailed = async (actor: string, message: string) => {
  const current = await ensureGeneralConfig();
  const previous = getRuntimeSyncState(current.config);
  const now = new Date().toISOString();
  const runtimeSync = {
    ...previous,
    runtimeDirty: true,
    runtimeDirtySince: previous.runtimeDirtySince ?? now,
    runtimeDirtyReason: previous.runtimeDirtyReason ?? 'Runtime sync failed',
    lastRuntimeSyncError: message
  };
  await prisma.botManagerGeneralConfig.update({
    where: { id: 'default' },
    data: {
      config: attachRuntimeSyncState(current.config, runtimeSync) as Prisma.InputJsonValue,
      updatedBy: actor
    }
  });
  return runtimeSync;
};

const backupProgress = (percent: number, stage: string, message: string) => ({ percent, stage, message });

const serializeBackupJob = (job: Awaited<ReturnType<typeof prisma.botManagerBackupJob.findFirst>> | Awaited<ReturnType<typeof prisma.botManagerBackupJob.create>>) => {
  if (!job) return job;
  return {
    ...job,
    progress: job.progress ?? backupProgress(0, 'queued', 'Queued')
  };
};

const formatBotManagerBackupName = (date: Date) => {
  const dd = String(date.getUTCDate()).padStart(2, '0');
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const yy = String(date.getUTCFullYear()).slice(-2);
  const hh = String(date.getUTCHours()).padStart(2, '0');
  const ss = String(date.getUTCSeconds()).padStart(2, '0');
  return `bot-manager_${dd}${mm}${yy}${hh}${ss}.zip`;
};

const buildBotManagerBackupFiles = async (identityIds: string[]): Promise<ZipFile[]> => {
  const where = identityIds.length ? { id: { in: identityIds } } : {};
  const identities = await prisma.botManagerIdentity.findMany({
    where,
    include: { files: true },
    orderBy: [{ isActive: 'desc' }, { name: 'asc' }]
  });
  const files: ZipFile[] = [];
  const manifest = {
    generatedAt: new Date().toISOString(),
    mode: identityIds.length ? 'custom' : 'full',
    identityCount: identities.length,
    activeIdentityId: identities.find((identity) => identity.isActive)?.id ?? null
  };
  files.push({ name: 'manifest.json', content: JSON.stringify(manifest, null, 2) });

  for (const identity of identities) {
    files.push({
      name: `identities/${identity.slug}/identity.json`,
      content: JSON.stringify(serializeIdentity(identity), null, 2)
    });
    for (const workspaceFile of identity.files.sort((left, right) => left.path.localeCompare(right.path))) {
      try {
        const stored = await readFileWithMetadataFromStorage(workspaceFile.objectPath);
        files.push({
          name: `identities/${identity.slug}/workspace/${workspaceFile.path}`,
          content: stored.buffer
        });
      } catch {
        files.push({
          name: `identities/${identity.slug}/workspace/${workspaceFile.path}.missing.txt`,
          content: `Storage object not found: ${workspaceFile.objectPath}`
        });
      }
    }
    if (identity.profileImageObjectPath) {
      try {
        const stored = await readFileWithMetadataFromStorage(identity.profileImageObjectPath);
        files.push({
          name: `identities/${identity.slug}/profile/${identity.profileImageObjectPath.split('/').pop() ?? 'profile-image'}`,
          content: stored.buffer
        });
      } catch {
        files.push({
          name: `identities/${identity.slug}/profile/missing.txt`,
          content: `Storage object not found: ${identity.profileImageObjectPath}`
        });
      }
    }
  }

  return files;
};

const runBotManagerBackupJob = async (jobId: string, actor: string, identityIds: string[], downloadName: string) => {
  try {
    const updateProgress = async (percent: number, stage: string, message: string) => {
      await prisma.botManagerBackupJob.update({
        where: { id: jobId },
        data: { progress: backupProgress(percent, stage, message) }
      });
    };
    await updateProgress(15, 'collecting', 'Collecting Bot Manager personalities');
    const files = await buildBotManagerBackupFiles(identityIds);
    await updateProgress(70, 'compressing', 'Compressing Bot Manager backup');
    const zip = makeZip(files);
    await updateProgress(86, 'uploading', 'Uploading backup artifact');
    const objectPath = `bot-manager/backups/${jobId}/${downloadName}`;
    const stored = await saveFileToStorage({ objectPath, buffer: zip, contentType: 'application/zip' });
    const completed = await prisma.botManagerBackupJob.update({
      where: { id: jobId },
      data: {
        status: 'completed',
        completedAt: new Date(),
        artifactPath: stored.objectPath,
        artifactUrl: stored.url,
        progress: backupProgress(100, 'completed', 'Backup ready')
      }
    });
    await writeAudit(prisma, {
      actor,
      action: 'bot-manager.backup.create',
      entity: 'BotManagerBackupJob',
      entityId: completed.id,
      metadata: { identityCount: identityIds.length || 'all', fileCount: files.length }
    });
  } catch (error) {
    await prisma.botManagerBackupJob.update({
      where: { id: jobId },
      data: {
        status: 'failed',
        error: error instanceof Error ? error.message : 'Bot Manager backup failed',
        progress: backupProgress(100, 'failed', 'Backup failed')
      }
    });
  }
};

type BotManagerBackupTicket = {
  jobId: string;
  actor: string;
  exp: number;
  nonce: string;
};

const signBackupTicketPayload = (payload: string) =>
  createHmac('sha256', env.jwtAccessSecret).update(payload).digest('base64url');

const createBotManagerBackupTicket = (jobId: string, actor: string) => {
  const payload: BotManagerBackupTicket = {
    jobId,
    actor,
    exp: Date.now() + 5 * 60 * 1000,
    nonce: randomUUID()
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${encodedPayload}.${signBackupTicketPayload(encodedPayload)}`;
};

const parseBotManagerBackupTicket = (ticket: string): BotManagerBackupTicket => {
  const [encodedPayload, signature] = ticket.split('.');
  if (!encodedPayload || !signature) throw new Error('Invalid download ticket');
  const expectedSignature = signBackupTicketPayload(encodedPayload);
  const signatureBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expectedSignature);
  if (signatureBuffer.length !== expectedBuffer.length || !timingSafeEqual(signatureBuffer, expectedBuffer)) {
    throw new Error('Invalid download ticket');
  }
  const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8')) as BotManagerBackupTicket;
  if (!payload.jobId || !payload.actor || !payload.exp || payload.exp < Date.now()) {
    throw new Error('Expired download ticket');
  }
  return payload;
};

const sendBotManagerBackupDownload = async (
  res: Response,
  job: { id: string; artifactPath: string | null; downloadName: string | null },
  actor: string
) => {
  if (!job.artifactPath) return fail(res, 404, 'Artifact not found', 'NOT_FOUND');
  await writeAudit(prisma, {
    actor,
    action: 'bot-manager.backup.download',
    entity: 'BotManagerBackupJob',
    entityId: job.id
  });
  const file = await createReadStreamFromStorage(job.artifactPath);
  res.setHeader('Content-Type', file.contentType ?? 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${job.downloadName ?? `bot-manager-backup-${job.id}.zip`}"`);
  if (file.contentLength !== undefined) res.setHeader('Content-Length', String(file.contentLength));
  file.stream.on('error', (error) => {
    if (!res.headersSent) {
      fail(res, 500, 'Download stream failed', 'STORAGE_ERROR');
      return;
    }
    res.destroy(error);
  });
  return file.stream.pipe(res);
};

const serializeIdentity = (identity: IdentityRecord) => ({
  id: identity.id,
  slug: identity.slug,
  name: identity.name,
  roleTitle: identity.roleTitle,
  description: identity.description,
  isActive: identity.isActive,
  profileImageObjectPath: identity.profileImageObjectPath,
  profileImageUrl: identity.profileImageUrl,
  channels: identity.channels,
  settings: identity.settings,
  createdAt: identity.createdAt.toISOString(),
  updatedAt: identity.updatedAt.toISOString(),
  fileCount: identity.files?.length
});

const serializeCredential = (credential: { provider: string; keyPreview?: string | null; metadata?: Prisma.JsonValue | null; updatedAt: Date }) => ({
  provider: credential.provider,
  configured: true,
  keyPreview: credential.keyPreview ?? '***',
  metadata: credential.metadata ?? {},
  updatedAt: credential.updatedAt.toISOString()
});

const serializeOpenRouterProfile = (profile: {
  id: string;
  name: string;
  keyPreview?: string | null;
  modelId: string;
  apiBase?: string | null;
  tags: Prisma.JsonValue;
  notes: string;
  isActive: boolean;
  updatedBy?: string | null;
  createdAt: Date;
  updatedAt: Date;
}) => ({
  id: profile.id,
  name: profile.name,
  configured: true,
  keyPreview: profile.keyPreview ?? '***',
  modelId: profile.modelId,
  apiBase: profile.apiBase ?? '',
  tags: asStringArray(profile.tags),
  notes: profile.notes,
  isActive: profile.isActive,
  updatedBy: profile.updatedBy ?? null,
  createdAt: profile.createdAt.toISOString(),
  updatedAt: profile.updatedAt.toISOString()
});

const listMaskedCredentials = async () => {
  const configured = await prisma.botManagerCredential.findMany({ orderBy: { provider: 'asc' } });
  const byProvider = new Map(configured.map((credential) => [credential.provider, serializeCredential(credential)]));
  return providers.map((provider) => byProvider.get(provider) ?? {
    provider,
    configured: false,
    keyPreview: '',
    metadata: {},
    updatedAt: null
  });
};

const ensureGeneralConfig = async () =>
  prisma.botManagerGeneralConfig.upsert({
    where: { id: 'default' },
    create: { id: 'default', config: attachRuntimeSyncState(defaultGeneralConfig, defaultRuntimeSyncState) },
    update: {}
  });

const fileObjectPath = (slug: string, workspacePath: string) => `bot-manager/workspace/${slug}/${workspacePath}`;

const saveIdentityFile = async (
  identity: { id: string; slug: string },
  input: { path: string; kind: string; content: string; contentType?: string },
  actor: string
) => {
  const workspacePath = normalizeWorkspacePath(input.path);
  if (!workspacePath) throw new Error('Invalid workspace file path');
  const contentType = input.contentType ?? (workspacePath.endsWith('.json') || workspacePath.endsWith('.jsonl') ? 'application/json' : 'text/markdown');
  const objectPath = fileObjectPath(identity.slug, workspacePath);
  const buffer = Buffer.from(input.content, 'utf8');
  await saveFileToStorage({ objectPath, buffer, contentType });
  return prisma.botManagerIdentityFile.upsert({
    where: { identityId_path: { identityId: identity.id, path: workspacePath } },
    create: {
      identityId: identity.id,
      path: workspacePath,
      kind: input.kind,
      contentType,
      objectPath,
      size: buffer.byteLength,
      updatedBy: actor
    },
    update: {
      kind: input.kind,
      contentType,
      objectPath,
      size: buffer.byteLength,
      updatedBy: actor
    }
  });
};

const buildLoreFileContent = (item: {
  id: string;
  name: string;
  type: string | null;
  shortDesc: string;
  fullDesc: string;
  metadata: Prisma.JsonValue | null;
}) => {
  const metadata = asJsonRecord(item.metadata);
  const traits = asStringArray(metadata.traits);
  return [
    `# ${item.name} Lore`,
    '',
    `Source: Morneven Lore/Wiki`,
    `Lore ID: ${item.id}`,
    item.type ? `Type: ${item.type}` : '',
    traits.length ? `Traits: ${traits.join(', ')}` : '',
    '',
    '## Summary',
    item.shortDesc,
    '',
    '## Full Lore',
    item.fullDesc
  ].filter((line) => line !== '').join('\n');
};

const attachLoreFile = async (
  identity: { id: string; slug: string; name: string; roleTitle: string; settings: Prisma.JsonValue },
  loreCharacterId: string,
  actor: string
) => {
  const character = await prisma.loreItem.findFirst({
    where: { id: loreCharacterId, category: EntityType.character }
  });
  if (!character) throw new Error('Lore character not found');

  const currentSettings = asJsonRecord(identity.settings);
  const metadata = asJsonRecord(character.metadata);
  const settings = {
    ...currentSettings,
    loreReference: {
      category: 'characters',
      id: character.id,
      name: character.name,
      traits: asStringArray(metadata.traits)
    }
  };

  await prisma.botManagerIdentity.update({
    where: { id: identity.id },
    data: { settings: settings as Prisma.InputJsonValue, updatedBy: actor }
  });
  await saveIdentityFile(identity, {
    path: 'LORE.md',
    kind: 'identity',
    content: buildLoreFileContent(character),
    contentType: 'text/markdown'
  }, actor);
};

const readIdentityFileContent = async (file: { objectPath: string }) => {
  const stored = await readFileWithMetadataFromStorage(file.objectPath);
  return stored.buffer.toString('utf8');
};

const loadIdentityFiles = async (identity: IdentityWithFiles) => {
  const files = [];
  for (const file of identity.files.sort((left, right) => left.path.localeCompare(right.path))) {
    files.push({
      id: file.id,
      path: file.path,
      kind: file.kind,
      contentType: file.contentType,
      objectPath: file.objectPath,
      size: file.size,
      updatedAt: file.updatedAt.toISOString(),
      content: await readIdentityFileContent(file)
    });
  }
  return files;
};

const buildRuntimeBundle = async () => {
  if (!env.botManagerSyncToken) throw new Error('BOT_MANAGER_SYNC_TOKEN is not configured');
  const activeIdentity = await prisma.botManagerIdentity.findFirst({
    where: { isActive: true },
    include: { files: true }
  });
  if (!activeIdentity) throw new Error('No active bot personality is configured');

  const [generalConfig, credentials] = await Promise.all([
    ensureGeneralConfig(),
    prisma.botManagerCredential.findMany({ orderBy: { provider: 'asc' } })
  ]);
  const publicConfig = stripInternalGeneralConfig(generalConfig.config);
  const credentialMap = new Map(credentials.map((credential) => [credential.provider, credential]));
  const activeProvider = typeof publicConfig.activeProvider === 'string'
    ? publicConfig.activeProvider
    : credentials[0]?.provider ?? null;
  let runtimeCredentials: Record<string, unknown> = {};

  if (activeProvider === 'openrouter') {
    const activeOpenRouterProfileId = typeof publicConfig.activeOpenRouterProfileId === 'string'
      ? publicConfig.activeOpenRouterProfileId
      : undefined;
    const openRouterProfile = activeOpenRouterProfileId
      ? await prisma.botManagerOpenRouterProfile.findUnique({ where: { id: activeOpenRouterProfileId } })
      : await prisma.botManagerOpenRouterProfile.findFirst({ where: { isActive: true }, orderBy: { updatedAt: 'desc' } });
    if (openRouterProfile) {
      runtimeCredentials = {
        openrouter: decryptJson<Record<string, unknown>>(openRouterProfile.encryptedValue)
      };
    }
  } else if (activeProvider && credentialMap.has(activeProvider)) {
    runtimeCredentials = {
      [activeProvider]: decryptJson<Record<string, unknown>>(credentialMap.get(activeProvider)!.encryptedValue)
    };
  }

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    mode: 'single-active-personality',
    generalConfig: publicConfig,
    activeIdentity: serializeIdentity(activeIdentity),
    credentials: runtimeCredentials,
    channels: activeIdentity.channels,
    settings: activeIdentity.settings,
    files: await loadIdentityFiles(activeIdentity)
  };
};

const nanobotBaseUrlCandidates = () => {
  if (!env.nanobotInternalBaseUrl) return [];
  const candidates: string[] = [];
  const addCandidate = (value: string) => {
    const normalized = value.replace(/\/+$/, '');
    if (normalized && !candidates.includes(normalized)) candidates.push(normalized);
  };

  addCandidate(env.nanobotInternalBaseUrl);
  try {
    const parsed = new URL(env.nanobotInternalBaseUrl);
    const isRailwayPrivate = parsed.hostname.endsWith('.railway.internal');
    if (isRailwayPrivate) {
      parsed.protocol = 'http:';
      addCandidate(parsed.toString());
      if (!parsed.port) {
        parsed.port = '8080';
        addCandidate(parsed.toString());
      }
    }
  } catch {
    return candidates;
  }
  return candidates;
};

const describeNanobotFetchError = (error: unknown, endpoint: string) => {
  const baseMessage = error instanceof Error ? error.message : 'request failed';
  const cause = (error as { cause?: { code?: string; message?: string } })?.cause;
  const causeText = cause?.code ? `${cause.code}${cause.message ? `: ${cause.message}` : ''}` : cause?.message;
  const railwayHint = endpoint.includes('.railway.internal')
    ? ' Railway private networking should use http://<private-domain>:<port>, not https.'
    : '';
  return `Nanobot request failed at ${endpoint}: ${causeText ?? baseMessage}.${railwayHint}`;
};

const parseNanobotPayload = async (response: globalThis.Response) => {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
};

const nanobotPayloadMessage = (payload: unknown) => {
  if (payload && typeof payload === 'object') {
    const record = payload as { error?: unknown; message?: unknown };
    if (typeof record.error === 'string') return record.error;
    if (typeof record.message === 'string') return record.message;
  }
  if (typeof payload === 'string' && payload.trim()) return payload;
  return null;
};

const callNanobot = async (path: string, init: { method?: string; body?: unknown } = {}) => {
  if (!env.nanobotInternalBaseUrl || !env.nanobotMornevenReloadToken) {
    throw new Error('Nanobot runtime endpoint is not configured');
  }

  const bases = nanobotBaseUrlCandidates();
  let lastError = `Nanobot request failed: ${path}`;
  for (const base of bases) {
    const endpoint = `${base}${path}`;
    try {
      const response = await fetch(endpoint, {
        method: init.method ?? 'GET',
        headers: {
          'content-type': 'application/json',
          'x-morneven-reload-token': env.nanobotMornevenReloadToken
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body)
      });
      const payload = await parseNanobotPayload(response);
      if (!response.ok) {
        const message = nanobotPayloadMessage(payload) ?? `Nanobot responded with ${response.status}`;
        throw new Error(`${message} (${response.status})`);
      }
      return { endpoint, payload };
    } catch (error) {
      lastError = describeNanobotFetchError(error, endpoint);
      if (error instanceof Error && !error.message.includes('fetch failed')) break;
    }
  }

  throw new Error(lastError);
};

const clearNanobotStatusCache = () => {
  nanobotStatusCache = null;
};

const setNanobotStatusCache = (payload: unknown) => {
  nanobotStatusCache = { payload, cachedAt: Date.now() };
};

const getNanobotStatus = async (force = false) => {
  if (!force && nanobotStatusCache && Date.now() - nanobotStatusCache.cachedAt < nanobotStatusCacheMs) {
    return nanobotStatusCache.payload;
  }
  const { payload } = await callNanobot('/api/morneven/status');
  setNanobotStatusCache(payload);
  return payload;
};

botManagerRouter.get('/runtime/bundle', async (req, res) => {
  const parsed = syncTokenSchema.safeParse({ token: req.header('x-bot-manager-sync-token') });
  if (!parsed.success || !env.botManagerSyncToken || parsed.data.token !== env.botManagerSyncToken) {
    return fail(res, 403, 'Invalid bot manager sync token', 'FORBIDDEN');
  }

  try {
    return ok(res, await buildRuntimeBundle());
  } catch (error) {
    return fail(res, 503, error instanceof Error ? error.message : 'Runtime bundle unavailable', 'BOT_MANAGER_UNAVAILABLE');
  }
});

botManagerRouter.use(auth);
botManagerRouter.use(botManagerRateLimiter);

botManagerRouter.get('/summary', async (req, res) => {
  if (!requireBotManagerAccess(req, res)) return;
  const [generalConfig, credentials, identities, openRouterProfiles] = await Promise.all([
    ensureGeneralConfig(),
    listMaskedCredentials(),
    prisma.botManagerIdentity.findMany({ include: { files: true }, orderBy: [{ isActive: 'desc' }, { updatedAt: 'desc' }] }),
    prisma.botManagerOpenRouterProfile.findMany({ orderBy: [{ isActive: 'desc' }, { updatedAt: 'desc' }], take: 5 })
  ]);
  const publicConfig = stripInternalGeneralConfig(generalConfig.config);

  return ok(res, {
    credentials,
    openRouterProfiles: openRouterProfiles.map(serializeOpenRouterProfile),
    generalConfig: publicConfig,
    identities: identities.map(serializeIdentity),
    runtimeSync: getRuntimeSyncState(generalConfig.config),
    runtimeStatus: {
      nanobotConfigured: Boolean(env.nanobotInternalBaseUrl && env.nanobotMornevenReloadToken),
      singleActivePersonality: true,
      activeIdentityId: identities.find((identity) => identity.isActive)?.id ?? null,
      activeProvider: typeof publicConfig.activeProvider === 'string' ? publicConfig.activeProvider : null,
      activeOpenRouterProfileId: typeof publicConfig.activeOpenRouterProfileId === 'string' ? publicConfig.activeOpenRouterProfileId : null
    }
  });
});

botManagerRouter.get('/runtime/status', async (req, res) => {
  if (!requireBotManagerAccess(req, res)) return;
  try {
    return ok(res, await getNanobotStatus(req.query.fresh === 'true'));
  } catch (error) {
    return fail(res, 502, error instanceof Error ? error.message : 'Nanobot status request failed', 'NANOBOT_REQUEST_FAILED');
  }
});

botManagerRouter.post('/runtime/:action', async (req, res) => {
  if (!requireBotManagerAccess(req, res)) return;
  const parsed = runtimeActionSchema.safeParse(req.params.action);
  if (!parsed.success) return fail(res, 422, 'Invalid nanobot runtime action', 'VALIDATION_ERROR', parsed.error.flatten());

  try {
    clearNanobotStatusCache();
    const { payload } = await callNanobot(`/api/morneven/gateway/${parsed.data}`, {
      method: 'POST',
      body: { requestedBy: req.user!.username }
    });
    setNanobotStatusCache(payload);
    await writeAudit(prisma, {
      actor: req.user!.username,
      action: `bot-manager.runtime.${parsed.data}`,
      entity: 'NanobotGateway',
      metadata: { action: parsed.data }
    });
    return ok(res, payload);
  } catch (error) {
    return fail(res, 502, error instanceof Error ? error.message : 'Nanobot runtime request failed', 'NANOBOT_REQUEST_FAILED');
  }
});

botManagerRouter.post('/credentials/unlock', async (req, res) => {
  if (!requireBotManagerAccess(req, res)) return;
  const parsed = credentialGateSchema.safeParse(req.body);
  if (!parsed.success) return fail(res, 422, 'Validation failed', 'VALIDATION_ERROR', parsed.error.flatten());

  try {
    await verifyCredentialGate(req, parsed.data.password, parsed.data.botManagerKey);
    await writeAudit(prisma, {
      actor: req.user!.username,
      action: 'bot-manager.credential.unlock',
      entity: 'BotManagerCredential',
      metadata: { unlocked: true }
    });
    return ok(res, { unlocked: true, unlockedAt: new Date().toISOString() });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Credential unlock failed';
    return fail(res, message.includes('configured') ? 503 : 403, message, message.includes('configured') ? 'BOT_MANAGER_UNAVAILABLE' : 'FORBIDDEN');
  }
});

botManagerRouter.put('/credentials', async (req, res) => {
  if (!requireBotManagerAccess(req, res)) return;
  const parsed = credentialSchema.safeParse(req.body);
  if (!parsed.success) return fail(res, 422, 'Validation failed', 'VALIDATION_ERROR', parsed.error.flatten());

  try {
    await verifyCredentialGate(req, parsed.data.password, parsed.data.botManagerKey);
    const value = {
      apiKey: parsed.data.apiKey,
      apiBase: parsed.data.apiBase || null,
      modelId: parsed.data.modelId
    };
    const metadata = {
      apiBaseConfigured: Boolean(parsed.data.apiBase),
      modelId: parsed.data.modelId
    };
    const saved = await prisma.botManagerCredential.upsert({
      where: { provider: parsed.data.provider },
      create: {
        provider: parsed.data.provider,
        encryptedValue: encryptJson(value),
        keyPreview: keyPreview(parsed.data.apiKey),
        metadata,
        updatedBy: req.user!.username
      },
      update: {
        encryptedValue: encryptJson(value),
        keyPreview: keyPreview(parsed.data.apiKey),
        metadata,
        updatedBy: req.user!.username
      }
    });
    await writeAudit(prisma, {
      actor: req.user!.username,
      action: 'bot-manager.credential.update',
      entity: 'BotManagerCredential',
      entityId: saved.id,
      metadata: { provider: saved.provider }
    });
    await markRuntimeDirty(req.user!.username, `Credential updated: ${saved.provider}`);
    return ok(res, serializeCredential(saved));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Credential update failed';
    return fail(res, message.includes('configured') ? 503 : 403, message, message.includes('configured') ? 'BOT_MANAGER_UNAVAILABLE' : 'FORBIDDEN');
  }
});

botManagerRouter.patch('/credentials/:provider/activate', async (req, res) => {
  if (!requireBotManagerAccess(req, res)) return;
  const provider = z.enum(providers).safeParse(req.params.provider);
  if (!provider.success || provider.data === 'openrouter') {
    return fail(res, 422, 'Invalid provider activation target', 'VALIDATION_ERROR');
  }
  const parsed = providerActivationSchema.safeParse(req.body);
  if (!parsed.success) return fail(res, 422, 'Validation failed', 'VALIDATION_ERROR', parsed.error.flatten());

  try {
    await verifyCredentialGate(req, parsed.data.password, parsed.data.botManagerKey);
    const credential = await prisma.botManagerCredential.findUnique({ where: { provider: provider.data } });
    if (!credential) return fail(res, 409, 'Provider credential is incomplete', 'PROVIDER_INCOMPLETE');
    await prisma.botManagerOpenRouterProfile.updateMany({ where: { isActive: true }, data: { isActive: false, updatedBy: req.user!.username } });
    const result = await setRuntimeProviderConfig(req.user!.username, { provider: provider.data });
    await writeAudit(prisma, {
      actor: req.user!.username,
      action: 'bot-manager.provider.activate',
      entity: 'BotManagerCredential',
      entityId: credential.id,
      metadata: { provider: provider.data }
    });
    return ok(res, result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Provider activation failed';
    return fail(res, message.includes('configured') ? 503 : 403, message, message.includes('configured') ? 'BOT_MANAGER_UNAVAILABLE' : 'FORBIDDEN');
  }
});

botManagerRouter.get('/openrouter-profiles', async (req, res) => {
  if (!requireBotManagerAccess(req, res)) return;
  const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
  const filter = typeof req.query.filter === 'string' ? req.query.filter : 'all';
  const page = Math.max(Number(req.query.page ?? 1) || 1, 1);
  const pageSize = Math.min(Math.max(Number(req.query.pageSize ?? 6) || 6, 1), 50);
  const where: Prisma.BotManagerOpenRouterProfileWhereInput = {
    ...(search
      ? {
          OR: [
            { name: { contains: search, mode: 'insensitive' } },
            { modelId: { contains: search, mode: 'insensitive' } },
            { notes: { contains: search, mode: 'insensitive' } }
          ]
        }
      : {}),
    ...(filter === 'active' ? { isActive: true } : {}),
    ...(filter === 'incomplete' ? { OR: [{ modelId: '' }, { keyPreview: null }] } : {})
  };
  const [items, total] = await Promise.all([
    prisma.botManagerOpenRouterProfile.findMany({
      where,
      orderBy: [{ isActive: 'desc' }, { updatedAt: 'desc' }],
      skip: (page - 1) * pageSize,
      take: pageSize
    }),
    prisma.botManagerOpenRouterProfile.count({ where })
  ]);
  return ok(res, { items: items.map(serializeOpenRouterProfile), page, pageSize, total, totalPages: Math.max(Math.ceil(total / pageSize), 1) });
});

botManagerRouter.post('/openrouter-profiles', async (req, res) => {
  if (!requireBotManagerAccess(req, res)) return;
  const parsed = openRouterProfileSchema.safeParse(req.body);
  if (!parsed.success) return fail(res, 422, 'Validation failed', 'VALIDATION_ERROR', parsed.error.flatten());
  try {
    await verifyCredentialGate(req, parsed.data.password, parsed.data.botManagerKey);
    const value = {
      apiKey: parsed.data.apiKey,
      apiBase: parsed.data.apiBase || null,
      modelId: parsed.data.modelId
    };
    const created = await prisma.botManagerOpenRouterProfile.create({
      data: {
        name: parsed.data.name,
        encryptedValue: encryptJson(value),
        keyPreview: keyPreview(parsed.data.apiKey),
        modelId: parsed.data.modelId,
        apiBase: parsed.data.apiBase || null,
        tags: parsed.data.tags as Prisma.InputJsonValue,
        notes: parsed.data.notes,
        updatedBy: req.user!.username
      }
    });
    await markRuntimeDirty(req.user!.username, `OpenRouter profile created: ${created.name}`);
    return res.status(201).json({ success: true, data: serializeOpenRouterProfile(created) });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'OpenRouter profile create failed';
    return fail(res, message.includes('configured') ? 503 : 403, message, message.includes('configured') ? 'BOT_MANAGER_UNAVAILABLE' : 'FORBIDDEN');
  }
});

botManagerRouter.put('/openrouter-profiles/:id', async (req, res) => {
  if (!requireBotManagerAccess(req, res)) return;
  const parsed = openRouterProfileSchema.safeParse(req.body);
  if (!parsed.success) return fail(res, 422, 'Validation failed', 'VALIDATION_ERROR', parsed.error.flatten());
  try {
    await verifyCredentialGate(req, parsed.data.password, parsed.data.botManagerKey);
    const existing = await prisma.botManagerOpenRouterProfile.findUnique({ where: { id: req.params.id } });
    if (!existing) return fail(res, 404, 'OpenRouter profile not found', 'NOT_FOUND');
    const value = {
      apiKey: parsed.data.apiKey,
      apiBase: parsed.data.apiBase || null,
      modelId: parsed.data.modelId
    };
    const updated = await prisma.botManagerOpenRouterProfile.update({
      where: { id: existing.id },
      data: {
        name: parsed.data.name,
        encryptedValue: encryptJson(value),
        keyPreview: keyPreview(parsed.data.apiKey),
        modelId: parsed.data.modelId,
        apiBase: parsed.data.apiBase || null,
        tags: parsed.data.tags as Prisma.InputJsonValue,
        notes: parsed.data.notes,
        updatedBy: req.user!.username
      }
    });
    await markRuntimeDirty(req.user!.username, `OpenRouter profile updated: ${updated.name}`);
    return ok(res, serializeOpenRouterProfile(updated));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'OpenRouter profile update failed';
    return fail(res, message.includes('configured') ? 503 : 403, message, message.includes('configured') ? 'BOT_MANAGER_UNAVAILABLE' : 'FORBIDDEN');
  }
});

botManagerRouter.patch('/openrouter-profiles/:id/activate', async (req, res) => {
  if (!requireBotManagerAccess(req, res)) return;
  const parsed = credentialGateSchema.safeParse(req.body);
  if (!parsed.success) return fail(res, 422, 'Validation failed', 'VALIDATION_ERROR', parsed.error.flatten());
  try {
    await verifyCredentialGate(req, parsed.data.password, parsed.data.botManagerKey);
    const existing = await prisma.botManagerOpenRouterProfile.findUnique({ where: { id: req.params.id } });
    if (!existing) return fail(res, 404, 'OpenRouter profile not found', 'NOT_FOUND');
    await prisma.$transaction([
      prisma.botManagerOpenRouterProfile.updateMany({ where: { isActive: true }, data: { isActive: false, updatedBy: req.user!.username } }),
      prisma.botManagerOpenRouterProfile.update({ where: { id: existing.id }, data: { isActive: true, updatedBy: req.user!.username } })
    ]);
    const result = await setRuntimeProviderConfig(req.user!.username, { provider: 'openrouter', openRouterProfileId: existing.id });
    const activated = await prisma.botManagerOpenRouterProfile.findUniqueOrThrow({ where: { id: existing.id } });
    return ok(res, { ...result, profile: serializeOpenRouterProfile(activated) });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'OpenRouter profile activation failed';
    return fail(res, message.includes('configured') ? 503 : 403, message, message.includes('configured') ? 'BOT_MANAGER_UNAVAILABLE' : 'FORBIDDEN');
  }
});

botManagerRouter.delete('/openrouter-profiles/:id', async (req, res) => {
  if (!requireBotManagerAccess(req, res)) return;
  const parsed = credentialGateSchema.safeParse(req.body);
  if (!parsed.success) return fail(res, 422, 'Validation failed', 'VALIDATION_ERROR', parsed.error.flatten());
  try {
    await verifyCredentialGate(req, parsed.data.password, parsed.data.botManagerKey);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Credential gate failed';
    return fail(res, message.includes('configured') ? 503 : 403, message, message.includes('configured') ? 'BOT_MANAGER_UNAVAILABLE' : 'FORBIDDEN');
  }
  const existing = await prisma.botManagerOpenRouterProfile.findUnique({ where: { id: req.params.id } });
  if (!existing) return fail(res, 404, 'OpenRouter profile not found', 'NOT_FOUND');
  const generalConfig = await ensureGeneralConfig();
  const publicConfig = stripInternalGeneralConfig(generalConfig.config);
  if (existing.isActive || publicConfig.activeOpenRouterProfileId === existing.id) {
    return fail(res, 409, 'Active OpenRouter profile cannot be deleted', 'ACTIVE_PROFILE');
  }
  await prisma.botManagerOpenRouterProfile.delete({ where: { id: existing.id } });
  await markRuntimeDirty(req.user!.username, `OpenRouter profile deleted: ${existing.name}`);
  return ok(res, { deleted: true });
});

botManagerRouter.put('/general-config', async (req, res) => {
  if (!requireBotManagerAccess(req, res)) return;
  const parsed = generalConfigSchema.safeParse(req.body);
  if (!parsed.success) return fail(res, 422, 'Validation failed', 'VALIDATION_ERROR', parsed.error.flatten());
  const current = await ensureGeneralConfig();
  const config = stripInternalGeneralConfig(parsed.data.config as Prisma.JsonValue);
  const runtimeSync = createDirtyRuntimeSyncState(getRuntimeSyncState(current.config), 'General config updated');
  const saved = await prisma.botManagerGeneralConfig.upsert({
    where: { id: 'default' },
    create: {
      id: 'default',
      config: attachRuntimeSyncState(config, runtimeSync) as Prisma.InputJsonValue,
      updatedBy: req.user!.username
    },
    update: {
      config: attachRuntimeSyncState(config, runtimeSync) as Prisma.InputJsonValue,
      updatedBy: req.user!.username
    }
  });
  return ok(res, stripInternalGeneralConfig(saved.config));
});

botManagerRouter.get('/identities', async (req, res) => {
  if (!requireBotManagerAccess(req, res)) return;
  const identities = await prisma.botManagerIdentity.findMany({ include: { files: true }, orderBy: [{ isActive: 'desc' }, { updatedAt: 'desc' }] });
  return ok(res, identities.map(serializeIdentity));
});

botManagerRouter.post('/identities', async (req, res) => {
  if (!requireBotManagerAccess(req, res)) return;
  const parsed = identitySchema.safeParse(req.body);
  if (!parsed.success) return fail(res, 422, 'Validation failed', 'VALIDATION_ERROR', parsed.error.flatten());

  const [slug, activeCount] = await Promise.all([
    createUniqueSlug(parsed.data.name),
    prisma.botManagerIdentity.count({ where: { isActive: true } })
  ]);
  const identity = await prisma.botManagerIdentity.create({
    data: {
      slug,
      name: parsed.data.name,
      roleTitle: parsed.data.roleTitle,
      description: parsed.data.description,
      channels: parsed.data.channels as Prisma.InputJsonValue,
      settings: parsed.data.settings as Prisma.InputJsonValue,
      isActive: activeCount === 0,
      createdBy: req.user!.username,
      updatedBy: req.user!.username
    }
  });

  for (const file of defaultIdentityFiles(identity.name, identity.roleTitle)) {
    await saveIdentityFile(identity, file, req.user!.username);
  }
  if (parsed.data.loreCharacterId) {
    await attachLoreFile({
      id: identity.id,
      slug: identity.slug,
      name: identity.name,
      roleTitle: identity.roleTitle,
      settings: identity.settings
    }, parsed.data.loreCharacterId, req.user!.username);
  }

  const created = await prisma.botManagerIdentity.findUniqueOrThrow({ where: { id: identity.id }, include: { files: true } });
  await markRuntimeDirty(req.user!.username, `Personality created: ${created.name}`);
  return res.status(201).json({ success: true, data: serializeIdentity(created) });
});

botManagerRouter.get('/identities/:id', async (req, res) => {
  if (!requireBotManagerAccess(req, res)) return;
  const identity = await prisma.botManagerIdentity.findUnique({ where: { id: req.params.id }, include: { files: true } });
  if (!identity) return fail(res, 404, 'Bot personality not found', 'NOT_FOUND');
  return ok(res, { ...serializeIdentity(identity), files: await loadIdentityFiles(identity) });
});

botManagerRouter.put('/identities/:id', async (req, res) => {
  if (!requireBotManagerAccess(req, res)) return;
  const parsed = identityUpdateSchema.safeParse(req.body);
  if (!parsed.success) return fail(res, 422, 'Validation failed', 'VALIDATION_ERROR', parsed.error.flatten());
  const existing = await prisma.botManagerIdentity.findUnique({ where: { id: req.params.id } });
  if (!existing) return fail(res, 404, 'Bot personality not found', 'NOT_FOUND');
  const updated = await prisma.botManagerIdentity.update({
    where: { id: existing.id },
    data: {
      ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
      ...(parsed.data.roleTitle !== undefined ? { roleTitle: parsed.data.roleTitle } : {}),
      ...(parsed.data.description !== undefined ? { description: parsed.data.description } : {}),
      ...(parsed.data.channels !== undefined ? { channels: parsed.data.channels as Prisma.InputJsonValue } : {}),
      ...(parsed.data.settings !== undefined ? { settings: parsed.data.settings as Prisma.InputJsonValue } : {}),
      updatedBy: req.user!.username
    },
    include: { files: true }
  });
  if (parsed.data.loreCharacterId) {
    await attachLoreFile({
      id: updated.id,
      slug: updated.slug,
      name: updated.name,
      roleTitle: updated.roleTitle,
      settings: updated.settings
    }, parsed.data.loreCharacterId, req.user!.username);
  }
  await markRuntimeDirty(req.user!.username, `Personality updated: ${updated.name}`);
  const latest = await prisma.botManagerIdentity.findUniqueOrThrow({ where: { id: updated.id }, include: { files: true } });
  return ok(res, serializeIdentity(latest));
});

botManagerRouter.patch('/identities/:id/activate', async (req, res) => {
  if (!requireBotManagerAccess(req, res)) return;
  const existing = await prisma.botManagerIdentity.findUnique({ where: { id: req.params.id } });
  if (!existing) return fail(res, 404, 'Bot personality not found', 'NOT_FOUND');
  const [, activated] = await prisma.$transaction([
    prisma.botManagerIdentity.updateMany({ where: { isActive: true }, data: { isActive: false, updatedBy: req.user!.username } }),
    prisma.botManagerIdentity.update({ where: { id: existing.id }, data: { isActive: true, updatedBy: req.user!.username }, include: { files: true } })
  ]);
  await markRuntimeDirty(req.user!.username, `Active personality changed: ${activated.name}`);
  return ok(res, serializeIdentity(activated));
});

botManagerRouter.delete('/identities/:id', async (req, res) => {
  if (!requireBotManagerAccess(req, res)) return;
  const existing = await prisma.botManagerIdentity.findUnique({ where: { id: req.params.id }, include: { files: true } });
  if (!existing) return fail(res, 404, 'Bot personality not found', 'NOT_FOUND');
  if (existing.isActive) return fail(res, 409, 'Active personality cannot be deleted', 'ACTIVE_PERSONALITY');
  await prisma.botManagerIdentity.delete({ where: { id: existing.id } });
  await Promise.allSettled([
    ...existing.files.map((file) => deleteFileFromStorage(file.objectPath)),
    existing.profileImageObjectPath ? deleteFileFromStorage(existing.profileImageObjectPath) : Promise.resolve()
  ]);
  await markRuntimeDirty(req.user!.username, `Personality deleted: ${existing.name}`);
  await writeAudit(prisma, {
    actor: req.user!.username,
    action: 'bot-manager.identity.delete',
    entity: 'BotManagerIdentity',
    entityId: existing.id,
    metadata: { name: existing.name }
  });
  return ok(res, { deleted: true });
});

botManagerRouter.get('/identities/:id/files', async (req, res) => {
  if (!requireBotManagerAccess(req, res)) return;
  const identity = await prisma.botManagerIdentity.findUnique({ where: { id: req.params.id }, include: { files: true } });
  if (!identity) return fail(res, 404, 'Bot personality not found', 'NOT_FOUND');
  return ok(res, await loadIdentityFiles(identity));
});

botManagerRouter.get('/identities/:id/files/proxy', async (req, res) => {
  if (!requireBotManagerAccess(req, res)) return;
  const objectPath = typeof req.query.path === 'string' ? req.query.path : '';
  const identity = await prisma.botManagerIdentity.findUnique({ where: { id: req.params.id }, include: { files: true } });
  if (!identity) return fail(res, 404, 'Bot personality not found', 'NOT_FOUND');
  const allowed = new Set([
    identity.profileImageObjectPath,
    ...identity.files.map((file) => file.objectPath)
  ].filter((value): value is string => Boolean(value)));
  if (!allowed.has(objectPath)) return fail(res, 403, 'File path is not part of this personality', 'FORBIDDEN');

  try {
    const stored = await readFileWithMetadataFromStorage(objectPath);
    res.setHeader('Content-Type', stored.contentType ?? 'application/octet-stream');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (typeof stored.contentLength === 'number') res.setHeader('Content-Length', String(stored.contentLength));
    return res.send(stored.buffer);
  } catch (error) {
    return fail(res, 404, error instanceof Error ? error.message : 'File not found', 'NOT_FOUND');
  }
});

botManagerRouter.put('/identities/:id/files', async (req, res) => {
  if (!requireBotManagerAccess(req, res)) return;
  const parsed = fileSchema.safeParse(req.body);
  if (!parsed.success) return fail(res, 422, 'Validation failed', 'VALIDATION_ERROR', parsed.error.flatten());
  const workspacePath = normalizeWorkspacePath(parsed.data.path);
  if (workspacePath && isReadOnlyWorkspacePath(workspacePath)) {
    return fail(res, 403, 'This workspace file is read-only and managed by runtime history', 'FORBIDDEN');
  }
  const identity = await prisma.botManagerIdentity.findUnique({ where: { id: req.params.id } });
  if (!identity) return fail(res, 404, 'Bot personality not found', 'NOT_FOUND');

  try {
    const file = await saveIdentityFile(identity, parsed.data, req.user!.username);
    await markRuntimeDirty(req.user!.username, `Workspace file saved: ${file.path}`);
    return ok(res, { ...file, content: parsed.data.content, updatedAt: file.updatedAt.toISOString() });
  } catch (error) {
    return fail(res, 422, error instanceof Error ? error.message : 'File save failed', 'VALIDATION_ERROR');
  }
});

botManagerRouter.delete('/identities/:id/files', async (req, res) => {
  if (!requireBotManagerAccess(req, res)) return;
  const parsed = fileDeleteSchema.safeParse(req.body ?? {});
  if (!parsed.success) return fail(res, 422, 'Validation failed', 'VALIDATION_ERROR', parsed.error.flatten());
  const workspacePath = normalizeWorkspacePath(parsed.data.path);
  if (!workspacePath) return fail(res, 422, 'Invalid workspace file path', 'VALIDATION_ERROR');
  if (isProtectedWorkspacePath(workspacePath)) {
    return fail(res, 403, 'Default workspace files are protected from delete', 'FORBIDDEN');
  }
  const identity = await prisma.botManagerIdentity.findUnique({ where: { id: req.params.id }, include: { files: true } });
  if (!identity) return fail(res, 404, 'Bot personality not found', 'NOT_FOUND');
  const file = identity.files.find((item) => item.path === workspacePath);
  if (!file) return fail(res, 404, 'Workspace file not found', 'NOT_FOUND');
  await prisma.botManagerIdentityFile.delete({ where: { id: file.id } });
  await deleteFileFromStorage(file.objectPath).catch(() => undefined);
  await markRuntimeDirty(req.user!.username, `Workspace file deleted: ${file.path}`);
  return ok(res, { deleted: true });
});

botManagerRouter.post('/identities/:id/profile-image', upload.single('file'), async (req, res) => {
  if (!requireBotManagerAccess(req, res)) return;
  const identity = await prisma.botManagerIdentity.findUnique({ where: { id: req.params.id } });
  if (!identity) return fail(res, 404, 'Bot personality not found', 'NOT_FOUND');
  if (!req.file) return fail(res, 400, 'File is required', 'VALIDATION_ERROR');
  if (!req.file.mimetype.startsWith('image/')) return fail(res, 400, 'Profile image must be an image', 'VALIDATION_ERROR');

  const safeName = req.file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_') || 'profile-image';
  const objectPath = `bot-manager/profiles/${identity.id}/${Date.now()}-${safeName}`;
  const scan = await scanUploadBuffer({ objectPath, buffer: req.file.buffer, mime: req.file.mimetype });
  if (scan.verdict === 'blocked' || scan.verdict === 'quarantined') {
    return fail(res, 400, scan.reason ?? 'Upload blocked by security policy', 'FILE_BLOCKED');
  }

  const stored = await saveFileToStorage({ objectPath, buffer: req.file.buffer, contentType: req.file.mimetype });
  const updated = await prisma.botManagerIdentity.update({
    where: { id: identity.id },
    data: {
      profileImageObjectPath: stored.objectPath,
      profileImageUrl: stored.url,
      updatedBy: req.user!.username
    },
    include: { files: true }
  });
  if (identity.isActive) {
    await markRuntimeDirty(req.user!.username, `Profile image updated: ${updated.name}`);
  }
  return ok(res, serializeIdentity(updated));
});

botManagerRouter.get('/backups', async (req, res) => {
  if (!requireBotManagerAccess(req, res)) return;
  const page = Math.max(Number(req.query.page ?? 1) || 1, 1);
  const pageSize = Math.min(Math.max(Number(req.query.pageSize ?? 8) || 8, 1), 50);
  const status = typeof req.query.status === 'string' && req.query.status !== 'all' ? req.query.status : undefined;
  const mode = typeof req.query.mode === 'string' && req.query.mode !== 'all' ? req.query.mode : undefined;
  const where: Prisma.BotManagerBackupJobWhereInput = {
    createdBy: req.user!.username,
    expiresAt: { gt: new Date() },
    ...(status ? { status } : {}),
    ...(mode ? { mode } : {})
  };
  const [items, total] = await Promise.all([
    prisma.botManagerBackupJob.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize
    }),
    prisma.botManagerBackupJob.count({ where })
  ]);
  return ok(res, { items: items.map(serializeBackupJob), page, pageSize, total, totalPages: Math.max(Math.ceil(total / pageSize), 1) });
});

botManagerRouter.post('/backups', async (req, res) => {
  if (!requireBotManagerAccess(req, res)) return;
  const parsed = backupSchema.safeParse(req.body);
  if (!parsed.success) return fail(res, 422, 'Validation failed', 'VALIDATION_ERROR', parsed.error.flatten());
  try {
    requireExtractionKey(parsed.data.secretKey);
    await verifyAccountPassword(req, parsed.data.password);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Backup authorization failed';
    return fail(res, message.includes('configured') ? 503 : 403, message, message.includes('configured') ? 'EXTRACTION_UNAVAILABLE' : 'FORBIDDEN');
  }

  const identityIds = parsed.data.mode === 'custom' ? Array.from(new Set(parsed.data.identityIds)) : [];
  if (parsed.data.mode === 'custom' && identityIds.length === 0) {
    return fail(res, 422, 'Select at least one personality for custom backup', 'VALIDATION_ERROR');
  }
  if (identityIds.length) {
    const count = await prisma.botManagerIdentity.count({ where: { id: { in: identityIds } } });
    if (count !== identityIds.length) return fail(res, 422, 'One or more selected personalities were not found', 'VALIDATION_ERROR');
  }

  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + 30 * 24 * 60 * 60 * 1000);
  const downloadName = formatBotManagerBackupName(createdAt);
  const job = await prisma.botManagerBackupJob.create({
    data: {
      mode: parsed.data.mode,
      status: 'processing',
      identityIds: identityIds as Prisma.InputJsonValue,
      createdBy: req.user!.username,
      expiresAt,
      downloadName,
      progress: backupProgress(0, 'queued', 'Queued')
    }
  });
  setImmediate(() => {
    void runBotManagerBackupJob(job.id, req.user!.username, identityIds, downloadName);
  });
  return res.status(202).json({ success: true, data: serializeBackupJob(job) });
});

botManagerRouter.get('/backups/:id', async (req, res) => {
  if (!requireBotManagerAccess(req, res)) return;
  const job = await prisma.botManagerBackupJob.findFirst({ where: { id: req.params.id, createdBy: req.user!.username } });
  if (!job) return fail(res, 404, 'Bot Manager backup job not found', 'NOT_FOUND');
  return ok(res, serializeBackupJob(job));
});

botManagerRouter.post('/backups/:id/download-ticket', async (req, res) => {
  if (!requireBotManagerAccess(req, res)) return;
  const parsed = backupDownloadTicketSchema.safeParse(req.body);
  if (!parsed.success) return fail(res, 422, 'Validation failed', 'VALIDATION_ERROR', parsed.error.flatten());
  try {
    requireExtractionKey(parsed.data.secretKey);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid extraction key';
    return fail(res, message.includes('configured') ? 503 : 403, message, message.includes('configured') ? 'EXTRACTION_UNAVAILABLE' : 'FORBIDDEN');
  }
  const job = await prisma.botManagerBackupJob.findFirst({ where: { id: req.params.id, createdBy: req.user!.username } });
  if (!job || job.status !== 'completed' || !job.artifactPath) return fail(res, 404, 'Artifact not found', 'NOT_FOUND');
  return ok(res, {
    ticket: createBotManagerBackupTicket(job.id, req.user!.username),
    expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString()
  });
});

botManagerRouter.get('/backups/:id/download', async (req, res, next: NextFunction) => {
  const ticket = typeof req.query.ticket === 'string' ? req.query.ticket : null;
  if (!ticket) return next();
  try {
    const payload = parseBotManagerBackupTicket(ticket);
    if (payload.jobId !== req.params.id) return fail(res, 403, 'Invalid download ticket', 'FORBIDDEN');
    const job = await prisma.botManagerBackupJob.findFirst({ where: { id: payload.jobId, createdBy: payload.actor } });
    if (!job || job.status !== 'completed' || !job.artifactPath) return fail(res, 404, 'Artifact not found', 'NOT_FOUND');
    return sendBotManagerBackupDownload(res, job, payload.actor);
  } catch (error) {
    return fail(res, 403, error instanceof Error ? error.message : 'Invalid download ticket', 'FORBIDDEN');
  }
});

botManagerRouter.get('/backups/:id/download', async (req, res) => {
  if (!requireBotManagerAccess(req, res)) return;
  const job = await prisma.botManagerBackupJob.findFirst({ where: { id: req.params.id, createdBy: req.user!.username } });
  if (!job || job.status !== 'completed' || !job.artifactPath) return fail(res, 404, 'Artifact not found', 'NOT_FOUND');
  return sendBotManagerBackupDownload(res, job, req.user!.username);
});

botManagerRouter.delete('/backups', async (req, res) => {
  if (!requireBotManagerAccess(req, res)) return;
  const parsed = clearBackupSchema.safeParse(req.body ?? {});
  if (!parsed.success) return fail(res, 422, 'Validation failed', 'VALIDATION_ERROR', parsed.error.flatten());
  const where = parsed.data.ids?.length
    ? { createdBy: req.user!.username, id: { in: parsed.data.ids } }
    : { createdBy: req.user!.username };
  const jobs = await prisma.botManagerBackupJob.findMany({ where, select: { artifactPath: true } });
  const result = await prisma.botManagerBackupJob.deleteMany({ where });
  await Promise.allSettled(jobs.map((job) => job.artifactPath ? deleteFileFromStorage(job.artifactPath) : Promise.resolve()));
  await writeAudit(prisma, {
    actor: req.user!.username,
    action: 'bot-manager.backup.delete',
    entity: 'BotManagerBackupJob',
    metadata: { count: result.count }
  });
  return ok(res, { deleted: result.count });
});

botManagerRouter.post('/sync', async (req, res) => {
  if (!requireBotManagerAccess(req, res)) return;
  let bundle;
  try {
    bundle = await buildRuntimeBundle();
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Runtime bundle unavailable';
    await markRuntimeSyncFailed(req.user!.username, message);
    return fail(res, 409, message, 'BOT_MANAGER_UNAVAILABLE');
  }

  if (!env.nanobotInternalBaseUrl || !env.nanobotMornevenReloadToken) {
    const message = 'Nanobot reload endpoint is not configured';
    const runtimeSync = await markRuntimeSyncFailed(req.user!.username, message);
    return fail(res, 502, message, 'NANOBOT_RELOAD_FAILED', { runtimeSync });
  }

  try {
    clearNanobotStatusCache();
    const { payload } = await callNanobot('/api/morneven/reload', {
      method: 'POST',
      body: { requestedBy: req.user!.username }
    });
    setNanobotStatusCache(payload);
    const runtimeSync = await markRuntimeSynced(req.user!.username);
    return ok(res, {
      synced: true,
      runtimeSync,
      bundle,
      nanobot: payload
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Nanobot reload failed';
    const runtimeSync = await markRuntimeSyncFailed(req.user!.username, message);
    return fail(res, 502, message, 'NANOBOT_RELOAD_FAILED', { runtimeSync });
  }
});
