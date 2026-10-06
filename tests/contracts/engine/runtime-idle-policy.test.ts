import { describe, expect, it } from 'vitest';
import { RuntimeServiceIdlePolicy, runtimeConfigFreshness, restartConfigDigest } from '#engine/index.js';

/** Fake clock: `wait` advances time and resolves, or never resolves until the signal ends. */
function harness(options: { autoStarted: boolean; afterMs: number | null }) {
  let now = 0; const waits: number[] = [];
  const policy = new RuntimeServiceIdlePolicy({ ...options, now: () => now, wait: (ms, signal) => new Promise<void>(resolve => {
    waits.push(ms); if (signal.aborted) { resolve(); return; }
    const timer = setTimeout(() => { now += ms; resolve(); }, 0); signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true }); }) });
  return { policy, waits, advance: (ms: number) => { now += ms; } };
}
describe('idle stop of an automatically started service (K6 = A)', () => {
  it('stops once the idle period passed with nothing in flight', async () => {
    const h = harness({ autoStarted: true, afterMs: 900_000 });
    expect(await h.policy.run(new AbortController().signal)).toBe('idle'); expect(h.waits).toEqual([900_000]);
  });
  it('never stops a service that was not started automatically, however long it is quiet (live/hand-started)', async () => {
    const h = harness({ autoStarted: false, afterMs: 60_000 });
    expect(h.policy.enabled).toBe(false); expect(await h.policy.run(new AbortController().signal)).toBe('aborted'); expect(h.waits).toEqual([]);
  });
  it('never stops while a request or execution is in flight, and counts the idle period from when it ended', async () => {
    const h = harness({ autoStarted: true, afterMs: 100 }); const release = h.policy.begin();
    const controller = new AbortController(); const outcome = h.policy.run(controller.signal);
    await new Promise(resolve => setTimeout(resolve, 20)); expect(h.waits.length).toBeGreaterThan(1); // re-armed, not stopped, while busy
    release(); release(); // idempotent
    expect(await outcome).toBe('idle'); controller.abort();
  });
  it('a disabled period (null) and an abort both end the loop without stopping', async () => {
    expect(await harness({ autoStarted: true, afterMs: null }).policy.run(new AbortController().signal)).toBe('aborted');
    const h = harness({ autoStarted: true, afterMs: 900_000 }); const controller = new AbortController(); controller.abort();
    expect(await h.policy.run(controller.signal)).toBe('aborted');
  });
});
describe('runtime configuration freshness', () => {
  it('an older service without a digest is unknown, never stale', () => {
    expect(runtimeConfigFreshness(undefined, { language: 'en' })).toBe('unknown');
    expect(runtimeConfigFreshness(restartConfigDigest({ language: 'en' }), { language: 'en' })).toBe('current');
    expect(runtimeConfigFreshness('1'.repeat(64), { language: 'en' })).toBe('stale');
  });
  it('masks resolved secret values: a credential never enters the digest', () => {
    const a = restartConfigDigest({ terminal: { chat: { key: 'one' } }, secretPaths: ['/terminal/chat/key'] });
    expect(restartConfigDigest({ terminal: { chat: { key: 'two' } }, secretPaths: ['/terminal/chat/key'] })).toBe(a);
  });
});
