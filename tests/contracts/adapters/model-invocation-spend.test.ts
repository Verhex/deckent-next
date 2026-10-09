import { createHash } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { openSqliteModelActivationStore, openSqliteModelInvocationStore } from '#adapters/index.js';
import { encodeModelBindingDefinition, parseProviderCatalog, resolveModelBindingDefinition } from '#domain/index.js';
import { createModelInvocationResponseEvidence, createProviderSpendCheckpoint, providerSpendEvidenceDigest, modelInvocationProfileDigest, modelInvocationRequestDigest } from '#engine/index.js';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))));
const options = { journalMode: 'delete' as const, durability: 'full' as const, busyTimeoutMs: 2_000 };
const reference = { providerId: 'provider', providerVersion: 1, modelId: 'model', modelVersion: 1 };
const definition = resolveModelBindingDefinition(parseProviderCatalog({ schemaVersion: 1, revision: 'catalog', providers: [
  { id: 'provider', version: 1, models: [{ id: 'model', version: 1, nativeId: 'native/model',
    protocols: [{ family: 'openai-chat-completions', version: 'v1', capabilities: [] }] }] },
] }), reference)!;
const binding = { encodingVersion: 1 as const, algorithm: 'sha256' as const,
  digest: createHash('sha256').update(encodeModelBindingDefinition(definition)).digest('hex') };
const actor = { id: 'actor', issuer: 'host', subject: '1000', assurance: 'os-user' } as const;
const authorization = { revision: 'policy', ruleId: 'invoke' };

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'deckent-model-spend-')); roots.push(root); const path = join(root, 'ledger.db');
  const activations = await openSqliteModelActivationStore(path, options);
  const activation = await activations.admit({ command: { schemaVersion: 1, action: 'activate', commandId: 'activate', scopeId: 'scope',
    reference, expectedRevision: 0, catalogRevision: 'catalog', expectedBinding: binding }, actor,
  authorization: { revision: 'policy', ruleId: 'activate' }, admittedAtMs: 1, definition });
  activations.close();
  return { path, activation: activation.receipt.record };
}
function admission(base: Awaited<ReturnType<typeof fixture>>, commandId: string, invocationId: string,
  allocationId = 'allocation-a', maximum = 6) {
  const command = { schemaVersion: 1 as const, commandId, scopeId: 'scope', reference, catalogRevision: 'catalog', expectedBinding: binding,
    nativeRequest: { model: 'native/model', messages: [{ role: 'user', content: commandId }] } };
  const profile = { schemaVersion: 1 as const, id: `profile-${allocationId}`, version: 1, scopeId: 'scope', reference,
    bindingDigest: binding.digest, protocol: { family: 'openai-chat-completions', version: 'v1' },
    adapter: { id: 'fixture', version: 1, definition: { endpoint: 'https://openrouter.ai/api/v1/chat/completions' } }, allocation: { id: allocationId, maxCalls: 10, maxInFlight: 10 },
    limits: { requestMaxBytes: 4096, responseMaxBytes: 4096, timeoutMs: 1000 } };
  const requestDigest = modelInvocationRequestDigest(command), profileDigest = modelInvocationProfileDigest(profile);
  return { command, requestDigest, actor, authorization, definition, activation: base.activation, profile, profileDigest, invocationId, claimedAtMs: 10,
    spending: { budget: { schemaVersion: 1 as const, scopeId: 'scope', budgetId: 'scope-budget', revision: 1, currency: 'USD', limitMinorUnits: 10 },
      quote: { schemaVersion: 1 as const, scopeId: 'scope', requestDigest, profileDigest,
        pricing: { id: 'price', version: 1, digest: '291f395a66cb728f57612b09b06f9512815b982e9a5d65e3fafec28256ff0aa9', definition: { schemaVersion: 1, kind: 'synthetic-price' } }, meter: { id: 'meter', version: 1, evidenceDigest: '446658cc1c39184b672f423a7f970bffab0e8f38e851c5b5dacd3f38eb85051f', evidence: { schemaVersion: 1, kind: 'synthetic-meter' } },
        currency: 'USD', maxChargeMinorUnits: maximum } } };
}
function snapshot(path: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const account = db.prepare('SELECT record FROM provider_spend_accounts WHERE scope_id=?').get('scope') as { record: string } | undefined;
    const reservations = [...db.prepare('SELECT invocation_id,record FROM model_invocation_spend_reservations ORDER BY invocation_id').iterate()]
      .map(row => ({ invocationId: row.invocation_id, record: JSON.parse(String(row.record)) }));
    return { account: account ? JSON.parse(account.record) : null, reservations,
      invocations: db.prepare('SELECT count(*) AS count FROM model_invocations').get()?.count,
      controls: db.prepare('SELECT count(*) AS count FROM model_invocation_controls').get()?.count,
      allocations: [...db.prepare('SELECT allocation_id,lifetime_calls,in_flight FROM model_invocation_allocations ORDER BY allocation_id').iterate()] };
  } finally { db.close(); }
}
const claimant = String.raw`
import { readFile, writeFile } from 'node:fs/promises';
import { openSqliteModelInvocationStore } from './dist/adapters/index.js';
const [path,inputPath] = process.argv.slice(1);
const store = await openSqliteModelInvocationStore(path,{journalMode:'delete',durability:'full',busyTimeoutMs:2000},'forbid');
await writeFile(inputPath + '.ready', 'READY');
const deadline = Date.now() + 10000;
for (;;) {
  try { await readFile(inputPath + '.go'); break; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (Date.now() > deadline) throw new Error('CLAIMANT_GATE_TIMEOUT');
  await new Promise(resolve => setTimeout(resolve, 5));
}
try { await store.claim(JSON.parse(await readFile(inputPath,'utf8'))); await writeFile(inputPath + '.result','COMMITTED'); }
catch (error) { await writeFile(inputPath + '.result', String(error?.code ?? error?.message)); }
finally { store.close(); }
`;
async function competingClaim(path: string, inputPath: string) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', claimant, path, inputPath],
    { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'] });
  let errors = ''; child.stderr.on('data', chunk => { errors += String(chunk); });
  const untilFile = async (suffix: string) => {
    const deadline = Date.now() + 5_000;
    for (;;) {
      try { return await readFile(inputPath + suffix, 'utf8'); }
      catch (error) { if ((error as { code: string }).code !== 'ENOENT') throw error; }
      if (Date.now() > deadline || child.exitCode !== null) throw new Error(`CLAIMANT${suffix}:${errors}`);
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  };
  await untilFile('.ready');
  return { child, release: () => writeFile(inputPath + '.go', 'GO'), result: async () => {
    const result = await untilFile('.result');
    if (child.exitCode === null) await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('CLAIMANT_EXIT')); }, 5_000);
      child.once('exit', code => { clearTimeout(timer); if (code === 0) resolve(); else reject(new Error(`CLAIMANT_CODE:${code}:${errors}`)); });
    });
    return result;
  } };
}

it('enforces one scoped budget across distinct profile allocations', async () => {
  const base = await fixture(), store = await openSqliteModelInvocationStore(base.path, options, 'forbid');
  await store.claim(admission(base, 'one', 'invocation-one', 'allocation-a', 6));
  await expect(store.claim(admission(base, 'two', 'invocation-two', 'allocation-b', 5))).rejects.toThrow('PROVIDER_SPEND_EXHAUSTED');
  store.close();
  expect(snapshot(base.path)).toMatchObject({ account: { reservedMinorUnits: 6, settledMinorUnits: 0 }, invocations: 1, controls: 1,
    allocations: [{ allocation_id: 'allocation-a', lifetime_calls: 1, in_flight: 1 }] });
});

it('replays one reservation exactly once without current spending evidence and rejects supplied substitution', async () => {
  const base = await fixture(), store = await openSqliteModelInvocationStore(base.path, options, 'forbid');
  const input = admission(base, 'one', 'invocation-one'), first = await store.claim(input);
  expect((await store.claim({ ...input, invocationId: 'ignored' })).replayed).toBe(true);
  const beforeHistorical = snapshot(base.path);
  const { spending: _omitted, ...withoutSpending } = input;
  void _omitted;
  expect(await store.claim(withoutSpending)).toEqual({ replayed: true, record: first.record });
  expect(snapshot(base.path)).toEqual(beforeHistorical);
  await expect(store.claim({ ...input, spending: { ...input.spending,
    quote: { ...input.spending.quote, maxChargeMinorUnits: 5 } } })).rejects.toThrow('PROVIDER_SPEND_CONFLICT');
  store.close();
  expect(first.replayed).toBe(false); expect(snapshot(base.path)).toMatchObject({ account: { reservedMinorUnits: 6 },
    reservations: [{ invocationId: 'invocation-one', record: { disposition: { state: 'reserved' } } }] });
});

it('rolls invocation, control, allocation, and account back when reservation insertion fails', async () => {
  const base = await fixture(), db = new DatabaseSync(base.path);
  db.exec(`CREATE TRIGGER reject_spend BEFORE INSERT ON model_invocation_spend_reservations
    BEGIN SELECT RAISE(ABORT,'fixture spend failure'); END;`); db.close();
  const store = await openSqliteModelInvocationStore(base.path, options, 'forbid');
  await expect(store.claim(admission(base, 'one', 'invocation-one'))).rejects.toThrow('MODEL_INVOCATION_UNAVAILABLE'); store.close();
  expect(snapshot(base.path)).toEqual({ account: null, reservations: [], invocations: 0, controls: 0, allocations: [] });
});

it('rolls outcome, allocation, account, and reservation back together on spend settlement failure', async () => {
  const base = await fixture(), seed = await openSqliteModelInvocationStore(base.path, options, 'forbid');
  const claimed = await seed.claim(admission(base, 'one', 'invocation-one')); await seed.permitSend(claimed.record.receipt.claim, 'owner', 11); seed.close();
  const db = new DatabaseSync(base.path); db.exec(`CREATE TRIGGER reject_spend_settlement BEFORE UPDATE ON model_invocation_spend_reservations
    BEGIN SELECT RAISE(ABORT,'fixture settlement failure'); END;`); db.close();
  const store = await openSqliteModelInvocationStore(base.path, options, 'forbid');
  await expect(store.recordUnknown(claimed.record.receipt.claim, 'transport-error', 12)).rejects.toThrow('MODEL_INVOCATION_UNAVAILABLE'); store.close();
  const check = new DatabaseSync(base.path, { readOnly: true });
  expect(JSON.parse(String((check.prepare('SELECT record FROM model_invocations').get() as { record: string }).record)).outcome).toBeNull(); check.close();
  expect(snapshot(base.path)).toMatchObject({ account: { reservedMinorUnits: 6 },
    reservations: [{ record: { disposition: { state: 'reserved' } } }], allocations: [{ in_flight: 1 }] });
});

it('holds unknown spend and releases a cancellation prevented before permission', async () => {
  const unknownBase = await fixture(), unknownStore = await openSqliteModelInvocationStore(unknownBase.path, options, 'forbid');
  const unknown = await unknownStore.claim(admission(unknownBase, 'unknown', 'unknown-id'));
  await unknownStore.permitSend(unknown.record.receipt.claim, 'owner', 11);
  await unknownStore.recordUnknown(unknown.record.receipt.claim, 'transport-error', 12); unknownStore.close();
  expect(snapshot(unknownBase.path)).toMatchObject({ account: { reservedMinorUnits: 6, settledMinorUnits: 0 },
    reservations: [{ record: { disposition: { state: 'held', reason: 'unknown' } } }] });

  const cancelledBase = await fixture(), cancelledStore = await openSqliteModelInvocationStore(cancelledBase.path, options, 'forbid');
  const cancelledInput = admission(cancelledBase, 'cancelled', 'cancelled-id'); await cancelledStore.claim(cancelledInput);
  await cancelledStore.cancelInvocation({ command: { schemaVersion: 1, commandId: 'cancel', scopeId: 'scope', targetCommandId: 'cancelled', reference,
    expectedRequestDigest: cancelledInput.requestDigest }, actor, authorization, requestedAtMs: 12 }); cancelledStore.close();
  expect(snapshot(cancelledBase.path)).toMatchObject({ account: { reservedMinorUnits: 0, settledMinorUnits: 0 },
    reservations: [{ record: { disposition: { state: 'released-not-sent' } } }], allocations: [{ in_flight: 0 }] });
});

it.each([
  ['responded', 'missing-usage'],
  ['rejected', 'unknown'],
] as const)('holds spend for a complete %s outcome without trusted pricing settlement authority', async (kind, reason) => {
  const base = await fixture(), store = await openSqliteModelInvocationStore(base.path, options, 'forbid');
  const claimed = await store.claim(admission(base, kind, `${kind}-id`)); await store.permitSend(claimed.record.receipt.claim, 'owner', 11);
  if (kind === 'responded') await store.recordResponse(claimed.record.receipt.claim,
    { schemaVersion: 1, native: { id: 'response' }, usage: { total_tokens: 1 } }, 12);
  else await store.recordRejected(claimed.record.receipt.claim,
    createModelInvocationResponseEvidence({ id: 'fixture', version: 1 }, 'http-status', 500, Buffer.from('{"error":"failed"}'), true), 12);
  store.close();
  expect(snapshot(base.path)).toMatchObject({ account: { reservedMinorUnits: 6, settledMinorUnits: 0 },
    reservations: [{ record: { disposition: { state: 'held', reason } } }], allocations: [{ in_flight: 0 }] });
});

it('atomically admits only one of two processes competing for one scoped budget', async () => {
  const base = await fixture(), root = join(base.path, '..'), firstPath = join(root, 'first.json'), secondPath = join(root, 'second.json');
  await Promise.all([writeFile(firstPath, JSON.stringify(admission(base, 'first', 'first-id', 'allocation-a', 6))),
    writeFile(secondPath, JSON.stringify(admission(base, 'second', 'second-id', 'allocation-b', 6)))]);
  const children: ChildProcessWithoutNullStreams[] = [];
  try {
    const first = await competingClaim(base.path, firstPath), second = await competingClaim(base.path, secondPath);
    children.push(first.child, second.child); await Promise.all([first.release(), second.release()]);
    expect([await first.result(), await second.result()].sort()).toEqual(['COMMITTED', 'PROVIDER_SPEND_EXHAUSTED']);
  } finally {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  expect(snapshot(base.path)).toMatchObject({ account: { reservedMinorUnits: 6, settledMinorUnits: 0 }, invocations: 1, controls: 1,
    reservations: [{ record: { disposition: { state: 'reserved' } } }] });
  expect(snapshot(base.path).allocations).toHaveLength(1);
});


it.each([400, 401, 402, 403, 404, 413, 422, 429])('releases a complete HTTP %s rejection once and preserves the rejected receipt', async status => {
  const base = await fixture(), store = await openSqliteModelInvocationStore(base.path, options, 'forbid');
  const claimed = await store.claim(admission(base, 'rejected', 'rejected-id'));
  await store.permitSend(claimed.record.receipt.claim, 'owner', 11);
  const evidence = createModelInvocationResponseEvidence({ id: 'fixture', version: 1 }, 'http-status', status, Buffer.from('{"error":"rejected"}'), true);
  const record = await store.recordRejected(claimed.record.receipt.claim, evidence, 12);
  expect(await store.recordRejected(claimed.record.receipt.claim, evidence, 12)).toEqual(record);
  store.close();
  expect(record.receipt.outcome).toMatchObject({ state: 'rejected', evidence: { httpStatus: status } });
  expect(snapshot(base.path)).toMatchObject({ account: { reservedMinorUnits: 0, settledExactMinorUnits: '0' },
    reservations: [{ record: { schemaVersion: 4, disposition: { state: 'released-no-charge' } } }], allocations: [{ in_flight: 0 }] });
});

it.each([408, 409, 499, 500, 503])('keeps uncertain HTTP %s spending held', async status => {
  const base = await fixture(), store = await openSqliteModelInvocationStore(base.path, options, 'forbid');
  const claimed = await store.claim(admission(base, 'uncertain', 'uncertain-id'));
  await store.permitSend(claimed.record.receipt.claim, 'owner', 11);
  await store.recordRejected(claimed.record.receipt.claim,
    createModelInvocationResponseEvidence({ id: 'fixture', version: 1 }, 'http-status', status, Buffer.from('{}'), true), 12);
  store.close(); expect(snapshot(base.path)).toMatchObject({ account: { reservedMinorUnits: 6, settledExactMinorUnits: '0' },
    reservations: [{ record: { disposition: { state: 'held' } } }], allocations: [{ in_flight: 0 }] });
});

it('releases a transport-certified pre-POST refusal and keeps a cut 400 response held', async () => {
  const before = await fixture(), store = await openSqliteModelInvocationStore(before.path, options, 'forbid');
  const claimed = await store.claim(admission(before, 'not-sent', 'not-sent-id'));
  await store.permitSend(claimed.record.receipt.claim, 'owner', 11);
  await store.recordRejected(claimed.record.receipt.claim,
    createModelInvocationResponseEvidence({ id: 'fixture', version: 1 }, 'not-sent', null, Buffer.alloc(0), true), 12);
  store.close(); expect(snapshot(before.path)).toMatchObject({ account: { reservedMinorUnits: 0 },
    reservations: [{ record: { disposition: { state: 'released-no-charge' } } }] });
  const cut = await fixture(), reader = await openSqliteModelInvocationStore(cut.path, options, 'forbid');
  const second = await reader.claim(admission(cut, 'cut', 'cut-id'));
  await reader.permitSend(second.record.receipt.claim, 'owner', 11);
  await reader.recordUnknown(second.record.receipt.claim, 'transport-error', 12,
    createModelInvocationResponseEvidence({ id: 'fixture', version: 1 }, 'interrupted', 400, Buffer.from('{'), false));
  reader.close(); expect(snapshot(cut.path)).toMatchObject({ account: { reservedMinorUnits: 6 }, reservations: [{ record: { disposition: { state: 'held' } } }] });
});

it('cancellation after permission keeps spending held after the local send closes', async () => {
  const base = await fixture(), input = admission(base, 'cancel-after', 'cancel-after-id'), store = await openSqliteModelInvocationStore(base.path, options, 'forbid');
  const claimed = await store.claim(input); await store.permitSend(claimed.record.receipt.claim, 'owner', 11);
  await store.cancelInvocation({ command: { schemaVersion: 1, commandId: 'cancel', scopeId: 'scope', targetCommandId: input.command.commandId,
    reference, expectedRequestDigest: input.requestDigest }, actor, authorization, requestedAtMs: 12 });
  expect(snapshot(base.path).allocations).toMatchObject([{ in_flight: 1 }]);
  await store.recordUnknown(claimed.record.receipt.claim, 'transport-error', 13); store.close();
  expect(snapshot(base.path)).toMatchObject({ account: { reservedMinorUnits: 6 }, reservations: [{ record: { disposition: { state: 'held' } } }], allocations: [{ in_flight: 0 }] });
});

it('restart only recovers the ended send owner; another endpoint and unpermitted claims remain protected', async () => {
  const base = await fixture(), store = await openSqliteModelInvocationStore(base.path, options, 'forbid');
  for (const [suffix, owner] of [['dead', 'dead-owner'], ['foreign', 'other-endpoint'], ['unpermitted', null]] as const) {
    const claimed = await store.claim(admission(base, suffix, suffix, `allocation-${suffix}`, 2));
    if (owner) await store.permitSend(claimed.record.receipt.claim, owner, 11);
  }
  store.close(); const restarted = await openSqliteModelInvocationStore(base.path, options, 'forbid');
  expect(await restarted.releaseSettledSlots({ atMs: 20, endedOwner: owner => owner === 'dead-owner' })).toMatchObject({ settled: 1, inconsistent: [] });
  expect(await restarted.releaseSettledSlots({ atMs: 21, endedOwner: owner => owner === 'dead-owner' })).toMatchObject({ settled: 0, inconsistent: [] });
  restarted.close(); expect(snapshot(base.path)).toMatchObject({ account: { reservedMinorUnits: 6 }, reservations: [
    { invocationId: 'dead', record: { disposition: { state: 'held', reason: 'unknown' } } },
    { invocationId: 'foreign', record: { disposition: { state: 'reserved' } } },
    { invocationId: 'unpermitted', record: { disposition: { state: 'reserved' } } }] });
});

it('a model switch cannot release a prior uncertain charge or create a duplicate reservation', async () => {
  const base = await fixture(), store = await openSqliteModelInvocationStore(base.path, options, 'forbid');
  const first = await store.claim(admission(base, 'old-model', 'old-model', 'old-allocation', 4));
  await store.permitSend(first.record.receipt.claim, 'owner', 11); await store.recordUnknown(first.record.receipt.claim, 'transport-error', 12);
  const nextReference = { ...reference, modelId: 'new-model' };
  const nextDefinition = { ...definition, model: { ...definition.model, id: 'new-model', nativeId: 'native/new-model' } };
  const nextBinding = { ...binding, digest: createHash('sha256').update(encodeModelBindingDefinition(nextDefinition)).digest('hex') };
  const activations = await openSqliteModelActivationStore(base.path, options, 'forbid');
  const activated = await activations.admit({ command: { schemaVersion: 1, action: 'activate', commandId: 'activate-next', scopeId: 'scope',
    reference: nextReference, expectedRevision: 0, catalogRevision: 'catalog', expectedBinding: nextBinding }, actor,
    authorization, admittedAtMs: 13, definition: nextDefinition });
  activations.close();
  const next = admission(base, 'new-model', 'new-model', 'new-allocation', 4);
  next.command = { ...next.command, reference: nextReference, expectedBinding: nextBinding,
    nativeRequest: { ...next.command.nativeRequest, model: 'native/new-model' } };
  next.definition = nextDefinition; next.activation = activated.receipt.record;
  next.profile = { ...next.profile, reference: nextReference, bindingDigest: nextBinding.digest };
  next.requestDigest = modelInvocationRequestDigest(next.command); next.profileDigest = modelInvocationProfileDigest(next.profile);
  next.spending.quote = { ...next.spending.quote, requestDigest: next.requestDigest, profileDigest: next.profileDigest };
  await store.claim(next); expect((await store.claim(next)).replayed).toBe(true); store.close();
  expect(snapshot(base.path)).toMatchObject({ account: { reservedMinorUnits: 8 }, reservations: [
    { record: { disposition: { state: 'reserved' } } }, { record: { disposition: { state: 'held' } } }] });
});

it('a zero tariff bypasses a frozen money account and persists no zero reservation', async () => {
  const base = await fixture(), store = await openSqliteModelInvocationStore(base.path, options, 'forbid');
  const paid = await store.claim(admission(base, 'paid', 'paid-id')); await store.permitSend(paid.record.receipt.claim, 'owner', 11);
  await store.recordUnknown(paid.record.receipt.claim, 'transport-error', 12);
  const db = new DatabaseSync(base.path), row = db.prepare('SELECT record,revision,reservation_count FROM provider_spend_accounts').get()!;
  const account = { ...JSON.parse(String(row.record)), frozen: true }, checkpoint = createProviderSpendCheckpoint(account, Number(row.revision), Number(row.reservation_count));
  db.prepare('UPDATE provider_spend_accounts SET record=?,digest=?').run(JSON.stringify(account), checkpoint.digest); db.close();
  const zero = admission(base, 'zero', 'zero-id', 'allocation-b', 0), free = { kind: 'operator-static', version: 1, currency: 'USD', inputMinorUnitsPerMillionTokens: 0, outputMinorUnitsPerMillionTokens: 0 };
  const input = { ...zero, spending: { ...zero.spending, quote: { ...zero.spending.quote, pricing: { id: 'operator-static-tariff', version: 1, definition: free, digest: providerSpendEvidenceDigest(free) } } } };
  const claim = await store.claim(input); await store.permitSend(claim.record.receipt.claim, 'owner', 13); await store.recordUnknown(claim.record.receipt.claim, 'transport-error', 14);
  expect((await store.claim(input)).replayed).toBe(true);
  await expect(store.claim(admission(base, 'another-paid', 'another-paid-id'))).rejects.toThrow('PROVIDER_SPEND_FROZEN'); store.close();
  expect(snapshot(base.path)).toMatchObject({ account, invocations: 2, reservations: [{ invocationId: 'paid-id' }] });
});
