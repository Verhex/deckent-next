import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { openSqliteModelActivationStore, openSqliteModelInvocationStore, openSqliteProviderSpendIntegrityReader, openSqliteModelAllocationIntegrityReader } from '#adapters/index.js';
import { encodeModelBindingDefinition, parseProviderCatalog, resolveModelBindingDefinition } from '#domain/index.js';
import { modelInvocationProfileDigest, modelInvocationRequestDigest, verifyProviderSpendIntegrity, createModelAllocationCheckpoint, verifyModelAllocationIntegrity,
  parseModelInvocationAdmission, createModelInvocationClaimReceipt, createProviderSpendAccount, reserveProviderSpend,
  providerSpendQuoteDigest, providerSpendReservationDigest, createProviderSpendCheckpoint } from '#engine/index.js';

const roots: string[] = [];
const options = { busyTimeoutMs: 20, journalMode: 'delete' as const, durability: 'full' as const };
const reference = { providerId: 'provider', providerVersion: 1, modelId: 'model', modelVersion: 1 };
const definition = resolveModelBindingDefinition(parseProviderCatalog({ schemaVersion: 1, revision: 'catalog', providers: [{ id: 'provider', version: 1,
  models: [{ id: 'model', version: 1, nativeId: 'native/model', protocols: [{ family: 'openai-chat-completions', version: 'v1', capabilities: [] }] }] }] }), reference)!;
const binding = { encodingVersion: 1 as const, algorithm: 'sha256' as const,
  digest: createHash('sha256').update(encodeModelBindingDefinition(definition)).digest('hex') };
const actor = { id: 'actor', issuer: 'host', subject: '1000', assurance: 'os-user' } as const;
const authorization = { revision: 'policy', ruleId: 'invoke' };
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'deckent-provider-spend-integrity-')); roots.push(root); const path = join(root, 'ledger.db');
  const activations = new Map<string, unknown>();
  const activate = async (scopeId: string) => {
    const known = activations.get(scopeId); if (known) return known;
    const activationStore = await openSqliteModelActivationStore(path, options);
    try {
      const activation = await activationStore.admit({ command: { schemaVersion: 1, action: 'activate', commandId: `activate-${scopeId}`, scopeId,
        reference, expectedRevision: 0, catalogRevision: 'catalog', expectedBinding: binding }, actor,
      authorization: { revision: 'policy', ruleId: 'activate' }, admittedAtMs: 1, definition });
      activations.set(scopeId, activation.receipt.record); return activation.receipt.record;
    } finally { activationStore.close(); }
  };
  return { path, activate };
}
function admission(base: Awaited<ReturnType<typeof fixture>>, commandId: string, invocationId: string, scopeId = 'scope', maximum = 1) {
  const command = { schemaVersion: 1 as const, commandId, scopeId, reference, catalogRevision: 'catalog', expectedBinding: binding,
    nativeRequest: { model: 'native/model', messages: [{ role: 'user', content: commandId }] } };
  const profile = { schemaVersion: 1 as const, id: `profile-${scopeId}`, version: 1, scopeId, reference, bindingDigest: binding.digest,
    protocol: { family: 'openai-chat-completions', version: 'v1' }, adapter: { id: 'fixture', version: 1, definition: {} },
    allocation: { id: `allocation-${scopeId}`, maxCalls: 20_000, maxInFlight: 20_000 }, limits: { requestMaxBytes: 4096, responseMaxBytes: 4096, timeoutMs: 1000 } };
  const requestDigest = modelInvocationRequestDigest(command), profileDigest = modelInvocationProfileDigest(profile);
  return { command, requestDigest, actor, authorization, definition, profile, profileDigest, invocationId, claimedAtMs: 10,
    spending: { budget: { schemaVersion: 1 as const, scopeId, budgetId: `budget-${scopeId}`, revision: 1, currency: 'USD', limitMinorUnits: 100_000 },
      quote: { schemaVersion: 1 as const, scopeId, requestDigest, profileDigest, pricing: { id: 'price', version: 1, digest: '291f395a66cb728f57612b09b06f9512815b982e9a5d65e3fafec28256ff0aa9', definition: { schemaVersion: 1, kind: 'synthetic-price' } },
        meter: { id: 'meter', version: 1, evidenceDigest: '446658cc1c39184b672f423a7f970bffab0e8f38e851c5b5dacd3f38eb85051f', evidence: { schemaVersion: 1, kind: 'synthetic-meter' } }, currency: 'USD', maxChargeMinorUnits: maximum } } };
}
async function seed(base: Awaited<ReturnType<typeof fixture>>, count: number, scopeId = 'scope', offset = 0, maximum = 1) {
  const store = await openSqliteModelInvocationStore(base.path, options, 'allow');
  try { const activation = await base.activate(scopeId);
    for (let index = 0; index < count; index++) await store.claim({ ...admission(base, `${scopeId}-command-${offset + index}`,
      `${scopeId}-invocation-${String(offset + index).padStart(5, '0')}`, scopeId, maximum), activation }); }
  finally { store.close(); }
}
async function materializeHistory(base: Awaited<ReturnType<typeof fixture>>, count: number) {
  if (count === 0) return;
  const activation = await base.activate('scope'), db = new DatabaseSync(base.path);
  const example = admission(base, 'example', 'example'), budget = example.spending.budget;
  let account = createProviderSpendAccount(budget);
  try {
    db.exec('BEGIN IMMEDIATE');
    const initial = createProviderSpendCheckpoint(account, 1, 0);
    db.prepare('INSERT INTO provider_spend_accounts(scope_id,revision,reservation_count,digest,record) VALUES(?,?,?,?,?)')
      .run('scope', initial.revision, 0, initial.digest, JSON.stringify(account));
    const allocation = { schemaVersion: 1, scopeId: 'scope', allocationId: example.profile.allocation.id,
      maxCalls: example.profile.allocation.maxCalls, maxInFlight: example.profile.allocation.maxInFlight, lifetimeCalls: count, inFlight: count };
    db.prepare(`INSERT INTO model_invocation_allocations(scope_id,allocation_id,max_calls,max_in_flight,lifetime_calls,in_flight,record)
      VALUES(?,?,?,?,?,?,?)`).run('scope', allocation.allocationId, allocation.maxCalls, allocation.maxInFlight, count, count, JSON.stringify(allocation));
    const quota = createModelAllocationCheckpoint(allocation, 1);
    db.prepare('INSERT INTO model_invocation_allocation_checkpoints(scope_id,allocation_id,revision,digest) VALUES(?,?,?,?)')
      .run('scope', allocation.allocationId, quota.revision, quota.digest);
    const invocation = db.prepare('INSERT INTO model_invocations(scope_id,command_id,invocation_id,allocation_id,state,record) VALUES(?,?,?,?,?,?)');
    const control = db.prepare('INSERT INTO model_invocation_controls(scope_id,invocation_id,send_state,record) VALUES(?,?,?,?)');
    const spend = db.prepare('INSERT INTO model_invocation_spend_reservations(scope_id,invocation_id,digest,record) VALUES(?,?,?,?)');
    for (let index = 0; index < count; index++) {
      const id = `history-invocation-${String(index).padStart(5, '0')}`;
      const input = parseModelInvocationAdmission({ ...admission(base, `history-command-${index}`, id), activation });
      const receipt = createModelInvocationClaimReceipt(input), quote = input.spending!.quote;
      const next = reserveProviderSpend(account, budget, { schemaVersion: 1, scopeId: 'scope', invocationId: id,
        budgetId: budget.budgetId, budgetRevision: budget.revision, currency: budget.currency, quoteDigest: providerSpendQuoteDigest(quote), quote });
      account = next.account;
      invocation.run('scope', input.command.commandId, id, allocation.allocationId, 'claimed', JSON.stringify(receipt));
      control.run('scope', id, 'pending', JSON.stringify({ schemaVersion: 1, claim: receipt.claim, reference,
        send: { state: 'pending' }, cancellation: null }));
      spend.run('scope', id, providerSpendReservationDigest(next.reservation), JSON.stringify(next.reservation));
    }
    const checkpoint = createProviderSpendCheckpoint(account, count, count);
    db.prepare('UPDATE provider_spend_accounts SET revision=?,reservation_count=?,digest=?,record=? WHERE scope_id=?')
      .run(checkpoint.revision, count, checkpoint.digest, JSON.stringify(account), 'scope');
    db.exec('COMMIT');
  } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
  finally { db.close(); }
}

it('verifies independent SQLite pages without duplicate rows and keeps scopes isolated', async () => {
  const base = await fixture(); await seed(base, 3); await seed(base, 2, 'other');
  const reader = await openSqliteProviderSpendIntegrityReader(base.path, { busyTimeoutMs: 20 });
  try {
    const first = await reader.readPage({ scopeId: 'scope', checkpoint: null, afterInvocationId: null, limit: 2 });
    expect(first?.reservations.map(value => value.descriptor.invocationId)).toEqual(['scope-invocation-00000', 'scope-invocation-00001']);
    const second = await reader.readPage({ scopeId: 'scope', checkpoint: first!.checkpoint, afterInvocationId: first!.nextInvocationId, limit: 2 });
    expect(second?.reservations.map(value => value.descriptor.invocationId)).toEqual(['scope-invocation-00002']);
    const result = await verifyProviderSpendIntegrity(reader, 'scope', 2);
    expect(result).toMatchObject({ reservationCount: 3, reservedMinorUnits: 3, settledMinorUnits: 0,
      checkpoint: { reservationCount: 3, account: { budget: { scopeId: 'scope' }, reservedMinorUnits: 3 } } });
    expect(await verifyProviderSpendIntegrity(reader, 'other', 2)).toMatchObject({ reservationCount: 2, reservedMinorUnits: 2,
      checkpoint: { account: { budget: { scopeId: 'other' } } } });
    expect(await verifyProviderSpendIntegrity(reader, 'missing', 2)).toBeNull();
  } finally { reader.close(); }
});

it('rejects a tampered account checkpoint before a claim can create an invocation', async () => {
  const base = await fixture(); await seed(base, 2); const db = new DatabaseSync(base.path);
  try { db.prepare("UPDATE provider_spend_accounts SET digest=? WHERE scope_id='scope'").run('0'.repeat(64)); }
  finally { db.close(); }
  const reader = await openSqliteProviderSpendIntegrityReader(base.path, { busyTimeoutMs: 20 });
  try { await expect(reader.readPage({ scopeId: 'scope', checkpoint: null, afterInvocationId: null, limit: 1 }))
    .rejects.toMatchObject({ code: 'PROVIDER_SPEND_INVALID' }); }
  finally { reader.close(); }
  const countBefore = new DatabaseSync(base.path);
  let invocationCount: number;
  try { invocationCount = (countBefore.prepare("SELECT COUNT(*) AS count FROM model_invocations WHERE scope_id='scope'").get() as { count: number }).count; }
  finally { countBefore.close(); }
  const store = await openSqliteModelInvocationStore(base.path, options, 'forbid');
  try {
    const activation = await base.activate('scope');
    await expect(store.claim({ ...admission(base, 'tampered-account-claim', 'tampered-account-invocation'), activation }))
      .rejects.toMatchObject({ code: 'PROVIDER_SPEND_INVALID' });
  } finally { store.close(); }
  const countAfter = new DatabaseSync(base.path);
  try { expect((countAfter.prepare("SELECT COUNT(*) AS count FROM model_invocations WHERE scope_id='scope'").get() as { count: number }).count).toBe(invocationCount!); }
  finally { countAfter.close(); }
});

it('rejects a reservation checksum corruption without inventing an integrity result', async () => {
  const base = await fixture(); await seed(base, 2); const db = new DatabaseSync(base.path);
  try { db.prepare("UPDATE model_invocation_spend_reservations SET digest=? WHERE scope_id='scope'").run('0'.repeat(64)); }
  finally { db.close(); }
  const reader = await openSqliteProviderSpendIntegrityReader(base.path, { busyTimeoutMs: 20 });
  try { await expect(verifyProviderSpendIntegrity(reader, 'scope', 1)).rejects.toMatchObject({ code: 'PROVIDER_SPEND_INVALID' }); }
  finally { reader.close(); }
});

it('rejects a changed account checkpoint between read-only pages', async () => {
  const base = await fixture(); await seed(base, 3); const reader = await openSqliteProviderSpendIntegrityReader(base.path, { busyTimeoutMs: 20 });
  let changed = false;
  const racingReader = { close() { reader.close(); }, async readPage(query: Parameters<typeof reader.readPage>[0]) {
    const page = await reader.readPage(query);
    if (!changed && page) { changed = true; await seed(base, 1, 'scope', 100); }
    return page;
  } };
  try { await expect(verifyProviderSpendIntegrity(racingReader, 'scope', 1)).rejects.toMatchObject({ code: 'PROVIDER_SPEND_CONFLICT' }); }
  finally { racingReader.close(); }
});

it('never migrates or mutates a ledger through the read-only integrity path', async () => {
  const base = await fixture(); await seed(base, 2); const before = await readFile(base.path);
  const reader = await openSqliteProviderSpendIntegrityReader(base.path, { busyTimeoutMs: 20 });
  try { await expect(verifyProviderSpendIntegrity(reader, 'scope', 2)).resolves.toMatchObject({ reservationCount: 2 }); }
  finally { reader.close(); }
  expect(await readFile(base.path)).toEqual(before);
});

it('counts valid zero-charge reservations instead of deriving their count from reserved units', async () => {
  const base = await fixture(); await seed(base, 2, 'scope', 0, 0);
  const reader = await openSqliteProviderSpendIntegrityReader(base.path, { busyTimeoutMs: 20 });
  try { await expect(verifyProviderSpendIntegrity(reader, 'scope', 1)).resolves.toMatchObject({ reservationCount: 2, reservedMinorUnits: 0 }); }
  finally { reader.close(); }
});

it('rejects a missing zero-charge reservation even though reserved units remain zero', async () => {
  const base = await fixture(); await seed(base, 2, 'scope', 0, 0); const db = new DatabaseSync(base.path);
  try { db.prepare("DELETE FROM model_invocation_spend_reservations WHERE scope_id='scope' AND invocation_id='scope-invocation-00001'").run(); }
  finally { db.close(); }
  const reader = await openSqliteProviderSpendIntegrityReader(base.path, { busyTimeoutMs: 20 });
  try { await expect(verifyProviderSpendIntegrity(reader, 'scope', 1)).rejects.toMatchObject({ code: 'PROVIDER_SPEND_INVALID' }); }
  finally { reader.close(); }
});

it('reports prepared-claim median and p95 after bounded synthetic histories', async () => {
  const timings: Array<{ history: number; samples: number; medianMs: number; p95Ms: number }> = [];
  for (const history of [0, 100, 10_000]) {
    const base = await fixture(); await seed(base, 0); await materializeHistory(base, history);
    const auditor = await openSqliteProviderSpendIntegrityReader(base.path, { busyTimeoutMs: 20 });
    try {
      const verified = await verifyProviderSpendIntegrity(auditor, 'scope', 250);
      if (history === 0) expect(verified).toBeNull();
      else expect(verified).toMatchObject({ reservationCount: history, reservedMinorUnits: history });
    } finally { auditor.close(); }
    const quotaAuditor = await openSqliteModelAllocationIntegrityReader(base.path, { busyTimeoutMs: 20 });
    try {
      const quota = await verifyModelAllocationIntegrity(quotaAuditor, 'scope', admission(base, 'sample', 'sample').profile.allocation.id, 250);
      if (history === 0) expect(quota).toEqual({ status: 'not-found' });
      else expect(quota).toMatchObject({ lifetimeCalls: history, inFlight: history });
    } finally { quotaAuditor.close(); }
    const store = await openSqliteModelInvocationStore(base.path, options, 'forbid');
    try {
      const activation = await base.activate('scope');
      const inputs = Array.from({ length: 12 }, (_unused, index) => ({ ...admission(base, `benchmark-${history}-${index}`, `benchmark-invocation-${history}-${index}`), activation }));
      await store.claim(inputs[0]!); await store.claim(inputs[1]!);
      const samples: number[] = [];
      for (const input of inputs.slice(2)) { const start = performance.now(); await store.claim(input); samples.push(performance.now() - start); }
      const ordered = [...samples].sort((left, right) => left - right), median = (ordered[4]! + ordered[5]!) / 2;
      timings.push({ history, samples: samples.length, medianMs: median, p95Ms: ordered[Math.ceil(samples.length * 0.95) - 1]! });
    } finally { store.close(); }
  }
  expect(timings.map(value => [value.history, value.samples])).toEqual([[0, 10], [100, 10], [10_000, 10]]);
  expect(timings.every(value => Number.isFinite(value.medianMs) && Number.isFinite(value.p95Ms))).toBe(true);
  process.stdout.write(`${JSON.stringify({ benchmark: 'provider-spend-store-claim', historyKind: 'schema-valid receipts and monetary reservations in one scope/allocation; both audits before warmup', warmupClaims: 2, timings })}\n`);
}, 120_000);
