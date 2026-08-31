import assert from 'node:assert/strict';
import test from 'node:test';

process.env.DATABASE_URL ??= 'postgresql://user:pass@localhost:5432/morneven_test';
process.env.JWT_ACCESS_SECRET ??= 'test-access-secret-at-least-16';
process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret-at-least-16';
process.env.S3_ENDPOINT = 'http://localhost:9000';

test('file inspection blocks executable signatures and active web content', async () => {
  const { inspectUploadBuffer } = await import('./scanner.js');
  const executable = inspectUploadBuffer({
    objectPath: 'uploads/avatar.png',
    buffer: Buffer.from([0x4d, 0x5a, 0x00, 0x00]),
    mime: 'image/png'
  });
  assert.equal(executable.verdict, 'blocked');

  const activeText = inspectUploadBuffer({
    objectPath: 'uploads/readme.txt',
    buffer: Buffer.from('<iframe src="https://example.test"></iframe>'),
    mime: 'text/plain'
  });
  assert.equal(activeText.verdict, 'blocked');
});

test('file inspection accepts a matching image signature', async () => {
  const { inspectUploadBuffer } = await import('./scanner.js');
  const png = inspectUploadBuffer({
    objectPath: 'gallery/image.png',
    buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    mime: 'image/png'
  });
  assert.equal(png.verdict, 'clean');
});
