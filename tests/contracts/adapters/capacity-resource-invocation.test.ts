import { createHash } from 'node:crypto';
import { mkdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { encodeModelBindingDefinition, parseModelBindingDefinition } from '#domain/index.js';
import { hasCapacityRoom, modelInvocationProfileDigest, modelInvocationRequestDigest } from '#engine/index.js';
import { openSqliteAttemptStore, openSqliteModelActivationStore, openSqliteModelInvocationStore } from '#adapters/index.js';
import { bindCapacityResource, openSqliteLedger } from '#adapters/core/sqlite-ledger/index.js';
import { headlessCapacityBinding, readCapacityResourceOccupancy } from '#adapters/core/sqlite-model-invocation/index.js';
import { binding as baseDefinition, cleanupConnections, connection } from '../../fixtures/native-headless/connection.js';
import { fixtureExecution } from '../support/execution-registry.js';
afterEach(cleanupConnections);
const sqlite = { journalMode: 'delete', durability: 'full', busyTimeoutMs: 100 } as const;
const actor = { id: 'person', issuer: 'fixture', subject: 'owner', assurance: 'os-user' } as const;
const authorization = { revision: 'policy', ruleId: 'invoke' };
async function fixture(bound = true, slots = 1) {
  const c = await connection(), path = join(c.root, 'ledger.db');
  async function admit(scopeId: string, modelId: string) {
    const definition = parseModelBindingDefinition({ ...baseDefinition, model: { ...baseDefinition.model, id: modelId } });
    const reference = { providerId: definition.provider.id, providerVersion: definition.provider.version, modelId, modelVersion: definition.model.version };
    const expectedBinding = { encodingVersion: 1 as const, algorithm: 'sha256' as const, digest: createHash('sha256').update(encodeModelBindingDefinition(definition)).digest('hex') };
    const activations = await openSqliteModelActivationStore(path, sqlite);
    const activated = await activations.admit({ command: { schemaVersion: 1, action: 'activate', commandId: 'activate', scopeId,
      reference, expectedRevision: 0, catalogRevision: 'catalog', expectedBinding }, actor, authorization, definition, admittedAtMs: 1 }); activations.close();
    const profile = { ...c.profile, scopeId, reference, bindingDigest: expectedBinding.digest, allocation: { ...c.profile.allocation, id: 'allocation-' + modelId } };
    const command = { schemaVersion: 1 as const, commandId: 'invoke', scopeId, reference, catalogRevision: 'catalog', expectedBinding,
      nativeRequest: { model: definition.model.nativeId, messages: [{ role: 'user', content: 'fixture' }] } };
    return { command, actor, authorization, definition, activation: activated.receipt.record, profile, profileDigest: modelInvocationProfileDigest(profile),
      requestDigest: modelInvocationRequestDigest(command), invocationId: 'invocation', claimedAtMs: 2 };
  }
  const first = await admit('one', 'first-model'), second = await admit('two', 'second-model');
  const db = openSqliteLedger(path, sqlite, 'forbid'); let resourceKey: string | null = null;
  try { if (bound) resourceKey = bindCapacityResource(db, headlessCapacityBinding(c.profile.adapter.definition), { executionSlots: slots, inFlightSlots: slots }).resourceKey; } finally { db.close(); }
  return { c, path, first, second, resourceKey };
}
it('shares one login resource between two models/projects; cancellation and proven-ended send custody free it without changing an unknown outcome', async () => {
  const f = await fixture(), store = await openSqliteModelInvocationStore(f.path, sqlite, 'forbid');
  try {
    const first = await store.claim(f.first); await expect(store.claim(f.second)).rejects.toMatchObject({ code: 'MODEL_INVOCATION_CAPACITY_EXHAUSTED' });
    expect(await store.claim(f.first)).toMatchObject({ replayed: true }); expect(await store.loadReceipt('two', 'invoke')).toBeNull();
    await store.cancelInvocation({ command: { schemaVersion: 1, commandId: 'cancel', scopeId: 'one', targetCommandId: 'invoke', reference: f.first.command.reference,
      expectedRequestDigest: f.first.requestDigest }, actor, authorization, requestedAtMs: 3 });
    const second = await store.claim(f.second); await store.permitSend(second.record.receipt.claim, 'ended-owner', 4);
    expect(await store.releaseSettledSlots({ atMs: 5, endedOwner: () => false })).toMatchObject({ settled: 0 });
    const db = openSqliteLedger(f.path, sqlite, 'forbid');
    try { expect(readCapacityResourceOccupancy(db, f.resourceKey!)).toEqual({ execution: 1, inFlight: 1 }); } finally { db.close(); }
    expect(await store.releaseSettledSlots({ atMs: 6, endedOwner: owner => owner === 'ended-owner' })).toMatchObject({ settled: 1 });
    expect((await store.loadInvocation('two', 'invocation'))?.receipt.outcome?.state).toBe('unknown');
    const after = openSqliteLedger(f.path, sqlite, 'forbid');
    try { expect(readCapacityResourceOccupancy(after, f.resourceKey!)).toEqual({ execution: 0, inFlight: 0 }); } finally { after.close(); }
    expect(first.record.receipt.outcome).toBeNull();
  } finally { store.close(); }
});
it('writes the shared resource key and keeps mixed legacy/new capacity decisions identical to the JSON-only reader', async () => {
  const f = await fixture(true, 2), store = await openSqliteModelInvocationStore(f.path, sqlite, 'forbid');
  const db = openSqliteLedger(f.path, sqlite, 'forbid');
  const keys = () => db.prepare('SELECT scope_id,resource_key FROM model_invocations ORDER BY scope_id').all();
  const decision = () => {
    const occupancy = readCapacityResourceOccupancy(db, f.resourceKey!);
    return JSON.stringify({ occupancy, room: hasCapacityRoom({ executionSlots: 2, inFlightSlots: 2 }, occupancy) });
  };
  try {
    const first = await store.claim(f.first);
    expect(keys()).toEqual([{ scope_id: 'one', resource_key: f.resourceKey }]);
    // A migrated receipt keeps its original bytes and NULL metadata until a product write touches it.
    db.exec('UPDATE model_invocations SET resource_key=NULL');
    const legacyRecord = db.prepare("SELECT record FROM model_invocations WHERE scope_id='one'").get()?.record;
    await store.claim(f.second);
    expect(keys()).toEqual([{ scope_id: 'one', resource_key: null }, { scope_id: 'two', resource_key: f.resourceKey }]);
    const prepare = vi.spyOn(db, 'prepare');
    const mixed = decision();
    const lookup = prepare.mock.calls.find(([sql]) => sql.startsWith('SELECT scope_id,invocation_id,record FROM model_invocations'))![0];
    prepare.mockRestore();
    const plan = db.prepare('EXPLAIN QUERY PLAN ' + lookup).all(f.resourceKey!);
    expect(plan.filter(row => String(row.detail).includes('SEARCH model_invocations USING INDEX model_invocations_resource_claimed (resource_key=?)'))).toHaveLength(2);
    expect(JSON.parse(mixed)).toEqual({ occupancy: { execution: 2, inFlight: 2 }, room: false });
    const third = { ...f.first, command: { ...f.first.command, commandId: 'third' }, invocationId: 'third' };
    third.requestDigest = modelInvocationRequestDigest(third.command);
    await expect(store.claim(third)).rejects.toMatchObject({ code: 'MODEL_INVOCATION_CAPACITY_EXHAUSTED' });
    db.exec('BEGIN; PRAGMA user_version=74');
    try { expect(decision()).toBe(mixed); } finally { db.exec('ROLLBACK'); }
    expect(db.prepare("SELECT record FROM model_invocations WHERE scope_id='one'").get()?.record).toBe(legacyRecord);
    await store.cancelInvocation({ command: { schemaVersion: 1, commandId: 'cancel', scopeId: 'one', targetCommandId: 'invoke', reference: f.first.command.reference,
      expectedRequestDigest: f.first.requestDigest }, actor, authorization, requestedAtMs: 3 });
    expect(first.record.receipt.outcome).toBeNull();
    expect(keys()).toEqual([{ scope_id: 'one', resource_key: f.resourceKey }, { scope_id: 'two', resource_key: f.resourceKey }]);
    const freed = decision();
    expect(JSON.parse(freed)).toEqual({ occupancy: { execution: 1, inFlight: 1 }, room: true });
    db.exec('BEGIN; PRAGMA user_version=74');
    try { expect(decision()).toBe(freed); } finally { db.exec('ROLLBACK'); }
    await expect(store.claim(third)).resolves.toMatchObject({ replayed: false });
    expect(keys().every(row => row.resource_key === f.resourceKey)).toBe(true);
  } finally { db.close(); store.close(); }
});
it('binds an alpha.62-shaped subscription on its first claim, reuses the login resource and separates another login directory', async () => {
  const f = await fixture(false), store = await openSqliteModelInvocationStore(f.path, sqlite, 'forbid');
  try {
    expect(f.first.profile.adapter.definition).not.toHaveProperty('sourceBinding');
    await expect(store.claim(f.first)).resolves.toMatchObject({ replayed: false });
    const db = openSqliteLedger(f.path, sqlite, 'forbid');
    try { expect(db.prepare('SELECT count(*) AS n FROM capacity_resources').get()?.n).toBe(1); } finally { db.close(); }
    await expect(store.claim(f.second)).rejects.toMatchObject({ code: 'MODEL_INVOCATION_CAPACITY_EXHAUSTED' });
    const configDir = join(f.c.root, 'second-login'); await mkdir(configDir, { mode: 0o700 });
    const profile = { ...f.second.profile, adapter: { ...f.second.profile.adapter, definition: { ...f.second.profile.adapter.definition, configDir } } };
    await expect(store.claim({ ...f.second, profile, profileDigest: modelInvocationProfileDigest(profile) })).resolves.toMatchObject({ replayed: false });
    const after = openSqliteLedger(f.path, sqlite, 'forbid');
    try {
      expect(after.prepare('SELECT count(*) AS n FROM capacity_resources').get()?.n).toBe(2);
      const resources = after.prepare('SELECT resource_key FROM model_invocations ORDER BY scope_id').all();
      expect(resources.every(row => typeof row.resource_key === 'string')).toBe(true);
      expect(new Set(resources.map(row => row.resource_key)).size).toBe(2);
      const keyed = resources.map(row => readCapacityResourceOccupancy(after, String(row.resource_key)));
      expect(keyed).toEqual([{ execution: 1, inFlight: 1 }, { execution: 1, inFlight: 1 }]);
      after.exec('BEGIN; PRAGMA user_version=74');
      try { expect(resources.map(row => readCapacityResourceOccupancy(after, String(row.resource_key)))).toEqual(keyed); }
      finally { after.exec('ROLLBACK'); }
    } finally { after.close(); }
  } finally { store.close(); }
});
it('reports unavailable legacy login metadata as reconnect required before allocation or invocation writes', async () => {
  const f = await fixture(false), store = await openSqliteModelInvocationStore(f.path, sqlite, 'forbid');
  // A login whose family no registry CLI serves has no slot count, so its first claim is refused, never left uncounted (KG10 F3).
  const unserved = { ...f.second.profile, protocol: { ...f.second.profile.protocol, family: 'unserved-family' } };
  await expect(store.claim({ ...f.second, profile: unserved, profileDigest: modelInvocationProfileDigest(unserved) })).rejects.toMatchObject({ code: 'NATIVE_AGENT_RECONNECT_REQUIRED' });
  await rename(f.c.configDir, join(f.c.root, 'moved-login'));
  try {
    await expect(store.claim(f.first)).rejects.toMatchObject({ code: 'NATIVE_AGENT_RECONNECT_REQUIRED' });
    expect(await store.loadReceipt('one', 'invoke')).toBeNull();
    const db = openSqliteLedger(f.path, sqlite, 'forbid');
    try {
      expect(db.prepare('SELECT count(*) AS n FROM capacity_resources').get()?.n).toBe(0);
      expect(db.prepare('SELECT count(*) AS n FROM model_invocation_allocations').get()?.n).toBe(0);
    } finally { db.close(); }
  } finally { store.close(); }
});
it('counts a model call against a worker reservation and a worker reservation against a model call', async () => {
  const f = await fixture(), model = await openSqliteModelInvocationStore(f.path, sqlite, 'forbid');
  const runs = await openSqliteAttemptStore(f.path, sqlite, { now: Date.now, timeoutMs: 1000 });
  const graph = { schemaVersion: 2 as const, revision: 1, tasks: [{ id: 'a', kind: 'custom', dependencies: [], acceptanceCriteria: ['exit'] }],
    criterionDefinitions: [{ id: 'exit', version: 1, description: 'exit', evaluator: { id: 'process-exit', version: 1 }, parameters: { acceptedExitCodes: [0] } }] };
  const runActor = { id: actor.id, issuer: actor.issuer, subject: actor.subject };
  const claim = { commandId: 'reserve', actor: runActor, scopeId: 'worker-project', runId: 'run', expectedRevision: 0, now: 4,
    identities: [{ scopeId: 'worker-project', runId: 'run', layoutRevision: 'layout', taskId: 'a', attemptId: 'attempt', generation: 1 }] };
  try {
    await runs.createExecutionPool({ schemaVersion: 1, poolId: 'pool', capacity: { executionSlots: 4, inFlightSlots: 4 } });
    await runs.createRun({ commandId: 'create', actor: runActor, identity: { scopeId: 'worker-project', runId: 'run', layoutRevision: 'layout' }, graph,
      execution: fixtureExecution(graph), now: 1, policy: { schemaVersion: 2, poolId: 'pool', capacity: { executionSlots: 4, inFlightSlots: 4 }, ordering: ['a'] } },
    undefined, undefined, [{ taskId: 'a', resourceKey: f.resourceKey! }]);
    await model.claim(f.first);
    await expect(runs.reserveRunTasks(claim)).rejects.toMatchObject({ code: 'RUN_CAPACITY_OR_ORDER' });
    await model.cancelInvocation({ command: { schemaVersion: 1, commandId: 'cancel', scopeId: 'one', targetCommandId: 'invoke', reference: f.first.command.reference,
      expectedRequestDigest: f.first.requestDigest }, actor, authorization, requestedAtMs: 3 });
    await runs.reserveRunTasks(claim);
    await expect(model.claim(f.second)).rejects.toMatchObject({ code: 'MODEL_INVOCATION_CAPACITY_EXHAUSTED' });
    expect(await model.loadReceipt('two', 'invoke')).toBeNull();
  } finally { model.close(); runs.close(); }
});
