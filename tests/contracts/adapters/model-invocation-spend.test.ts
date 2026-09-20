import { createHash } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { openSqliteModelActivationStore, openSqliteModelInvocationStore } from '#adapters/index.js';
import { encodeModelBindingDefinition, parseProviderCatalog, resolveModelBindingDefinition } from '#domain/index.js';
import { createModelInvocationResponseEvidence, modelInvocationProfileDigest, modelInvocationRequestDigest } from '#engine/index.js';

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
    adapter: { id: 'fixture', version: 1, definition: {} }, allocation: { id: allocationId, maxCalls: 10, maxInFlight: 10 },
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
const claimant = `
import { readFile } from 'node:fs/promises';
import { openSqliteModelInvocationStore } from './dist/adapters/index.js';
const [path,inputPath] = process.argv.slice(1);
const store = await openSqliteModelInvocationStore(path,{journalMode:'delete',durability:'full',busyTimeoutMs:2000},'forbid');
process.stdout.write('READY\\n');
await new Promise(resolve => process.stdin.once('data', resolve));
try { await store.claim(JSON.parse(await readFile(inputPath,'utf8'))); process.stdout.write('COMMITTED\\n'); }
catch (error) { process.stdout.write('ERROR:' + String(error?.code ?? error?.message) + '\\n'); }
finally { store.close(); }
`;
async function competingClaim(path: string, inputPath: string) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', claimant, path, inputPath],
    { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '', errors = ''; child.stdout.on('data', chunk => { output += String(chunk); }); child.stderr.on('data', chunk => { errors += String(chunk); });
  const until = async (predicate: () => boolean, label: string) => {
    const deadline = Date.now() + 5_000;
    while (!predicate()) { if (Date.now() > deadline || child.exitCode !== null) throw new Error(`${label}:${errors}`); await new Promise(resolve => setTimeout(resolve, 5)); }
  };
  await until(() => output.includes('READY\n'), 'CLAIMANT_READY');
  return { child, release: () => child.stdin.write('GO\n'), result: async () => {
    await until(() => output.includes('COMMITTED\n') || output.includes('ERROR:'), 'CLAIMANT_RESULT');
    child.stdin.end(); await new Promise<void>((resolve, reject) => { const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('CLAIMANT_EXIT')); }, 5_000);
      child.once('exit', code => { clearTimeout(timer); if (code === 0) resolve(); else reject(new Error(`CLAIMANT_CODE:${code}:${errors}`)); }); });
    return output.includes('COMMITTED\n') ? 'COMMITTED' : output.trim().split('ERROR:').at(-1)!;
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
    createModelInvocationResponseEvidence({ id: 'fixture', version: 1 }, 'http-status', 429, Buffer.from('{"error":"denied"}'), true), 12);
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
    children.push(first.child, second.child); first.release(); second.release();
    expect([await first.result(), await second.result()].sort()).toEqual(['COMMITTED', 'PROVIDER_SPEND_EXHAUSTED']);
  } finally {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  expect(snapshot(base.path)).toMatchObject({ account: { reservedMinorUnits: 6, settledMinorUnits: 0 }, invocations: 1, controls: 1,
    reservations: [{ record: { disposition: { state: 'reserved' } } }] });
  expect(snapshot(base.path).allocations).toHaveLength(1);
});
