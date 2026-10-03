import { expect, it, vi } from 'vitest';
import { RuntimeServiceLifecycle, RuntimeServiceLifecycleError } from '#engine/core/runtime/index.js';

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(value => { resolve = value; }); return { promise, resolve }; }
function deadline() {
  const waits: { milliseconds: number; signal: AbortSignal; release(): void }[] = [];
  return { waits, value: { wait(milliseconds: number, signal: AbortSignal) { const gate = deferred<void>(); waits.push({ milliseconds, signal, release: () => gate.resolve() }); return gate.promise; } } };
}

it('includes transport finalization in the same grace deadline after work has settled', async () => {
  const timer = deadline(); const transport = deferred<void>(); const entered = deferred<void>();
  const lifecycle = new RuntimeServiceLifecycle({ maxConcurrentRequests: 2, maxConcurrentExecutions: 1 }, () => {}, timer.value);
  const stopping = lifecycle.stop(25, () => { entered.resolve(); return transport.promise; });
  await entered.promise;
  timer.waits[0]!.release();
  await expect(stopping).resolves.toEqual({ state: 'incomplete', remainingRequests: 0, recoveryPending: false });
  let settled = false; void lifecycle.whenSettled().then(() => { settled = true; });
  await Promise.resolve(); expect(settled).toBe(false);
  transport.resolve(); await lifecycle.whenSettled(); expect(settled).toBe(true);
});

it('does not finalize the transport before admitted work settles and finalizes only once', async () => {
  const timer = deadline(); const operation = deferred<void>(); let finalized = 0;
  const lifecycle = new RuntimeServiceLifecycle({ maxConcurrentRequests: 2, maxConcurrentExecutions: 1 }, () => {}, timer.value);
  const running = lifecycle.admit(() => operation.promise);
  const stopping = lifecycle.stop(25, () => { finalized++; });
  expect(lifecycle.stop(25, () => { throw new Error('second finalizer'); })).toBe(stopping);
  await Promise.resolve(); expect(finalized).toBe(0);
  operation.resolve(); await running;
  await expect(stopping).resolves.toMatchObject({ state: 'clean' }); expect(finalized).toBe(1);
});

it('validates capacity and deadline dependencies before accepting work', () => {
  const timer = deadline();
  for (const maxConcurrentRequests of [0, -1, 1.5]) expect(() => new RuntimeServiceLifecycle({ maxConcurrentRequests, maxConcurrentExecutions: 1 }, () => {}, timer.value)).toThrow(RuntimeServiceLifecycleError);
  expect(() => new RuntimeServiceLifecycle({ maxConcurrentRequests: 2, maxConcurrentExecutions: 1 }, () => {}, {} as never)).toThrow(RuntimeServiceLifecycleError);
  const lifecycle = new RuntimeServiceLifecycle({ maxConcurrentRequests: 2, maxConcurrentExecutions: 1 }, () => {}, timer.value);
  expect(() => lifecycle.whenSettled()).toThrow('RUNTIME_SERVICE_NOT_STOPPING');
});

it('rejects excess admission without queueing before the handler runs', async () => {
  const timer = deadline(); const gate = deferred<void>(); let calls = 0;
  const lifecycle = new RuntimeServiceLifecycle({ maxConcurrentRequests: 2, maxConcurrentExecutions: 1 }, () => {}, timer.value);
  const active = lifecycle.admit(async () => { calls++; await gate.promise; }, 'execution');
  lifecycle.admit(() => undefined, 'control');
  expect(() => lifecycle.admit(() => { calls++; })).toThrow('RUNTIME_SERVICE_BUSY'); expect(calls).toBe(0);
  gate.resolve(); await active;
});

it('tracks admitted work independently of a disconnected caller and cancels the clean deadline', async () => {
  const timer = deadline(); const gate = deferred<void>(); let recoveryStops = 0;
  const lifecycle = new RuntimeServiceLifecycle({ maxConcurrentRequests: 2, maxConcurrentExecutions: 1 }, () => { recoveryStops++; }, timer.value);
  void lifecycle.admit(() => gate.promise); // No client awaits this operation.
  const stopping = lifecycle.stop(50); await Promise.resolve(); expect(recoveryStops).toBe(1); expect(timer.waits).toHaveLength(1);
  gate.resolve(); await expect(stopping).resolves.toEqual({ state: 'clean', remainingRequests: 0, recoveryPending: false }); expect(timer.waits[0]!.signal.aborted).toBe(true);
  expect(() => lifecycle.admit(() => undefined)).toThrow('RUNTIME_SERVICE_STOPPING');
});

it('returns incomplete at grace expiry without cancelling durable worker work', async () => {
  const timer = deadline(); const gate = deferred<void>(); let workerCancels = 0; let recoveryStops = 0;
  const lifecycle = new RuntimeServiceLifecycle({ maxConcurrentRequests: 2, maxConcurrentExecutions: 1 }, () => { recoveryStops++; }, timer.value);
  const operation = lifecycle.admit(async () => { await gate.promise; workerCancels++; });
  const stopping = lifecycle.stop(25); await Promise.resolve(); timer.waits[0]!.release();
  await expect(stopping).resolves.toEqual({ state: 'incomplete', remainingRequests: 1, recoveryPending: false }); expect(recoveryStops).toBe(1); expect(workerCancels).toBe(0);
  let settled = false; void lifecycle.whenSettled().then(() => { settled = true; });
  await Promise.resolve(); expect(settled).toBe(false);
  gate.resolve(); await operation; expect(workerCancels).toBe(1);
  await expect(lifecycle.whenSettled()).resolves.toBeUndefined(); expect(settled).toBe(true);
});

it('accounts for throwing work in finally and can drain cleanly without an unhandled tracked rejection', async () => {
  const timer = deadline(); const lifecycle = new RuntimeServiceLifecycle({ maxConcurrentRequests: 2, maxConcurrentExecutions: 1 }, () => {}, timer.value);
  await expect(lifecycle.admit(() => { throw new Error('operation-failed'); })).rejects.toThrow('operation-failed');
  const stopping = lifecycle.stop(10); await expect(stopping).resolves.toEqual({ state: 'clean', remainingRequests: 0, recoveryPending: false }); expect(timer.waits[0]!.signal.aborted).toBe(true);
});

it('waits for an in-flight recovery page after aborting it and marks recovery-only expiry incomplete', async () => {
  const timer = deadline(); const recovery = deferred<void>();
  const lifecycle = new RuntimeServiceLifecycle({ maxConcurrentRequests: 2, maxConcurrentExecutions: 1 }, () => recovery.promise, timer.value);
  const stopping = lifecycle.stop(25); await Promise.resolve(); expect(timer.waits).toHaveLength(1);
  timer.waits[0]!.release(); await expect(stopping).resolves.toEqual({ state: 'incomplete', remainingRequests: 0, recoveryPending: true });
  recovery.resolve();
});

it('returns clean only after the recovery page settles and preserves a typed recovery failure for later stop calls', async () => {
  const timer = deadline(); const recovery = deferred<void>();
  const lifecycle = new RuntimeServiceLifecycle({ maxConcurrentRequests: 2, maxConcurrentExecutions: 1 }, () => recovery.promise, timer.value);
  const stopping = lifecycle.stop(25); await Promise.resolve(); recovery.resolve();
  await expect(stopping).resolves.toEqual({ state: 'clean', remainingRequests: 0, recoveryPending: false }); expect(timer.waits[0]!.signal.aborted).toBe(true);
  const failed = new RuntimeServiceLifecycle({ maxConcurrentRequests: 2, maxConcurrentExecutions: 1 }, () => { throw new Error('recovery-failed'); }, deadline().value);
  const first = failed.stop(25), second = failed.stop(25); expect(second).toBe(first);
  await expect(first).rejects.toMatchObject({ code: 'RUNTIME_SERVICE_RECOVERY_FAILED' });
  await new Promise<void>(resolve => setImmediate(resolve));
  await expect(failed.whenSettled()).rejects.toMatchObject({ code: 'RUNTIME_SERVICE_RECOVERY_FAILED' });
});

it('reserves a bounded execution lane while admitting control until the total cap', async () => {
  const timer = deadline(); const execution = deferred<void>(); const control = deferred<void>();
  const lifecycle = new RuntimeServiceLifecycle({ maxConcurrentRequests: 2, maxConcurrentExecutions: 1 }, () => {}, timer.value);
  const running = lifecycle.admit(() => execution.promise, 'execution');
  expect(() => lifecycle.admit(() => undefined, 'execution')).toThrow('RUNTIME_SERVICE_BUSY');
  const cancellation = lifecycle.admit(() => control.promise, 'control');
  expect(() => lifecycle.admit(() => undefined, 'control')).toThrow('RUNTIME_SERVICE_BUSY');
  execution.resolve(); control.resolve(); await Promise.all([running, cancellation]);
  await expect(lifecycle.admit(() => { throw new Error('released'); }, 'execution')).rejects.toThrow('released');
});

it('executes independent admitted work up to the execution bound and grants waiting slots in order', async () => {
  const gates = Array.from({ length: 5 }, () => deferred<void>()); const started: number[] = [];
  let active = 0; let peak = 0;
  const lifecycle = new RuntimeServiceLifecycle({ maxConcurrentRequests: 3, maxConcurrentExecutions: 2 }, () => {}, deadline().value);
  const operations = gates.map((gate, index) => lifecycle.admitExecution(async () => {
    started.push(index); active++; peak = Math.max(peak, active); await gate.promise; active--;
  }));
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(started).toEqual([0, 1]); expect(peak).toBe(2);
  gates[1]!.resolve(); await operations[1];
  await new Promise<void>(resolve => setImmediate(resolve)); expect(started).toEqual([0, 1, 2]);
  gates[0]!.resolve(); await operations[0];
  await new Promise<void>(resolve => setImmediate(resolve)); expect(started).toEqual([0, 1, 2, 3]);
  gates[2]!.resolve(); await operations[2];
  await new Promise<void>(resolve => setImmediate(resolve)); expect(started).toEqual([0, 1, 2, 3, 4]);
  gates[3]!.resolve(); gates[4]!.resolve(); await Promise.all(operations); expect(peak).toBe(2);
});

it('drains active and slot-waiting executions during shutdown before finalizing', async () => {
  const first = deferred<void>(); const second = deferred<void>(); const entered = deferred<void>(); let finalized = 0;
  const lifecycle = new RuntimeServiceLifecycle({ maxConcurrentRequests: 2, maxConcurrentExecutions: 1 }, () => {}, deadline().value);
  const running = lifecycle.admit(() => first.promise, 'execution');
  const queued = lifecycle.admitExecution(() => { entered.resolve(); return second.promise; });
  const stopping = lifecycle.stop(25, () => { finalized++; });
  await new Promise<void>(resolve => setImmediate(resolve)); expect(finalized).toBe(0);
  first.resolve(); await running; await entered.promise; expect(finalized).toBe(0);
  let settled = false; void lifecycle.whenSettled().then(() => { settled = true; });
  await new Promise<void>(resolve => setImmediate(resolve)); expect(settled).toBe(false);
  expect(() => lifecycle.admit(() => undefined, 'execution')).toThrow('RUNTIME_SERVICE_STOPPING');
  expect(() => lifecycle.admitExecution(() => undefined)).toThrow('RUNTIME_SERVICE_STOPPING');
  second.resolve(); await queued;
  await expect(stopping).resolves.toEqual({ state: 'clean', remainingRequests: 0, recoveryPending: false }); expect(finalized).toBe(1);
});

it('reports all queued executions when grace expires and later settles without discarding them', async () => {
  const timer = deadline(); const first = deferred<void>(); const second = deferred<void>(); let started = 0;
  const lifecycle = new RuntimeServiceLifecycle({ maxConcurrentRequests: 2, maxConcurrentExecutions: 1 }, () => {}, timer.value);
  const operations = [lifecycle.admit(() => { started++; return first.promise; }, 'execution'),
    lifecycle.admitExecution(() => { started++; return second.promise; })];
  const stopping = lifecycle.stop(25); await new Promise<void>(resolve => setImmediate(resolve)); timer.waits[0]!.release();
  await expect(stopping).resolves.toEqual({ state: 'incomplete', remainingRequests: 2, recoveryPending: false }); expect(started).toBe(1);
  first.resolve(); await operations[0]; await new Promise<void>(resolve => setImmediate(resolve)); expect(started).toBe(2);
  second.resolve(); await Promise.all(operations); await lifecycle.whenSettled();
});

it('releases an execution slot after a throwing operation so a queued operation still runs', async () => {
  const gate = deferred<void>(); const started: number[] = [];
  const lifecycle = new RuntimeServiceLifecycle({ maxConcurrentRequests: 2, maxConcurrentExecutions: 1 }, () => {}, deadline().value);
  const failure = lifecycle.admit(async () => { started.push(1); await gate.promise; throw new Error('execution-failed'); }, 'execution');
  const observedFailure = expect(failure).rejects.toThrow('execution-failed');
  const queued = lifecycle.admitExecution(() => { started.push(2); });
  await new Promise<void>(resolve => setImmediate(resolve)); expect(started).toEqual([1]);
  gate.resolve(); await observedFailure; await queued; expect(started).toEqual([1, 2]);
  await expect(lifecycle.stop(25)).resolves.toMatchObject({ state: 'clean' });
});

it('keeps the transport request budget and control access independent of internal execution waiters', async () => {
  const execution = deferred<void>(); const control = deferred<void>();
  const lifecycle = new RuntimeServiceLifecycle({ maxConcurrentRequests: 2, maxConcurrentExecutions: 1 }, () => {}, deadline().value);
  const internal = Array.from({ length: 4 }, () => lifecycle.admitExecution(() => execution.promise));
  expect(() => lifecycle.admit(() => undefined, 'execution')).toThrow('RUNTIME_SERVICE_BUSY');
  const controls = [lifecycle.admit(() => control.promise), lifecycle.admit(() => control.promise)];
  expect(() => lifecycle.admit(() => undefined)).toThrow('RUNTIME_SERVICE_BUSY');
  control.resolve(); execution.resolve(); await Promise.all([...controls, ...internal]);
  await expect(lifecycle.stop(25)).resolves.toMatchObject({ state: 'clean' });
});

it('reports monotonic slot wait only for an execution that actually queued', async () => {
  const gate = deferred<void>(); const immediate = vi.fn(); const waited = vi.fn();
  const clock = vi.spyOn(performance, 'now').mockReturnValue(10);
  try {
    const lifecycle = new RuntimeServiceLifecycle({ maxConcurrentRequests: 2, maxConcurrentExecutions: 1 }, () => {}, deadline().value);
    const running = lifecycle.admitExecution(() => gate.promise, immediate);
    const queued = lifecycle.admitExecution(() => undefined, waited);
    await new Promise<void>(resolve => setImmediate(resolve)); expect(immediate).not.toHaveBeenCalled(); expect(waited).not.toHaveBeenCalled();
    clock.mockReturnValue(35); gate.resolve(); await running; await queued;
    expect(immediate).not.toHaveBeenCalled(); expect(waited).toHaveBeenCalledExactlyOnceWith(25);
  } finally { clock.mockRestore(); }
});

it('releases a granted slot when its wait observer throws and drains the next waiter', async () => {
  const gate = deferred<void>(); let executed = 0;
  const lifecycle = new RuntimeServiceLifecycle({ maxConcurrentRequests: 2, maxConcurrentExecutions: 1 }, () => {}, deadline().value);
  const running = lifecycle.admitExecution(() => gate.promise);
  const failure = lifecycle.admitExecution(() => { executed++; }, () => { throw new Error('wait-observer-failed'); });
  const observedFailure = expect(failure).rejects.toThrow('wait-observer-failed');
  const queued = lifecycle.admitExecution(() => { executed++; });
  gate.resolve(); await running; await observedFailure; await queued; expect(executed).toBe(1);
  await expect(lifecycle.stop(25)).resolves.toMatchObject({ state: 'clean' });
});


it.each([1, 2, 8])('uses every configured execution slot without exceeding cap=%s', async cap => {
  const gates = Array.from({ length: cap + 1 }, () => deferred<void>()), starts: number[] = [];
  let active = 0, peak = 0;
  const lifecycle = new RuntimeServiceLifecycle({ maxConcurrentRequests: cap + 1, maxConcurrentExecutions: cap }, () => {}, deadline().value);
  const operations = gates.map((gate, index) => lifecycle.admitExecution(async () => {
    starts.push(index); active++; peak = Math.max(peak, active); await gate.promise; active--;
  }));
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(starts).toEqual(Array.from({ length: cap }, (_, index) => index)); expect(peak).toBe(cap);
  gates[0]!.resolve(); await operations[0]; await new Promise<void>(resolve => setImmediate(resolve));
  expect(starts).toHaveLength(cap + 1); expect(peak).toBe(cap);
  gates.forEach(gate => gate.resolve()); await Promise.all(operations);
  await expect(lifecycle.stop(25)).resolves.toMatchObject({ state: 'clean' });
});
