import { Request, Response, Router } from 'express';
import bcrypt from 'bcryptjs';
import multer from 'multer';
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { prisma } from '../../config/prisma.js';
import { readFileWithMetadataFromStorage, saveFileToStorage } from '../../config/storage.js';
import { auth, isPl7Admin, isPl7Author } from '../../middleware/auth.js';
import { scanUploadBuffer } from '../../security/files/scanner.js';
import { fail, ok } from '../../utils/response.js';
import { writeAudit } from '../../utils/audit.js';

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

const generalConfigSchema = z.object({
  config: z.record(z.unknown()).default({})
});

const identitySchema = z.object({
  name: z.string().trim().min(2).max(80),
  roleTitle: z.string().trim().min(2).max(120),
  description: z.string().trim().max(1200).optional().default(''),
  channels: z.record(z.unknown()).optional().default({}),
  settings: z.record(z.unknown()).optional().default({})
});

const identityUpdateSchema = identitySchema.partial();

const fileSchema = z.object({
  path: z.string().trim().min(1).max(240),
  kind: z.enum(fileKinds).default('other'),
  content: z.string().max(500000),
  contentType: z.string().trim().min(3).max(120).optional()
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

const readOnlyWorkspacePaths = new Set(['memory/history.jsonl']);

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

const verifyCredentialGate = async (req: Request, password: string, botManagerKey: string) => {
  if (!env.botManagerKey) throw new Error('BOT_MANAGER_KEY is not configured');
  if (!env.botManagerEncryptionKey) throw new Error('BOT_MANAGER_ENCRYPTION_KEY is not configured');
  if (!safeEquals(botManagerKey, env.botManagerKey)) throw new Error('Bot manager key is invalid');
  const user = await prisma.user.findUnique({ where: { id: req.user!.id } });
  if (!user) throw new Error('Invalid user');
  const passwordOk = await bcrypt.compare(password, user.passwordHash);
  if (!passwordOk) throw new Error('Password confirmation failed');
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
    create: { id: 'default', config: defaultGeneralConfig },
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

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    mode: 'single-active-personality',
    generalConfig: generalConfig.config,
    activeIdentity: serializeIdentity(activeIdentity),
    credentials: Object.fromEntries(
      credentials.map((credential) => [
        credential.provider,
        decryptJson<Record<string, unknown>>(credential.encryptedValue)
      ])
    ),
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

botManagerRouter.get('/summary', async (req, res) => {
  if (!requireBotManagerAccess(req, res)) return;
  const [generalConfig, credentials, identities] = await Promise.all([
    ensureGeneralConfig(),
    listMaskedCredentials(),
    prisma.botManagerIdentity.findMany({ include: { files: true }, orderBy: [{ isActive: 'desc' }, { updatedAt: 'desc' }] })
  ]);

  return ok(res, {
    credentials,
    generalConfig: generalConfig.config,
    identities: identities.map(serializeIdentity),
    runtimeStatus: {
      nanobotConfigured: Boolean(env.nanobotInternalBaseUrl && env.nanobotMornevenReloadToken),
      singleActivePersonality: true,
      activeIdentityId: identities.find((identity) => identity.isActive)?.id ?? null
    }
  });
});

botManagerRouter.get('/runtime/status', async (req, res) => {
  if (!requireBotManagerAccess(req, res)) return;
  try {
    const { payload } = await callNanobot('/api/morneven/status');
    return ok(res, payload);
  } catch (error) {
    return fail(res, 502, error instanceof Error ? error.message : 'Nanobot status request failed', 'NANOBOT_REQUEST_FAILED');
  }
});

botManagerRouter.post('/runtime/:action', async (req, res) => {
  if (!requireBotManagerAccess(req, res)) return;
  const parsed = runtimeActionSchema.safeParse(req.params.action);
  if (!parsed.success) return fail(res, 422, 'Invalid nanobot runtime action', 'VALIDATION_ERROR', parsed.error.flatten());

  try {
    const { payload } = await callNanobot(`/api/morneven/gateway/${parsed.data}`, {
      method: 'POST',
      body: { requestedBy: req.user!.username }
    });
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
    return ok(res, serializeCredential(saved));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Credential update failed';
    return fail(res, message.includes('configured') ? 503 : 403, message, message.includes('configured') ? 'BOT_MANAGER_UNAVAILABLE' : 'FORBIDDEN');
  }
});

botManagerRouter.put('/general-config', async (req, res) => {
  if (!requireBotManagerAccess(req, res)) return;
  const parsed = generalConfigSchema.safeParse(req.body);
  if (!parsed.success) return fail(res, 422, 'Validation failed', 'VALIDATION_ERROR', parsed.error.flatten());
  const config = parsed.data.config as Prisma.InputJsonValue;
  const saved = await prisma.botManagerGeneralConfig.upsert({
    where: { id: 'default' },
    create: { id: 'default', config, updatedBy: req.user!.username },
    update: { config, updatedBy: req.user!.username }
  });
  return ok(res, saved.config);
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

  const created = await prisma.botManagerIdentity.findUniqueOrThrow({ where: { id: identity.id }, include: { files: true } });
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
  return ok(res, serializeIdentity(updated));
});

botManagerRouter.patch('/identities/:id/activate', async (req, res) => {
  if (!requireBotManagerAccess(req, res)) return;
  const existing = await prisma.botManagerIdentity.findUnique({ where: { id: req.params.id } });
  if (!existing) return fail(res, 404, 'Bot personality not found', 'NOT_FOUND');
  const [, activated] = await prisma.$transaction([
    prisma.botManagerIdentity.updateMany({ where: { isActive: true }, data: { isActive: false, updatedBy: req.user!.username } }),
    prisma.botManagerIdentity.update({ where: { id: existing.id }, data: { isActive: true, updatedBy: req.user!.username }, include: { files: true } })
  ]);
  return ok(res, serializeIdentity(activated));
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
    return ok(res, { ...file, content: parsed.data.content, updatedAt: file.updatedAt.toISOString() });
  } catch (error) {
    return fail(res, 422, error instanceof Error ? error.message : 'File save failed', 'VALIDATION_ERROR');
  }
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
  return ok(res, serializeIdentity(updated));
});

botManagerRouter.post('/sync', async (req, res) => {
  if (!requireBotManagerAccess(req, res)) return;
  let bundle;
  try {
    bundle = await buildRuntimeBundle();
  } catch (error) {
    return fail(res, 409, error instanceof Error ? error.message : 'Runtime bundle unavailable', 'BOT_MANAGER_UNAVAILABLE');
  }

  if (!env.nanobotInternalBaseUrl || !env.nanobotMornevenReloadToken) {
    return ok(res, {
      synced: false,
      reason: 'Nanobot reload endpoint is not configured',
      bundle
    });
  }

  try {
    const { payload } = await callNanobot('/api/morneven/reload', {
      method: 'POST',
      body: { requestedBy: req.user!.username }
    });
    return ok(res, {
      synced: true,
      bundle,
      nanobot: payload
    });
  } catch (error) {
    return fail(res, 502, error instanceof Error ? error.message : 'Nanobot reload failed', 'NANOBOT_RELOAD_FAILED');
  }
});
