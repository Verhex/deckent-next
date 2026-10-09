import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { openSqliteModelActivationStore, openSqliteModelInvocationStore, openSqliteProviderSpendRecoveryStore,
  openSqliteProviderSpendIntegrityReader, openSqliteProviderSpendAccountReader } from '#adapters/index.js';
import { encodeModelBindingDefinition, parseProviderCatalog, resolveModelBindingDefinition } from '#domain/index.js';
import { parseProviderSpendReservation, recoverProviderSpendHold, createProviderSpendCheckpoint, modelInvocationProfileDigest, modelInvocationRequestDigest, providerSpendEvidenceDigest,
  providerSpendQuoteDigest, providerSpendReservationDigest, createModelInvocationResponseEvidence, verifyProviderSpendIntegrity } from '#engine/index.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const options = { journalMode: 'delete' as const, durability: 'full' as const, busyTimeoutMs: 2000 };
const reference = { providerId: 'provider', providerVersion: 1, modelId: 'model', modelVersion: 1 };
const definition = resolveModelBindingDefinition(parseProviderCatalog({ schemaVersion: 1, revision: 'catalog', providers: [
  { id: 'provider', version: 1, models: [{ id: 'model', version: 1, nativeId: 'native/model', protocols: [{ family: 'openai-chat-completions', version: 'v1', capabilities: [] }] }] },
] }), reference)!;
const binding = { encodingVersion: 1 as const, algorithm: 'sha256' as const, digest: createHash('sha256').update(encodeModelBindingDefinition(definition)).digest('hex') };
const actor = { id: 'actor', issuer: 'host', subject: '1000', assurance: 'os-user' } as const;
const free = { kind: 'operator-static', version: 1, currency: 'USD', inputMinorUnitsPerMillionTokens: 0, outputMinorUnitsPerMillionTokens: 0 };
const budget = { schemaVersion: 1 as const, scopeId: 'scope', budgetId: 'scope-budget', revision: 1, currency: 'USD', limitMinorUnits: 2500 };

async function fixture(rows: readonly { amount: number; endpoint?: string; status?: number; zero?: boolean; incomplete?: boolean; notSent?: boolean }[]) {
  const root = await mkdtemp(join(tmpdir(), 'deckent-hold-recovery-')); roots.push(root); const path = join(root, 'ledger.db');
  const activations = await openSqliteModelActivationStore(path, options);
  const active = await activations.admit({ command: { schemaVersion: 1, action: 'activate', commandId: 'activate', scopeId: 'scope', reference,
    expectedRevision: 0, catalogRevision: 'catalog', expectedBinding: binding }, actor, authorization: { revision: 'policy', ruleId: 'activate' }, admittedAtMs: 1, definition });
  activations.close();
  const store = await openSqliteModelInvocationStore(path, options, 'forbid');
  for (const [index, row] of rows.entries()) {
    const id = `inv-${String(index).padStart(3, '0')}`;
    const command = { schemaVersion: 1 as const, commandId: id, scopeId: 'scope', reference, catalogRevision: 'catalog', expectedBinding: binding, nativeRequest: { model: 'native/model' } };
    const profile = { schemaVersion: 1 as const, id: 'profile', version: 1, scopeId: 'scope', reference, bindingDigest: binding.digest,
      protocol: { family: 'openai-chat-completions', version: 'v1' }, adapter: { id: 'fixture', version: 1,
        definition: { endpoint: row.endpoint ?? 'https://api.openai.com/v1/responses' } }, allocation: { id: 'allocation', maxCalls: 100, maxInFlight: 100 },
      limits: { requestMaxBytes: 4096, responseMaxBytes: 4096, timeoutMs: 1000 } };
    const requestDigest = modelInvocationRequestDigest(command), profileDigest = modelInvocationProfileDigest(profile);
    const price = { kind: 'synthetic-price' }, evidence = { kind: 'synthetic-meter' };
    const quote = { schemaVersion: 1 as const, scopeId: 'scope', requestDigest, profileDigest, currency: 'USD', maxChargeMinorUnits: row.amount,
      pricing: { id: 'price', version: 1, definition: price, digest: providerSpendEvidenceDigest(price) }, meter: { id: 'meter', version: 1, evidence, evidenceDigest: providerSpendEvidenceDigest(evidence) } };
    const result = await store.claim({ command, requestDigest, actor, authorization: { revision: 'policy', ruleId: 'invoke' }, definition,
      activation: active.receipt.record, profile, profileDigest, invocationId: id, claimedAtMs: 10, spending: { budget, quote } });
    await store.permitSend(result.record.receipt.claim, 'owner', 11);
    if (row.notSent) await store.recordRejected(result.record.receipt.claim, createModelInvocationResponseEvidence({ id: 'fixture', version: 1 }, 'not-sent', null, Buffer.alloc(0), true), 12);
    else if (row.status) {
      const evidence = createModelInvocationResponseEvidence({ id: 'fixture', version: 1 }, row.incomplete ? 'interrupted' : 'http-status', row.status, Buffer.from('{"error":"rejected"}'), !row.incomplete);
      if (row.incomplete) await store.recordUnknown(result.record.receipt.claim, 'transport-error', 12, evidence);
      else await store.recordRejected(result.record.receipt.claim, evidence, 12);
    } else await store.recordUnknown(result.record.receipt.claim, 'transport-error', 12);
  }
  store.close();
  // Reconstruct valid pre-W6 v3 held rows, not a live database: same invocation/content/quote checksums and checkpoint fold.
  const db = new DatabaseSync(path);
  let reserved = 0;
  for (const [index, row] of rows.entries()) {
    const id = `inv-${String(index).padStart(3, '0')}`, raw = db.prepare('SELECT record FROM model_invocation_spend_reservations WHERE invocation_id=?').get(id)!;
    const value = JSON.parse(String(raw.record)); reserved += row.amount;
    value.schemaVersion = 3;
    value.disposition = { state: 'held', reason: 'unknown', observedMinorUnits: null, evidenceDigest: value.disposition.evidenceDigest };
    if (row.zero) { value.descriptor.quote.pricing = { id: 'operator-static-tariff', version: 1, definition: free, digest: providerSpendEvidenceDigest(free) }; value.descriptor.quoteDigest = providerSpendQuoteDigest(value.descriptor.quote); }
    db.prepare('UPDATE model_invocation_spend_reservations SET record=?,digest=? WHERE invocation_id=?').run(JSON.stringify(value), providerSpendReservationDigest(value), id);
  }
  const accountRow = db.prepare('SELECT record,revision,reservation_count FROM provider_spend_accounts').get()!;
  const account = { ...JSON.parse(String(accountRow.record)), reservedMinorUnits: reserved };
  const checkpoint = createProviderSpendCheckpoint(account, Number(accountRow.revision), Number(accountRow.reservation_count));
  db.prepare('UPDATE provider_spend_accounts SET record=?,digest=?').run(JSON.stringify(account), checkpoint.digest);
  db.close(); return path;
}
function records(path: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try { return { account: db.prepare('SELECT * FROM provider_spend_accounts').get(),
    reservations: db.prepare('SELECT * FROM model_invocation_spend_reservations ORDER BY invocation_id').all(),
    invocations: db.prepare('SELECT * FROM model_invocations ORDER BY invocation_id').all() }; } finally { db.close(); }
}

it('recovers the live-shaped 26 v3 holds / 884 minor units, retains 22 zero histories, and leaves a genuinely uncertain call held', async () => {
  const path = await fixture([{ amount: 386, status: 400 }, { amount: 386, status: 400 }, { amount: 78, status: 400 },
    { amount: 34, status: 404, endpoint: 'https://openrouter.ai/api/v1/chat/completions' },
    ...Array.from({ length: 22 }, () => ({ amount: 0, zero: true, endpoint: 'http://127.0.0.1/chat' })), { amount: 6 }]);
  const before = records(path), store = await openSqliteProviderSpendRecoveryStore(path, options);
  expect(JSON.parse(String(before.account!.record)).reservedMinorUnits).toBe(890);
  expect(await store.recoverCertifiedHolds(20)).toEqual({ released: 26, zeroTariff: 22, inconsistent: [] });
  const after = records(path);
  expect(after.invocations).toEqual(before.invocations);
  expect(JSON.parse(String(after.account!.record))).toMatchObject({ reservedMinorUnits: 6, settledExactMinorUnits: '0' });
  expect(after.account!.reservation_count).toBe(27);
  for (const row of after.reservations.slice(0, 26)) expect(JSON.parse(String(row.record))).toMatchObject({ schemaVersion: 5,
    recovery: { schemaVersion: 1, recordedAtMs: 20, previousSchemaVersion: 3, previousDisposition: { state: 'held', reason: 'unknown' } } });
  expect(await store.recoverCertifiedHolds(21)).toEqual({ released: 0, zeroTariff: 0, inconsistent: [] }); store.close();
  expect(records(path)).toEqual(after);
  const reopened = await openSqliteProviderSpendRecoveryStore(path, options);
  expect((await reopened.recoverCertifiedHolds(22)).released).toBe(0); reopened.close();
  const integrity = await openSqliteProviderSpendIntegrityReader(path, options);
  try { expect(await verifyProviderSpendIntegrity(integrity, 'scope', 10)).toMatchObject({ reservationCount: 27, reservedMinorUnits: 6 }); } finally { integrity.close(); }
  const reader = await openSqliteProviderSpendAccountReader(path, { busyTimeoutMs: options.busyTimeoutMs });
  try { expect((await reader.loadSnapshot({ schemaVersion: 2, scopeId: 'scope', budgetId: budget.budgetId, budgetRevision: 1,
    holds: { afterInvocationId: null, limit: 20 } })).holds?.entries).toMatchObject([{ invocationId: 'inv-026', amountMinorUnits: 6 }]); } finally { reader.close(); }
});

it.each([
  { amount: 6, status: 408 }, { amount: 6, status: 409 }, { amount: 6, status: 499 }, { amount: 6, status: 503 },
  { amount: 6, status: 400, incomplete: true }, { amount: 6, status: 400, endpoint: 'https://uncertified.example/chat' },
  { amount: 0 },
])('preserves an uncertified or incomplete hold: %j', async row => {
  const path = await fixture([row]), before = records(path), store = await openSqliteProviderSpendRecoveryStore(path, options);
  expect(await store.recoverCertifiedHolds(20)).toEqual({ released: 0, zeroTariff: 0, inconsistent: [] }); store.close();
  expect(records(path)).toEqual(before);
});

it('recovers a certified historical pre-POST refusal', async () => {
  const path = await fixture([{ amount: 6, notSent: true }]), store = await openSqliteProviderSpendRecoveryStore(path, options);
  expect((await store.recoverCertifiedHolds(20)).released).toBe(1); store.close();
});

it('rolls the release audit and reservation back with a failing account update', async () => {
  const path = await fixture([{ amount: 6, status: 400 }]), before = records(path), db = new DatabaseSync(path);
  db.exec("CREATE TRIGGER refuse_recovery BEFORE UPDATE ON provider_spend_accounts BEGIN SELECT RAISE(ABORT,'fixture'); END;"); db.close();
  const store = await openSqliteProviderSpendRecoveryStore(path, options);
  await expect(store.recoverCertifiedHolds(20)).rejects.toThrow('PROVIDER_SPEND_UNAVAILABLE'); store.close(); expect(records(path)).toEqual(before);
});

it('validates the retained pure recovery audit independently of SQLite', async () => {
  const path = await fixture([{ amount: 6, notSent: true }]), state = records(path);
  const result = recoverProviderSpendHold(JSON.parse(String(state.account!.record)), JSON.parse(String(state.reservations[0]!.record)),
    JSON.parse(String(state.invocations[0]!.record)), 20);
  expect(result?.account.reservedMinorUnits).toBe(0);
  expect(() => parseProviderSpendReservation({ ...result!.reservation, recovery: { ...result!.reservation.recovery, previousDigest: '0'.repeat(64) } })).toThrow('PROVIDER_SPEND_INVALID');
});
