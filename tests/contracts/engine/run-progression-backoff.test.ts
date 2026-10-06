import { afterEach, expect, it, vi } from 'vitest';
import { RunLifecycleRuntimeLoop, type ProgressionCursor } from '#engine/index.js';

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
