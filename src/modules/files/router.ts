import { Router } from 'express';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { auth } from '../../middleware/auth.js';
import { uploadSingle } from '../../middleware/upload.js';
import { getStorageBucket, buildObjectUrl } from '../../config/storage.js';
import { fail, ok } from '../../utils/response.js';

export const filesRouter = Router();

const querySchema = z.object({
  folder: z.string().min(1).max(80).optional()
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

      const bucket = getStorageBucket();
      const file = bucket.file(objectPath);

      await file.save(req.file.buffer, {
        metadata: { contentType: req.file.mimetype },
        resumable: false,
        validation: 'crc32c'
      });

      return ok(res, {
        objectPath,
        bucket: bucket.name,
        contentType: req.file.mimetype,
        size: req.file.size,
        url: buildObjectUrl(objectPath)
      });
    } catch (error) {
      return fail(res, 500, 'Storage upload failed', 'STORAGE_ERROR', (error as Error).message);
    }
  });
});
