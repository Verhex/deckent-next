import { CURRENT_LEDGER_VERSION } from '#adapters/core/sqlite-ledger/index.js';
import { createHash } from 'node:crypto';
import { access, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { encodeModelBindingDefinition, parseProviderCatalog, resolveModelBindingDefinition } from '#domain/index.js';
import { openSqliteModelActivationReader, openSqliteModelActivationStore } from '#adapters/core/sqlite-model-activation/index.js';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))));
const reference = { providerId: 'provider', providerVersion: 1, modelId: 'model', modelVersion: 2 };
const definition = resolveModelBindingDefinition(parseProviderCatalog({ schemaVersion: 1, revision: 'catalog', providers: [
  { id: 'provider', version: 1, models: [{ id: 'model', version: 2, nativeId: 'native/model',
    protocols: [{ family: 'wire', version: '1', capabilities: [] }] }] },
] }), reference)!;
const binding = { encodingVersion: 1 as const, algorithm: 'sha256' as const,
  digest: createHash('sha256').update(encodeModelBindingDefinition(definition), 'utf8').digest('hex') };
const writerOptions = { journalMode: 'delete' as const, durability: 'full' as const, busyTimeoutMs: 1_000 };
async function path() { const root = await mkdtemp(join(tmpdir(), 'deckent-activation-reader-')); roots.push(root); return join(root, 'ledger.db'); }
async function seeded() {
  const file = await path(), writer = await openSqliteModelActivationStore(file, writerOptions);
  await writer.admit({ command: { schemaVersion: 1, action: 'activate', commandId: 'activate', scopeId: 'scope', reference,
    expectedRevision: 0, catalogRevision: 'catalog', expectedBinding: binding },
  actor: { id: 'actor', issuer: 'host', subject: '1000', assurance: 'os-user' },
  authorization: { revision: 'policy', ruleId: 'rule' }, admittedAtMs: 1_000, definition }); writer.close(); return file;
}

it('reads the current exact record and returns null for a missing key without writer methods', async () => {
  const file = await seeded(), before = await readFile(file), reader = await openSqliteModelActivationReader(file, { busyTimeoutMs: 100 });
  expect('admit' in reader).toBe(false);
  expect('loadReceipt' in reader).toBe(false);
  await expect(reader.loadRecord('scope', reference)).resolves.toMatchObject({ revision: 1, state: 'active', binding });
  await expect(reader.loadRecord('other-scope', reference)).resolves.toBeNull(); reader.close();
  expect(await readFile(file)).toEqual(before);
  const db = new DatabaseSync(file, { readOnly: true }); expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(CURRENT_LEDGER_VERSION); db.close();
});

it('accepts a genuine historical v13 activation ledger read-only without changing its bytes', async () => {
  const file = await seeded(), db = new DatabaseSync(file);
  db.exec(`DROP TABLE provider_spend_audits; DROP TABLE model_invocation_spend_reservations; DROP TABLE provider_spend_accounts;
    DROP TABLE model_invocation_allocation_checkpoints; DROP INDEX model_invocations_allocation_identity;
    DROP TABLE model_invocation_cancellations; DROP TABLE model_invocation_controls; DROP INDEX model_invocations_allocation_state;
    DROP TABLE model_invocation_contents; DROP TABLE model_invocation_content_purges; DROP TABLE model_invocations; DROP TABLE model_invocation_allocations; PRAGMA user_version=13`);
  db.close();
  const before = await readFile(file), reader = await openSqliteModelActivationReader(file, { busyTimeoutMs: 100 });
  await expect(reader.loadRecord('scope', reference)).resolves.toMatchObject({ revision: 1, state: 'active', binding });
  reader.close();
  expect(await readFile(file)).toEqual(before);
  const check = new DatabaseSync(file, { readOnly: true }); expect(check.prepare('PRAGMA user_version').get()?.user_version).toBe(13); check.close();
});

it('does not create a missing database and rejects an older schema without changing it', async () => {
  const missing = await path();
  await expect(openSqliteModelActivationReader(missing, { busyTimeoutMs: 100 })).rejects.toThrow('MODEL_ACTIVATION_UNAVAILABLE');
  await expect(access(missing)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readdir(join(missing, '..'))).not.toContain('ledger.db');
  const old = await path(), db = new DatabaseSync(old); db.exec('PRAGMA user_version=12'); db.close(); const before = await readFile(old);
  await expect(openSqliteModelActivationReader(old, { busyTimeoutMs: 100 })).rejects.toMatchObject({ code: 'ATTEMPT_STORE_VERSION' });
  expect(await readFile(old)).toEqual(before);
  const check = new DatabaseSync(old, { readOnly: true }); expect(check.prepare('PRAGMA user_version').get()?.user_version).toBe(12); check.close();
});

it('fails closed for corrupt JSON and SQL key mismatches', async () => {
  for (const { mutate, requested } of [
    { mutate: (db: DatabaseSync) => db.prepare('UPDATE model_activations SET record=?').run('{'), requested: reference },
    { mutate: (db: DatabaseSync) => db.prepare('UPDATE model_activations SET model_id=?').run('wrong-model'),
      requested: { ...reference, modelId: 'wrong-model' } },
  ]) {
    const file = await seeded(), db = new DatabaseSync(file); mutate(db); db.close();
    const reader = await openSqliteModelActivationReader(file, { busyTimeoutMs: 100 });
    await expect(reader.loadRecord('scope', requested)).rejects.toThrow('MODEL_ACTIVATION_CORRUPT'); reader.close();
  }
});
