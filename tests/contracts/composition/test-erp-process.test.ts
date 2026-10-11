import { afterEach, beforeAll, describe, expect, it, type TestContext } from 'vitest';
import { config, testErpFixture } from '../../fixtures/test-erp/fixture.js';
import { startProcess } from '../../fixtures/test-erp/process.js';
import { checkFixtureAvailability, recordFixtureAvailability, FixtureUnavailableError, type FixtureAvailability } from '../../fixtures/test-erp/availability.js';
import { runtimeBinaryAvailability } from '../../fixtures/test-erp/runtime.js';

type Fixture = Awaited<ReturnType<typeof testErpFixture>>;
const opened: { name: string; fixture: Fixture }[] = [];
afterEach(async () => { for (const f of opened.splice(0).reverse()) await f.fixture.close(f.name); });
describe.each(['sdk', 'runtime'] as const)('one purchase-order Run through %s admission and acceptance', surface => {
  let availability: FixtureAvailability;
  beforeAll(async () => {
    availability = await checkFixtureAvailability();
    if (availability.status === 'available' && surface === 'runtime') availability = await runtimeBinaryAvailability();
    await recordFixtureAvailability(surface, availability);
  });
  async function fixture(name: string, context: TestContext) {
    if (availability.status === 'verify-not-run') context.skip(JSON.stringify(availability));
    try { const f = await testErpFixture({ surface }); opened.push({ name: `process-${name}`, fixture: f }); return f; }
    catch (error) { if (!(error instanceof FixtureUnavailableError)) throw error; context.skip(JSON.stringify(error.availability)); }
  }
  async function process(name: string, context: TestContext) {
    const f = await fixture(name, context), read = f.command('read-version', { operation: config.operations.read, expectedVersion: null, input: null });
    const approve = f.command('approve-order'); const run = await startProcess(f, [read, approve]);
    expect((await run.inspect()).tasks.map(row => row.phase)).toEqual(['pending', 'pending']);
    await expect(run.start(1)).rejects.toThrow(); // The successor cannot start before canonical predecessor acceptance.
    const first = await run.start(0); await f.execute(read);
    const accepted = await run.evaluate(first, 'accept-read'); await run.assertSettlement(0, accepted);
    expect(accepted.result.evaluation.run.tasks.map(row => row.phase)).toEqual(['accepted', 'pending']);
    return { f, run, approve, identity: await run.start(1) };
  }
  it('matches settlement, server record, approval receipt and canonical acceptance command/digest', async context => {
    const { f, run, approve, identity } = await process('happy', context);
    const { pending } = await f.approve(approve); expect(f.server.writes).toEqual([]);
    await f.execute(approve); const accepted = await run.evaluate(identity, 'accept-approval');
    const binding = await run.assertSettlement(1, accepted);
    expect(binding.approval?.approvalId).toBe(pending.approval.approvalId);
    expect(accepted.result.evaluation.run.tasks[1]!.acceptance).toMatchObject({ outcome: 'accepted', score: 1, evaluationId: 'accept-approval' });
    expect(f.server.writes).toHaveLength(1); expect(f.server.current().status).toBe(config.approvedStatus);
    const decision = await f.inspectApproval(pending.approval.approvalId);
    expect(decision).toMatchObject({ request: { actionDigest: binding.approval!.actionDigest,
      subject: { commandId: binding.commandId, inputDigest: binding.inputDigest } }, decision: { decision: 'allow' } });
    const reopened = await run.inspect(); expect(reopened.tasks).toEqual(accepted.result.evaluation.run.tasks);
  });
  it('keeps a pending card and four-eyes refusal out of acceptance and performs no effect', async context => {
    const { f, run, approve, identity } = await process('four-eyes', context); await f.policy(true);
    const pending = await f.execute(approve); if (pending.status !== 'approval-pending') throw new Error('missing card');
    expect(f.server.writes).toEqual([]);
    await expect(f.decide(pending.approval.approvalId, 'self-allow')).rejects.toMatchObject({ code: 'APPROVAL_DENIED' });
    const held = await run.evaluate(identity, 'pending-not-accepted');
    expect(held.result.evaluation.run.tasks[1]!.phase).toBe('awaiting-decision');
    expect(held.evaluation.criteria[0].verdict).toBe('unknown');
    expect((await f.inspect(approve.commandId)).record).toBeNull(); expect(f.server.writes).toEqual([]);
  });
  it('fails the Task on a typed precondition refusal after an approved version races', async context => {
    const { f, run, approve, identity } = await process('advanced-version', context); await f.approve(approve);
    f.server.faults.advanceBeforeWrite = true;
    await expect(f.execute(approve)).rejects.toMatchObject({ code: 'EFFECT_PRECONDITION_CHANGED' });
    const failed = await run.evaluate(identity, 'refused-not-accepted');
    expect(failed.result.evaluation.run.tasks[1]!.phase).toBe('failed');
    expect(failed.evaluation.criteria[0]).toMatchObject({ verdict: 'fail' });
    expect(f.server.writes).toEqual([]);
  });
  it('retains unknown, reconciles the same effect, and re-evaluates the same Attempt without another write', async context => {
    const { f, run, approve, identity } = await process('unknown-reconcile', context); await f.approve(approve);
    f.server.faults.loseResponseAfterWrite = true; f.server.faults.lookupUnavailable = true;
    await expect(f.execute(approve)).rejects.toMatchObject({ code: 'EFFECT_OUTCOME_UNKNOWN' });
    const held = await run.evaluate(identity, 'unknown-hold');
    expect(held.result.evaluation.run.tasks[1]!.phase).toBe('awaiting-decision');
    const deadline = held.receipt.snapshot.progress[1]!.decision!.deadline;
    await expect(run.evaluate(identity, 'unchanged-evidence')).rejects.toMatchObject({ code: 'TASK_EVALUATION_NOT_READY' });
    expect((await f.inspect(approve.commandId)).record?.state).toBe('unknown');
    if (surface === 'runtime') await f.restart();
    f.server.faults.lookupUnavailable = false; await f.execute(approve);
    const accepted = await run.evaluate(identity, 'reconciled-acceptance'); await run.assertSettlement(1, accepted);
    expect(accepted.evaluation.identity).toEqual(identity); expect(f.server.writes).toHaveLength(1);
    expect(held.receipt.snapshot.progress[1]!.decision!.deadline).toBe(deadline);
    expect(held.evaluation.criteria[0].verdict).toBe('unknown');
  });
  it('requires a separate compensation card and fails original acceptance when the new intent settled', async context => {
    const { f, run, approve, identity } = await process('compensation', context); await f.approve(approve); await f.execute(approve);
    const original = (await f.inspect(approve.commandId)).record;
    const undo = f.command('compensate-order', { operation: config.operations.undo, input: { status: config.initialStatus }, compensates: approve.commandId });
    const { pending } = await f.approve(undo, 'compensate'); expect(f.server.writes).toHaveLength(1);
    expect(pending.approval.approvalId).not.toBe(original!.intent.approval!.approvalId);
    await f.compensate(undo); expect((await f.inspect(approve.commandId)).record).toEqual(original);
    const failed = await run.evaluate(identity, 'compensated-not-accepted');
    expect(failed.result.evaluation.run.tasks[1]!.phase).toBe('failed'); expect(failed.evaluation.criteria[0].verdict).toBe('fail');
    expect(f.server.writes).toHaveLength(2); expect(f.server.current().status).toBe(config.initialStatus);
  });
  it('keeps the same canonical process result after runtime restart between accepted read and approval', async context => {
    const { f, run, approve, identity } = await process('restart', context);
    if (surface === 'runtime') await f.restart();
    await f.approve(approve); await f.execute(approve); const accepted = await run.evaluate(identity, 'accept-after-restart');
    if (surface === 'runtime') await f.restart();
    expect((await run.inspect()).tasks).toEqual(accepted.result.evaluation.run.tasks); await run.assertSettlement(1, accepted);
    expect(f.server.writes).toHaveLength(1);
  });
});
