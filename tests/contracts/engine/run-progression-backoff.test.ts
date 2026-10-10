import { afterEach, expect, it, vi } from 'vitest';
import { RunProgressionFailure, RunLifecycleRuntimeLoop, type ProgressionCursor } from '#engine/index.js';

afterEach(() => { vi.useRealTimers(); });
const run = (runId: string): ProgressionCursor => ({ scopeId: 's', runId });
const none = { items: [], next: null } as const;

it('backs off a failing Run on its own: the other Runs keep advancing every poll and the failed one is retried only after the backoff', async () => {
  vi.useFakeTimers(); const controller = new AbortController(), calls: string[] = [], errors: string[] = [];
  const loop = new RunLifecycleRuntimeLoop({
    async discover() { return { page: { items: [run('bad'), run('good-1'), run('good-2')], next: null }, due: none }; },
    async expire() {},
    async advance(query) { calls.push(query.runId); if (query.runId === 'bad') throw new Error('boom'); return {} as never; },
  }, { onError(query) { errors.push(query?.runId ?? '-'); } }, { pollIntervalMs: 10, failureBackoffMs: 100, maxConcurrentRuns: 3 }, Date.now);
  const work = loop.run(controller.signal);
  try {
    await vi.advanceTimersByTimeAsync(10);
    expect(calls).toEqual(['bad', 'good-1', 'good-2']);
    await vi.advanceTimersByTimeAsync(50); // five more polls inside the backoff window
    expect(calls.filter(id => id === 'bad')).toHaveLength(1);
    expect(calls.filter(id => id === 'good-1').length).toBeGreaterThanOrEqual(5);
    expect(calls.filter(id => id === 'good-2').length).toBeGreaterThanOrEqual(5);
    await vi.advanceTimersByTimeAsync(60); // past the 100 ms backoff
    expect(calls.filter(id => id === 'bad')).toHaveLength(2);
    expect(errors).toEqual(['bad', 'bad']);
  } finally { controller.abort(); await vi.advanceTimersByTimeAsync(20); await work; }
});

it('a failed discovery still pauses the whole loop for the failure backoff, then recovers', async () => {
  vi.useFakeTimers(); const controller = new AbortController(); let discoveries = 0, advanced = 0;
  const loop = new RunLifecycleRuntimeLoop({
    async discover() { discoveries++; if (discoveries === 1) throw new Error('ledger'); return { page: { items: [run('r')], next: null }, due: none }; },
    async expire() {}, async advance() { advanced++; return {} as never; },
  }, {}, { pollIntervalMs: 10, failureBackoffMs: 100, maxConcurrentRuns: 1 });
  const work = loop.run(controller.signal);
  try {
    await vi.advanceTimersByTimeAsync(10); expect(discoveries).toBe(1);
    await vi.advanceTimersByTimeAsync(80); expect(discoveries).toBe(1); expect(advanced).toBe(0);
    await vi.advanceTimersByTimeAsync(40); expect(advanced).toBeGreaterThanOrEqual(1);
  } finally { controller.abort(); await vi.advanceTimersByTimeAsync(20); await work; }
});

it('notes each skipped scope once however many polls report it, and a failing note observer stops nothing', async () => {
  vi.useFakeTimers(); const controller = new AbortController(), notes: string[] = []; let advanced = 0;
  const loop = new RunLifecycleRuntimeLoop({
    async discover() { return { page: { items: [run('r')], next: null }, due: none, skipped: [{ scopeId: 'other', reason: 'foreign' as const }, { scopeId: 'new', reason: 'unregistered' as const }] }; },
    async expire() {}, async advance() { advanced++; return {} as never; },
  }, { onScopeSkipped(scope) { notes.push(`${scope.scopeId}:${scope.reason}`); throw new Error('observer'); } }, { pollIntervalMs: 10, failureBackoffMs: 100, maxConcurrentRuns: 1 });
  const work = loop.run(controller.signal);
  try {
    await vi.advanceTimersByTimeAsync(55);
    expect(notes).toEqual(['other:foreign', 'new:unregistered']); expect(advanced).toBeGreaterThanOrEqual(4);
  } finally { controller.abort(); await vi.advanceTimersByTimeAsync(20); await work; }
});


it('bounds failing turns, parks once, leaves other Runs advancing and does not restart a parked Run', async () => {
  vi.useFakeTimers(); const controller = new AbortController(), calls: string[] = [], reports: string[] = [];
  let parked = false;
  const park = vi.fn(async (query: ProgressionCursor, error: unknown) => { expect(query).toEqual(run('bad')); expect(error).toBeInstanceOf(RunProgressionFailure); parked = true; return 'parked' as const; });
  const loop = new RunLifecycleRuntimeLoop({
    async discover() { return { page: { items: [run('good'), ...parked ? [] : [run('bad')]], next: null }, due: none }; },
    async expire() {}, park,
    async advance(query) { calls.push(query.runId); if (query.runId === 'bad') throw new RunProgressionFailure(new Error('SUPERVISOR_CONTROL_FAILED'), 5); return {} as never; },
  }, { onError(_query, error) { reports.push(error instanceof Error ? error.message : String(error)); } },
  { pollIntervalMs: 10, failureBackoffMs: 30, maxConcurrentRuns: 2, maxConsecutiveFailures: 2 });
  const work = loop.run(controller.signal);
  try {
    await vi.advanceTimersByTimeAsync(500);
    expect(calls.filter(value => value === 'bad')).toHaveLength(2); expect(park).toHaveBeenCalledTimes(1);
    expect(calls.filter(value => value === 'good').length).toBeGreaterThan(20);
    expect(reports).toHaveLength(3); expect(park.mock.calls[0]![0]).toEqual(run('bad'));
  } finally { controller.abort(); await work; }
});

it('stops dispatch attempts when durable parking is refused, reports attention once and isolates the healthy Run', async () => {
  vi.useFakeTimers(); const controller = new AbortController(), calls: string[] = [], codes: string[] = [];
  const park = vi.fn(async () => { throw Object.assign(new Error('POLICY_DENIED'), { code: 'POLICY_DENIED' }); });
  const loop = new RunLifecycleRuntimeLoop({
    async discover() { return { page: { items: [run('bad'), run('good')], next: null }, due: none }; }, async expire() {}, park,
    async advance(query) { calls.push(query.runId); if (query.runId === 'bad') throw new RunProgressionFailure(new Error('broken'), 5); return {} as never; },
  }, { onError(_query, error) { if (error && typeof error === 'object' && 'code' in error) codes.push(String(error.code)); } },
  { pollIntervalMs: 10, failureBackoffMs: 30, maxConcurrentRuns: 2, maxConsecutiveFailures: 2 });
  const work = loop.run(controller.signal);
  try {
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls.filter(value => value === 'bad')).toHaveLength(2); expect(park).toHaveBeenCalledTimes(1);
    expect(codes).toEqual(['POLICY_DENIED', 'RUN_PROGRESSION_PARK_UNAVAILABLE']);
    expect(calls.filter(value => value === 'good').length).toBeGreaterThan(50);
  } finally { controller.abort(); await work; }
});

it('a changed failed revision resets the budget; a park CAS race permits a fresh turn instead of writing over a human decision', async () => {
  vi.useFakeTimers(); const controller = new AbortController(); let calls = 0;
  const park = vi.fn(async () => 'changed' as const);
  const loop = new RunLifecycleRuntimeLoop({ async discover() { return { page: { items: [run('bad')], next: null }, due: none }; }, async expire() {}, park,
    async advance() { calls++; if (calls <= 3) throw new RunProgressionFailure(new Error('same failure'), calls === 1 ? 1 : 2); return {} as never; },
  }, {}, { pollIntervalMs: 10, failureBackoffMs: 30, maxConsecutiveFailures: 2 });
  const work = loop.run(controller.signal);
  try {
    await vi.advanceTimersByTimeAsync(70); expect(calls).toBe(3); expect(park).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30); expect(calls).toBe(4);
  } finally { controller.abort(); await work; }
});


it('shutdown drains and reports a failing turn without creating a new durable park', async () => {
  vi.useFakeTimers(); const controller = new AbortController(), park = vi.fn(), onError = vi.fn();
  const loop = new RunLifecycleRuntimeLoop({ async discover() { return { page: { items: [run('bad')], next: null }, due: none }; }, async expire() {}, park,
    async advance() { controller.abort(); throw new RunProgressionFailure(new Error('interrupted'), 5); },
  }, { onError }, { pollIntervalMs: 10, failureBackoffMs: 30, maxConsecutiveFailures: 1 });
  const work = loop.run(controller.signal); await vi.advanceTimersByTimeAsync(10); await work;
  expect(park).not.toHaveBeenCalled(); expect(onError).toHaveBeenCalledTimes(1);
});
