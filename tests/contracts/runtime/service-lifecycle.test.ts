import { expect, it } from 'vitest';
import { RuntimeServiceLifecycle, RuntimeServiceLifecycleError } from '#engine/core/runtime/index.js';

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(value => { resolve = value; }); return { promise, resolve }; }
function deadline() {
  const waits: { milliseconds: number; signal: AbortSignal; release(): void }[] = [];
  return { waits, value: { wait(milliseconds: number, signal: AbortSignal) { const gate = deferred<void>(); waits.push({ milliseconds, signal, release: () => gate.resolve() }); return gate.promise; } } };
}

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
