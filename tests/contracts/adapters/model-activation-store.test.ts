import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { encodeModelBindingDefinition, parseProviderCatalog, resolveModelBindingDefinition } from '#domain/core/provider-catalog/index.js';
import { openSqliteModelActivationStore } from '#adapters/core/sqlite-model-activation/index.js';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))));
const options = { journalMode: 'delete' as const, durability: 'full' as const, busyTimeoutMs: 1_000 };
const reference = { providerId: 'provider', providerVersion: 1, modelId: 'model', modelVersion: 2 };
const definition = resolveModelBindingDefinition(parseProviderCatalog({ schemaVersion: 1, revision: 'catalog', providers: [
  { id: 'provider', version: 1, models: [{ id: 'model', version: 2, nativeId: 'native/model',
    protocols: [{ family: 'wire', version: '1', capabilities: [{ id: 'text', version: 1, state: 'supported' }] }] }] },
] }), reference)!;
const binding = { encodingVersion: 1 as const, algorithm: 'sha256' as const,
  digest: createHash('sha256').update(encodeModelBindingDefinition(definition), 'utf8').digest('hex') };
const actor = { id: 'actor', issuer: 'host', subject: '1000', assurance: 'os-user' };
const authorization = { revision: 'policy-1', ruleId: 'activation-rule' };
const activate = (scopeId: string, commandId: string, expectedRevision = 0) => ({ command: { schemaVersion: 1 as const,
  action: 'activate' as const, commandId, scopeId, reference, expectedRevision, catalogRevision: 'catalog', expectedBinding: binding },
actor, authorization, admittedAtMs: 1_000, definition });
const deactivate = (scopeId: string, commandId: string, expectedRevision: number) => ({ command: { schemaVersion: 1 as const,
  action: 'deactivate' as const, commandId, scopeId, reference, expectedRevision, expectedBinding: binding },
actor, authorization, admittedAtMs: 1_001 });
async function path() { const root = await mkdtemp(join(tmpdir(), 'deckent-model-activation-')); roots.push(root); return join(root, 'ledger.db'); }

it('atomically activates, replays, re-attests and deactivates while isolating scopes', async () => {
  const file = await path(), store = await openSqliteModelActivationStore(file, options);
  try {
    const first = await store.admit(activate('scope-a', 'activate-a'));
    expect(first).toMatchObject({ replayed: false, receipt: { previousRevision: null, record: { revision: 1, state: 'active' } } });
    expect(await store.admit(activate('scope-a', 'activate-a'))).toEqual({ replayed: true, receipt: first.receipt });
    const second = await store.admit(activate('scope-a', 'activate-b', 1));
    expect(second.receipt.record.revision).toBe(2);
    await expect(store.loadRecord('scope-b', reference)).resolves.toBeNull();
    const beforeMissingDb = new DatabaseSync(file), beforeMissing = {
      records: beforeMissingDb.prepare('SELECT revision,record FROM model_activations ORDER BY scope_id').all(),
      receipts: beforeMissingDb.prepare('SELECT count(*) AS count FROM model_activation_receipts').get()!.count,
    }; beforeMissingDb.close();
    await expect(store.admit(deactivate('missing', 'deactivate-missing', 1))).rejects.toThrow('MODEL_ACTIVATION_NOT_FOUND');
    const afterMissingDb = new DatabaseSync(file); expect({
      records: afterMissingDb.prepare('SELECT revision,record FROM model_activations ORDER BY scope_id').all(),
      receipts: afterMissingDb.prepare('SELECT count(*) AS count FROM model_activation_receipts').get()!.count,
    }).toEqual(beforeMissing); afterMissingDb.close();
    expect((await store.admit(deactivate('scope-a', 'deactivate', 2))).receipt.record).toMatchObject({ revision: 3, state: 'inactive' });
    const inactive = await store.loadRecord('scope-a', reference);
    const beforeInactiveDb = new DatabaseSync(file), beforeInactiveCount = beforeInactiveDb.prepare('SELECT count(*) AS count FROM model_activation_receipts').get()!.count;
    beforeInactiveDb.close();
    await expect(store.admit(deactivate('scope-a', 'deactivate-again', 3))).rejects.toThrow('MODEL_ACTIVATION_NOT_ACTIVE');
    expect(await store.loadRecord('scope-a', reference)).toEqual(inactive);
    const afterInactiveDb = new DatabaseSync(file); expect(afterInactiveDb.prepare('SELECT count(*) AS count FROM model_activation_receipts').get()!.count).toBe(beforeInactiveCount); afterInactiveDb.close();
    await expect(store.loadReceipt('missing', 'deactivate-missing')).resolves.toBeNull();
    await expect(store.loadReceipt('scope-a', 'deactivate-again')).resolves.toBeNull();
    expect((await store.loadReceipt('scope-a', 'activate-a'))).toEqual(first.receipt);
    await expect(store.loadReceipt('', 'activate-a')).rejects.toThrow('MODEL_ACTIVATION_INVALID');
  } finally { store.close(); }
});

it('rejects malformed and mis-keyed persisted receipts without changing activation state', async () => {
  const file = await path(), store = await openSqliteModelActivationStore(file, options);
  await store.admit(activate('scope-a', 'activate-a')); store.close();
  const db = new DatabaseSync(file), before = db.prepare('SELECT revision,record FROM model_activations').get();
  const valid = db.prepare('SELECT record FROM model_activation_receipts WHERE scope_id=? AND command_id=?').get('scope-a', 'activate-a')!.record;
  db.prepare('UPDATE model_activation_receipts SET record=? WHERE scope_id=? AND command_id=?').run('{', 'scope-a', 'activate-a'); db.close();
  const malformed = await openSqliteModelActivationStore(file, options, 'forbid');
  await expect(malformed.loadReceipt('scope-a', 'activate-a')).rejects.toThrow('MODEL_ACTIVATION_CORRUPT');
  await expect(malformed.admit(activate('scope-a', 'activate-a'))).rejects.toThrow('MODEL_ACTIVATION_CORRUPT'); malformed.close();
  const move = new DatabaseSync(file); expect(move.prepare('SELECT revision,record FROM model_activations').get()).toEqual(before);
  move.prepare('UPDATE model_activation_receipts SET command_id=?,record=? WHERE scope_id=? AND command_id=?')
    .run('wrong-key', valid, 'scope-a', 'activate-a'); move.close();
  const wrongKey = await openSqliteModelActivationStore(file, options, 'forbid');
  await expect(wrongKey.loadReceipt('scope-a', 'wrong-key')).rejects.toThrow('MODEL_ACTIVATION_CORRUPT'); wrongKey.close();
  const moveScope = new DatabaseSync(file); moveScope.prepare('UPDATE model_activation_receipts SET scope_id=? WHERE scope_id=? AND command_id=?')
    .run('wrong-scope', 'scope-a', 'wrong-key'); expect(moveScope.prepare('SELECT revision,record FROM model_activations').get()).toEqual(before); moveScope.close();
  const wrongScope = await openSqliteModelActivationStore(file, options, 'forbid');
  await expect(wrongScope.loadReceipt('wrong-scope', 'wrong-key')).rejects.toThrow('MODEL_ACTIVATION_CORRUPT'); wrongScope.close();
});

it('restores exact existing state when re-attest or deactivate receipt insertion aborts', async () => {
  for (const admission of [activate('scope-a', 'reattest', 1), deactivate('scope-a', 'deactivate', 1)]) {
    const file = await path(), seed = await openSqliteModelActivationStore(file, options);
    await seed.admit(activate('scope-a', 'activate-a')); seed.close();
    const db = new DatabaseSync(file), before = db.prepare('SELECT revision,record FROM model_activations').get();
    const receiptCount = db.prepare('SELECT count(*) AS count FROM model_activation_receipts').get()!.count;
    db.exec(`CREATE TRIGGER reject_existing_receipt BEFORE INSERT ON model_activation_receipts
      BEGIN SELECT RAISE(ABORT,'fixture existing receipt failure'); END;`); db.close();
    const failing = await openSqliteModelActivationStore(file, options, 'forbid');
    await expect(failing.admit(admission)).rejects.toThrow('MODEL_ACTIVATION_UNAVAILABLE'); failing.close();
    const inspect = new DatabaseSync(file);
    expect(inspect.prepare('SELECT revision,record FROM model_activations').get()).toEqual(before);
    expect(inspect.prepare('SELECT count(*) AS count FROM model_activation_receipts').get()!.count).toBe(receiptCount);
    inspect.close();
  }
});

it('rolls back state when receipt insertion fails and detects corrupt persisted evidence', async () => {
  const file = await path(), store = await openSqliteModelActivationStore(file, options); store.close();
  const db = new DatabaseSync(file); db.exec(`CREATE TRIGGER reject_activation_receipt BEFORE INSERT ON model_activation_receipts
    BEGIN SELECT RAISE(ABORT,'fixture receipt failure'); END;`); db.close();
  const failing = await openSqliteModelActivationStore(file, options, 'forbid');
  await expect(failing.admit(activate('scope-a', 'activate-a'))).rejects.toThrow('MODEL_ACTIVATION_UNAVAILABLE');
  await expect(failing.loadRecord('scope-a', reference)).resolves.toBeNull(); failing.close();
  const inspect = new DatabaseSync(file); inspect.exec('DROP TRIGGER reject_activation_receipt');
  inspect.prepare(`INSERT INTO model_activations(scope_id,provider_id,provider_version,model_id,model_version,revision,record)
    VALUES(?,?,?,?,?,?,?)`).run('scope-a', 'provider', 1, 'model', 2, 1, '{}'); inspect.close();
  const corrupt = await openSqliteModelActivationStore(file, options, 'forbid');
  await expect(corrupt.loadRecord('scope-a', reference)).rejects.toThrow('MODEL_ACTIVATION_CORRUPT'); corrupt.close();
});

it('allows only one winner for distinct commands at the same expected revision across connections', async () => {
  const file = await path(), first = await openSqliteModelActivationStore(file, options);
  const second = await openSqliteModelActivationStore(file, options, 'forbid');
  try {
    const outcomes = await Promise.allSettled([first.admit(activate('scope-a', 'command-a')), second.admit(activate('scope-a', 'command-b'))]);
    expect(outcomes.filter(value => value.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter(value => value.status === 'rejected')).toHaveLength(1);
    expect((await first.loadRecord('scope-a', reference))?.revision).toBe(1);
  } finally { first.close(); second.close(); }
});
