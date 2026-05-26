import { inflateRawSync } from 'node:zlib';

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let j = 0; j < 8; j += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

const crc32 = (buffer: Buffer) => {
  let c = 0xffffffff;
  for (const byte of buffer) {
    c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
};

const le = (value: number, bytes: number) => {
  const buffer = Buffer.alloc(bytes);
  if (bytes === 2) buffer.writeUInt16LE(value, 0);
  if (bytes === 4) buffer.writeUInt32LE(value >>> 0, 0);
  return buffer;
};

export type ZipFile = {
  name: string;
  content: string | Buffer;
};

export type ZipEntry = {
  name: string;
  content: Buffer;
};

const normalizeZipEntryName = (name: string) => {
  const normalized = name.replace(/\\/g, '/');
  if (!normalized || normalized.includes('\0')) throw new Error('Invalid ZIP entry name');
  if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) throw new Error('Invalid ZIP entry path');
  const segments = normalized.split('/');
  if (segments.some((segment) => segment === '..')) throw new Error('Invalid ZIP entry path');
  return normalized;
};

export const readZip = (archive: Buffer): ZipEntry[] => {
  const entries: ZipEntry[] = [];
  let offset = 0;

  while (offset + 30 <= archive.length) {
    const signature = archive.readUInt32LE(offset);
    if (signature === 0x02014b50 || signature === 0x06054b50) break;
    if (signature !== 0x04034b50) throw new Error('Unsupported ZIP archive structure');

    const flags = archive.readUInt16LE(offset + 6);
    const method = archive.readUInt16LE(offset + 8);
    if (flags & 0x08) throw new Error('ZIP data descriptors are not supported');
    if (method !== 0 && method !== 8) throw new Error('ZIP entry compression is not supported');

    const compressedSize = archive.readUInt32LE(offset + 18);
    const uncompressedSize = archive.readUInt32LE(offset + 22);
    const fileNameLength = archive.readUInt16LE(offset + 26);
    const extraLength = archive.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const dataStart = nameStart + fileNameLength + extraLength;
    const dataEnd = dataStart + compressedSize;

    if (nameStart + fileNameLength > archive.length || dataEnd > archive.length) {
      throw new Error('ZIP archive is truncated');
    }

    const name = normalizeZipEntryName(archive.subarray(nameStart, nameStart + fileNameLength).toString('utf8'));
    if (!name.endsWith('/')) {
      const compressed = archive.subarray(dataStart, dataEnd);
      const content = method === 8 ? inflateRawSync(compressed) : Buffer.from(compressed);
      if (content.length !== uncompressedSize) throw new Error(`ZIP entry size mismatch: ${name}`);
      entries.push({ name, content });
    }

    offset = dataEnd;
  }

  return entries;
};

export const makeZip = (files: ZipFile[]) => {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8');
    const content = Buffer.isBuffer(file.content) ? file.content : Buffer.from(file.content, 'utf8');
    const crc = crc32(content);

    const local = Buffer.concat([
      le(0x04034b50, 4),
      le(20, 2),
      le(0, 2),
      le(0, 2),
      le(0, 2),
      le(0, 2),
      le(crc, 4),
      le(content.length, 4),
      le(content.length, 4),
      le(name.length, 2),
      le(0, 2),
      name,
      content
    ]);
    localParts.push(local);

    centralParts.push(
      Buffer.concat([
        le(0x02014b50, 4),
        le(20, 2),
        le(20, 2),
        le(0, 2),
        le(0, 2),
        le(0, 2),
        le(0, 2),
        le(crc, 4),
        le(content.length, 4),
        le(content.length, 4),
        le(name.length, 2),
        le(0, 2),
        le(0, 2),
        le(0, 2),
        le(0, 2),
        le(0, 4),
        le(offset, 4),
        name
      ])
    );
    offset += local.length;
  }

  const central = Buffer.concat(centralParts);
  const end = Buffer.concat([
    le(0x06054b50, 4),
    le(0, 2),
    le(0, 2),
    le(files.length, 2),
    le(files.length, 2),
    le(central.length, 4),
    le(offset, 4),
    le(0, 2)
  ]);

  return Buffer.concat([...localParts, central, end]);
};
