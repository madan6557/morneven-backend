import path from 'node:path';
import type { RequestHandler } from 'express';
import { pipeline } from 'node:stream/promises';
import { createReadStreamFromStorage } from '../../config/storage.js';
import { fail } from '../../utils/response.js';
import { isPublicObjectPath, isReadableObjectPath, normalizeObjectPath } from './object-path.js';

const contentTypesByExtension: Record<string, string> = {
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.json': 'application/json',
  '.md': 'text/markdown; charset=utf-8',
  '.mp4': 'video/mp4',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.txt': 'text/plain; charset=utf-8',
  '.webm': 'video/webm',
  '.webp': 'image/webp'
};

const activeOrDocumentTypes = new Set([
  'application/javascript',
  'application/pdf',
  'application/xhtml+xml',
  'application/xml',
  'image/svg+xml',
  'text/css',
  'text/html',
  'text/javascript',
  'text/xml'
]);

const inferContentType = (objectPath: string, storedContentType?: string) =>
  storedContentType || contentTypesByExtension[path.extname(objectPath).toLowerCase()] || 'application/octet-stream';

export const servePublicStorageObject: RequestHandler = async (req, res) => {
  const wildcard = typeof req.params[0] === 'string' ? req.params[0] : '';
  const objectPath = normalizeObjectPath(wildcard);
  if (!isReadableObjectPath(objectPath) || !isPublicObjectPath(objectPath)) {
    return fail(res, 404, 'File not found', 'NOT_FOUND');
  }

  try {
    const file = await createReadStreamFromStorage(objectPath);
    const contentType = inferContentType(objectPath, file.contentType);
    const baseContentType = contentType.split(';')[0].trim().toLowerCase();
    const forceDownload = activeOrDocumentTypes.has(baseContentType);
    const filename = objectPath.split('/').pop() ?? 'file';

    res.setHeader('Content-Type', forceDownload ? 'application/octet-stream' : contentType);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader(
      'Content-Security-Policy',
      "sandbox; default-src 'none'; script-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
    );
    res.setHeader('Cache-Control', 'public, max-age=3600, stale-while-revalidate=86400');
    if (typeof file.contentLength === 'number' && Number.isFinite(file.contentLength)) {
      res.setHeader('Content-Length', String(file.contentLength));
    }
    if (forceDownload) {
      res.setHeader('Content-Disposition', `attachment; filename="${filename.replace(/"/g, '')}"`);
    }
    res.status(200);
    if (req.method === 'HEAD') return res.end();
    await pipeline(file.stream, res);
    return;
  } catch (error) {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    const message = error instanceof Error ? error.message : 'Storage read failed';
    if (/NoSuchKey|not found|ENOENT/i.test(message)) {
      return fail(res, 404, 'File not found', 'NOT_FOUND');
    }
    return fail(res, 500, 'Storage read failed', 'STORAGE_ERROR');
  }
};
