import { releaseSettledModelSlots } from '#composition/core/model-invocation/index.js';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { openSqliteModelActivationStore, openSqliteModelInvocationStore, openSqliteProviderSpendAccountReader,
  openSqliteProviderSpendManagementStore, openSqliteProviderSpendIntegrityReader, upgradeExistingProductLedger } from '#adapters/index.js';
import { encodeModelBindingDefinition, parseProviderCatalog, resolveModelBindingDefinition, parseProviderSpendAccountQuery } from '#domain/index.js';
import { ProviderSpendAccountInspectionApplication, ProviderSpendManagementApplication, modelInvocationProfileDigest,
  modelInvocationRequestDigest, createModelInvocationResponseEvidence, createProviderSpendCheckpoint, providerSpendReservationDigest, modelInvocationResponseContentDescriptor, providerSpendQuoteDigest, providerSpendEvidenceDigest, verifyProviderSpendIntegrity,
  type ProviderSpendReportedMeasurement } from '#engine/index.js';
import { ErrorRegistry } from '#platform/index.js';
import { spendRecoveryView, terminalAdminPorts, terminalInfoLabels, type TerminalAdminContext } from '#surfaces/core/terminal-admin/index.js';
import { EMPTY_SESSION_USAGE } from '#surfaces/core/terminal-kit/index.js';
import { mountWorkline, settle, until } from '../support/workline-harness.js';

const roots: string[] = [], views: Array<ReturnType<typeof mountWorkline>> = [];
afterEach(async () => { for (const view of views.splice(0)) view.instance.unmount(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const options = { journalMode: 'delete' as const, durability: 'full' as const, busyTimeoutMs: 2_000 };
const actor = { id: 'operator', issuer: 'fixture', subject: '1000', assurance: 'os-user' as const };
const principal = { ...actor, scopeIds: ['scope'] }, authorization = { revision: 'p1', ruleId: 'spend' };
const reference = { providerId: 'fixture', providerVersion: 1, modelId: 'model', modelVersion: 1 };
const definition = resolveModelBindingDefinition(parseProviderCatalog({ schemaVersion: 1, revision: 'c1', providers: [{ id: 'fixture', version: 1,
  models: [{ id: 'model', version: 1, nativeId: 'native/model', protocols: [{ family: 'openai-chat-completions', version: 'v1', capabilities: [] }] }] }] }), reference)!;
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const binding = { encodingVersion: 1 as const, algorithm: 'sha256' as const, digest: hash(encodeModelBindingDefinition(definition)) };

async function fixture(certified = false) {
  const root = await mkdtemp(join(tmpdir(), 'deckent-spend-holds-terminal-')); roots.push(root); const path = join(root, 'ledger.db');
  const activations = await openSqliteModelActivationStore(path, options);
  const activation = (await activations.admit({ command: { schemaVersion: 1, action: 'activate', commandId: 'activate', scopeId: 'scope', reference,
    expectedRevision: 0, catalogRevision: 'c1', expectedBinding: binding }, actor, authorization, definition, admittedAtMs: 1 })).receipt.record;
  activations.close();
  const admit = (id: string, maximum: number) => {
    const command = { schemaVersion: 1 as const, commandId: id, scopeId: 'scope', reference, catalogRevision: 'c1', expectedBinding: binding,
      nativeRequest: { model: 'native/model', messages: [{ role: 'user', content: id }] } };
    const profile = { schemaVersion: 1 as const, id: 'profile', version: 1, scopeId: 'scope', reference, bindingDigest: binding.digest,
      protocol: { family: 'openai-chat-completions', version: 'v1' }, adapter: { id: 'fixture', version: 1, definition: { endpoint: 'https://api.openai.com/v1/responses' } },
      allocation: { id: 'allocation', maxCalls: 100, maxInFlight: 100 }, limits: { requestMaxBytes: 4096, responseMaxBytes: 4096, timeoutMs: 1000 } };
    const requestDigest = modelInvocationRequestDigest(command), profileDigest = modelInvocationProfileDigest(profile);
    const quote = { schemaVersion: 1 as const, scopeId: 'scope', requestDigest, profileDigest, currency: 'USD', maxChargeMinorUnits: maximum,
      pricing: { id: 'synthetic', version: 1, digest: providerSpendEvidenceDigest({ schemaVersion: 1, kind: 'synthetic' }), definition: { schemaVersion: 1, kind: 'synthetic' } },
      meter: { id: 'synthetic', version: 1, evidenceDigest: providerSpendEvidenceDigest({ schemaVersion: 1, kind: 'synthetic' }), evidence: { schemaVersion: 1, kind: 'synthetic' } } };
    return { command, requestDigest, profileDigest, profile, actor, authorization, definition, activation, invocationId: id, claimedAtMs: 2,
      spending: { budget: { schemaVersion: 1 as const, scopeId: 'scope', budgetId: 'scope-budget', revision: 5, currency: 'USD', limitMinorUnits: 2500 }, quote } };
  };
  const store = await openSqliteModelInvocationStore(path, options, 'forbid'), input = admit('settled', 1025), claim = await store.claim(input);
  const response = { schemaVersion: 1 as const, native: { answer: 'ok' }, usage: null };
  const measurement: ProviderSpendReportedMeasurement = { schemaVersion: 1, basis: 'provider-reported', currency: 'USD', exactMinorUnits: '1024.51', roundedMinorUnits: 1025,
    quoteDigest: providerSpendQuoteDigest(input.spending.quote), requestDigest: input.requestDigest, profileDigest: input.profileDigest,
    responseContentDigest: modelInvocationResponseContentDescriptor(response).digest,
    source: { id: 'fixture', version: 1, field: 'usage.cost', generationId: 'generation', modelId: 'native/model', numericSource: '10.2451',
      minorUnitsPerCurrencyUnit: 100, bodyDigest: hash('body'), responseDigest: hash('response'), requestBodyDigest: hash('request'),
      tariffDigest: input.spending.quote.pricing.digest, selectedEndpointTag: 'fixture' } };
  await store.permitSend(claim.record.receipt.claim, 'owner', 3); await store.recordResponse(claim.record.receipt.claim, response, 4, measurement);
  const hold = await store.claim(admit('held-original', 850)); await store.permitSend(hold.record.receipt.claim, 'owner', 5);
  if (certified) await store.recordRejected(hold.record.receipt.claim,
    createModelInvocationResponseEvidence({ id: 'fixture', version: 1 }, 'http-status', 400, Buffer.from('{"error":"admission rejected"}'), true), 6);
  else await store.recordUnknown(hold.record.receipt.claim, 'transport-error', 6);
  store.close();
  if (certified) {
    const db = new DatabaseSync(path), row = db.prepare("SELECT record FROM model_invocation_spend_reservations WHERE invocation_id='held-original'").get()!;
    const old = JSON.parse(String(row.record)); old.schemaVersion = 3; old.disposition = { state: 'held', reason: 'unknown', observedMinorUnits: null, evidenceDigest: old.disposition.evidenceDigest };
    db.prepare("UPDATE model_invocation_spend_reservations SET record=?,digest=? WHERE invocation_id='held-original'").run(JSON.stringify(old), providerSpendReservationDigest(old));
    const accountRow = db.prepare('SELECT record,revision,reservation_count FROM provider_spend_accounts').get()!, account = { ...JSON.parse(String(accountRow.record)), reservedMinorUnits: 850 };
    const checkpoint = createProviderSpendCheckpoint(account, Number(accountRow.revision), Number(accountRow.reservation_count));
    db.prepare('UPDATE provider_spend_accounts SET record=?,digest=?').run(JSON.stringify(account), checkpoint.digest); db.close();
  }
  let denied = false;
  const verifier = { async verify() { return principal; } }, authorizer = { async authorize() { if (denied) throw ErrorRegistry.createError('POLICY_DENIED'); return authorization; } };
  const inspection = new ProviderSpendAccountInspectionApplication(verifier, authorizer, async () => openSqliteProviderSpendAccountReader(path, { busyTimeoutMs: options.busyTimeoutMs }));
  const management = new ProviderSpendManagementApplication(verifier, authorizer, async () => openSqliteProviderSpendManagementStore(path, options), () => 50);
  const context: TerminalAdminContext = { inspectProviderSpendAccount: async (_root, query) => inspection.inspect(query), manageProviderSpend: async (_root, command) => management.execute(command) };
  const call = (locale: 'en' | 'tr') => ({ root, scopeId: 'scope', options: {}, locale, context });
  const snapshot = async () => (await inspection.inspect({ schemaVersion: 1, scopeId: 'scope', current: true })).checkpoint!;
  return { root, path, admit, inspection, management, call, snapshot, deny: () => { denied = true; } };
}
const text = (view: Awaited<ReturnType<typeof spendRecoveryView>>) => JSON.stringify(view.model);
async function integrity(path: string) { const reader = await openSqliteProviderSpendIntegrityReader(path, { busyTimeoutMs: options.busyTimeoutMs }); try { return await verifyProviderSpendIntegrity(reader, 'scope', 2); } finally { reader.close(); } }
async function confirmView(f: Awaited<ReturnType<typeof fixture>>, locale: 'en' | 'tr' = 'en') {
  const start = await spendRecoveryView(f.call(locale)), held = (await start.pick!('reconcile'))!;
  return (await held.pick!('held-original'))!;
}

it.each(['en', 'tr'] as const)('shows exact settled vs held totals and releases only after a governed selection (%s)', async locale => {
  const f = await fixture(), before = await f.snapshot(), start = await spendRecoveryView(f.call(locale));
  expect(text(start)).toContain(locale === 'tr' ? '10,2451 USD' : '10.2451 USD');
  expect(text(start)).toContain(locale === 'tr' ? '8,50 USD' : '8.50 USD');
  expect(text(start)).toContain(locale === 'tr' ? 'Bekleyen rezervasyonları uzlaştır' : 'Reconcile held reservations');
  expect(text(start)).toContain(locale === 'tr' ? 'Bütçeyi değiştir' : 'Change budget');
  const confirmation = await confirmView(f, locale);
  expect(text(confirmation)).toContain(locale === 'tr' ? 'ücret almış' : 'may still have charged');
  expect(await f.snapshot()).toEqual(before); expect(await confirmation.pick!('cancel')).toBeNull();
  await confirmation.pick!('write-off');
  expect((await f.snapshot()).account).toMatchObject({ reservedMinorUnits: 0, settledExactMinorUnits: '1024.51', settledMinorUnits: 1025 });
  expect(await integrity(f.path)).toMatchObject({ reservedMinorUnits: 0, settledExactMinorUnits: '1024.51' });
  const db = new DatabaseSync(f.path, { readOnly: true });
  try {
    const record = JSON.parse(String(db.prepare("SELECT record FROM model_invocation_spend_reservations WHERE invocation_id='held-original'").get()!.record));
    expect(record).toMatchObject({ disposition: { state: 'held', reason: 'unknown' }, reconciliation: { resolution: 'write-off', exactMinorUnits: '0' } });
    const receipt = JSON.parse(String(db.prepare('SELECT record FROM provider_spend_management').get()!.record));
    expect(receipt).toMatchObject({ actor, authorization, command: { scopeId: 'scope', invocationId: 'held-original', evidence: { kind: 'write-off' } } });
  } finally { db.close(); }
  expect((await f.inspection.inspect({ schemaVersion: 2, scopeId: 'scope', current: true, holds: { afterInvocationId: null, limit: 20 } })).holds!.entries).toEqual([]);
});

it('rechecks policy and checkpoint; denied and stale selections cannot release capacity', async () => {
  const denied = await fixture(), confirmation = await confirmView(denied), before = await denied.snapshot(); denied.deny();
  expect(text((await confirmation.pick!('write-off'))!)).toContain('POLICY_DENIED');
  denied.deny(); const db = new DatabaseSync(denied.path, { readOnly: true });
  try { expect(JSON.parse(String(db.prepare('SELECT record FROM provider_spend_accounts').get()!.record))).toEqual(before.account); expect(db.prepare('SELECT count(*) AS n FROM provider_spend_management').get()!.n).toBe(0); } finally { db.close(); }
  const stale = await fixture(), first = await confirmView(stale), second = await confirmView(stale);
  await first.pick!('write-off'); const after = await stale.snapshot();
  expect(text((await second.pick!('write-off'))!)).toContain('PROVIDER_SPEND_CONFLICT'); expect(await stale.snapshot()).toEqual(after);
});

it('changes budget by preset selection without settling a hold or silently unfreezing', async () => {
  const f = await fixture(), start = await spendRecoveryView(f.call('tr')), budgets = (await start.pick!('budget'))!, before = await f.snapshot();
  expect(await budgets.pick!('12345')).toBeNull(); const confirmation = (await budgets.pick!('50'))!;
  expect(await f.snapshot()).toEqual(before); await confirmation.pick!('confirm');
  expect((await f.snapshot()).account).toMatchObject({ budget: { revision: 6, limitMinorUnits: 5000 }, reservedMinorUnits: 850, settledExactMinorUnits: '1024.51', frozen: false });
  await integrity(f.path);
});

it('pages only unreconciled holds using the partial index; v1 queries do not acquire a new shape', async () => {
  const f = await fixture(), store = await openSqliteModelInvocationStore(f.path, options, 'forbid');
  for (let n = 0; n < 24; n++) { const claim = await store.claim(f.admit(`hold-${String(n).padStart(2, '0')}`, 1)); await store.permitSend(claim.record.receipt.claim, 'owner', 7); await store.recordUnknown(claim.record.receipt.claim, 'transport-error', 8); }
  store.close(); const query = { schemaVersion: 2, scopeId: 'scope', current: true, holds: { afterInvocationId: null, limit: 20 } };
  const first = await f.inspection.inspect(query), second = await f.inspection.inspect({ ...query, holds: { ...query.holds, afterInvocationId: first.holds!.nextAfterInvocationId } });
  expect(first).toMatchObject({ schemaVersion: 3 }); expect(first.holds!.entries).toHaveLength(20); expect(second.holds!.entries).toHaveLength(5);
  expect(second.holds!.nextAfterInvocationId).toBeNull(); expect(new Set([...first.holds!.entries, ...second.holds!.entries].map(row => row.invocationId)).size).toBe(25);
  expect(JSON.stringify(first.holds)).not.toContain('native/model'); expect(JSON.stringify(first.holds)).not.toContain('nativeRequest');
  expect(await f.inspection.inspect({ schemaVersion: 1, scopeId: 'scope', current: true })).not.toHaveProperty('holds');
  expect(() => parseProviderSpendAccountQuery({ ...query, schemaVersion: 1 })).toThrow(); expect(() => parseProviderSpendAccountQuery({ ...query, holds: { afterInvocationId: null, limit: 21 } })).toThrow();
  await expect(f.inspection.inspect({ ...query, scopeId: 'foreign' })).rejects.toThrow('AUTHENTICATION_SCOPE_DENIED');
  const db = new DatabaseSync(f.path, { readOnly: true });
  try { const plan = db.prepare(`EXPLAIN QUERY PLAN SELECT invocation_id FROM model_invocation_spend_reservations
    WHERE scope_id=? AND json_extract(record,'$.disposition.state')='held' AND json_extract(record,'$.reconciliation') IS NULL
    AND invocation_id COLLATE BINARY>? ORDER BY invocation_id COLLATE BINARY LIMIT ?`).all('scope', '', 21);
    expect(JSON.stringify(plan)).toContain('model_invocation_spend_unreconciled_holds'); expect(JSON.stringify(plan)).not.toContain('USE TEMP B-TREE');
  } finally { db.close(); }
});

it('upgrades a v49 ledger without rewriting financial evidence and forbids an unadmitted v49 writer', async () => {
  const f = await fixture(), before = await f.snapshot(), db = new DatabaseSync(f.path);
  db.exec('DROP INDEX model_invocation_spend_unreconciled_holds; PRAGMA user_version=49'); db.close();
  await expect(openSqliteModelInvocationStore(f.path, options, 'forbid')).rejects.toThrow('ATTEMPT_STORE_VERSION');
  await mkdir(join(f.root, 'backup'));
  await upgradeExistingProductLedger(f.path, options, join(f.root, 'backup'), new Date('2026-10-09T00:00:00Z')); expect(await f.snapshot()).toEqual(before); await integrity(f.path);
});

it.each(['en', 'tr'] as const)('opens selections on exhausted turn and on /usage in the real Ink terminal (%s)', async locale => {
  const f = await fixture(), call = f.call(locale), { info } = terminalAdminPorts({ ...call, installationId: 'fixture', projectId: 'fixture', status: async () => '', doctor: async () => undefined });
  const view = mountWorkline({ info, spending: () => spendRecoveryView(call), completeTurn: async () => { throw ErrorRegistry.createError('PROVIDER_SPEND_EXHAUSTED', { params: { settled: '1024.51', held: 850, requested: 1000, limit: 2500, currency: 'USD' } }); } }); views.push(view);
  await until(() => view.stdout.frame.includes('READY'), 'ready'); view.stdin.write('hi\r');
  const action = locale === 'tr' ? 'Bekleyen rezervasyonları uzlaştır' : 'Reconcile held reservations';
  await until(() => view.stdout.frame.includes(action) && view.stdout.frame.includes(locale === 'tr' ? '8,50 USD' : '8.50 USD'), 'exhausted recovery selections');
  expect(view.stdout.text).toContain('1024.51'); expect(view.stdout.text).toContain('850');
  view.stdin.write('\r'); await until(() => view.stdout.frame.includes('held-original'), 'hold selection');
  view.stdin.write('\r'); await until(() => view.stdout.frame.includes(locale === 'tr' ? 'ücret almış' : 'may still have charged'), 'governed warning');
  view.stdin.write('\u001b'); await until(() => view.stdout.frame.includes('READY'), 'escape recovery'); expect((await f.snapshot()).account.reservedMinorUnits).toBe(850);
  await settle(); view.stdin.write('/usage\r'); await until(() => view.stdout.frame.includes(action) && view.stdout.frame.includes(locale === 'tr' ? '8,50 USD' : '8.50 USD'), 'usage selections');
  expect(view.stdout.frame).toContain(locale === 'tr' ? '8,50 USD' : '8.50 USD');
  expect(info.labels).toEqual(terminalInfoLabels(locale));
  expect(EMPTY_SESSION_USAGE.reports).toBe(0);
});

it.each(['tr', 'en'] as const)('startup recovery refreshes /usage and the exhaustion window from one account (%s)', async locale => {
  const f = await fixture(true);
  const started = await releaseSettledModelSlots(f.path, options, 'a'.repeat(64));
  expect(started.spend).toEqual({ released: 1, zeroTariff: 0, inconsistent: [] });
  const snapshot = await f.snapshot();
  expect(snapshot.account).toMatchObject({ reservedMinorUnits: 0, settledExactMinorUnits: '1024.51', budget: { limitMinorUnits: 2500 } });
  const exhaustion = await spendRecoveryView(f.call(locale));
  expect(text(exhaustion)).toContain(locale === 'tr' ? '10,2451 USD' : '10.2451 USD');
  expect(text(exhaustion)).toContain(locale === 'tr' ? '0,00 USD' : '0.00 USD');
  const usage = await terminalAdminPorts({ ...f.call(locale), installationId: 'fixture', projectId: 'fixture', status: async () => '', doctor: async () => undefined }).info.ports.usage!({ usage: EMPTY_SESSION_USAGE });
  const output = JSON.stringify(usage.model);
  expect(output).toContain(locale === 'tr' ? 'Ayrılan (etkin + askıda)' : 'Reserved (active + held)');
  expect(output).toContain(locale === 'tr' ? '10,2451 USD' : '10.2451 USD');
  expect(output).toContain(locale === 'tr' ? '25,00 USD' : '25.00 USD');
  expect((await integrity(f.path))?.reservedMinorUnits).toBe(0);
});
