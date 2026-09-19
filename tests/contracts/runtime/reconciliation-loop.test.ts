import { describe, expect, it } from 'vitest';
import { ReconciliationRuntimeLoop, ReconciliationRuntimeLoopError,
  type ReconciliationRecoveryPage } from '#engine/core/runtime/index.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function page(nextAfter: string | null, unavailable = false): ReconciliationRecoveryPage {
  return { nextAfter, outcomes: unavailable ? [{ identity: { scopeId: 's1', runId: 'r', taskId: 't', attemptId: 'a',
    generation: 1, layoutRevision: 'layout' }, status: 'failed', reason: 'unavailable' }] : [] };
}
const options = { scopeIds: ['s1', 's2'], pollIntervalMs: 5, failureBackoffMs: 10 };

describe('reconciliation runtime loop', () => {
  it('visits one page per scope fairly and carries each independent cursor', async () => {
    const controller = new AbortController(); const calls: string[] = []; let pages = 0;
    const loop = new ReconciliationRuntimeLoop(async command => {
      calls.push(`${command.scopeId}:${command.after ?? 'null'}`);
      return page(command.after === null ? `${command.scopeId}-a` : null);
    }, async () => {}, { now: () => 0 }, {
      onPage() { if (++pages === 4) controller.abort(); }, onError() { throw new Error('unexpected'); },
    }, options);
    await loop.run(controller.signal);
    expect(calls).toEqual(['s1:null', 's2:null', 's1:s1-a', 's2:s2-a']);
  });

  it('resets unavailable cursors and backs off only the affected scope', async () => {
    const controller = new AbortController(); const calls: string[] = []; let now = 0; let first = true;
    const loop = new ReconciliationRuntimeLoop(async command => {
      calls.push(`${command.scopeId}:${command.after ?? 'null'}`);
      if (command.scopeId === 's1' && first) { first = false; return page('s1-a', true); }
      if (command.scopeId === 's1') controller.abort();
      return page(command.scopeId === 's2' ? 's2-a' : null);
    }, async () => { now += 5; }, { now: () => now }, { onPage() {}, onError() {} }, options);
    await loop.run(controller.signal);
    expect(calls).toEqual(['s1:null', 's2:null', 's2:s2-a', 's1:null']);
  });

  it('backs off thrown page failures and reports the exact command', async () => {
    const controller = new AbortController(); const errors: unknown[] = []; let now = 0; let failed = false;
    const loop = new ReconciliationRuntimeLoop(async command => {
      if (command.scopeId === 's1' && !failed) { failed = true; throw new Error('page-failed'); }
      if (command.scopeId === 's1') controller.abort();
      return page(null);
    }, async () => { now += 10; }, { now: () => now }, {
      onPage() {}, onError(command, error) { errors.push({ command, error }); },
    }, options);
    await loop.run(controller.signal);
    expect(errors).toMatchObject([{ command: { schemaVersion: 1, scopeId: 's1', after: null },
      error: { message: 'page-failed' } }]);
  });

  it('rejects a concurrent run without interrupting the active page', async () => {
    const controller = new AbortController(); const active = deferred<ReconciliationRecoveryPage>();
    const loop = new ReconciliationRuntimeLoop(() => active.promise, async () => {}, { now: () => 0 },
      { onPage() { controller.abort(); }, onError() {} }, { ...options, scopeIds: ['s1'] });
    const running = loop.run(controller.signal); await Promise.resolve();
    await expect(loop.run(new AbortController().signal)).rejects.toMatchObject({ code: 'RECONCILIATION_RUNTIME_LOOP_RUNNING' });
    active.resolve(page(null)); await running;
  });

  it('awaits the active page after abort and never starts the next scope', async () => {
    const controller = new AbortController(); const active = deferred<ReconciliationRecoveryPage>(); const calls: string[] = [];
    const loop = new ReconciliationRuntimeLoop(command => { calls.push(command.scopeId); return active.promise; }, async () => {},
      { now: () => 0 }, { onPage() {}, onError() {} }, options);
    let settled = false; const running = loop.run(controller.signal).then(() => { settled = true; });
    await Promise.resolve(); controller.abort(); await Promise.resolve(); expect(settled).toBe(false);
    active.resolve(page(null)); await running;
    expect(calls).toEqual(['s1']);
  });

  it('rejects invalid or duplicate scopes with its own typed error', () => {
    const dependencies = [async () => page(null), async () => {}, { now: () => 0 }, { onPage() {}, onError() {} }] as const;
    expect(() => new ReconciliationRuntimeLoop(...dependencies, { ...options, scopeIds: ['s1', 's1'] }))
      .toThrowError(ReconciliationRuntimeLoopError);
    expect(() => new ReconciliationRuntimeLoop(...dependencies, { ...options, pollIntervalMs: 0 }))
      .toThrowError(ReconciliationRuntimeLoopError);
  });
});
