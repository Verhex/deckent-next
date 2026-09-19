import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { openSqliteAttemptStore, openSqliteModelActivationStore, openSqliteModelInvocationReader,
  openSqliteModelInvocationStore } from '#adapters/index.js';
import { encodeModelBindingDefinition, parseProviderCatalog, resolveModelBindingDefinition } from '#domain/index.js';
import { admitRunAttempts } from '../support/admission.js';

const options = { busyTimeoutMs: 20, journalMode: 'delete' as const, durability: 'full' as const };
const reference = { providerId: 'provider', providerVersion: 1, modelId: 'model', modelVersion: 1 };
const definition = resolveModelBindingDefinition(parseProviderCatalog({ schemaVersion: 1, revision: 'catalog', providers: [
  { id: 'provider', version: 1, models: [{ id: 'model', version: 1, nativeId: 'native/model',
    protocols: [{ family: 'openai-chat-completions', version: 'v1', capabilities: [] }] }] },
] }), reference)!;
const binding = { encodingVersion: 1 as const, algorithm: 'sha256' as const,
  digest: createHash('sha256').update(encodeModelBindingDefinition(definition)).digest('hex') };

async function workspace(work: (path: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'deckent-model-invocation-migration-'));
  try { await work(join(root, 'ledger.db')); } finally { await rm(root, { recursive: true, force: true }); }
}
async function seedV13(path: string) {
  const attempts = await openSqliteAttemptStore(path, options);
  try { await admitRunAttempts(attempts, [{ scopeId: 'scope', runId: 'run', taskId: 'task', attemptId: 'attempt', layoutRevision: 'layout', generation: 1 }]); }
  finally { attempts.close(); }
  const activation = await openSqliteModelActivationStore(path, options, 'forbid');
  try {
    await activation.admit({ command: { schemaVersion: 1, action: 'activate', commandId: 'activate', scopeId: 'scope',
      reference, expectedRevision: 0, catalogRevision: 'catalog', expectedBinding: binding },
    actor: { id: 'actor', issuer: 'host', subject: '1000', assurance: 'os-user' },
    authorization: { revision: 'policy', ruleId: 'activate' }, admittedAtMs: 1, definition });
  } finally { activation.close(); }
  const db = new DatabaseSync(path);
  try {
    db.exec(`DROP INDEX model_invocations_allocation_state;
      DROP TABLE model_invocations; DROP TABLE model_invocation_allocations; PRAGMA user_version=13`);
  } finally { db.close(); }
}
function evidence(path: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return {
      version: db.prepare('PRAGMA user_version').get()?.user_version,
      activation: db.prepare('SELECT revision,record FROM model_activations').all(),
      activationReceipts: db.prepare('SELECT command_id,record FROM model_activation_receipts').all(),
      attempts: db.prepare('SELECT scope_id,attempt_id,snapshot FROM attempts').all(),
      runReceipts: db.prepare('SELECT command_id,command,snapshot FROM run_receipts').all(),
    };
  } finally { db.close(); }
}

it('migrates genuine v13 activation and execution evidence to v14 without changing existing payloads', async () => workspace(async path => {
  await seedV13(path);
  const before = evidence(path);
  expect(before.version).toBe(13);
  const store = await openSqliteModelInvocationStore(path, options, 'allow');
  store.close();
  const after = evidence(path);
  expect(after).toEqual({ ...before, version: 14 });
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    expect(db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name IN ('model_invocation_allocations','model_invocations') ORDER BY name").all())
      .toEqual([{ name: 'model_invocation_allocations' }, { name: 'model_invocations' }]);
  } finally { db.close(); }
}));

it('forbids v13 read-only mutation and rolls back a partial v14 collision without touching activation or execution evidence', async () => workspace(async path => {
  await seedV13(path);
  const before = evidence(path);
  const bytes = await import('node:fs/promises').then(({ readFile }) => readFile(path));
  await expect(openSqliteModelInvocationReader(path, { busyTimeoutMs: 20 })).rejects.toMatchObject({ code: 'ATTEMPT_STORE_VERSION' });
  expect(evidence(path)).toEqual(before);
  await expect(import('node:fs/promises').then(({ readFile }) => readFile(path))).resolves.toEqual(bytes);

  const db = new DatabaseSync(path);
  try { db.exec('CREATE TABLE model_invocations(marker TEXT)'); } finally { db.close(); }
  await expect(openSqliteModelInvocationStore(path, options, 'allow')).rejects.toThrow();
  const failed = evidence(path);
  expect(failed).toEqual(before);
  const inspect = new DatabaseSync(path, { readOnly: true });
  try {
    expect(inspect.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name='model_invocations'").get()?.sql).toContain('marker TEXT');
    expect(inspect.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name='model_invocation_allocations'").all()).toEqual([]);
  } finally { inspect.close(); }
}));
