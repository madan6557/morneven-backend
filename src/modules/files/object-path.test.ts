import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isAllowedObjectPath,
  isPublicObjectPath,
  isReadableObjectPath,
  isSafeObjectPath,
  normalizeObjectPath
} from './object-path.js';

test('object paths accept current storage namespaces', () => {
  assert.equal(normalizeObjectPath('/gallery/image.png'), 'gallery/image.png');
  assert.equal(isSafeObjectPath('bot-manager/profiles/id/avatar.png'), true);
  assert.equal(isAllowedObjectPath('uploads/report.txt'), true);
  assert.equal(isReadableObjectPath('gallery/image.png'), true);
});

test('object paths reject traversal, separators, and control characters', () => {
  assert.equal(isSafeObjectPath('../secret.txt'), false);
  assert.equal(isSafeObjectPath('gallery//image.png'), false);
  assert.equal(isSafeObjectPath('gallery\\image.png'), false);
  assert.equal(isSafeObjectPath('gallery/image.png\r\nx-header: injected'), false);
  assert.equal(isReadableObjectPath('backups/job/archive.zip'), false);
});

test('only content assets and bot profile images are publicly readable', () => {
  assert.equal(isPublicObjectPath('gallery/image.png'), true);
  assert.equal(isPublicObjectPath('bot-manager/profiles/id/avatar.png'), true);
  assert.equal(isPublicObjectPath('chat/conversation/private.png'), false);
  assert.equal(isPublicObjectPath('uploads/report.txt'), false);
  assert.equal(isPublicObjectPath('bot-manager/workspace/personality/SOUL.md'), false);
  assert.equal(isPublicObjectPath('exports/report.zip'), false);
});
