import { describe, expect, it } from 'vitest';
import { createProviderSpendAccount, createProviderSpendAuditReceipt, createProviderSpendCheckpoint,
  ProviderSpendAuditApplication, ProviderSpendError, parseProviderSpendAuditResultForCommand, providerSpendEvidenceDigest, providerSpendQuoteDigest,
  reserveProviderSpend, type ProviderSpendAuditReceipt, type ProviderSpendAuditStore,
  type ProviderSpendIntegrityReader } from '#engine/core/provider-spend/index.js';

const principal = { id: 'actor', issuer: 'issuer', subject: 'subject', assurance: 'token-verified' as const,
  scopeIds: ['scope'] };
const authorization = { revision: 'policy-1', ruleId: 'audit-rule' };
const budget = { schemaVersion: 1 as const, scopeId: 'scope', budgetId: 'budget', revision: 3,
  currency: 'USD', limitMinorUnits: 100 };

function monetaryFixture(count = 0) {
  let account = createProviderSpendAccount(budget);
  const reservations = Array.from({ length: count }, (_, index) => {
    const pricingDefinition = { schemaVersion: 1, kind: 'test-price' }, meterEvidence = { schemaVersion: 1, kind: 'test-meter' };
    const quote = { schemaVersion: 1 as const, scopeId: 'scope', requestDigest: 'a'.repeat(64), profileDigest: 'b'.repeat(64),
      pricing: { id: 'price', version: 1, digest: providerSpendEvidenceDigest(pricingDefinition), definition: pricingDefinition },
      meter: { id: 'meter', version: 1, evidenceDigest: providerSpendEvidenceDigest(meterEvidence), evidence: meterEvidence },
      currency: 'USD', maxChargeMinorUnits: 3 };
    const result = reserveProviderSpend(account, budget, { schemaVersion: 1, scopeId: 'scope', invocationId: `invocation-${index}`,
      budgetId: 'budget', budgetRevision: 3, currency: 'USD', quoteDigest: providerSpendQuoteDigest(quote), quote });
    account = result.account; return result.reservation;
  });
  return { reservations, checkpoint: createProviderSpendCheckpoint(account, Math.max(1, count), count) };
}

function harness(options: { checkpoint?: ReturnType<typeof monetaryFixture>['checkpoint'];
  reservations?: ReturnType<typeof monetaryFixture>['reservations']; prior?: ProviderSpendAuditReceipt | null;
  verifierPrincipal?: typeof principal; elapsed?: () => number; signal?: AbortSignal; maxResultBytes?: number } = {}) {
  const monetary = options.checkpoint ? { checkpoint: options.checkpoint, reservations: options.reservations ?? [] } : monetaryFixture();
  const command = { schemaVersion: 1 as const, commandId: 'audit', scopeId: 'scope', budgetId: 'budget', budgetRevision: 3,
    expectedCheckpointDigest: monetary.checkpoint.digest };
  const calls = { authorizations: 0, storeOpens: 0, finds: 0, records: 0, storeCloses: 0,
    readerOpens: 0, reads: 0, readerCloses: 0 };
  let prior = options.prior ?? null, recorded: ProviderSpendAuditReceipt | null = null;
  const store: ProviderSpendAuditStore = { async find() { calls.finds++; return prior; }, async record(receipt) {
    calls.records++; recorded = receipt; return { schemaVersion: 1, receipt, replayed: false };
  }, close() { calls.storeCloses++; } };
  const reader: ProviderSpendIntegrityReader = { async readPage() { calls.reads++;
    return { checkpoint: monetary.checkpoint, reservations: monetary.reservations,
      nextInvocationId: null };
  }, close() { calls.readerCloses++; } };
  let nowCalls = 0;
  const app = new ProviderSpendAuditApplication({ async verify() { return options.verifierPrincipal ?? principal; } },
    { async authorize(action, target, observed) { calls.authorizations++; expect(action).toBe('audit');
      expect(target).toEqual({ scopeId: 'scope', budgetId: 'budget', budgetRevision: 3 }); expect(observed).toEqual(options.verifierPrincipal ?? principal);
      return { ...authorization, revision: `policy-${calls.authorizations}` };
    } }, async () => { calls.storeOpens++; return store; }, async () => { calls.readerOpens++; return reader; },
    { pageSize: 10, maxReservations: 10, timeoutMs: 100, maxResultBytes: options.maxResultBytes ?? 64_000 }, () => ++nowCalls * 10, options.elapsed ?? (() => 0));
  return { app, calls, command, monetary, store, reader, get recorded() { return recorded; }, set prior(value) { prior = value; } };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}

describe('provider spending audit application', () => {
  it('correlates public results and rejects extra fields, altered receipts and wrong commands', async () => {
    const f = harness(), result = await f.app.audit(f.command);
    expect(parseProviderSpendAuditResultForCommand(f.command, result)).toEqual(result);
    for (const invalid of [{ ...result, extra: true }, { ...result, replayed: 'false' },
      { ...result, receipt: { ...result.receipt, digest: '0'.repeat(64) } }]) {
      expect(() => parseProviderSpendAuditResultForCommand(f.command, invalid)).toThrow(ProviderSpendError);
    }
    expect(() => parseProviderSpendAuditResultForCommand({ ...f.command, commandId: 'other' }, result))
      .toThrow(expect.objectContaining({ code: 'PROVIDER_SPEND_CONFLICT' }));
    const exact = harness({ maxResultBytes: Buffer.byteLength(JSON.stringify(result)) });
    await expect(exact.app.audit(exact.command)).resolves.toEqual(result);
  });
  it('rejects a result exceeding delivery capacity before recording a new audit', async () => {
    const f = harness({ maxResultBytes: 1 });
    await expect(f.app.audit(f.command)).rejects.toMatchObject({ code: 'PROVIDER_SPEND_RESULT_LIMIT' });
    expect(f.calls).toMatchObject({ records: 0, storeCloses: 1, readerCloses: 1 });
  });

  it('bounds exact replay without rescanning or inserting an audit', async () => {
    const original = harness(), result = await original.app.audit(original.command);
    const replay = harness({ prior: result.receipt, maxResultBytes: 1 });
    await expect(replay.app.audit(replay.command)).rejects.toMatchObject({ code: 'PROVIDER_SPEND_RESULT_LIMIT' });
    expect(replay.calls).toMatchObject({ records: 0, readerOpens: 0, storeCloses: 1 });
  });
  it('opens no resources when current policy denies', async () => {
    const f = harness();
    const app = new ProviderSpendAuditApplication({ async verify() { return principal; } },
      { async authorize() { throw Object.assign(new Error('POLICY_DENIED'), { code: 'POLICY_DENIED' }); } },
      async () => { f.calls.storeOpens++; return f.store; }, async () => { f.calls.readerOpens++; return f.reader; },
      { pageSize: 10, maxReservations: 10, timeoutMs: 100, maxResultBytes: 64_000 });
    await expect(app.audit(f.command)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    expect(f.calls).toMatchObject({ storeOpens: 0, readerOpens: 0, records: 0 });
  });

  it('records a consistent checkpoint only after a second current authorization', async () => {
    const f = harness(), result = await f.app.audit(f.command);
    expect(result).toMatchObject({ schemaVersion: 1, replayed: false, receipt: { authorization: { revision: 'policy-2' },
      startedAtMs: 10, completedAtMs: 20, examinedCheckpoint: f.monetary.checkpoint } });
    expect(f.recorded?.digest).toBe(result.receipt.digest);
    expect(f.calls).toEqual({ authorizations: 2, storeOpens: 1, finds: 1, records: 1, storeCloses: 1,
      readerOpens: 1, reads: 1, readerCloses: 1 });
  });

  it('rejects a different checkpoint without recording and closes both resources', async () => {
    const f = harness(), other = monetaryFixture();
    const altered = createProviderSpendCheckpoint(other.checkpoint.account, 2, 0);
    f.reader.readPage = async () => { f.calls.reads++; return { checkpoint: altered, reservations: [], nextInvocationId: null }; };
    await expect(f.app.audit(f.command)).rejects.toThrow('PROVIDER_SPEND_CONFLICT');
    expect(f.calls).toMatchObject({ records: 0, storeCloses: 1, readerCloses: 1 });
  });

  it('does not record when the second authorization is revoked', async () => {
    const f = harness();
    const app = new ProviderSpendAuditApplication({ async verify() { return principal; } }, { async authorize() {
      if (++f.calls.authorizations === 2) throw Object.assign(new Error('POLICY_DENIED'), { code: 'POLICY_DENIED' });
      return authorization;
    } }, async () => f.store, async () => f.reader, { pageSize: 10, maxReservations: 10, timeoutMs: 100, maxResultBytes: 64_000 }, () => 0, () => 0);
    await expect(app.audit(f.command)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    expect(f.calls).toMatchObject({ authorizations: 2, records: 0, storeCloses: 1, readerCloses: 1 });
  });

  it('bounds cancellation, elapsed time, and reservation count without recording', async () => {
    const controller = new AbortController(); controller.abort(); const aborted = harness();
    await expect(aborted.app.audit(aborted.command, undefined, controller.signal)).rejects.toThrow('PROVIDER_SPEND_UNAVAILABLE');
    expect(aborted.calls).toMatchObject({ storeOpens: 0, records: 0 });

    let clock = 0; const timed = harness({ elapsed: () => clock });
    timed.reader.readPage = async () => { timed.calls.reads++; clock = 100;
      return { checkpoint: timed.monetary.checkpoint, reservations: [], nextInvocationId: null }; };
    await expect(timed.app.audit(timed.command)).rejects.toThrow('PROVIDER_SPEND_UNAVAILABLE');
    expect(timed.calls).toMatchObject({ records: 0, storeCloses: 1, readerCloses: 1 });

    const large = monetaryFixture(2), bounded = harness({ checkpoint: large.checkpoint, reservations: large.reservations });
    const app = new ProviderSpendAuditApplication({ async verify() { return principal; } },
      { async authorize() { return authorization; } }, async () => bounded.store, async () => bounded.reader,
      { pageSize: 10, maxReservations: 1, timeoutMs: 100, maxResultBytes: 64_000 }, () => 0, () => 0);
    await expect(app.audit(bounded.command)).rejects.toThrow('PROVIDER_SPEND_UNAVAILABLE');
    expect(bounded.calls).toMatchObject({ records: 0, reads: 1, storeCloses: 1, readerCloses: 1 });
  });

  it('replays only the exact command and stable actor after current authorization without scanning or writing', async () => {
    const base = harness();
    const prior = createProviderSpendAuditReceipt({ command: base.command, principal, authorization,
      examinedCheckpoint: base.monetary.checkpoint, startedAtMs: 1, completedAtMs: 2 });
    const replay = harness({ prior });
    expect(await replay.app.audit(replay.command)).toEqual({ schemaVersion: 1, receipt: prior, replayed: true });
    expect(replay.calls).toMatchObject({ authorizations: 1, finds: 1, readerOpens: 0, reads: 0, records: 0, storeCloses: 1 });

    const changedActor = harness({ prior, verifierPrincipal: { ...principal, id: 'other' } });
    await expect(changedActor.app.audit(changedActor.command)).rejects.toThrow('PROVIDER_SPEND_CONFLICT');
    const changedCommand = harness({ prior });
    await expect(changedCommand.app.audit({ ...changedCommand.command, expectedCheckpointDigest: '0'.repeat(64) }))
      .rejects.toThrow('PROVIDER_SPEND_CONFLICT');
    expect(changedActor.calls.records + changedCommand.calls.records).toBe(0);
  });

  it('redacts unknown backend failures, closes opened resources, and preserves typed record conflicts', async () => {
    const failedRead = harness();
    failedRead.reader.readPage = async () => { throw new Error('secret database path'); };
    await expect(failedRead.app.audit(failedRead.command)).rejects.toMatchObject({ code: 'PROVIDER_SPEND_UNAVAILABLE', message: 'PROVIDER_SPEND_UNAVAILABLE' });
    expect(failedRead.calls).toMatchObject({ records: 0, storeCloses: 1, readerCloses: 1 });

    const conflict = harness();
    conflict.store.record = async () => { conflict.calls.records++; throw new ProviderSpendError('PROVIDER_SPEND_CONFLICT'); };
    await expect(conflict.app.audit(conflict.command)).rejects.toMatchObject({ code: 'PROVIDER_SPEND_CONFLICT' });
    expect(conflict.calls).toMatchObject({ records: 1, storeCloses: 1, readerCloses: 1 });
  });

  it('times out a never-settling page read and closes the acquired reader and store', async () => {
    const f = harness(); f.reader.readPage = async () => { f.calls.reads++; return new Promise(() => {}); };
    const app = new ProviderSpendAuditApplication({ async verify() { return principal; } },
      { async authorize() { return authorization; } }, async () => f.store, async () => f.reader,
      { pageSize: 10, maxReservations: 10, timeoutMs: 20, maxResultBytes: 64_000 });
    await expect(app.audit(f.command)).rejects.toThrow('PROVIDER_SPEND_UNAVAILABLE');
    expect(f.calls).toMatchObject({ reads: 1, records: 0, readerCloses: 1, storeCloses: 1 });
  });

  it('honors caller abort while a page read is pending and closes acquired resources', async () => {
    const f = harness(), entered = deferred<void>(), controller = new AbortController();
    f.reader.readPage = async () => { f.calls.reads++; entered.resolve(); return new Promise(() => {}); };
    const app = new ProviderSpendAuditApplication({ async verify() { return principal; } },
      { async authorize() { return authorization; } }, async () => f.store, async () => f.reader,
      { pageSize: 10, maxReservations: 10, timeoutMs: 1_000, maxResultBytes: 64_000 });
    const pending = app.audit(f.command, undefined, controller.signal); await entered.promise; controller.abort();
    await expect(pending).rejects.toThrow('PROVIDER_SPEND_UNAVAILABLE');
    expect(f.calls).toMatchObject({ reads: 1, records: 0, readerCloses: 1, storeCloses: 1 });
  });

  it('disposes a reader that resolves only after the audit deadline', async () => {
    const f = harness(), opening = deferred<ProviderSpendIntegrityReader>();
    const app = new ProviderSpendAuditApplication({ async verify() { return principal; } },
      { async authorize() { return authorization; } }, async () => f.store, () => opening.promise,
      { pageSize: 10, maxReservations: 10, timeoutMs: 20, maxResultBytes: 64_000 });
    await expect(app.audit(f.command)).rejects.toThrow('PROVIDER_SPEND_UNAVAILABLE');
    expect(f.calls).toMatchObject({ records: 0, readerCloses: 0, storeCloses: 1 });
    opening.resolve(f.reader); await new Promise(resolve => setTimeout(resolve, 0));
    expect(f.calls.readerCloses).toBe(1);
  });

  it('does not record when the second authorization remains pending past the deadline', async () => {
    const f = harness(); let authorizations = 0;
    const app = new ProviderSpendAuditApplication({ async verify() { return principal; } },
      { async authorize() { if (++authorizations === 2) return new Promise(() => {}); return authorization; } },
      async () => f.store, async () => f.reader, { pageSize: 10, maxReservations: 10, timeoutMs: 20, maxResultBytes: 64_000 });
    await expect(app.audit(f.command)).rejects.toThrow('PROVIDER_SPEND_UNAVAILABLE');
    expect(authorizations).toBe(2);
    expect(f.calls).toMatchObject({ reads: 1, records: 0, readerCloses: 1, storeCloses: 1 });
  });

  it('times out a never-settling receipt lookup before opening a reader', async () => {
    const f = harness(); f.store.find = async () => { f.calls.finds++; return new Promise(() => {}); };
    const app = new ProviderSpendAuditApplication({ async verify() { return principal; } },
      { async authorize() { return authorization; } }, async () => f.store, async () => f.reader,
      { pageSize: 10, maxReservations: 10, timeoutMs: 20, maxResultBytes: 64_000 });
    await expect(app.audit(f.command)).rejects.toThrow('PROVIDER_SPEND_UNAVAILABLE');
    expect(f.calls).toMatchObject({ finds: 1, readerOpens: 0, records: 0, storeCloses: 1 });
  });
});
