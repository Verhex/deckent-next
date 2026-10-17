import { createHash, randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { attemptIdentitySchema, auditEventSchema, type AttemptIdentity, type AuditEvent, type RunSnapshot } from '#domain/index.js';
import { DispatchPreparationGuard, dispatchPreparationRecordSchema, type DispatchPreparationContext, type DispatchPreparationPark } from '#engine/index.js';
import type { JsonRead, JsonRecordFile } from '#platform/index.js';

// Crash-loop breaker decisions without I/O: the record port is in memory, each "process" is its own instance, a crash is a guard that never
// settles, and the park port models the ledger's revision check (a stale expected revision conflicts).
const identity = { scopeId: 's', runId: 'r', taskId: 'a', attemptId: randomUUID(), generation: 1, layoutRevision: 'layout' };
const running = { revision: 7, state: { kind: 'running' } } as unknown as RunSnapshot;
const breakerPark = { kind: 'parked', reason: 'progression-failed', failureCode: 'DISPATCH_PREPARATION_ABORTED', since: 1, deadline: 2 };
const parkedRun = { revision: 8, state: breakerPark } as unknown as RunSnapshot;
const runAt = (revision: number, state: object = { kind: 'running' }) => ({ revision, state }) as unknown as RunSnapshot;
const key = (id: AttemptIdentity) => createHash('sha256').update(JSON.stringify(attemptIdentitySchema.parse(id))).digest('hex');
function harness() {
  const files = new Map<string, string>(), events: AuditEvent[] = [], parks: DispatchPreparationPark[] = [], receipts = new Set<string>();
  const ledger = { run: running };
  const port = (name: string): JsonRecordFile => ({
    async read(): Promise<JsonRead> { const text = files.get(name); return text === undefined ? { kind: 'absent' } : (() => { try { return { kind: 'ready', value: JSON.parse(text), text, digest: '' }; } catch { return { kind: 'corrupt', text, digest: '' }; } })(); },
    async write(value) { files.set(name, JSON.stringify(value)); }, async remove() { files.delete(name); } });
  const faults = { park: null as Error | null, audit: null as Error | null };
  const context = (id: AttemptIdentity = identity): DispatchPreparationContext => ({ identity: id, principal: { issuer: 'host', subject: '1000' }, policyRevision: 'p', bound: 2, now: () => 1000,
    instance: { id: randomUUID(), pid: 1, startedAt: 1 }, record: async event => { if (faults.audit) throw faults.audit; events.push(auditEventSchema.parse(event)); },
    parked: async commandId => receipts.has(commandId), loadRun: async () => ledger.run,
    park: async command => {
      if (faults.park) throw faults.park;
      if (command.expectedRevision !== ledger.run.revision) throw Object.assign(new Error('conflict'), { code: 'RUN_STORE_CONFLICT' });
      parks.push(command); receipts.add(command.commandId); ledger.run = runAt(ledger.run.revision + 1, breakerPark);
    } });
  const record = (id: AttemptIdentity = identity) => { const text = files.get(key(id)); return text === undefined ? null : dispatchPreparationRecordSchema.parse(JSON.parse(text)); };
  const ownPark = (id: AttemptIdentity = identity) => { const park = record(id)?.park; return park?.kind === 'own' ? park.commandId : null; };
  /** One process start that reaches `phase` and dies there (never settles). */
  const crash = async (phase: 'workspace' | 'secret-gate' = 'secret-gate', id: AttemptIdentity = identity) => {
    const guard = new DispatchPreparationGuard(port, context(id)); await guard.begin(ledger.run); await guard.enter(phase);
  };
  return { files, events, parks, receipts, faults, ledger, port, context, record, ownPark, crash };
}

it('counts only another instance\'s unsettled preparation, audits each with its last phase, and parks once at the bound instead of preparing', async () => {
  const h = harness();
  await h.crash('workspace');
  // The same instance starting again (an ordinary retry) is not an abnormal end.
  const same = h.context(), first = new DispatchPreparationGuard(h.port, same); await first.begin(running);
  const again = new DispatchPreparationGuard(h.port, same); await again.begin(running); await again.enter('secret-gate');
  expect(h.events).toHaveLength(1); expect(h.record()).toMatchObject({ starts: 3, aborts: 1, phase: 'secret-gate', park: null, lastAbort: { phase: 'workspace' } });
  // Next instance: second abnormal end reaches the bound; the park command is durable before it is sent; nothing is started.
  const third = new DispatchPreparationGuard(h.port, h.context());
  await expect(third.begin(running)).rejects.toMatchObject({ code: 'DISPATCH_PREPARATION_ABORTED', params: { task: 'a', attempt: identity.attemptId, phase: 'secret-gate', aborts: 2, bound: 2 } });
  expect(h.events.map(event => event.subject)).toEqual([1, 2].map((aborts, index) => ({ kind: 'dispatch-preparation-aborted', runId: 'r', taskId: 'a', attemptId: identity.attemptId,
    phase: index ? 'secret-gate' : 'workspace', aborts, bound: 2 })));
  expect(h.parks).toEqual([{ schemaVersion: 1, scopeId: 's', runId: 'r', commandId: h.ownPark(), expectedRevision: 7, failureCode: 'DISPATCH_PREPARATION_ABORTED' }]);
  expect(h.record()).toMatchObject({ starts: 3, aborts: 2 });
  await third.settle(); expect(h.record()?.park).not.toBeNull();
  // While parked: refused without a new park, count or marker, from any instance.
  await expect(new DispatchPreparationGuard(h.port, h.context()).begin(parkedRun)).rejects.toMatchObject({ code: 'DISPATCH_PREPARATION_ABORTED' });
  expect(h.parks).toHaveLength(1); expect(h.events).toHaveLength(2);
  // After an explicit resume (the Run is no longer in this park): a fresh count; the next crash is abnormal end 1 again.
  const resumed = new DispatchPreparationGuard(h.port, h.context()); await resumed.begin(runAt(9));
  expect(h.record()).toMatchObject({ starts: 4, aborts: 0, park: null, lastAbort: null });
  await resumed.settle(); expect(h.files.size).toBe(0);
});

it('a park that did not commit is retried with the same command and never turns into a dispatch; a failed audit changes nothing', async () => {
  const h = harness();
  await h.crash(); h.faults.audit = new Error('AUDIT_UNAVAILABLE');
  await expect(new DispatchPreparationGuard(h.port, h.context()).begin(running)).rejects.toThrow('AUDIT_UNAVAILABLE');
  expect(h.record()).toMatchObject({ starts: 1, aborts: 0 }); h.faults.audit = null;
  await h.crash();
  h.faults.park = Object.assign(new Error('denied'), { code: 'POLICY_DENIED' });
  await expect(new DispatchPreparationGuard(h.port, h.context()).begin(running)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
  const pending = h.ownPark();
  // Another instance (the refusing one died too): still no count, same command, still no start.
  await expect(new DispatchPreparationGuard(h.port, h.context()).begin(running)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
  expect(h.events).toHaveLength(2); expect(h.record()).toMatchObject({ aborts: 2, starts: 2, park: { kind: 'own', commandId: pending } });
  h.faults.park = null; h.ledger.run = runAt(8);
  await expect(new DispatchPreparationGuard(h.port, h.context()).begin(h.ledger.run)).rejects.toMatchObject({ code: 'DISPATCH_PREPARATION_ABORTED' });
  expect(h.parks).toEqual([expect.objectContaining({ commandId: pending, expectedRevision: 8 })]);
});

it('Attempts of one Run that trip together share one park: the late one joins it, and one resume releases both', async () => {
  const h = harness(), other = { ...identity, taskId: 'b', attemptId: randomUUID() };
  for (let start = 0; start < 2; start++) for (const id of [identity, other]) await h.crash('secret-gate', id);
  // Both read revision 7 in the same start; the first park wins, the second conflicts, finds the breaker park holding the Run and joins it.
  await expect(new DispatchPreparationGuard(h.port, h.context()).begin(running)).rejects.toMatchObject({ code: 'DISPATCH_PREPARATION_ABORTED' });
  await expect(new DispatchPreparationGuard(h.port, h.context(other)).begin(running)).rejects.toMatchObject({ code: 'DISPATCH_PREPARATION_ABORTED', params: { task: 'b', aborts: 2 } });
  expect(h.parks).toHaveLength(1); expect(h.record(other)?.park).toEqual({ kind: 'joined', revision: 8, at: 1000 });
  // A start that already sees the breaker park joins without sending a command; another failure (not this park) is still thrown.
  const third = { ...identity, taskId: 'c', attemptId: randomUUID() };
  for (let start = 0; start < 2; start++) await h.crash('workspace', third);
  await expect(new DispatchPreparationGuard(h.port, h.context(third)).begin(parkedRun)).rejects.toMatchObject({ code: 'DISPATCH_PREPARATION_ABORTED' });
  expect(h.parks).toHaveLength(1); expect(h.record(third)?.park).toMatchObject({ kind: 'joined', revision: 8 });
  // One explicit resume: every attempt prepares again from a fresh count; no second park.
  for (const id of [identity, other, third]) { const guard = new DispatchPreparationGuard(h.port, h.context(id)); await guard.begin(runAt(9)); expect(h.record(id)).toMatchObject({ aborts: 0, park: null }); await guard.settle(); }
  expect(h.parks).toHaveLength(1); expect(h.files.size).toBe(0);
});

it('an unreadable record is one abnormal end of unknown phase; settle without a start keeps crash evidence, a claimed settle clears it', async () => {
  const h = harness();
  const foreign = new DispatchPreparationGuard(h.port, h.context()); await foreign.begin(running);
  h.files.set(key(identity), '{"schemaVersion":1');
  // A guard that never began (e.g. refused earlier in the call) leaves the record as it was.
  await new DispatchPreparationGuard(h.port, h.context()).settle(); expect(h.files.get(key(identity))).toBe('{"schemaVersion":1');
  const next = new DispatchPreparationGuard(h.port, h.context()); await next.begin(running);
  expect(h.events.map(event => event.subject)).toMatchObject([{ phase: null, aborts: 1 }]); expect(h.record()).toMatchObject({ starts: 1, aborts: 1 });
  // A dispatch claim already exists: whatever a death after the claim left is cleared, not counted.
  await new DispatchPreparationGuard(h.port, h.context()).settle(true); expect(h.files.size).toBe(0);
  expect(() => new DispatchPreparationGuard(h.port, { ...h.context(), bound: 0 })).toThrow();
});
