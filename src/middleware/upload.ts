import multer from 'multer';
import { env } from '../config/env.js';

export const uploadSingle = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: env.maxUploadMb * 1024 * 1024
  }
}).single('file');
