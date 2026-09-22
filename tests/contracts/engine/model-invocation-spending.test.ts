import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { createOpenAiChatNativePort, openSqliteModelActivationStore, openSqliteModelInvocationStore } from '#adapters/index.js';
import { encodeModelBindingDefinition, resolveModelBindingDefinition } from '#domain/index.js';
import { ModelInvocationApplication, providerSpendEvidenceDigest, type ModelInvocationSpendingAuthority, type ModelInvocationSpendingInput,
  type ModelInvocationSpending, type ModelInvocationNativeRegistry } from '#engine/index.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const sqlite = { journalMode: 'delete' as const, durability: 'full' as const, busyTimeoutMs: 2000 };
const reference = { providerId: 'p', providerVersion: 1, modelId: 'm', modelVersion: 1 };
const definition = resolveModelBindingDefinition({ schemaVersion: 1, revision: 'catalog', providers: [{ id: 'p', version: 1,
  models: [{ id: 'm', version: 1, nativeId: 'owned-fixture', protocols: [{ family: 'openai-chat-completions', version: 'v1', capabilities: [] }] }] }] }, reference)!;
const binding = { encodingVersion: 1 as const, algorithm: 'sha256' as const,
  digest: createHash('sha256').update(encodeModelBindingDefinition(definition)).digest('hex') };
const principal = { id: 'actor', issuer: 'os', subject: '1', assurance: 'os-user' as const, scopeIds: ['scope'] };
// Synthetic test accounting. This is not vendor pricing, an invoice bound, or a production quote producer.
function testSpending(input: ModelInvocationSpendingInput): ModelInvocationSpending {
  return { budget: { schemaVersion: 1, scopeId: 'scope', budgetId: 'shared', revision: 1, currency: 'USD', limitMinorUnits: 10 },
    quote: { schemaVersion: 1, scopeId: 'scope', requestDigest: input.requestDigest, profileDigest: input.profileDigest,
      pricing: { id: 'synthetic-price', version: 1, digest: '291f395a66cb728f57612b09b06f9512815b982e9a5d65e3fafec28256ff0aa9', definition: { schemaVersion: 1, kind: 'synthetic-price' } },
      meter: { id: 'synthetic-meter', version: 1, evidenceDigest: '446658cc1c39184b672f423a7f970bffab0e8f38e851c5b5dacd3f38eb85051f', evidence: { schemaVersion: 1, kind: 'synthetic-meter' } }, currency: 'USD', maxChargeMinorUnits: 6 } };
}
async function fixture(timeoutMs = 1000) {
  const root = await mkdtemp(join(tmpdir(), 'deckent-spend-app-')); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'ledger.db'), events: string[] = [];
  const server = createServer((request, response) => {
    events.push('http'); request.resume();
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ id: 'owned', object: 'chat.completion', created: 1, model: 'owned-fixture', choices: [{ index: 0,
      message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); }));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('FIXTURE');
  let profile = { schemaVersion: 1 as const, id: 'profile', version: 1, scopeId: 'scope', reference, bindingDigest: binding.digest,
    protocol: { family: 'openai-chat-completions', version: 'v1' }, adapter: { id: 'openai-chat-http', version: 4,
      definition: { endpoint: `http://127.0.0.1:${address.port}/chat`, maxOutputTokens: 8, authentication: { type: 'none' },
        tariff: { kind: 'operator-static', version: 1, currency: 'USD', inputMinorUnitsPerMillionTokens: 0, outputMinorUnitsPerMillionTokens: 0 } } },
    allocation: { id: 'calls', maxCalls: 10, maxInFlight: 10 }, limits: { requestMaxBytes: 4096, responseMaxBytes: 4096, timeoutMs } };
  const activations = await openSqliteModelActivationStore(path, sqlite);
  const activation = await activations.admit({ command: { schemaVersion: 1, action: 'activate', commandId: 'activate', scopeId: 'scope',
    reference, expectedRevision: 0, catalogRevision: 'catalog', expectedBinding: binding },
    actor: { id: principal.id, issuer: principal.issuer, subject: principal.subject, assurance: principal.assurance },
    authorization: { revision: 'policy', ruleId: 'activate' }, admittedAtMs: 1, definition });
  activations.close();
  let allowed = true, sequence = 0;
  function application(spending?: ModelInvocationSpendingAuthority, acquire?: ModelInvocationNativeRegistry['acquire']) {
    return new ModelInvocationApplication({ async verify() { return principal; } },
      { async authorize() { events.push('policy'); if (!allowed) throw new Error('DENIED'); return { revision: 'policy', ruleId: 'invoke' }; } },
      { async inspect() { events.push('binding'); return { schemaVersion: 1, reference, status: 'declared', catalogRevision: 'catalog',
        definition, binding, availability: 'not-observed' }; } },
      async () => ({ async loadRecord() { return activation.receipt.record; }, close() {} }),
      { async resolve() { events.push('profile'); return profile; } }, { resolve() {
        const native = createOpenAiChatNativePort({ async resolveCredential() { events.push('secret'); return 'synthetic'; } });
        return { ...native, async prepare(...args: Parameters<typeof native.prepare>) { events.push('prepare'); return native.prepare(...args); } };
      }, ...(acquire ? { acquire } : {}) }, async () => {
        const store = await openSqliteModelInvocationStore(path, sqlite, 'forbid'), claim = store.claim.bind(store);
        store.claim = async input => { events.push('claim'); return claim(input); }; return store;
      }, { invocationId: () => `invocation-${++sequence}`, ownerId: () => 'runtime', now: Date.now }, spending);
  }
  function counts() {
    const db = new DatabaseSync(path, { readOnly: true });
    try { return Object.fromEntries(['model_invocations', 'model_invocation_controls', 'model_invocation_allocations',
      'model_invocation_spend_reservations', 'provider_spend_accounts'].map(table =>
      [table, db.prepare(`SELECT count(*) AS count FROM ${table}`).get()!.count])); } finally { db.close(); }
  }
  const command = (commandId: string) => ({ schemaVersion: 1 as const, commandId, scopeId: 'scope', reference, catalogRevision: 'catalog',
    expectedBinding: binding, nativeRequest: { model: 'owned-fixture', messages: [{ role: 'user', content: 'owned test' }], max_completion_tokens: 8 } });
  return { application, command, counts, events, path, deny: () => { allowed = false; },
    changeProfile: () => { profile = { ...profile, version: 2 }; } };
}
function noEffects(f: Awaited<ReturnType<typeof fixture>>) {
  expect(f.events).not.toContain('claim'); expect(f.events).not.toContain('http'); expect(f.events).not.toContain('secret');
  expect(Object.values(f.counts())).toEqual([0, 0, 0, 0, 0]);
}

it('replays the winning claim when concurrent native tariff observations differ without replacing its reservation', async () => {
  const f = await fixture(); let arrivals = 0, release!: () => void;
  const bothQuoting = new Promise<void>(resolve => { release = resolve; });
  const authority = (observation: number): ModelInvocationSpendingAuthority => ({ async authorize(input) {
    if (++arrivals === 2) release();
    await bothQuoting;
    const spending = testSpending(input), evidence = { schemaVersion: 1, kind: 'synthetic-meter', observation };
    return { ...spending, quote: { ...spending.quote, meter: { ...spending.quote.meter,
      evidence, evidenceDigest: providerSpendEvidenceDigest(evidence) } } };
  } });
  const command = f.command('parallel'), results = await Promise.all([
    f.application(authority(1)).invoke(command), f.application(authority(2)).invoke(command),
  ]);
  expect(results.map(value => value.replayed).sort()).toEqual([false, true]);
  expect(results[0]!.receipt.claim).toEqual(results[1]!.receipt.claim);
  expect(f.events.filter(value => value === 'http')).toHaveLength(1);
  expect(Object.values(f.counts())).toEqual([1, 1, 1, 1, 1]);
  const db = new DatabaseSync(f.path, { readOnly: true });
  try {
    const row = db.prepare('SELECT record FROM model_invocation_spend_reservations').get()!;
    const reservation = JSON.parse(String(row.record));
    expect([1, 2]).toContain(reservation.descriptor.quote.meter.evidence.observation);
    expect(reservation.descriptor.quote.maxChargeMinorUnits).toBe(6);
    const stored = String(row.record);
    expect((await f.application().invoke(command)).replayed).toBe(true);
    expect(db.prepare('SELECT record FROM model_invocation_spend_reservations').get()!.record).toBe(stored);
  } finally { db.close(); }
});

it('fails closed without a trusted quote source and redacts its backend failures before claim or native HTTP', async () => {
  const f = await fixture();
  await expect(f.application().invoke(f.command('missing'))).rejects.toMatchObject({ code: 'PROVIDER_SPEND_UNAVAILABLE' });
  const failed = f.application({ async authorize() { throw new Error('/private/api-key=synthetic-secret'); } });
  await expect(failed.invoke(f.command('failed'))).rejects.toMatchObject({ code: 'PROVIDER_SPEND_UNAVAILABLE', message: 'PROVIDER_SPEND_UNAVAILABLE' });
  noEffects(f);
});

it('does not turn an account budget conflict without a matching command into a replay', async () => {
  const f = await fixture();
  await f.application({ async authorize(input) { return testSpending(input); } }).invoke(f.command('existing'));
  const changed = f.application({ async authorize(input) {
    const spending = testSpending(input);
    return { ...spending, budget: { ...spending.budget, revision: 2 } };
  } });
  await expect(changed.invoke(f.command('different'))).rejects.toMatchObject({ code: 'PROVIDER_SPEND_CONFLICT' });
  expect(f.events.filter(value => value === 'http')).toHaveLength(1);
  expect(Object.values(f.counts())).toEqual([1, 1, 1, 1, 1]);
});

it.each(['scope', 'currency', 'request', 'profile', 'ceiling', 'accessor', 'pricing-definition', 'meter-evidence'] as const)('rejects invalid %s spend evidence before any reservation or send', async kind => {
  const f = await fixture(); let accessorRead = false;
  const app = f.application({ async authorize(input) {
    const value = testSpending(input);
    if (kind === 'accessor') return Object.defineProperty({}, 'budget', { enumerable: true, get() { accessorRead = true; return value.budget; } }) as ModelInvocationSpending;
    if (kind === 'pricing-definition') return { ...value, quote: { ...value.quote,
      pricing: { ...value.quote.pricing, definition: { changed: true } } } };
    if (kind === 'meter-evidence') return { ...value, quote: { ...value.quote,
      meter: { ...value.quote.meter, evidence: { changed: true } } } };
    if (kind === 'scope') return { ...value, budget: { ...value.budget, scopeId: 'foreign' } };
    const change = kind === 'currency' ? { currency: 'EUR' } : kind === 'request' ? { requestDigest: 'f'.repeat(64) }
      : kind === 'profile' ? { profileDigest: 'f'.repeat(64) } : { maxChargeMinorUnits: 11 };
    return { ...value, quote: { ...value.quote, ...change } };
  } });
  await expect(app.invoke(f.command('invalid'))).rejects.toMatchObject({ code: ['accessor', 'pricing-definition', 'meter-evidence'].includes(kind) ? 'PROVIDER_SPEND_INVALID'
    : kind === 'ceiling' ? 'PROVIDER_SPEND_EXHAUSTED' : 'PROVIDER_SPEND_CONFLICT' });
  expect(accessorRead).toBe(false); noEffects(f);
});

it.each(['policy', 'profile', 'cancel'] as const)('rechecks %s after asynchronous quote resolution', async kind => {
  const f = await fixture(), controller = new AbortController();
  const app = f.application({ async authorize(input) {
    const value = testSpending(input);
    if (kind === 'policy') f.deny(); else if (kind === 'profile') f.changeProfile(); else controller.abort();
    return value;
  } });
  await expect(app.invoke(f.command('stale'), undefined, controller.signal)).rejects.toThrow(); noEffects(f);
});

it('reserves on the real ledger before owned HTTP; holds unpriced responses and replays without a current quote', async () => {
  const f = await fixture(), app = f.application({ async authorize(input) { f.events.push('quote'); return testSpending(input); } });
  const first = await app.invoke(f.command('one'));
  expect(first.receipt.outcome?.state).toBe('responded');
  expect(f.events).toEqual(['policy', 'binding', 'profile', 'prepare', 'quote', 'policy', 'binding', 'profile', 'quote', 'claim', 'http']);
  expect(await f.application().invoke(f.command('one'))).toEqual({ ...first, replayed: true });
  await expect(app.invoke(f.command('two'))).rejects.toMatchObject({ code: 'PROVIDER_SPEND_EXHAUSTED' });
  expect(f.events.filter(event => event === 'http')).toHaveLength(1);
  expect(Object.values(f.counts())).toEqual([1, 1, 1, 1, 1]);
  const db = new DatabaseSync(f.path, { readOnly: true });
  try {
    const account = JSON.parse(String(db.prepare('SELECT record FROM provider_spend_accounts').get()!.record));
    const reservation = JSON.parse(String(db.prepare('SELECT record FROM model_invocation_spend_reservations').get()!.record));
    expect(account).toMatchObject({ reservedMinorUnits: 6, settledMinorUnits: 0 });
    expect(reservation.disposition).toMatchObject({ state: 'held', reason: 'missing-usage' });
  } finally { db.close(); }
});

it('checks delivery capacity after quote validation but before monetary claim or HTTP', async () => {
  const f = await fixture(), app = f.application({ async authorize(input) { return testSpending(input); } });
  await expect(app.invoke(f.command('small'), undefined, undefined, { maxResultBytes: 1 }))
    .rejects.toMatchObject({ code: 'MODEL_INVOCATION_RESULT_LIMIT' }); noEffects(f);
});

it.each(['revoke', 'budget', 'pricing'] as const)('rejects %s changes at the final spending check before initializing an account', async kind => {
  const f = await fixture(); let resolutions = 0;
  const app = f.application({ async authorize(input) {
    const value = testSpending(input);
    if (++resolutions === 1) return value;
    if (kind === 'revoke') throw new Error('REVOKED');
    if (kind === 'budget') return { ...value, budget: { ...value.budget, revision: 2, limitMinorUnits: 9 } };
    return { ...value, quote: { ...value.quote, pricing: { ...value.quote.pricing, version: 2 } } };
  } });
  await expect(app.invoke(f.command('changed'))).rejects.toMatchObject({ code: kind === 'revoke'
    ? 'PROVIDER_SPEND_UNAVAILABLE' : 'PROVIDER_SPEND_CONFLICT' });
  expect(resolutions).toBe(2); noEffects(f);
});

it('aborts an uncooperative quote resolver and cannot claim when it resolves late', async () => {
  const f = await fixture(), controller = new AbortController();
  let notify!: () => void, resolve!: (value: ModelInvocationSpending) => void, saved!: ModelInvocationSpending;
  let sourceSignal: AbortSignal | undefined;
  const entered = new Promise<void>(done => { notify = done; });
  const app = f.application({ async authorize(input, signal) {
    saved = testSpending(input); sourceSignal = signal; notify();
    return new Promise<ModelInvocationSpending>(done => { resolve = done; });
  } });
  const observed = app.invoke(f.command('cancelled-quote'), undefined, controller.signal).then(
    () => ({ code: 'UNEXPECTED_SUCCESS' }), (error: { code: string }) => error);
  await entered; controller.abort();
  expect(await observed).toMatchObject({ code: 'PROVIDER_SPEND_UNAVAILABLE' });
  expect(sourceSignal?.aborted).toBe(true); resolve(saved);
  await new Promise<void>(done => setImmediate(done)); noEffects(f);
});

it('bounds quote resolution by the configured timeout even without a caller signal', async () => {
  const f = await fixture(25); let sourceSignal: AbortSignal | undefined;
  const app = f.application({ async authorize(_input, signal) { sourceSignal = signal; return new Promise(() => {}); } });
  await expect(app.invoke(f.command('timeout'))).rejects.toMatchObject({ code: 'PROVIDER_SPEND_UNAVAILABLE' });
  expect(sourceSignal?.aborted).toBe(true); noEffects(f);
});

it('acquires only after authorization and before pure preparation; replay requires no acquisition', async () => {
  const f = await fixture();
  const authority = { async authorize(input: ModelInvocationSpendingInput) { return testSpending(input); } };
  const acquire: NonNullable<ModelInvocationNativeRegistry['acquire']> = async input => {
    expect(input.profile.scopeId).toBe('scope'); expect(input.definition).toEqual(definition);
    expect(f.events).toEqual(['policy', 'binding', 'profile']); f.events.push('acquire');
  };
  const result = await f.application(authority, acquire).invoke(f.command('one'));
  expect(f.events.indexOf('acquire')).toBeLessThan(f.events.indexOf('prepare'));
  expect(result.receipt.outcome?.state).toBe('responded');
  f.events.length = 0;
  expect(await f.application(undefined, async () => { throw new Error('REPLAY_MUST_NOT_ACQUIRE'); }).invoke(f.command('one')))
    .toEqual({ ...result, replayed: true });
  expect(f.events).toEqual(['policy']);
});

it.each(['policy', 'missing-spending', 'cancelled'] as const)('does not acquire metadata when %s prevents admission', async kind => {
  const f = await fixture(), controller = new AbortController(); let acquisitions = 0;
  if (kind === 'policy') f.deny();
  if (kind === 'cancelled') controller.abort();
  const authority = kind === 'missing-spending' ? undefined : { async authorize(input: ModelInvocationSpendingInput) { return testSpending(input); } };
  await expect(f.application(authority, async () => { acquisitions++; }).invoke(f.command('blocked'), undefined, controller.signal)).rejects.toThrow();
  expect(acquisitions).toBe(0); expect(f.events).not.toContain('prepare'); noEffects(f);
});

it.each(['policy', 'profile'] as const)('rechecks %s changed during acquisition before claim', async kind => {
  const f = await fixture();
  const app = f.application({ async authorize(input) { return testSpending(input); } }, async () => {
    if (kind === 'policy') f.deny(); else f.changeProfile();
  });
  await expect(app.invoke(f.command('changed'))).rejects.toThrow(); noEffects(f);
});

it('aborts uncooperative acquisition and prevents late completion from preparing or claiming', async () => {
  const f = await fixture(), controller = new AbortController();
  let notify!: () => void, finish!: () => void, acquisitionSignal: AbortSignal | undefined;
  const entered = new Promise<void>(resolve => { notify = resolve; });
  const app = f.application({ async authorize(input) { return testSpending(input); } }, async (_input, signal) => {
    acquisitionSignal = signal; notify(); return new Promise<void>(resolve => { finish = resolve; });
  });
  const result = app.invoke(f.command('cancelled'), undefined, controller.signal).catch((error: { code: string }) => error);
  await entered; controller.abort(); expect(await result).toMatchObject({ code: 'MODEL_INVOCATION_UNAVAILABLE' });
  expect(acquisitionSignal?.aborted).toBe(true); finish(); await new Promise<void>(resolve => setImmediate(resolve));
  expect(f.events).not.toContain('prepare'); noEffects(f);
});

it('bounds acquisition by the profile timeout and redacts backend errors', async () => {
  const f = await fixture(25); let acquisitionSignal: AbortSignal | undefined;
  const authority = { async authorize(input: ModelInvocationSpendingInput) { return testSpending(input); } };
  const app = f.application(authority, async (_input, signal) => { acquisitionSignal = signal; return new Promise<void>(() => {}); });
  await expect(app.invoke(f.command('timeout'))).rejects.toMatchObject({ code: 'MODEL_INVOCATION_UNAVAILABLE' });
  expect(acquisitionSignal?.aborted).toBe(true);
  await expect(f.application(authority, async () => { throw new Error('https://private/secret'); }).invoke(f.command('failed')))
    .rejects.toMatchObject({ code: 'MODEL_INVOCATION_UNAVAILABLE', message: 'MODEL_INVOCATION_UNAVAILABLE' });
  expect(f.events).not.toContain('prepare'); noEffects(f);
});
