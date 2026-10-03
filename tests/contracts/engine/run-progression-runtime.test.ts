import { afterEach, expect, it, vi } from 'vitest';
import { RunLifecycleRuntimeLoop, type RunLifecycleRuntimeOperations, type ProgressionCursor } from '#engine/index.js';

const a = { scopeId: 's', runId: 'a' }, b = { scopeId: 's', runId: 'b' }, c = { scopeId: 's', runId: 'c' };
const result = { attempted: 1, stopped: false } as Awaited<ReturnType<RunLifecycleRuntimeOperations['advance']>>;
const empty = { items: [], next: null };
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
afterEach(() => vi.useRealTimers());

it('polls and refills free Run capacity while another turn is still in flight, skipping the same scope/Run across polls and due pages', async () => {
  vi.useFakeTimers(); const controller = new AbortController(), slow = deferred();
  const starts: string[] = [], completed: string[] = [];
  let pages = 0;
  const loop = new RunLifecycleRuntimeLoop({
    async discover() { pages++; return { page: { items: pages === 1 ? [a, b, a] : [a, c], next: null }, due: { items: pages > 1 ? [a] : [], next: null } }; },
    async advance(query) { starts.push(query.runId); if (query.runId === 'a') await slow.promise; return result; },
    expire: vi.fn(async () => { throw new Error('IN_FLIGHT_EXPIRED'); }),
  }, { onRun(query) { completed.push(query.runId); } }, { pollIntervalMs: 10, failureBackoffMs: 100, maxConcurrentRuns: 2 });
  const work = loop.run(controller.signal);
  try {
    await vi.advanceTimersByTimeAsync(20);
    expect(starts).toEqual(['a', 'b', 'c']); expect(completed).toEqual(['b', 'c']); expect(pages).toBe(2);
    controller.abort(); let drained = false; void work.then(() => { drained = true; });
    await vi.advanceTimersByTimeAsync(0); expect(drained).toBe(false);
    slow.resolve(); await work; expect(completed).toEqual(['b', 'c', 'a']); expect(drained).toBe(true);
  } finally { controller.abort(); slow.resolve(); await work; }
});

it.each([false, true])('backs off only when every admitted advance failed (allFailed=%s)', async allFailed => {
  vi.useFakeTimers(); const controller = new AbortController(), errors: (ProgressionCursor | null)[] = [];
  let polls = 0;
  const loop = new RunLifecycleRuntimeLoop({
    async discover() { polls++; return { page: { items: polls === 1 ? [a, b] : [], next: null }, due: empty }; },
    async advance(query) { if (query.runId === 'a' || allFailed) throw new Error('DENIED'); return result; }, async expire() {},
  }, { onError(query) { errors.push(query); } }, { pollIntervalMs: 10, failureBackoffMs: 100, maxConcurrentRuns: 2 });
  const work = loop.run(controller.signal);
  try {
    await vi.advanceTimersByTimeAsync(10); expect(errors).toEqual(allFailed ? [a, b] : [a]);
    await vi.advanceTimersByTimeAsync(10); expect(polls).toBe(allFailed ? 1 : 2);
    if (allFailed) { await vi.advanceTimersByTimeAsync(89); expect(polls).toBe(1); await vi.advanceTimersByTimeAsync(1); expect(polls).toBe(2); }
  } finally { controller.abort(); await work; }
});

it('isolates advance and observer failures from other turns and counts expiry/observer failures outside advance backoff', async () => {
  vi.useFakeTimers(); const controller = new AbortController(), release = deferred(), errors: (ProgressionCursor | null)[] = [];
  let polls = 0; const observed: string[] = [];
  const loop = new RunLifecycleRuntimeLoop({
    async discover() { polls++; return { page: { items: polls === 1 ? [a, b, c] : [c], next: null }, due: { items: [c], next: null } }; },
    async expire() { throw new Error('EXPIRY_DENIED'); },
    async advance(query) { if (query.runId === 'a') throw new Error('ADVANCE_DENIED'); if (query.runId === 'b') await release.promise; return result; },
  }, { onError(query) { errors.push(query); throw new Error('OBSERVER_DENIED'); },
    onRun(query) { observed.push(query.runId); if (query.runId === 'c') throw new Error('PUBLISH_LOST'); } },
  { pollIntervalMs: 10, failureBackoffMs: 100, maxConcurrentRuns: 2 });
  const work = loop.run(controller.signal);
  try {
    await vi.advanceTimersByTimeAsync(20); expect(polls).toBe(2); expect(observed).toEqual(['c']);
    expect(errors).toContainEqual(a); expect(errors.filter(q => q?.runId === 'c')).toHaveLength(3);
    release.resolve(); await vi.advanceTimersByTimeAsync(0); expect(observed).toEqual(['c', 'b']);
  } finally { controller.abort(); release.resolve(); await work; }
});

it('backs off discovery errors with null identity and resets both discovery cursors', async () => {
  vi.useFakeTimers(); const controller = new AbortController(); let polls = 0;
  const discover = vi.fn(async () => { if (++polls === 1) return { page: { items: [], next: a }, due: { items: [], next: b } }; if (polls === 2) throw new Error('DISCOVERY_LOST'); return { page: empty, due: empty }; });
  const onError = vi.fn();
  const loop = new RunLifecycleRuntimeLoop({ discover, async advance() { return result; }, async expire() {} }, { onError },
    { pollIntervalMs: 10, failureBackoffMs: 100, maxConcurrentRuns: 2 });
  const work = loop.run(controller.signal);
  try {
    await vi.advanceTimersByTimeAsync(20); expect(onError).toHaveBeenCalledWith(null, expect.any(Error));
    await vi.advanceTimersByTimeAsync(99); expect(polls).toBe(2);
    await vi.advanceTimersByTimeAsync(1); expect(polls).toBe(3); expect(discover).toHaveBeenLastCalledWith(null, null, expect.any(Number));
  } finally { controller.abort(); await work; }
});

it('drains both concurrently admitted Run turns on shutdown, publishes once each and refuses a second driver', async () => {
  vi.useFakeTimers(); const controller = new AbortController(), first = deferred(), second = deferred(), onRun = vi.fn();
  const loop = new RunLifecycleRuntimeLoop({ async discover() { return { page: { items: [a, b], next: null }, due: empty }; },
    async advance(query) { await (query.runId === 'a' ? first : second).promise; return result; }, async expire() {} },
  { onRun }, { pollIntervalMs: 10, failureBackoffMs: 100, maxConcurrentRuns: 2 });
  const work = loop.run(controller.signal); let settled = false; void work.then(() => { settled = true; });
  try {
    await vi.advanceTimersByTimeAsync(10); await expect(loop.run(controller.signal)).rejects.toThrow('RUN_RUNTIME_ALREADY_RUNNING');
    controller.abort(); first.resolve(); await vi.advanceTimersByTimeAsync(0); expect(settled).toBe(false); expect(onRun).toHaveBeenCalledTimes(1);
    second.resolve(); await work; expect(onRun).toHaveBeenCalledTimes(2); expect(settled).toBe(true);
  } finally { controller.abort(); first.resolve(); second.resolve(); await work; }
});

it('keys custody by scope as well as Run id and preserves a single-Run observer result byte for byte', async () => {
  vi.useFakeTimers(); const controller = new AbortController(), onRun = vi.fn();
  const scoped = { ...a, scopeId: 'other' }, advance = vi.fn(async () => result);
  const loop = new RunLifecycleRuntimeLoop({ async discover() { return { page: { items: [a, scoped, a], next: null }, due: empty }; }, advance, async expire() {} },
    { onRun(query, value) { onRun(query, value); if (onRun.mock.calls.length === 2) controller.abort(); } },
    { pollIntervalMs: 10, failureBackoffMs: 100, maxConcurrentRuns: 2 });
  const work = loop.run(controller.signal);
  await vi.advanceTimersByTimeAsync(10); await work;
  expect(advance).toHaveBeenCalledTimes(2); expect(onRun).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(onRun.mock.calls[0]![1])).toBe(JSON.stringify(result));
});

// Fable 5.1 R1 negative proof: a bound already full at poll start must not consume the page (fairness, not starvation).
const ovA = { scopeId: 's', runId: 'a' }, ovB = { scopeId: 's', runId: 'b' }, ovC = { scopeId: 's', runId: 'c' };
const ovAll = [ovA, ovB, ovC];
const ovResult = { attempted: 1, stopped: false } as Awaited<ReturnType<RunLifecycleRuntimeOperations['advance']>>;
function ovDeferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
it('a Run left out because the bound was already full at poll start is picked up by the next poll (not after a wrap)', async () => {
  vi.useFakeTimers(); const controller = new AbortController(), slow = ovDeferred();
  const starts: string[] = [], discoverAfter: (string | null)[] = [];
  const loop = new RunLifecycleRuntimeLoop({
    async discover(after) {
      discoverAfter.push(after?.runId ?? null);
      const index = after ? ovAll.findIndex(x => x.runId === after.runId) + 1 : 0;
      const items = ovAll.slice(index, index + 1);
      return { page: { items, next: index + 1 < ovAll.length ? items[0]! : null }, due: { items: [], next: null } };
    },
    async advance(query) { starts.push(query.runId); if (query.runId === 'a') await slow.promise; return ovResult; },
    async expire() {},
  }, {}, { pollIntervalMs: 10, failureBackoffMs: 100, maxConcurrentRuns: 1 });
  const work = loop.run(controller.signal);
  try {
    await vi.advanceTimersByTimeAsync(10); // poll 1: a starts and holds the only slot
    expect(starts).toEqual(['a']);
    await vi.advanceTimersByTimeAsync(10); // poll 2: page [b] discovered while saturated
    expect(starts).toEqual(['a']);
    slow.resolve(); await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(10); // poll 3: slot free — the Run left out (b) should be next
    expect(discoverAfter).toEqual([null, 'a', 'a']);
    expect(starts[1]).toBe('b');
  } finally { controller.abort(); slow.resolve(); await work; }
});

// Fable 5.1 R1 follow-up: a partially processed page advances past the last visited Run (positive proof of the visited path).
const vp_all = [{ scopeId: 's', runId: 'a' }, { scopeId: 's', runId: 'b' }, { scopeId: 's', runId: 'c' }];
const vp_res = { attempted: 1, stopped: false } as Awaited<ReturnType<RunLifecycleRuntimeOperations['advance']>>;
function vp_deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
it('visited path: a page broken mid-way by the bound resumes after the last visited Run (not from the page start)', async () => {
  vi.useFakeTimers(); const controller = new AbortController(), slow = vp_deferred();
  const starts: string[] = [], discoverAfter: (string | null)[] = [];
  const loop = new RunLifecycleRuntimeLoop({
    async discover(after) {
      discoverAfter.push(after?.runId ?? null);
      const index = after ? vp_all.findIndex(x => x.runId === after.runId) + 1 : 0;
      const items = vp_all.slice(index, index + 3);
      return { page: { items, next: null }, due: { items: [], next: null } };
    },
    async advance(query) { starts.push(query.runId); if (query.runId !== 'c') await slow.promise; return vp_res; },
    async expire() {},
  }, {}, { pollIntervalMs: 10, failureBackoffMs: 100, maxConcurrentRuns: 2 });
  const work = loop.run(controller.signal);
  try {
    await vi.advanceTimersByTimeAsync(10); // poll 1: page [a,b,c], a and b start, bound hit at c -> cursor = b
    expect(starts).toEqual(['a', 'b']);
    await vi.advanceTimersByTimeAsync(10); // poll 2: still saturated -> discover(after=b) returns [c], bound full at start -> cursor stays b
    expect(discoverAfter).toEqual([null, 'b']);
    slow.resolve(); await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(10); // poll 3: discover(after=b) -> [c] starts
    expect(discoverAfter).toEqual([null, 'b', 'b']);
    expect(starts).toEqual(['a', 'b', 'c']);
  } finally { controller.abort(); slow.resolve(); await work; }
});
