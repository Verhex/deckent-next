import { setTimeout as wait } from 'node:timers/promises';
import { expect, it } from 'vitest';
import {
  PolicyAuthorizationError, ReconciliationRecoveryApplication, ReconciliationRecoveryError,
  type AttemptIdentity, type DispatchInventoryEntry, type DispatchInventoryPage, type DispatchTerminal,
  type ReconciliationRecoveryExecutor,
} from '#engine/index.js';

const terminal: DispatchTerminal = { handle: 'h', exitCode: 0, interrupted: null };
function identity(attemptId: string, scopeId = 's'): AttemptIdentity {
  return { scopeId, runId: 'r', taskId: `task-${attemptId}`, attemptId, generation: 1, layoutRevision: 'layout' };
}
function entry(attemptId: string, changes: Partial<DispatchInventoryEntry> = {}): DispatchInventoryEntry {
  return { identity: identity(attemptId), owner: 'owner', launch: 'granted', terminal: null,
    cancellationRequested: false, outputRecorded: false, ...changes };
}
function executor(overrides: Partial<ReconciliationRecoveryExecutor> = {}): ReconciliationRecoveryExecutor {
  return {
    async reconcile() { return { status: 'unresolved', outputRecorded: false }; },
    async recoverOutput() { return { completeness: 'unavailable' }; },
    ...overrides,
  };
}
function app(page: DispatchInventoryPage, options: { maxPageSize?: number; maxConcurrentReconciliations?: number } = {}, impl = executor()) {
  return new ReconciliationRecoveryApplication({ async inspect() { return page; } }, impl, {
    maxPageSize: options.maxPageSize ?? 8, maxConcurrentReconciliations: options.maxConcurrentReconciliations ?? 2,
  });
}
const command = { schemaVersion: 1 as const, scopeId: 's', after: null };

it('passes the trusted page limit, skips pending/prevented entries, and preserves unresolved state without output collection', async () => {
  const calls: string[] = []; let observedLimit = 0;
  const inventory: DispatchInventoryPage = { entries: [
    entry('pending', { launch: 'pending' }), entry('prevented', { launch: 'prevented-before-launch' }), entry('unresolved'),
  ], nextAfter: null };
  const recovery = new ReconciliationRecoveryApplication({ async inspect(input) { observedLimit = input.limit; return inventory; } }, executor({
    async reconcile(value) { calls.push(`reconcile:${value.attemptId}`); return { status: 'unresolved', outputRecorded: false }; },
    async recoverOutput(value) { calls.push(`output:${value.attemptId}`); return { completeness: 'complete' }; },
  }), { maxPageSize: 3, maxConcurrentReconciliations: 2 });
  const page = await recovery.recover(command);
  expect(page.outcomes.map(outcome => outcome.status)).toEqual(['skipped', 'skipped', 'unresolved']);
  expect(calls).toEqual(['reconcile:unresolved']); expect(observedLimit).toBe(3);
});

it('reconciles a terminal-missing identity immediately and preserves partial output completeness', async () => {
  const calls: string[] = []; const identityValue = identity('recover');
  const recovery = app({ entries: [entry('recorded', { terminal }), entry('recover')], nextAfter: null }, {}, executor({
    async reconcile(value) { calls.push(`reconcile:${value.attemptId}`); return { status: 'terminal', outputRecorded: false }; },
    async recoverOutput(value) { calls.push(`output:${value.attemptId}`); return { completeness: 'partial' }; },
  }));
  const page = await recovery.recover(command);
  expect(page.outcomes).toEqual([
    { identity: identity('recorded'), status: 'output-recovered', completeness: 'partial' },
    { identity: identityValue, status: 'output-recovered', completeness: 'partial' },
  ]);
  expect(calls).toEqual(['output:recorded', 'reconcile:recover', 'output:recover']);
});

it('continues after denied or unavailable identities and reports bounded reasons', async () => {
  const calls: string[] = [];
  const recovery = app({ entries: [entry('denied'), entry('ok'), entry('unavailable')], nextAfter: null }, {}, executor({
    async reconcile(value) {
      calls.push(value.attemptId);
      if (value.attemptId === 'denied') throw new PolicyAuthorizationError('POLICY_DENIED');
      if (value.attemptId === 'unavailable') throw new Error('private path');
      return { status: 'unresolved', outputRecorded: false };
    },
  }));
  const page = await recovery.recover(command);
  expect(page.outcomes).toMatchObject([
    { status: 'failed', reason: 'denied' }, { status: 'unresolved' }, { status: 'failed', reason: 'unavailable' },
  ]);
  expect(JSON.stringify(page)).not.toContain('private path'); expect(calls).toEqual(['denied', 'ok', 'unavailable']);
});

it('rejects foreign scope, duplicate identities, oversize pages, nonprogress cursors, and missing terminal fields before effects', async () => {
  let effects = 0;
  const run = (page: DispatchInventoryPage, limit = 2) => app(page, { maxPageSize: limit }, executor({
    async reconcile() { effects++; return { status: 'unresolved', outputRecorded: false }; },
    async recoverOutput() { effects++; return { completeness: 'complete' }; },
  }));
  await expect(run({ entries: [entry('foreign', { identity: identity('foreign', 'other') })], nextAfter: null }).recover(command)).rejects.toBeInstanceOf(ReconciliationRecoveryError);
  await expect(run({ entries: [entry('same'), entry('same')], nextAfter: null }).recover(command)).rejects.toBeInstanceOf(ReconciliationRecoveryError);
  await expect(run({ entries: [entry('a'), entry('b'), entry('c')], nextAfter: null }).recover(command)).rejects.toBeInstanceOf(ReconciliationRecoveryError);
  await expect(run({ entries: [entry('a')], nextAfter: 'other' }).recover(command)).rejects.toBeInstanceOf(ReconciliationRecoveryError);
  const missingTerminal = { ...entry('missing'), terminal: undefined } as never;
  await expect(run({ entries: [missingTerminal], nextAfter: null }).recover(command)).rejects.toBeInstanceOf(ReconciliationRecoveryError);
  expect(effects).toBe(0);
});

it('keeps inventory order while completions run under the trusted concurrency cap', async () => {
  let active = 0; let peak = 0;
  const recovery = app({ entries: [entry('a'), entry('b'), entry('c'), entry('d')], nextAfter: null }, { maxConcurrentReconciliations: 2 }, executor({
    async reconcile(value) {
      active++; peak = Math.max(peak, active); await wait(value.attemptId === 'a' ? 20 : 1); active--;
      return { status: 'unresolved', outputRecorded: false };
    },
  }));
  const page = await recovery.recover(command);
  expect(peak).toBe(2); expect(page.outcomes.map(outcome => outcome.identity.attemptId)).toEqual(['a', 'b', 'c', 'd']);
});

it('does not invoke effects when inventory authorization is denied', async () => {
  let effects = 0;
  const recovery = new ReconciliationRecoveryApplication({ async inspect() { throw new PolicyAuthorizationError('POLICY_DENIED'); } }, executor({
    async reconcile() { effects++; return { status: 'unresolved', outputRecorded: false }; },
    async recoverOutput() { effects++; return { completeness: 'complete' }; },
  }), { maxPageSize: 2, maxConcurrentReconciliations: 1 });
  await expect(recovery.recover(command)).rejects.toMatchObject({ code: 'POLICY_DENIED' }); expect(effects).toBe(0);
});
