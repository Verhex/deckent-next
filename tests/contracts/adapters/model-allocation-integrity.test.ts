import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { openSqliteModelActivationStore, openSqliteModelAllocationIntegrityReader, openSqliteModelInvocationStore } from '#adapters/index.js';
import { encodeModelBindingDefinition, parseProviderCatalog, resolveModelBindingDefinition, type ModelActivationRecord } from '#domain/index.js';
import { modelInvocationProfileDigest, modelInvocationRequestDigest, verifyModelAllocationIntegrity } from '#engine/index.js';

const roots: string[] = [];
const options = { busyTimeoutMs: 20, journalMode: 'delete' as const, durability: 'full' as const };
const reference = { providerId: 'provider', providerVersion: 1, modelId: 'model', modelVersion: 1 };
const definition = resolveModelBindingDefinition(parseProviderCatalog({ schemaVersion: 1, revision: 'catalog', providers: [{ id: 'provider', version: 1,
  models: [{ id: 'model', version: 1, nativeId: 'native/model', protocols: [{ family: 'openai-chat-completions', version: 'v1', capabilities: [] }] }] }] }), reference)!;
const binding = { encodingVersion: 1 as const, algorithm: 'sha256' as const,
  digest: createHash('sha256').update(encodeModelBindingDefinition(definition)).digest('hex') };
const actor = { id: 'actor', issuer: 'host', subject: '1000', assurance: 'os-user' } as const;
const authorization = { revision: 'policy', ruleId: 'invoke' } as const;

afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))));

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'deckent-model-allocation-integrity-')); roots.push(root);
  const path = join(root, 'ledger.db'), activations = new Map<string, ModelActivationRecord>();
  const activate = async (scopeId: string) => {
    const known = activations.get(scopeId); if (known) return known;
    const store = await openSqliteModelActivationStore(path, options);
    try {
      const result = await store.admit({ command: { schemaVersion: 1, action: 'activate', commandId: `activate-${scopeId}`, scopeId,
        reference, expectedRevision: 0, catalogRevision: 'catalog', expectedBinding: binding }, actor,
      authorization: { revision: 'policy', ruleId: 'activate' }, admittedAtMs: 1, definition });
      activations.set(scopeId, result.receipt.record); return result.receipt.record;
    } finally { store.close(); }
  };
  return { path, activate };
}
function profile(scopeId: string, allocationId = 'allocation') {
  return { schemaVersion: 1 as const, id: `profile-${scopeId}-${allocationId}`, version: 1, scopeId, reference, bindingDigest: binding.digest,
    protocol: { family: 'openai-chat-completions', version: 'v1' }, adapter: { id: 'fixture', version: 1, definition: {} },
    allocation: { id: allocationId, maxCalls: 20, maxInFlight: 20 }, limits: { requestMaxBytes: 4096, responseMaxBytes: 4096, timeoutMs: 1000 } };
}
function admission(base: Awaited<ReturnType<typeof fixture>>, scopeId: string, allocationId: string, commandId: string, invocationId: string, activation: ModelActivationRecord) {
  const command = { schemaVersion: 1 as const, commandId, scopeId, reference, catalogRevision: 'catalog', expectedBinding: binding,
    nativeRequest: { model: 'native/model', messages: [{ role: 'user', content: commandId }] } };
  const configured = profile(scopeId, allocationId);
  return { command, requestDigest: modelInvocationRequestDigest(command), actor, authorization, definition, activation,
    profile: configured, profileDigest: modelInvocationProfileDigest(configured), invocationId, claimedAtMs: 10 };
}
async function claim(base: Awaited<ReturnType<typeof fixture>>, store: Awaited<ReturnType<typeof openSqliteModelInvocationStore>>,
  scopeId: string, allocationId: string, commandId: string, invocationId: string) {
  return store.claim(admission(base, scopeId, allocationId, commandId, invocationId, await base.activate(scopeId)));
}
async function seedOutcomes(base: Awaited<ReturnType<typeof fixture>>, scopeId = 'scope', allocationId = 'allocation') {
  await base.activate(scopeId);
  const store = await openSqliteModelInvocationStore(base.path, options, 'forbid');
  try {
    const pending = await claim(base, store, scopeId, allocationId, `${allocationId}-pending`, `${allocationId}-a-pending`);
    const unknown = await claim(base, store, scopeId, allocationId, `${allocationId}-unknown`, `${allocationId}-b-unknown`);
    await store.permitSend(unknown.record.receipt.claim, 'sender', 11);
    await store.recordUnknown(unknown.record.receipt.claim, 'transport-error', 12);
    const prevented = await claim(base, store, scopeId, allocationId, `${allocationId}-prevented`, `${allocationId}-c-prevented`);
    await store.cancelInvocation({ command: { schemaVersion: 1, commandId: `${allocationId}-cancel`, scopeId,
      targetCommandId: prevented.record.receipt.claim.commandId, reference, expectedRequestDigest: prevented.record.receipt.claim.requestDigest },
    actor, authorization, requestedAtMs: 13 });
    const responded = await claim(base, store, scopeId, allocationId, `${allocationId}-responded`, `${allocationId}-d-responded`);
    await store.permitSend(responded.record.receipt.claim, 'sender', 14);
    await store.recordResponse(responded.record.receipt.claim, { schemaVersion: 1, native: { id: 'response' }, usage: null }, 15);
    return { pending, unknown, prevented, responded };
  } finally { store.close(); }
}

it('audits typed receipts across pages and retains only pending or unknown invocation capacity', async () => {
  const base = await fixture(); await seedOutcomes(base);
  const reader = await openSqliteModelAllocationIntegrityReader(base.path, { busyTimeoutMs: 20 });
  try {
    const first = await reader.readPage({ scopeId: 'scope', allocationId: 'allocation', checkpoint: null, afterInvocationId: null, limit: 2 });
    expect(first?.receipts.map(receipt => receipt.claim.invocationId)).toEqual(['allocation-a-pending', 'allocation-b-unknown']);
    const second = await reader.readPage({ scopeId: 'scope', allocationId: 'allocation', checkpoint: first!.checkpoint, afterInvocationId: first!.nextInvocationId, limit: 2 });
    expect(second?.receipts.map(receipt => receipt.claim.invocationId)).toEqual(['allocation-c-prevented', 'allocation-d-responded']);
    await expect(verifyModelAllocationIntegrity(reader, 'scope', 'allocation', 2)).resolves.toMatchObject({ status: 'consistent', lifetimeCalls: 4, inFlight: 2,
      checkpoint: { allocation: { scopeId: 'scope', allocationId: 'allocation', lifetimeCalls: 4, inFlight: 2 } } });
  } finally { reader.close(); }
});

it('isolates allocation and scope pages without making reader writes', async () => {
  const base = await fixture(); await seedOutcomes(base, 'scope', 'allocation-a'); await seedOutcomes(base, 'scope', 'allocation-b');
  await seedOutcomes(base, 'other', 'allocation-a'); const before = await readFile(base.path);
  const reader = await openSqliteModelAllocationIntegrityReader(base.path, { busyTimeoutMs: 20 });
  try {
    await expect(verifyModelAllocationIntegrity(reader, 'scope', 'allocation-a', 1)).resolves.toMatchObject({ status: 'consistent', lifetimeCalls: 4, inFlight: 2 });
    await expect(verifyModelAllocationIntegrity(reader, 'scope', 'allocation-b', 1)).resolves.toMatchObject({ status: 'consistent', lifetimeCalls: 4, inFlight: 2 });
    await expect(verifyModelAllocationIntegrity(reader, 'other', 'allocation-a', 1)).resolves.toMatchObject({ status: 'consistent', lifetimeCalls: 4, inFlight: 2 });
    await expect(verifyModelAllocationIntegrity(reader, 'scope', 'missing', 1)).resolves.toEqual({ status: 'not-found' });
  } finally { reader.close(); }
  expect(await readFile(base.path)).toEqual(before);
});

it('rejects a checkpoint that changes between read-only pages without writing', async () => {
  const base = await fixture(); await seedOutcomes(base); const reader = await openSqliteModelAllocationIntegrityReader(base.path, { busyTimeoutMs: 20 });
  let mutated = false;
  const racingReader = { close() { reader.close(); }, async readPage(query: Parameters<typeof reader.readPage>[0]) {
    const page = await reader.readPage(query);
    if (!mutated && page) {
      mutated = true;
      const store = await openSqliteModelInvocationStore(base.path, options, 'forbid');
      try { await claim(base, store, 'scope', 'allocation', 'allocation-race', 'allocation-e-race'); }
      finally { store.close(); }
    }
    return page;
  } };
  try { await expect(verifyModelAllocationIntegrity(racingReader, 'scope', 'allocation', 1)).rejects.toMatchObject({ code: 'MODEL_INVOCATION_ALLOCATION_CONFLICT' }); }
  finally { racingReader.close(); }
});

it('fences an earlier page after unknown settlement changes receipt evidence but not allocation counters', async () => {
  const base = await fixture(); await base.activate('scope');
  const store = await openSqliteModelInvocationStore(base.path, options, 'forbid');
  let claimed: Awaited<ReturnType<typeof claim>>;
  try {
    claimed = await claim(base, store, 'scope', 'allocation', 'allocation-claimed', 'allocation-a-claimed');
    await claim(base, store, 'scope', 'allocation', 'allocation-pending', 'allocation-b-pending');
  }
  finally { store.close(); }
  const counters = (path: string) => {
    const db = new DatabaseSync(path, { readOnly: true });
    try { return db.prepare("SELECT lifetime_calls,in_flight FROM model_invocation_allocations WHERE scope_id='scope' AND allocation_id='allocation'").get(); }
    finally { db.close(); }
  };
  const before = counters(base.path), reader = await openSqliteModelAllocationIntegrityReader(base.path, { busyTimeoutMs: 20 });
  try {
    const page = await reader.readPage({ scopeId: 'scope', allocationId: 'allocation', checkpoint: null, afterInvocationId: null, limit: 1 });
    const settle = await openSqliteModelInvocationStore(base.path, options, 'forbid');
    try {
      await settle.permitSend(claimed!.record.receipt.claim, 'sender', 11);
      await settle.recordUnknown(claimed!.record.receipt.claim, 'transport-error', 12);
    } finally { settle.close(); }
    expect(counters(base.path)).toEqual(before);
    const current = await reader.readPage({ scopeId: 'scope', allocationId: 'allocation', checkpoint: null, afterInvocationId: null, limit: 1 });
    expect(current?.checkpoint.revision).toBeGreaterThan(page!.checkpoint.revision);
    await expect(reader.readPage({ scopeId: 'scope', allocationId: 'allocation', checkpoint: page!.checkpoint,
      afterInvocationId: page!.nextInvocationId, limit: 1 })).rejects.toMatchObject({ code: 'MODEL_INVOCATION_ALLOCATION_CONFLICT' });
  } finally { reader.close(); }
});

it('fails the next claim closed when its allocation checkpoint is missing or tampered', async () => {
  for (const mutation of [
    `DELETE FROM model_invocation_allocation_checkpoints WHERE scope_id='scope' AND allocation_id='allocation'`,
    `UPDATE model_invocation_allocation_checkpoints SET digest='${'0'.repeat(64)}' WHERE scope_id='scope' AND allocation_id='allocation'`,
    `UPDATE model_invocation_allocations SET lifetime_calls=2 WHERE scope_id='scope' AND allocation_id='allocation'`,
  ]) {
    const base = await fixture(); await seedOutcomes(base); const db = new DatabaseSync(base.path);
    try { db.exec(mutation); } finally { db.close(); }
    const store = await openSqliteModelInvocationStore(base.path, options, 'forbid');
    try { await expect(claim(base, store, 'scope', 'allocation', 'allocation-after-damage', 'allocation-after-damage'))
      .rejects.toMatchObject({ code: 'MODEL_INVOCATION_CORRUPT' }); }
    finally { store.close(); }
  }
});

it('rolls allocation and invocation writes back when checkpoint advancement fails', async () => {
  const base = await fixture(); await seedOutcomes(base);
  const before = new DatabaseSync(base.path, { readOnly: true });
  const snapshot = {
    allocation: before.prepare("SELECT lifetime_calls,in_flight,record FROM model_invocation_allocations WHERE scope_id='scope' AND allocation_id='allocation'").get(),
    checkpoint: before.prepare("SELECT revision,digest FROM model_invocation_allocation_checkpoints WHERE scope_id='scope' AND allocation_id='allocation'").get(),
    invocations: before.prepare("SELECT count(*) AS count FROM model_invocations WHERE scope_id='scope' AND allocation_id='allocation'").get(),
  };
  before.close();
  const damage = new DatabaseSync(base.path);
  try { damage.exec(`CREATE TRIGGER reject_allocation_checkpoint BEFORE UPDATE ON model_invocation_allocation_checkpoints
    BEGIN SELECT RAISE(ABORT,'fixture checkpoint failure'); END;`); }
  finally { damage.close(); }
  const store = await openSqliteModelInvocationStore(base.path, options, 'forbid');
  try { await expect(claim(base, store, 'scope', 'allocation', 'allocation-checkpoint-failure', 'allocation-checkpoint-failure'))
    .rejects.toMatchObject({ code: 'MODEL_INVOCATION_UNAVAILABLE' }); }
  finally { store.close(); }
  const after = new DatabaseSync(base.path, { readOnly: true });
  try {
    expect(after.prepare("SELECT lifetime_calls,in_flight,record FROM model_invocation_allocations WHERE scope_id='scope' AND allocation_id='allocation'").get()).toEqual(snapshot.allocation);
    expect(after.prepare("SELECT revision,digest FROM model_invocation_allocation_checkpoints WHERE scope_id='scope' AND allocation_id='allocation'").get()).toEqual(snapshot.checkpoint);
    expect(after.prepare("SELECT count(*) AS count FROM model_invocations WHERE scope_id='scope' AND allocation_id='allocation'").get()).toEqual(snapshot.invocations);
  } finally { after.close(); }
});
