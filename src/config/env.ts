import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().min(1),
  JWT_ACCESS_SECRET: z.string().min(16),
  JWT_REFRESH_SECRET: z.string().min(16),
  CORS_ORIGIN: z.string().default('http://localhost:3000'),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(900000),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(200),
  AUTH_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(900000),
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),
  SECURITY_LEVEL: z.coerce.number().int().min(0).max(5).default(5),
  SECURITY_BLOCK_TTL_MS: z.coerce.number().int().positive().default(900000),
  SECURITY_RETENTION_DAYS: z.coerce.number().int().positive().default(90),
  SECURITY_HASH_PEPPER: z.string().min(16).optional(),
  FILE_SCAN_PROVIDER: z.enum(['none', 'mock']).default('none'),
  AUTH_COOKIE_ENABLED: z.coerce.boolean().default(false),
  AUTH_COOKIE_DOMAIN: z.string().optional(),
  MAX_UPLOAD_MB: z.coerce.number().int().positive().default(20),
  STORAGE_DRIVER: z.enum(['local', 'gcs', 's3']).default('local'),
  LOCAL_STORAGE_PATH: z.string().default('storage'),
  LOCAL_STORAGE_BASE_PATH: z.string().default('/storage'),
  GCS_BUCKET_NAME: z.string().optional(),
  GCS_PROJECT_ID: z.string().optional(),
  GCS_PUBLIC_BASE_URL: z.string().url().optional(),
  S3_BUCKET_NAME: z.string().optional(),
  S3_REGION: z.string().optional(),
  S3_ENDPOINT: z.string().url().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_PUBLIC_BASE_URL: z.string().url().optional(),
  S3_FORCE_PATH_STYLE: z.coerce.boolean().default(false),
  MIGRATION_KEY: z.string().min(16).optional(),
  EXTRACTION_KEY: z.string().min(16).optional(),
  BOT_MANAGER_KEY: z.string().min(16).optional(),
  BOT_MANAGER_ENCRYPTION_KEY: z.string().min(32).optional(),
  BOT_MANAGER_SYNC_TOKEN: z.string().min(16).optional(),
  NANOBOT_INTERNAL_BASE_URL: z.string().url().optional(),
  NANOBOT_MORNEVEN_RELOAD_TOKEN: z.string().min(16).optional()
});


const parseCorsOrigins = (value: string) =>
  value
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment variables', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

const corsOrigins = parsed.data.CORS_ORIGIN.split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

export const env = {
  port: parsed.data.PORT,
  nodeEnv: parsed.data.NODE_ENV,
  databaseUrl: parsed.data.DATABASE_URL,
  jwtAccessSecret: parsed.data.JWT_ACCESS_SECRET,
  jwtRefreshSecret: parsed.data.JWT_REFRESH_SECRET,
  corsOrigins: parseCorsOrigins(parsed.data.CORS_ORIGIN),
  rateLimitWindowMs: parsed.data.RATE_LIMIT_WINDOW_MS,
  rateLimitMax: parsed.data.RATE_LIMIT_MAX,
  authRateLimitWindowMs: parsed.data.AUTH_RATE_LIMIT_WINDOW_MS,
  authRateLimitMax: parsed.data.AUTH_RATE_LIMIT_MAX,
  securityLevel: parsed.data.SECURITY_LEVEL,
  securityBlockTtlMs: parsed.data.SECURITY_BLOCK_TTL_MS,
  securityRetentionDays: parsed.data.SECURITY_RETENTION_DAYS,
  securityHashPepper: parsed.data.SECURITY_HASH_PEPPER ?? parsed.data.JWT_ACCESS_SECRET,
  fileScanProvider: parsed.data.FILE_SCAN_PROVIDER,
  authCookieEnabled: parsed.data.AUTH_COOKIE_ENABLED,
  authCookieDomain: parsed.data.AUTH_COOKIE_DOMAIN,
  maxUploadMb: parsed.data.MAX_UPLOAD_MB,
  storageDriver: parsed.data.STORAGE_DRIVER,
  localStoragePath: parsed.data.LOCAL_STORAGE_PATH,
  localStorageBasePath: parsed.data.LOCAL_STORAGE_BASE_PATH,
  gcsBucketName: parsed.data.GCS_BUCKET_NAME,
  gcsProjectId: parsed.data.GCS_PROJECT_ID,
  gcsPublicBaseUrl: parsed.data.GCS_PUBLIC_BASE_URL,
  s3BucketName: parsed.data.S3_BUCKET_NAME,
  s3Region: parsed.data.S3_REGION,
  s3Endpoint: parsed.data.S3_ENDPOINT,
  s3AccessKeyId: parsed.data.S3_ACCESS_KEY_ID,
  s3SecretAccessKey: parsed.data.S3_SECRET_ACCESS_KEY,
  s3PublicBaseUrl: parsed.data.S3_PUBLIC_BASE_URL,
  s3ForcePathStyle: parsed.data.S3_FORCE_PATH_STYLE,
  migrationKey: parsed.data.MIGRATION_KEY,
  extractionKey: parsed.data.EXTRACTION_KEY,
  botManagerKey: parsed.data.BOT_MANAGER_KEY,
  botManagerEncryptionKey: parsed.data.BOT_MANAGER_ENCRYPTION_KEY,
  botManagerSyncToken: parsed.data.BOT_MANAGER_SYNC_TOKEN,
  nanobotInternalBaseUrl: parsed.data.NANOBOT_INTERNAL_BASE_URL,
  nanobotMornevenReloadToken: parsed.data.NANOBOT_MORNEVEN_RELOAD_TOKEN
};
