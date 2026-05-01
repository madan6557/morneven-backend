import { Router } from 'express';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { auth } from '../../middleware/auth.js';
import { uploadSingle } from '../../middleware/upload.js';
import { saveFileToStorage } from '../../config/storage.js';
import { env } from '../../config/env.js';
import { fail, ok } from '../../utils/response.js';

export const filesRouter = Router();

const querySchema = z.object({
  folder: z
    .enum(['gallery', 'lore', 'projects', 'news', 'map', 'chat', 'exports', 'uploads'])
    .optional()
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
      const objectPath = `${folder}/${Date.now()}-${randomUUID()}-${safeName}`;

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
        url: stored.url
      });
    } catch (error) {
      return fail(res, 500, 'Storage upload failed', 'STORAGE_ERROR', (error as Error).message);
    }
  });
});
