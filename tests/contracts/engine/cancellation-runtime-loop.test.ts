import { expect, it } from 'vitest';
import { CancellationRuntimeLoop, CancellationRuntimeLoopError } from '#engine/core/runtime/index.js';

type Command = { readonly schemaVersion: 1; readonly scopeId: string; readonly afterAttemptId: string | null };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(value => { resolve = value; }); return { promise, resolve }; }
const clock = { now: () => 0 };
const abortWait = async (_milliseconds: number, signal: AbortSignal) => new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
const options = { scopeIds: ['s'], pollIntervalMs: 1, failureBackoffMs: 10 };

it('validates trusted unique scopes and safe polling and failure-backoff options', () => {
  const dependencies = [async () => ({ nextAfterAttemptId: null }), abortWait, clock, { async onPage() {}, async onError() {} }] as const;
  for (const value of [{ scopeIds: [], pollIntervalMs: 1, failureBackoffMs: 1 }, { scopeIds: ['s', 's'], pollIntervalMs: 1, failureBackoffMs: 1 },
    { scopeIds: ['s'], pollIntervalMs: 0, failureBackoffMs: 1 }, { scopeIds: ['s'], pollIntervalMs: 1, failureBackoffMs: 0 }]) {
    expect(() => new CancellationRuntimeLoop(...dependencies, value)).toThrow(CancellationRuntimeLoopError);
  }
});

it('drains one page per scope fairly and carries each cursor into the next cycle', async () => {
  const controller = new AbortController(); const commands: Command[] = []; let waits = 0;
  const loop = new CancellationRuntimeLoop(async command => {
    commands.push(command); if (commands.length === 4) controller.abort();
    return { nextAfterAttemptId: command.afterAttemptId === null ? command.scopeId + '-cursor' : null };
  }, async (_ms, signal) => { if (++waits === 1) return; await abortWait(0, signal); }, clock, { async onPage() {}, async onError() {} },
  { scopeIds: ['a', 'b'], pollIntervalMs: 9, failureBackoffMs: 10 });
  await loop.run(controller.signal);
  expect(commands).toEqual([
    { schemaVersion: 1, scopeId: 'a', afterAttemptId: null }, { schemaVersion: 1, scopeId: 'b', afterAttemptId: null },
    { schemaVersion: 1, scopeId: 'a', afterAttemptId: 'a-cursor' }, { schemaVersion: 1, scopeId: 'b', afterAttemptId: 'b-cursor' },
  ]);
});

it('never overlaps drain calls or concurrent run invocations', async () => {
  const controller = new AbortController(); const gate = deferred<{ nextAfterAttemptId: null }>(); let active = 0; let maximum = 0;
  const loop = new CancellationRuntimeLoop(async () => { active++; maximum = Math.max(maximum, active); const result = await gate.promise; active--; return result; }, abortWait,
    clock, { async onPage() {}, async onError() {} }, options);
  const running = loop.run(controller.signal); await Promise.resolve();
  await expect(loop.run(controller.signal)).rejects.toMatchObject({ code: 'CANCELLATION_RUNTIME_LOOP_RUNNING' });
  controller.abort(); gate.resolve({ nextAfterAttemptId: null }); await running;
  expect(maximum).toBe(1);
});

it('awaits an in-flight page after abort and starts no further pages', async () => {
  const controller = new AbortController(); const gate = deferred<{ nextAfterAttemptId: null }>(); let calls = 0;
  const loop = new CancellationRuntimeLoop(async () => { calls++; return gate.promise; }, abortWait,
    clock, { async onPage() {}, async onError() {} }, options);
  const running = loop.run(controller.signal); await Promise.resolve(); controller.abort(); let done = false; void running.then(() => { done = true; });
  await Promise.resolve(); expect(done).toBe(false); gate.resolve({ nextAfterAttemptId: null }); await running;
  expect(calls).toBe(1);
});

it('reports an error, resets that scope cursor, and retries it only after its backoff', async () => {
  const controller = new AbortController(); const commands: Command[] = []; const errors: string[] = []; let now = 0; let waits = 0;
  const loop = new CancellationRuntimeLoop(async command => { commands.push(command); if (commands.length === 1) throw new Error('outage'); controller.abort(); return { nextAfterAttemptId: 'later' }; },
    async (_ms, signal) => { now += ++waits === 1 ? 9 : 1; await (waits <= 2 ? Promise.resolve() : abortWait(0, signal)); }, { now: () => now },
    { async onPage() {}, async onError(_command, error) { errors.push((error as Error).message); } }, options);
  await loop.run(controller.signal);
  expect(errors).toEqual(['outage']); expect(commands).toEqual([
    { schemaVersion: 1, scopeId: 's', afterAttemptId: null }, { schemaVersion: 1, scopeId: 's', afterAttemptId: null },
  ]);
});

it('advances past persistent unavailable records while preserving failure visibility and scope fairness', async () => {
  const controller = new AbortController(); const commands: Command[] = []; const statuses: string[] = []; let now = 0;
  const loop = new CancellationRuntimeLoop(async command => {
    commands.push(command);
    if (command.scopeId === 'a' && command.afterAttemptId === null) {
      return { nextAfterAttemptId: 'a1', outcomes: [{ outcome: { status: 'unavailable' } }] };
    }
    return { nextAfterAttemptId: null, outcomes: [{ outcome: { status: 'terminal' } }] };
  }, async () => { now += 5; }, { now: () => now }, {
    async onPage(_command, result) {
      statuses.push(result.outcomes![0]!.outcome.status);
      if (commands.length === 6) controller.abort();
    }, async onError() { throw new Error('unexpected page failure'); },
  }, { scopeIds: ['a', 'b'], pollIntervalMs: 5, failureBackoffMs: 10 });
  await loop.run(controller.signal);
  expect(commands.map(value => [value.scopeId, value.afterAttemptId])).toEqual([
    ['a', null], ['b', null], ['a', 'a1'], ['b', null], ['a', null], ['b', null],
  ]);
  expect(statuses).toEqual(['unavailable', 'terminal', 'terminal', 'terminal', 'unavailable', 'terminal']);
});

it('surfaces observer failure and stops instead of swallowing it', async () => {
  const loop = new CancellationRuntimeLoop(async () => ({ nextAfterAttemptId: null }), abortWait,
    clock, { async onPage() { throw new Error('observer-failed'); }, async onError() {} }, options);
  await expect(loop.run(new AbortController().signal)).rejects.toThrow('observer-failed');
});
