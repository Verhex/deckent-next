import { afterAll, afterEach, beforeAll, describe, expect, it, type TestContext } from 'vitest';
import { HttpConditionalEffectTarget } from '#adapters/index.js';
import { config, testErpFixture } from '../../fixtures/test-erp/fixture.js';
import { checkFixtureAvailability, recordFixtureAvailability, FixtureUnavailableError, type FixtureAvailability } from '../../fixtures/test-erp/availability.js';
import { runtimeBinaryAvailability } from '../../fixtures/test-erp/runtime.js';

type Fixture = Awaited<ReturnType<typeof testErpFixture>>;
type Command = ReturnType<Fixture['command']>;
const fixtures: { name: string; value: Fixture }[] = [];
afterEach(async () => { for (const { name, value } of fixtures.splice(0).reverse()) await value.close(name); });

// Positive composition paths need Linux /proc OS sessions and a real PTY. Other platforms are verify-not-run, not acceptance.
describe.each(['sdk', 'runtime'] as const)('test.erp through the %s operation surface', surface => {
  let availability: FixtureAvailability;
  beforeAll(async () => {
    availability = await checkFixtureAvailability();
    if (availability.status === 'available' && surface === 'runtime') availability = await runtimeBinaryAvailability();
    await recordFixtureAvailability(surface, availability);
  });
  async function open(): Promise<Opened> {
    if (availability.status === 'verify-not-run') return { skip: JSON.stringify(availability) };
    try {
      return { value: await testErpFixture({ surface }) };
    } catch (error) {
      if (!(error instanceof FixtureUnavailableError)) throw error;
      await recordFixtureAvailability(surface, error.availability); return { skip: JSON.stringify(error.availability) };
    }
  }
  async function fixture(name: string, context: TestContext) {
    const opened = await open(); if ('skip' in opened) context.skip(opened.skip);
    fixtures.push({ name, value: opened.value }); return opened.value;
  }
  it('actively records unavailable verification as a typed result, never as operation acceptance', () => {
    expect(availability.platform).toBe(process.platform);
    if (process.platform !== 'linux') expect(availability).toEqual({ status: 'verify-not-run', reason: 'platform-unsupported', platform: process.platform });
    else expect(['available', 'verify-not-run']).toContain(availability.status);
    if (availability.status === 'verify-not-run') expect(['platform-unsupported', 'loopback-denied', 'binary-unavailable']).toContain(availability.reason);
  });
  it('reads a purchase-order version through the configured catalog without a business write', async context => {
    const f = await fixture('read', context);
    const before = f.server.current();
    const outcome = await f.execute(f.command('read', { operation: config.operations.read, expectedVersion: null, input: null }));
    expect(outcome).toMatchObject({ status: 'settled', version: f.server.etag(before.version) });
    expect(f.server.current()).toEqual(before); expect(f.server.writes).toEqual([]);
    expect((await f.inspect('read')).record).toMatchObject({ state: 'settled', intent: { descriptor: { effectClass: 'read' } } });
    // http-conditional exposes the version, not the business payload; no observed-readback evidence class is claimed.
    expect(outcome).not.toHaveProperty('input');
  });

  it('asks the actual operation card before applying a matching conditional approval', async context => {
    const f = await fixture('conditional-match', context); const command = f.command('approve');
    const { pending, decision } = await f.approve(command);
    expect(pending).toMatchObject({ status: 'approval-pending', approval: { revision: 0 } });
    expect(decision).toMatchObject({ status: 'decided', decision: { decision: 'allow' } });
    expect(f.server.requests).toEqual([]); expect((await f.inspect(command.commandId)).record).toBeNull();
    const outcome = await f.execute(command);
    expect(outcome).toMatchObject({ status: 'settled', version: f.server.etag(config.initialVersion + 1), evidence: 'idempotency-record' });
    if (outcome.status !== 'settled') throw new Error('approved command did not settle');
    expect(f.server.current().status).toBe(config.approvedStatus);
    expect(f.server.writes).toHaveLength(1);
    expect(f.server.requests.find(request => request.method === 'POST')).toMatchObject({ ifMatch: command.expectedVersion });
    expect((await f.inspect(command.commandId)).record).toMatchObject({ state: 'settled', intent: { approval: { approvalId: pending.approval.approvalId } },
      evidence: { kind: outcome.evidence, version: outcome.version } });
  });

  it('refuses an already advanced purchase-order version without any write or intent', async context => {
    const f = await fixture('stale-version', context);
    const command = f.command('stale', { expectedVersion: f.server.etag(config.initialVersion - 1) });
    await f.approve(command);
    await expect(f.execute(command)).rejects.toMatchObject({ code: 'EFFECT_PRECONDITION_CHANGED' });
    expect(f.server.writes).toEqual([]); expect(f.server.requests.filter(request => request.method === 'POST')).toEqual([]);
    expect(f.server.current()).toEqual({ version: config.initialVersion, status: config.initialStatus });
    expect((await f.inspect(command.commandId)).record).toBeNull();
  });

  it('records a typed refusal if the version races the authorized If-Match write', async context => {
    const f = await fixture('raced-version', context); const command = f.command('raced');
    await f.approve(command); f.server.faults.advanceBeforeWrite = true;
    await expect(f.execute(command)).rejects.toMatchObject({ code: 'EFFECT_PRECONDITION_CHANGED' });
    expect(f.server.writes).toEqual([]); expect(f.server.current().status).toBe(config.initialStatus);
    expect((await f.inspect(command.commandId)).record).toMatchObject({ state: 'refused', refusal: 'EFFECT_PRECONDITION_CHANGED' });
    const requests = f.server.requests.length;
    await expect(f.execute(command)).rejects.toMatchObject({ code: 'EFFECT_PRECONDITION_CHANGED' });
    expect(f.server.requests).toHaveLength(requests);
  });

  it('matches one server effect to durable settlement across application and wire-key replays', async context => {
    const f = await fixture('idempotency', context); const command = f.command('once'); await f.approve(command);
    const first = await f.execute(command);
    if (first.status !== 'settled') throw new Error('approved command did not settle');
    expect(await f.execute(command)).toEqual(first);
    const { record } = await f.inspect(command.commandId);
    if (!record?.intent.wireKey) throw new Error('missing durable wire key');
    const target = new HttpConditionalEffectTarget({ kind: config.targetKind, baseUrl: f.server.baseUrl, timeoutMs: config.http.timeoutMs,
      responseMaxBytes: config.http.responseMaxBytes, idempotencyLookup: true });
    // Deliberate duplicate at the adapter boundary: the service must deduplicate even with the now stale If-Match header.
    expect(await target.apply({ target: command.target, operation: command.operation, input: command.input,
      expectedVersion: command.expectedVersion, idempotencyKey: record.intent.wireKey })).toEqual({ version: first.version });
    expect(f.server.requests.filter(request => request.method === 'POST')).toHaveLength(2);
    expect(f.server.writes).toHaveLength(1); expect(f.server.idempotency.get(record.intent.wireKey)).toBe(first.version);
    expect(record).toMatchObject({ state: 'settled', sequence: first.sequence, evidence: { version: first.version } });
    expect(record.intent.wireKey).not.toBe(command.idempotencyKey);
    const other = f.command('other', { idempotencyKey: command.idempotencyKey }); await f.approve(other);
    await expect(f.execute(other)).rejects.toMatchObject({ code: 'EFFECT_CONFLICT' });
    expect(f.server.writes).toHaveLength(1);
  });

  it('enforces H34 requester-cannot-approve on the C12 card with the same real OS principal', async context => {
    const f = await fixture('four-eyes-self-refusal', context); await f.policy(true);
    const command = f.command('four-eyes'); const pending = await f.execute(command);
    if (pending.status !== 'approval-pending') throw new Error('missing operation card');
    for (const id of ['self-first', 'self-second']) {
      await expect(f.decide(pending.approval.approvalId, id)).rejects.toMatchObject({ code: 'APPROVAL_DENIED' });
    }
    expect(await f.inspectApproval(pending.approval.approvalId))
      .toMatchObject({ status: 'pending', revision: 0, decision: null });
    expect(await f.execute(command)).toEqual(pending);
    expect(f.server.requests).toEqual([]); expect(f.server.writes).toEqual([]); expect((await f.inspect(command.commandId)).record).toBeNull();
    // A second authenticated human is unavailable in this author lane; do not fabricate it or remove the SoD rule to settle this command.
  });

  unknownReconcileSteps(open);
  compensationSteps(open);
});

type Opened = { value: Fixture } | { skip: string };
// A heavy scenario runs as ordered steps on one fixture, so each step keeps the normal per-test bound (owner B′, 2026-10-19; the CLI cold start
// behind it is PB-COLDSTART). The fixture closes and correlates its evidence after the last step. An unavailable fixture skips every step; a step
// whose predecessor did not pass fails. Steps share state, so one step cannot run alone with -t.
function steps(name: string, open: () => Promise<Opened>) {
  const state: { f?: Fixture; skip?: string; passed: number } = { passed: 0 };
  afterAll(async () => { if (state.f) await state.f.close(name); });
  return {
    async open(context: TestContext) {
      const opened = await open(); if ('skip' in opened) { state.skip = opened.skip; context.skip(opened.skip); }
      return state.f = opened.value;
    },
    next(step: number, context: TestContext) {
      if (state.skip !== undefined) context.skip(state.skip);
      if (!state.f || state.passed !== step - 1) throw new Error(`${name}: step ${step} requires step ${step - 1} to pass first`);
      return state.f;
    },
    passed(step: number) { state.passed = step; },
  };
}

function unknownReconcileSteps(open: () => Promise<Opened>) {
  describe('preserves unknown after a real response timeout, blocks new intent and reconciles by lookup without another write', { concurrent: false, shuffle: false }, () => {
    const run = steps('unknown-reconcile', open); let command: Command;
    it('step 1: preserves unknown after a real response timeout and replays it without another write', async context => {
      const f = await run.open(context); command = f.command('uncertain'); await f.approve(command);
      f.server.faults.loseResponseAfterWrite = true; f.server.faults.lookupUnavailable = true;
      await expect(f.execute(command)).rejects.toMatchObject({ code: 'EFFECT_OUTCOME_UNKNOWN' });
      expect(await f.checkpoint('unknown-after-timeout', command.commandId)).toMatchObject({ state: 'unknown', evidence: null });
      expect(f.server.writes).toHaveLength(1); expect(f.server.current().status).toBe(config.approvedStatus);
      await expect(f.execute(command)).rejects.toMatchObject({ code: 'EFFECT_OUTCOME_UNKNOWN' });
      expect(f.server.requests.filter(request => request.method === 'POST')).toHaveLength(1);
      run.passed(1);
    });
    it('step 2: blocks a new approved intent on the busy target', async context => {
      const f = run.next(2, context);
      const other = f.command('blocked'); await f.approve(other);
      await expect(f.execute(other)).rejects.toMatchObject({ code: 'EFFECT_TARGET_BUSY' });
      expect((await f.inspect(other.commandId)).record).toBeNull();
      run.passed(2);
    });
    it('step 3: refuses an approved undo of the unknown effect as not compensable', async context => {
      const f = run.next(3, context);
      const undo = f.command('unknown-undo', { operation: config.operations.undo, compensates: command.commandId }); await f.approve(undo, 'compensate');
      await expect(f.compensate(undo)).rejects.toMatchObject({ code: 'EFFECT_NOT_COMPENSABLE' });
      run.passed(3);
    });
    it('step 4: reconciles by lookup without another write', async context => {
      const f = run.next(4, context);
      f.server.faults.lookupUnavailable = false;
      const outcome = await f.execute(command);
      expect(outcome).toMatchObject({ status: 'settled', evidence: 'idempotency-record', version: f.server.etag(config.initialVersion + 1) });
      expect(await f.checkpoint('settled-after-lookup', command.commandId)).toMatchObject({ state: 'settled', evidence: { kind: 'idempotency-record' } });
      expect(f.server.requests.filter(request => request.method === 'POST')).toHaveLength(1); expect(f.server.writes).toHaveLength(1);
      run.passed(4);
    });
  });
}

function compensationSteps(open: () => Promise<Opened>) {
  describe('requires a new card and settlement for undo, retains the original effect and replays compensation once', { concurrent: false, shuffle: false }, () => {
    const run = steps('compensation', open);
    let original: Command, originalRecord: Awaited<ReturnType<Fixture['inspect']>>['record'], undo: Command;
    let pending: Awaited<ReturnType<Fixture['approve']>>['pending'], settled: Awaited<ReturnType<Fixture['compensate']>>;
    it('step 1: settles the original purchase-order effect under its own card', async context => {
      const f = await run.open(context); original = f.command('original'); await f.approve(original); await f.execute(original);
      originalRecord = (await f.inspect(original.commandId)).record;
      run.passed(1);
    });
    it('step 2: requires a new card for undo before any compensating write', async context => {
      const f = run.next(2, context);
      undo = f.command('undo', { operation: config.operations.undo, input: { status: config.initialStatus }, compensates: original.commandId });
      ({ pending } = await f.approve(undo, 'compensate'));
      expect(f.server.writes).toHaveLength(1); expect(f.server.current().status).toBe(config.approvedStatus);
      expect((await f.inspect(undo.commandId)).record).toBeNull();
      expect(pending.approval.approvalId).not.toBe(originalRecord?.intent.approval?.approvalId);
      run.passed(2);
    });
    it('step 3: settles the undo and retains the original effect record', async context => {
      const f = run.next(3, context);
      settled = await f.compensate(undo);
      expect(settled).toMatchObject({ status: 'settled', compensates: original.commandId, operation: config.operations.undo });
      expect(f.server.current()).toEqual({ version: config.initialVersion + 2, status: config.initialStatus });
      expect((await f.inspect(original.commandId)).record).toEqual(originalRecord);
      expect((await f.inspect(undo.commandId)).record).toMatchObject({ state: 'settled', intent: { command: { compensates: original.commandId },
        approval: { approvalId: pending.approval.approvalId } } });
      run.passed(3);
    });
    it('step 4: replays the settled compensation once without another write', async context => {
      const f = run.next(4, context);
      expect(await f.compensate(undo)).toEqual(settled); expect(f.server.writes).toHaveLength(2);
      expect(new Set(f.server.writes.map(write => write.key)).size).toBe(2);
      run.passed(4);
    });
    it('step 5: refuses a denied undo card without a write', async context => {
      const f = run.next(5, context);
      const denied = f.command('denied-undo', { operation: config.operations.undo, compensates: original.commandId });
      const waiting = await f.compensate(denied); if (waiting.status !== 'approval-pending') throw new Error('missing undo card');
      await f.decide(waiting.approval.approvalId, 'deny-undo', 'deny');
      await expect(f.compensate(denied)).rejects.toMatchObject({ code: 'APPROVAL_DENIED' }); expect(f.server.writes).toHaveLength(2);
      run.passed(5);
    });
  });
}
