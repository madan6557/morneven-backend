import assert from 'node:assert/strict';
import test from 'node:test';

process.env.DATABASE_URL ??= 'postgresql://user:pass@localhost:5432/morneven_test';
process.env.JWT_ACCESS_SECRET ??= 'test-access-secret-at-least-16';
process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret-at-least-16';
process.env.S3_ENDPOINT = 'http://localhost:9000';

test('migration dataset validation accepts legacy runtime tables as empty', async () => {
  const { assertMigrationDatasetShape, MIGRATION_TABLES } = await import('./data-contract.js');
  const complete = Object.fromEntries(MIGRATION_TABLES.map((table) => [table.key, []]));
  assert.doesNotThrow(() => assertMigrationDatasetShape(complete));

  const legacy: Record<string, unknown> = { ...complete };
  delete legacy.scheduledTasks;
  delete legacy.scheduledTaskRuns;
  delete legacy.runtimeControlStates;
  assert.doesNotThrow(() => assertMigrationDatasetShape(legacy));

  const incomplete: Record<string, unknown> = { ...complete };
  delete incomplete.users;
  assert.throws(
    () => assertMigrationDatasetShape(incomplete),
    /users/
  );
});

test('restore preparation disables schedules and clears transient runtime state', async () => {
  const { MIGRATION_TABLES, prepareMigrationDatasetForRestore } = await import('./data-contract.js');
  const source = Object.fromEntries(MIGRATION_TABLES.map((table) => [table.key, []])) as Record<string, any[]>;
  source.extractionJobs = [{ id: 'extraction-1' }];
  source.botManagerBackupJobs = [{ id: 'manager-backup-1' }];
  source.scheduledTasks = [{
    id: 'task-1',
    enabled: true,
    nextRunAt: new Date('2026-07-20T00:00:00.000Z'),
    lastStatus: 'completed',
    lastError: 'old error',
    leaseOwner: 'worker-1',
    leaseUntil: new Date('2026-07-16T01:00:00.000Z')
  }];
  source.scheduledTaskRuns = [{ id: 'run-1' }];
  source.runtimeControlStates = [{
    id: 'global',
    frozen: true,
    frozenAt: new Date('2026-07-16T00:00:00.000Z'),
    reason: 'freeze',
    updatedBy: 'author'
  }];

  const prepared = prepareMigrationDatasetForRestore(source);

  assert.deepEqual(prepared.extractionJobs, []);
  assert.deepEqual(prepared.botManagerBackupJobs, []);
  assert.deepEqual(prepared.scheduledTaskRuns, []);
  assert.equal(prepared.scheduledTasks[0]?.enabled, false);
  assert.equal(prepared.scheduledTasks[0]?.nextRunAt, null);
  assert.equal(prepared.scheduledTasks[0]?.lastStatus, 'restored-disabled');
  assert.equal(prepared.scheduledTasks[0]?.leaseOwner, null);
  assert.equal(prepared.runtimeControlStates[0]?.frozen, false);
  assert.equal(prepared.runtimeControlStates[0]?.frozenAt, null);
  assert.equal(prepared.runtimeControlStates[0]?.updatedBy, 'restore');
  assert.equal(source.scheduledTasks[0]?.enabled, true);
  assert.equal(source.runtimeControlStates[0]?.frozen, true);
});

test('restore preparation migrates legacy provider credentials into default accounts', async () => {
  const { MIGRATION_TABLES, prepareMigrationDatasetForRestore } = await import('./data-contract.js');
  const source = Object.fromEntries(MIGRATION_TABLES
    .filter((table) => table.key !== 'botManagerProviderAccounts')
    .map((table) => [table.key, []])) as Record<string, any[]>;
  source.botManagerCredentials = [{
    id: 'credential-openai',
    provider: 'openai',
    encryptedValue: 'encrypted-openai',
    keyPreview: 'sk-***',
    metadata: { modelId: 'gpt-4.1-mini' },
    createdAt: '2026-08-17T00:00:00.000Z',
    updatedAt: '2026-08-17T00:00:00.000Z'
  }];
  const prepared = prepareMigrationDatasetForRestore(source);
  assert.equal(prepared.botManagerProviderAccounts.length, 1);
  assert.equal(prepared.botManagerProviderAccounts[0]?.provider, 'openai');
  assert.equal(prepared.botManagerProviderAccounts[0]?.name, 'default');
  assert.equal(prepared.botManagerProviderAccounts[0]?.isActive, true);
});
