import { expect, it } from 'vitest';
import { ModelCancellationRuntimeLoop } from '#engine/core/runtime/index.js';
import type { ModelInvocationCancellationRecoveryCommand } from '#engine/core/model-invocation/index.js';

it('advances past missing controllers fairly across scopes and stops without cancelling work', async () => {
  const controller = new AbortController(), calls: ModelInvocationCancellationRecoveryCommand[] = [];
  let cycles = 0;
  const loop = new ModelCancellationRuntimeLoop(async command => {
    calls.push(command);
    return command.scopeId === 'first' && command.afterInvocationId === null
      ? { nextAfterInvocationId: 'unresolved', outcomes: [{ invocationId: 'unresolved', status: 'not-live' }] }
      : { nextAfterInvocationId: null, outcomes: [] };
  }, async () => { if (++cycles === 2) controller.abort(); }, { now: () => cycles }, {
    onPage() {}, onError() { throw new Error('UNEXPECTED_PAGE_FAILURE'); },
  }, { scopeIds: ['first', 'second'], pollIntervalMs: 1, failureBackoffMs: 5 });
  await loop.run(controller.signal);
  expect(calls).toEqual([
    { schemaVersion: 1, scopeId: 'first', afterInvocationId: null },
    { schemaVersion: 1, scopeId: 'second', afterInvocationId: null },
    { schemaVersion: 1, scopeId: 'first', afterInvocationId: 'unresolved' },
    { schemaVersion: 1, scopeId: 'second', afterInvocationId: null },
  ]);
});

it('backs off a failed scope without starving another scope or inventing a cursor', async () => {
  const controller = new AbortController(), scopes: string[] = [], errors: string[] = [];
  let cycles = 0;
  const loop = new ModelCancellationRuntimeLoop(async command => {
    scopes.push(command.scopeId);
    if (command.scopeId === 'failed') throw new Error('INVENTORY_UNAVAILABLE');
    return { nextAfterInvocationId: null, outcomes: [] };
  }, async () => { if (++cycles === 3) controller.abort(); }, { now: () => cycles }, {
    onPage() {}, onError(command) { errors.push(command.scopeId); },
  }, { scopeIds: ['failed', 'healthy'], pollIntervalMs: 1, failureBackoffMs: 5 });
  await loop.run(controller.signal);
  expect(scopes).toEqual(['failed', 'healthy', 'healthy', 'healthy']);
  expect(errors).toEqual(['failed']);
});
