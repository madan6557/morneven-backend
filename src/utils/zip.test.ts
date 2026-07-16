import assert from 'node:assert/strict';
import test from 'node:test';
import { makeZip, readZip } from './zip.js';

test('ZIP round trip preserves file names and content', () => {
  const archive = makeZip([
    { name: 'manifest.json', content: '{"ok":true}' },
    { name: 'attachments/image.png', content: Buffer.from([1, 2, 3]) }
  ]);
  const entries = readZip(archive);
  assert.deepEqual(
    entries.map((entry) => [entry.name, entry.content]),
    [
      ['manifest.json', Buffer.from('{"ok":true}')],
      ['attachments/image.png', Buffer.from([1, 2, 3])]
    ]
  );
});

test('ZIP writer rejects traversal and duplicate entry names', () => {
  assert.throws(
    () => makeZip([{ name: '../outside.txt', content: 'blocked' }]),
    /Invalid ZIP entry path/
  );
  assert.throws(
    () => makeZip([
      { name: 'same.txt', content: 'one' },
      { name: 'same.txt', content: 'two' }
    ]),
    /Duplicate ZIP entry/
  );
});

test('ZIP reader enforces entry and uncompressed size limits', () => {
  const archive = makeZip([
    { name: 'one.txt', content: '1234' },
    { name: 'two.txt', content: '5678' }
  ]);
  assert.throws(() => readZip(archive, { maxEntries: 1 }), /too many entries/);
  assert.throws(
    () => readZip(archive, { maxTotalUncompressedBytes: 7 }),
    /total uncompressed size limit/
  );
  assert.throws(
    () => readZip(archive, { maxEntryUncompressedBytes: 3 }),
    /entry exceeds the uncompressed size limit/
  );
});
