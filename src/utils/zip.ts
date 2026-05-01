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
  content: string;
};

export const makeZip = (files: ZipFile[]) => {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8');
    const content = Buffer.from(file.content, 'utf8');
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
