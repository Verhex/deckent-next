import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { openSqliteModelActivationStore, openSqliteModelInvocationReader, openSqliteModelInvocationStore } from '#adapters/index.js';
import { encodeModelBindingDefinition, parseProviderCatalog, resolveModelBindingDefinition } from '#domain/index.js';
import { modelInvocationProfileDigest, modelInvocationRequestDigest, providerSpendQuoteDigest,
  providerSpendReservationDigest } from '#engine/index.js';

const roots: string[] = [], options = { journalMode: 'delete' as const, durability: 'full' as const, busyTimeoutMs: 2_000 };
const reference = { providerId: 'provider', providerVersion: 1, modelId: 'model', modelVersion: 1 };
const definition = resolveModelBindingDefinition(parseProviderCatalog({ schemaVersion: 1, revision: 'catalog', providers: [
  { id: 'provider', version: 1, models: [{ id: 'model', version: 1, nativeId: 'native/model',
    protocols: [{ family: 'chat', version: '1', capabilities: [] }] }] },
] }), reference)!;
const binding = { encodingVersion: 1 as const, algorithm: 'sha256' as const,
  digest: createHash('sha256').update(encodeModelBindingDefinition(definition)).digest('hex') };
const actor = { id: 'actor', issuer: 'host', subject: '1000', assurance: 'os-user' as const };
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))));

it('inspects reserved, held, and released-not-sent spending without exposing account totals or private request data', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deckent-spending-inspection-')); roots.push(root); const path = join(root, 'ledger.db');
  const activations = await openSqliteModelActivationStore(path, options);
  const activated = await activations.admit({ command: { schemaVersion: 1, action: 'activate', commandId: 'activate', scopeId: 'scope',
    reference, expectedRevision: 0, catalogRevision: 'catalog', expectedBinding: binding }, actor,
  authorization: { revision: 'policy', ruleId: 'activate' }, admittedAtMs: 1, definition }); activations.close();
  const profile = { schemaVersion: 1 as const, id: 'profile', version: 1, scopeId: 'scope', reference,
    bindingDigest: binding.digest, protocol: { family: 'chat', version: '1' }, adapter: { id: 'adapter', version: 1, definition: {} },
    allocation: { id: 'allocation', maxCalls: 3, maxInFlight: 3 }, limits: { requestMaxBytes: 1024, responseMaxBytes: 1024, timeoutMs: 1000 } };
  const profileDigest = modelInvocationProfileDigest(profile);
  const budget = { schemaVersion: 1 as const, scopeId: 'scope', budgetId: 'budget', revision: 1, currency: 'USD', limitMinorUnits: 100 };
  const admission = (suffix: string) => {
    const command = { schemaVersion: 1 as const, commandId: `command-${suffix}`, scopeId: 'scope', reference,
      catalogRevision: 'catalog', expectedBinding: binding, nativeRequest: { prompt: `private-${suffix}` } };
    const requestDigest = modelInvocationRequestDigest(command);
    const quote = { schemaVersion: 1 as const, scopeId: 'scope', requestDigest, profileDigest,
      pricing: { id: 'pricing', version: 1, digest: '291f395a66cb728f57612b09b06f9512815b982e9a5d65e3fafec28256ff0aa9', definition: { schemaVersion: 1, kind: 'synthetic-price' } },
      meter: { id: 'meter', version: 1, evidenceDigest: '446658cc1c39184b672f423a7f970bffab0e8f38e851c5b5dacd3f38eb85051f', evidence: { schemaVersion: 1, kind: 'synthetic-meter' } }, currency: 'USD', maxChargeMinorUnits: 10 };
    return { command, requestDigest, actor, authorization: { revision: 'policy', ruleId: 'invoke' }, definition,
      activation: activated.receipt.record, profile, profileDigest, invocationId: `invocation-${suffix}`, claimedAtMs: 2,
      spending: { budget, quote } };
  };
  const store = await openSqliteModelInvocationStore(path, options, 'forbid');
  const reserved = await store.claim(admission('reserved'));
  const held = await store.claim(admission('held')); await store.permitSend(held.record.receipt.claim, 'runtime', 3);
  await store.recordUnknown(held.record.receipt.claim, 'transport-error', 4);
  const released = await store.claim(admission('released'));
  await store.cancelInvocation({ command: { schemaVersion: 1, commandId: 'cancel', scopeId: 'scope',
    targetCommandId: released.record.receipt.claim.commandId, reference, expectedRequestDigest: released.record.receipt.claim.requestDigest },
  actor, authorization: { revision: 'policy', ruleId: 'cancel' }, requestedAtMs: 5 }); store.close();

  const before = await readFile(path), reader = await openSqliteModelInvocationReader(path, { busyTimeoutMs: 2_000 });
  try {
    const reservedInspection = await reader.loadInspection('scope', reserved.record.receipt.claim.invocationId);
    const heldInspection = await reader.loadInspection('scope', held.record.receipt.claim.invocationId);
    const releasedInspection = await reader.loadInspection('scope', released.record.receipt.claim.invocationId);
    expect(reservedInspection?.spending).toMatchObject({ descriptor: { quote: { maxChargeMinorUnits: 10 } }, disposition: { state: 'reserved' } });
    expect(heldInspection?.spending).toMatchObject({ disposition: { state: 'held', reason: 'unknown', observedMinorUnits: null } });
    expect(releasedInspection?.spending).toMatchObject({ disposition: { state: 'released-not-sent' } });
    const exposed = JSON.stringify([reservedInspection?.spending, heldInspection?.spending, releasedInspection?.spending]);
    expect(exposed).not.toContain('private-'); expect(exposed).not.toContain('reservedMinorUnits'); expect(exposed).not.toContain('settledMinorUnits');
  } finally { reader.close(); }
  expect(await readFile(path)).toEqual(before);

  const corrupt = new DatabaseSync(path);
  const row = corrupt.prepare('SELECT record FROM model_invocation_spend_reservations WHERE invocation_id=?')
    .get('invocation-held') as { record: string };
  const reservation = JSON.parse(row.record); reservation.descriptor.invocationId = 'foreign';
  corrupt.prepare('UPDATE model_invocation_spend_reservations SET record=?,digest=? WHERE invocation_id=?')
    .run(JSON.stringify(reservation), providerSpendReservationDigest(reservation), 'invocation-held'); corrupt.close();
  const rejected = await openSqliteModelInvocationReader(path, { busyTimeoutMs: 2_000 });
  await expect(rejected.loadInspection('scope', 'invocation-held')).rejects.toThrow('PROVIDER_SPEND_INVALID'); rejected.close();

  const repair = new DatabaseSync(path); reservation.descriptor.invocationId = 'invocation-held';
  reservation.descriptor.quote.requestDigest = 'c'.repeat(64);
  reservation.descriptor.quoteDigest = providerSpendQuoteDigest(reservation.descriptor.quote);
  repair.prepare('UPDATE model_invocation_spend_reservations SET record=?,digest=? WHERE invocation_id=?')
    .run(JSON.stringify(reservation), providerSpendReservationDigest(reservation), 'invocation-held'); repair.close();
  const rejectedReference = await openSqliteModelInvocationReader(path, { busyTimeoutMs: 2_000 });
  await expect(rejectedReference.loadInspection('scope', 'invocation-held')).rejects.toThrow('PROVIDER_SPEND_INVALID'); rejectedReference.close();
});
