import { Router } from 'express';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { auth } from '../../middleware/auth.js';
import { uploadSingle } from '../../middleware/upload.js';
import { readFileWithMetadataFromStorage, saveFileToStorage } from '../../config/storage.js';
import { env } from '../../config/env.js';
import { fail, ok } from '../../utils/response.js';
import { isReadableObjectPath, normalizeObjectPath } from './object-path.js';
import { scanUploadBuffer } from '../../security/files/scanner.js';
import { recordSecurityEvent } from '../../security/audit/events.js';

export const filesRouter = Router();

const querySchema = z.object({
  folder: z
    .enum(['gallery', 'lore', 'projects', 'news', 'map', 'chat', 'exports', 'uploads'])
    .optional()
});

const objectQuerySchema = z.object({
  path: z.string().min(1).max(2048),
  download: z.string().optional()
});

filesRouter.post('/upload', auth, (req, res) => {
  uploadSingle(req, res, async (err) => {
    if (err) {
      return fail(res, 400, 'Upload failed', 'UPLOAD_ERROR', err.message);
    }

    if (!req.file) {
      return fail(res, 400, 'File is required', 'VALIDATION_ERROR');
    }

    const parsedQuery = querySchema.safeParse(req.query);
    if (!parsedQuery.success) {
      return fail(res, 400, 'Validation failed', 'VALIDATION_ERROR', parsedQuery.error.flatten());
    }

    try {
      const folder = parsedQuery.data.folder ?? 'uploads';
      const safeName = req.file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
      if (!safeName || safeName === '.' || safeName === '..') {
        return fail(res, 400, 'Invalid file name', 'VALIDATION_ERROR');
      }
      const objectPath = `${folder}/${Date.now()}-${randomUUID()}-${safeName}`;
      const scan = await scanUploadBuffer({
        objectPath,
        buffer: req.file.buffer,
        mime: req.file.mimetype
      });

      if (scan.verdict === 'blocked' || scan.verdict === 'quarantined') {
        await recordSecurityEvent(req, {
          action: 'file.upload.blocked',
          severity: scan.verdict === 'quarantined' ? 'high' : 'medium',
          decision: 'deny',
          resource: 'FileUpload',
          metadata: {
            objectPath,
            verdict: scan.verdict,
            reason: scan.reason,
            mime: scan.mime,
            size: scan.size,
            sha256: scan.sha256
          }
        });
        return fail(res, 400, scan.reason ?? 'Upload blocked by security policy', 'FILE_BLOCKED');
      }

      const stored = await saveFileToStorage({
        objectPath,
        buffer: req.file.buffer,
        contentType: req.file.mimetype
      });

      return ok(res, {
        objectPath: stored.objectPath,
        provider: env.storageDriver,
        location: stored.location,
        contentType: req.file.mimetype,
        size: req.file.size,
        sha256: scan.sha256,
        scanVerdict: scan.verdict,
        url: stored.url
      });
    } catch (error) {
      return fail(res, 500, 'Storage upload failed', 'STORAGE_ERROR', (error as Error).message);
    }
  });
});

filesRouter.get('/object', auth, async (req, res) => {
  const parsedQuery = objectQuerySchema.safeParse(req.query);
  if (!parsedQuery.success) {
    return fail(res, 400, 'Validation failed', 'VALIDATION_ERROR', parsedQuery.error.flatten());
  }

  const objectPath = normalizeObjectPath(parsedQuery.data.path);
  if (!isReadableObjectPath(objectPath)) {
    return fail(res, 400, 'Invalid object path', 'VALIDATION_ERROR');
  }

  try {
    const file = await readFileWithMetadataFromStorage(objectPath);
    const shouldDownload = /^(1|true)$/i.test(parsedQuery.data.download ?? '');
    const filename = objectPath.split('/').pop() ?? 'file';

    res.setHeader('Content-Type', file.contentType ?? 'application/octet-stream');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (typeof file.contentLength === 'number' && Number.isFinite(file.contentLength)) {
      res.setHeader('Content-Length', String(file.contentLength));
    }
    if (file.etag) {
      res.setHeader('ETag', file.etag);
    }
    if (file.lastModified) {
      res.setHeader('Last-Modified', file.lastModified.toUTCString());
    }
    res.setHeader('Cache-Control', 'private, max-age=60');
    if (shouldDownload) {
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    }

    return res.status(200).send(file.buffer);
  } catch (error) {
    const message = (error as Error).message;
    if (/NoSuchKey|not found|ENOENT/i.test(message)) {
      return fail(res, 404, 'File not found', 'NOT_FOUND');
    }
    return fail(res, 500, 'Storage read failed', 'STORAGE_ERROR', message);
  }
});
