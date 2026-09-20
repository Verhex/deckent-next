import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { openSqliteModelActivationStore, openSqliteModelInvocationCancellationInventory,
  openSqliteModelInvocationStore } from '#adapters/index.js';
import { encodeModelBindingDefinition, parseProviderCatalog, resolveModelBindingDefinition, type ModelInvocationClaim } from '#domain/index.js';
import { createModelInvocationResponseEvidence, modelInvocationProfileDigest, modelInvocationRequestDigest } from '#engine/index.js';

const roots: string[] = [], options = { journalMode: 'delete' as const, durability: 'full' as const, busyTimeoutMs: 2_000 };
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))));
const reference = { providerId: 'provider', providerVersion: 1, modelId: 'model', modelVersion: 1 };
const definition = resolveModelBindingDefinition(parseProviderCatalog({ schemaVersion: 1, revision: 'catalog', providers: [
  { id: 'provider', version: 1, models: [{ id: 'model', version: 1, nativeId: 'native/model',
    protocols: [{ family: 'chat', version: '1', capabilities: [] }] }] },
] }), reference)!;
const binding = { encodingVersion: 1 as const, algorithm: 'sha256' as const,
  digest: createHash('sha256').update(encodeModelBindingDefinition(definition)).digest('hex') };
const actor = { id: 'actor', issuer: 'host', subject: '1000', assurance: 'os-user' as const };

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'deckent-invocation-cancellation-inventory-')); roots.push(root);
  const path = join(root, 'ledger.db'), activations = await openSqliteModelActivationStore(path, options);
  const activated = await activations.admit({ command: { schemaVersion: 1, action: 'activate', commandId: 'activate', scopeId: 'scope',
    reference, expectedRevision: 0, catalogRevision: 'catalog', expectedBinding: binding }, actor,
  authorization: { revision: 'policy', ruleId: 'activate' }, admittedAtMs: 1, definition }); activations.close();
  const profile = { schemaVersion: 1 as const, id: 'profile', version: 1, scopeId: 'scope', reference, bindingDigest: binding.digest,
    protocol: { family: 'chat', version: '1' }, adapter: { id: 'adapter', version: 1, definition: {} },
    allocation: { id: 'allocation', maxCalls: 10, maxInFlight: 10 }, limits: { requestMaxBytes: 1024, responseMaxBytes: 1024, timeoutMs: 1000 } };
  return { path, activation: activated.receipt.record, profile };
}
function admission(base: Awaited<ReturnType<typeof fixture>>, commandId: string, invocationId: string) {
  const command = { schemaVersion: 1 as const, commandId, scopeId: 'scope', reference, catalogRevision: 'catalog',
    expectedBinding: binding, nativeRequest: { prompt: `private-${invocationId}` } };
  return { command, requestDigest: modelInvocationRequestDigest(command), actor,
    authorization: { revision: 'policy', ruleId: 'invoke' }, definition, activation: base.activation, profile: base.profile,
    profileDigest: modelInvocationProfileDigest(base.profile), invocationId, claimedAtMs: 2 };
}
function cancellation(claim: ModelInvocationClaim, commandId: string) {
  return { command: { schemaVersion: 1 as const, commandId, scopeId: claim.scopeId, targetCommandId: claim.commandId,
    reference, expectedRequestDigest: claim.requestDigest }, actor,
  authorization: { revision: 'policy', ruleId: 'cancel' }, requestedAtMs: 4 };
}
async function requested(base: Awaited<ReturnType<typeof fixture>>, commandId: string, invocationId: string,
  outcome: 'claimed' | 'unknown' = 'claimed') {
  const store = await openSqliteModelInvocationStore(base.path, options, 'forbid');
  const claimed = await store.claim(admission(base, commandId, invocationId)), claim = claimed.record.receipt.claim;
  await store.permitSend(claim, 'owner', 3);
  if (outcome === 'unknown') {
    const evidence = createModelInvocationResponseEvidence(base.profile.adapter, 'interrupted', null,
      Buffer.from(`retained-secret-${invocationId}`), false, 100);
    await store.recordUnknown(claim, 'transport-error', 4, evidence);
  }
  await store.cancelInvocation(cancellation(claim, `cancel-${commandId}`)); store.close();
  return claim;
}
const query = (afterInvocationId: string | null, limit: number) =>
  ({ schemaVersion: 1 as const, scopeId: 'scope', afterInvocationId, limit });

describe('SQLite model invocation cancellation inventory', () => {
  it('pages requested claimed/unknown and historical unobserved metadata in strict order without retained content', async () => {
    const base = await fixture();
    const firstClaim = await requested(base, 'command-a', 'invocation-a');
    await requested(base, 'command-b', 'invocation-b', 'unknown');
    const unobserved = await requested(base, 'command-c', 'invocation-c');
    const db = new DatabaseSync(base.path);
    const row = db.prepare('SELECT record FROM model_invocation_controls WHERE scope_id=? AND invocation_id=?')
      .get('scope', unobserved.invocationId) as { record: string };
    db.prepare('UPDATE model_invocation_controls SET send_state=?,record=? WHERE scope_id=? AND invocation_id=?')
      .run('unobserved', JSON.stringify({ ...JSON.parse(row.record), send: { state: 'unobserved' } }), 'scope', unobserved.invocationId);
    db.close();
    const inventory = await openSqliteModelInvocationCancellationInventory(base.path, { busyTimeoutMs: 2_000 });
    const page1 = await inventory.inspectCancellationInventory(query(null, 2));
    expect(page1.entries.map(entry => entry.receipt.claim.invocationId)).toEqual(['invocation-a', 'invocation-b']);
    expect(page1.nextAfterInvocationId).toBe('invocation-b');
    expect(page1.entries[0]?.receipt.claim).toEqual(firstClaim);
    expect(JSON.stringify(page1)).not.toContain('retained-secret');
    const page2 = await inventory.inspectCancellationInventory(query(page1.nextAfterInvocationId, 2));
    expect(page2.entries.map(entry => [entry.receipt.claim.invocationId, entry.control.send.state]))
      .toEqual([['invocation-c', 'unobserved']]);
    expect(page2.nextAfterInvocationId).toBe('invocation-c');
    expect(await inventory.inspectCancellationInventory(query(page2.nextAfterInvocationId, 2)))
      .toEqual({ entries: [], nextAfterInvocationId: null });
    expect(await inventory.inspectCancellationInventory({ ...query(null, 2), scopeId: 'other' }))
      .toEqual({ entries: [], nextAfterInvocationId: null });
    inventory.close();
  });

  it('excludes requested cancellations that became terminal and already-terminal cancellation audits', async () => {
    const base = await fixture(), lateClaim = await requested(base, 'late', 'invocation-late');
    const store = await openSqliteModelInvocationStore(base.path, options, 'forbid');
    await store.recordResponse(lateClaim, { schemaVersion: 1, native: { id: 'late' }, usage: null }, 8);
    const terminal = await store.claim(admission(base, 'terminal', 'invocation-terminal'));
    await store.permitSend(terminal.record.receipt.claim, 'owner', 9);
    await store.recordResponse(terminal.record.receipt.claim, { schemaVersion: 1, native: { id: 'done' }, usage: null }, 10);
    await store.cancelInvocation(cancellation(terminal.record.receipt.claim, 'cancel-terminal')); store.close();
    const inventory = await openSqliteModelInvocationCancellationInventory(base.path, { busyTimeoutMs: 0 });
    expect(await inventory.inspectCancellationInventory(query(null, 10))).toEqual({ entries: [], nextAfterInvocationId: null });
    inventory.close();
  });

  it('fails closed when a selected cancellation references a missing invocation or control', async () => {
    for (const missing of ['invocation', 'control'] as const) {
      const base = await fixture(); await requested(base, `command-${missing}`, `invocation-${missing}`);
      const db = new DatabaseSync(base.path); db.exec('PRAGMA foreign_keys=OFF');
      db.prepare(`DELETE FROM ${missing === 'invocation' ? 'model_invocations' : 'model_invocation_controls'}
        WHERE scope_id=? AND invocation_id=?`).run('scope', `invocation-${missing}`); db.close();
      const inventory = await openSqliteModelInvocationCancellationInventory(base.path, { busyTimeoutMs: 0 });
      await expect(inventory.inspectCancellationInventory(query(null, 10))).rejects.toThrow('MODEL_INVOCATION_CORRUPT');
      inventory.close();
    }
  });

  it('fails closed on audit/control disposition contradictions and malformed persisted JSON', async () => {
    for (const corruption of ['audit-prevented', 'control-prevented', 'audit-json', 'control-json'] as const) {
      const base = await fixture(), invocationId = `invocation-${corruption}`;
      await requested(base, `command-${corruption}`, invocationId);
      const db = new DatabaseSync(base.path);
      const audit = db.prepare('SELECT record FROM model_invocation_cancellations WHERE scope_id=? AND invocation_id=?')
        .get('scope', invocationId) as { record: string };
      const control = db.prepare('SELECT record FROM model_invocation_controls WHERE scope_id=? AND invocation_id=?')
        .get('scope', invocationId) as { record: string };
      if (corruption === 'audit-prevented') {
        db.prepare('UPDATE model_invocation_cancellations SET record=? WHERE scope_id=? AND invocation_id=?')
          .run(JSON.stringify({ ...JSON.parse(audit.record), disposition: 'prevented' }), 'scope', invocationId);
      } else if (corruption === 'control-prevented') {
        const parsed = JSON.parse(control.record);
        db.prepare('UPDATE model_invocation_controls SET send_state=?,record=? WHERE scope_id=? AND invocation_id=?')
          .run('prevented', JSON.stringify({ ...parsed, send: { state: 'prevented' },
            cancellation: { ...parsed.cancellation, disposition: 'prevented' } }), 'scope', invocationId);
      } else if (corruption === 'audit-json') {
        db.prepare('UPDATE model_invocation_cancellations SET record=? WHERE scope_id=? AND invocation_id=?')
          .run('{', 'scope', invocationId);
      } else {
        db.prepare('UPDATE model_invocation_controls SET record=? WHERE scope_id=? AND invocation_id=?')
          .run('{', 'scope', invocationId);
      }
      db.close();
      const inventory = await openSqliteModelInvocationCancellationInventory(base.path, { busyTimeoutMs: 0 });
      await expect(inventory.inspectCancellationInventory(query(null, 10))).rejects.toThrow('MODEL_INVOCATION_CORRUPT');
      inventory.close();
    }
  });

  it('validates query and open bounds without mutating the current ledger', async () => {
    const base = await fixture(), inventory = await openSqliteModelInvocationCancellationInventory(base.path, { busyTimeoutMs: 0 });
    for (const invalid of [{ ...query(null, 1), limit: 0 }, { ...query(null, 1), afterInvocationId: ' ' },
      { ...query(null, 1), extra: true }]) {
      await expect(inventory.inspectCancellationInventory(invalid)).rejects.toThrow('MODEL_INVOCATION_CORRUPT');
    }
    inventory.close();
    await expect(openSqliteModelInvocationCancellationInventory(base.path, { busyTimeoutMs: -1 })).rejects
      .toThrow('MODEL_INVOCATION_UNAVAILABLE');
  });
});
