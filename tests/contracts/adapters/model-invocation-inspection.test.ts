import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { openSqliteModelActivationStore, openSqliteModelInvocationReader, openSqliteModelInvocationStore } from '#adapters/index.js';
import { CURRENT_LEDGER_VERSION } from '#adapters/core/sqlite-ledger/index.js';
import { encodeModelBindingDefinition, parseProviderCatalog, resolveModelBindingDefinition } from '#domain/index.js';
import { modelInvocationProfileDigest, modelInvocationRequestDigest } from '#engine/index.js';

const roots: string[] = [], options = { journalMode: 'delete' as const, durability: 'full' as const, busyTimeoutMs: 2_000 };
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))));
const reference = { providerId: 'provider', providerVersion: 1, modelId: 'model', modelVersion: 1 };
const definition = resolveModelBindingDefinition(parseProviderCatalog({ schemaVersion: 1, revision: 'catalog', providers: [
  { id: 'provider', version: 1, models: [{ id: 'model', version: 1, nativeId: 'native/model',
    protocols: [{ family: 'chat', version: '1', capabilities: [] }] }] },
] }), reference)!;
const binding = { encodingVersion: 1 as const, algorithm: 'sha256' as const,
  digest: createHash('sha256').update(encodeModelBindingDefinition(definition)).digest('hex') };
const actor = { id: 'actor', issuer: 'host', subject: '1000', assurance: 'os-user' } as const;

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'deckent-model-invocation-inspection-')); roots.push(root);
  const path = join(root, 'ledger.db'), activations = await openSqliteModelActivationStore(path, options);
  const activated = await activations.admit({ command: { schemaVersion: 1, action: 'activate', commandId: 'activate', scopeId: 'scope',
    reference, expectedRevision: 0, catalogRevision: 'catalog', expectedBinding: binding }, actor,
  authorization: { revision: 'policy', ruleId: 'activate' }, admittedAtMs: 1, definition }); activations.close();
  const profile = { schemaVersion: 1 as const, id: 'profile', version: 1, scopeId: 'scope', reference,
    bindingDigest: binding.digest, protocol: { family: 'chat', version: '1' }, adapter: { id: 'adapter', version: 1, definition: {} },
    allocation: { id: 'allocation', maxCalls: 2, maxInFlight: 2 }, limits: { requestMaxBytes: 1024, responseMaxBytes: 1024, timeoutMs: 1000 } };
  const command = { schemaVersion: 1 as const, commandId: 'invoke', scopeId: 'scope', reference,
    catalogRevision: 'catalog', expectedBinding: binding, nativeRequest: { prompt: 'private' } };
  const store = await openSqliteModelInvocationStore(path, options, 'forbid');
  const claimed = await store.claim({ command, requestDigest: modelInvocationRequestDigest(command), actor,
    authorization: { revision: 'policy', ruleId: 'invoke' }, definition, activation: activated.receipt.record, profile,
    profileDigest: modelInvocationProfileDigest(profile), invocationId: 'invocation', claimedAtMs: 2 });
  await store.permitSend(claimed.record.receipt.claim, 'runtime-owner', 3);
  const cancellation = { command: { schemaVersion: 1 as const, commandId: 'cancel', scopeId: 'scope', targetCommandId: 'invoke',
    reference, expectedRequestDigest: claimed.record.receipt.claim.requestDigest }, actor,
  authorization: { revision: 'policy', ruleId: 'cancel' }, requestedAtMs: 4 };
  await store.cancelInvocation(cancellation); store.close();
  return { path, claim: claimed.record.receipt.claim };
}

it('loads one read-only receipt/control/cancellation snapshot and rejects contradictory control identity', async () => {
  const base = await fixture(), before = await readFile(base.path);
  const reader = await openSqliteModelInvocationReader(base.path, { busyTimeoutMs: 2_000 });
  const inspected = await reader.loadInspection('scope', 'invocation'); reader.close();
  expect(inspected).toMatchObject({ record: { receipt: { claim: base.claim, outcome: null }, content: null, purge: null },
    control: { claim: base.claim, reference, send: { state: 'permitted', ownerId: 'runtime-owner' },
      cancellation: { command: { commandId: 'cancel', targetCommandId: 'invoke' }, disposition: 'requested' } }, spending: null });
  expect(await readFile(base.path)).toEqual(before);
  const version = new DatabaseSync(base.path, { readOnly: true });
  expect(version.prepare('PRAGMA user_version').get()?.user_version).toBe(CURRENT_LEDGER_VERSION); version.close();

  const corrupt = new DatabaseSync(base.path);
  const row = corrupt.prepare('SELECT record FROM model_invocation_controls WHERE invocation_id=?').get('invocation') as { record: string };
  const control = JSON.parse(row.record); control.claim.invocationId = 'foreign-invocation';
  corrupt.prepare('UPDATE model_invocation_controls SET record=? WHERE invocation_id=?').run(JSON.stringify(control), 'invocation'); corrupt.close();
  const rejected = await openSqliteModelInvocationReader(base.path, { busyTimeoutMs: 2_000 });
  await expect(rejected.loadInspection('scope', 'invocation')).rejects.toThrow('MODEL_INVOCATION_CORRUPT'); rejected.close();
  const contradictory = new DatabaseSync(base.path);
  control.claim.invocationId = 'invocation'; control.send = { state: 'pending' };
  contradictory.prepare('UPDATE model_invocation_controls SET send_state=?,record=? WHERE invocation_id=?')
    .run('pending', JSON.stringify(control), 'invocation'); contradictory.close();
  const rejectedState = await openSqliteModelInvocationReader(base.path, { busyTimeoutMs: 2_000 });
  await expect(rejectedState.loadInspection('scope', 'invocation')).rejects.toThrow('MODEL_INVOCATION_CORRUPT'); rejectedState.close();
});
