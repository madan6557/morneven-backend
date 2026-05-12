import { createHash } from 'node:crypto';
import { prisma } from '../../config/prisma.js';
import { env } from '../../config/env.js';
import { securityEnabled, securityFeatures } from '../config.js';

export type FileScanVerdict = 'clean' | 'blocked' | 'quarantined' | 'skipped';

export type FileScanResult = {
  verdict: FileScanVerdict;
  sha256: string;
  mime: string;
  size: number;
  reason?: string;
};

const ALLOWED_MIME = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'video/mp4',
  'video/webm',
  'video/quicktime',
  'application/pdf',
  'application/json',
  'text/plain',
  'text/markdown'
]);

const BLOCKED_MIME = new Set([
  'image/svg+xml',
  'text/html',
  'application/x-msdownload',
  'application/x-msdos-program',
  'application/x-sh',
  'application/x-bat',
  'application/zip',
  'application/x-7z-compressed',
  'application/x-rar-compressed'
]);

const hasBytes = (buffer: Buffer, bytes: number[]) => bytes.every((byte, index) => buffer[index] === byte);

const detectMagicMime = (buffer: Buffer) => {
  if (hasBytes(buffer, [0x89, 0x50, 0x4e, 0x47])) return 'image/png';
  if (hasBytes(buffer, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (buffer.subarray(0, 3).toString('ascii') === 'GIF') return 'image/gif';
  if (buffer.subarray(0, 4).toString('ascii') === '%PDF') return 'application/pdf';
  if (buffer.subarray(4, 8).toString('ascii') === 'ftyp') return 'video/mp4';
  if (hasBytes(buffer, [0x1a, 0x45, 0xdf, 0xa3])) return 'video/webm';
  return undefined;
};

const looksText = (buffer: Buffer) => {
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  if (sample.includes(0)) return false;
  return sample.every((byte) => byte === 9 || byte === 10 || byte === 13 || (byte >= 32 && byte <= 126) || byte >= 128);
};

const isMimeCompatible = (declared: string, magic: string | undefined, buffer: Buffer) => {
  if (!magic) return declared.startsWith('text/') ? looksText(buffer) : declared === 'application/json' || declared === 'application/octet-stream';
  if (declared === magic) return true;
  if (declared === 'video/quicktime' && magic === 'video/mp4') return true;
  if (declared === 'application/octet-stream' && ALLOWED_MIME.has(magic)) return true;
  return false;
};

export const scanUploadBuffer = async (input: {
  objectPath: string;
  buffer: Buffer;
  mime: string;
}): Promise<FileScanResult> => {
  const sha256 = createHash('sha256').update(input.buffer).digest('hex');
  const mime = (input.mime || 'application/octet-stream').toLowerCase();
  const size = input.buffer.length;

  if (!securityEnabled) {
    return { verdict: 'skipped', sha256, mime, size };
  }

  let verdict: FileScanVerdict = 'clean';
  let reason: string | undefined;
  const magic = detectMagicMime(input.buffer);

  if (BLOCKED_MIME.has(mime)) {
    verdict = 'blocked';
    reason = 'Blocked MIME type';
  } else if (!ALLOWED_MIME.has(mime) && mime !== 'application/octet-stream') {
    verdict = 'blocked';
    reason = 'Unsupported MIME type';
  } else if (!isMimeCompatible(mime, magic, input.buffer)) {
    verdict = 'blocked';
    reason = 'MIME and file signature mismatch';
  } else if (env.fileScanProvider === 'mock' && input.buffer.includes(Buffer.from('EICAR', 'ascii'))) {
    verdict = 'quarantined';
    reason = 'Mock malware signature detected';
  }

  if (securityFeatures.audit) {
    await prisma.fileScanRecord.create({
      data: {
        objectPath: input.objectPath,
        sha256,
        mime,
        size,
        verdict,
        provider: env.fileScanProvider,
        metadata: {
          reason,
          magic
        }
      }
    });
  }

  return { verdict, sha256, mime, size, reason };
};
