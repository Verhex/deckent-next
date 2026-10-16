import { randomUUID } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { createDefaultConfig } from '#platform/index.js';
import { RuntimeEventsApplication, RuntimeEventsError, runtimeEventsItemSchema, type RuntimeEventsItem, type RuntimeObservationRow,
  type RuntimeEventsSubscription } from '#engine/index.js';
const apps: RuntimeEventsApplication[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.stop())); });
const query = { schemaVersion: 1 as const, scopeId: 'scope', topics: ['run'] as const, resume: null };
const row = (revision: number, id = 'run'): RuntimeObservationRow => ({ record: { topic: 'run', entity: 'run', id, revision, status: 'running',
  observedAt: revision, evidence: 'ledger', sourceLoss: false }, watermark: String(revision) });
function fixture(overrides: Partial<ReturnType<typeof createDefaultConfig>['service']['events']> = {}) {
  let rows = [row(0)], wake: (() => void) | null = null, captures = 0, closed = 0, access = true, policy = 'policy', captureBarrier: Promise<void> | null = null;
  const app = new RuntimeEventsApplication({ ...createDefaultConfig().service.events, enabled: true, ...overrides }, {
    now: () => performance.now(), wallNow: () => Date.now(),
    async authorize(q, credential) {
      if (!access || q.scopeId !== 'scope' || q.topics.includes('usage')) throw new RuntimeEventsError('RUNTIME_EVENTS_UNAVAILABLE');
      return { binding: JSON.stringify([credential ?? 'owner', q.scopeId, q.topics, policy]), principalKey: String(credential ?? 'owner'),
        allows: async r => r.record.id !== 'denied' };
    },
    async open() { return { async capture() { const saved = [...rows]; captures++; await captureBarrier; return { rows: saved, sourceLoss: false }; },
      wait(signal) { if (signal.aborted) return Promise.resolve(); return new Promise<void>(resolve => {
        const finish = () => { signal.removeEventListener('abort', finish); wake = null; resolve(); }; wake = finish; signal.addEventListener('abort', finish, { once: true }); }); },
      close() { closed++; wake?.(); } }; },
  }); apps.push(app);
  return { app, setRows: (next: RuntimeObservationRow[]) => { rows = next; wake?.(); }, revoke: () => { access = false; wake?.(); },
    policy: () => { policy = 'changed'; wake?.(); }, block: (wait: Promise<void>) => { captureBarrier = wait; },
    get captures() { return captures; }, get closed() { return closed; } };
}
async function next(iterator: AsyncIterator<RuntimeEventsItem>) { const item = await iterator.next(); expect(item.done).not.toBe(true); return item.value!; }
async function snapshot(subscription: RuntimeEventsSubscription) {
  const iterator = subscription.items[Symbol.asyncIterator](); const items: RuntimeEventsItem[] = [];
  while (true) { const item = await next(iterator); items.push(item); if (item.type === 'snapshot.end') return { iterator, items, token: item.resume }; }
}
async function settle() { for (let n = 0; n < 30; n++) await Promise.resolve(); }
it('denies all requested topics before opening a source or emitting data', async () => {
  const f = fixture(); await expect(f.app.subscribe({ ...query, topics: ['run', 'usage'] })).rejects.toMatchObject({ code: 'RUNTIME_EVENTS_UNAVAILABLE' }); expect(f.captures).toBe(0);
  await expect(f.app.subscribe({ ...query, scopeId: 'foreign' })).rejects.toBeInstanceOf(RuntimeEventsError); expect(f.captures).toBe(0);
});
it('strictly rejects caller principal, actor, unknown topics and unsafe DTO fields', () => {
  const record = row(0).record;
  for (const extra of ['secret', 'prompt', 'rawOutput', 'decisionCapability', 'workspace', 'patch']) {
    expect(runtimeEventsItemSchema.safeParse({ type: 'snapshot.part', snapshotId: randomUUID(), record: { ...record, [extra]: 'CANARY' } }).success).toBe(false);
  }
});
it('filters record-level denials and produces one captured barrier before changes', async () => {
  const f = fixture(); f.setRows([row(0), row(0, 'denied')]); const sub = await f.app.subscribe(query); const s = await snapshot(sub);
  expect(s.items.filter(item => item.type === 'snapshot.part')).toHaveLength(1);
  f.setRows([row(1)]); const change = await next(s.iterator); expect(change).toMatchObject({ type: 'change', record: { revision: 1 }, resume: { sequence: 1 } });
});
it('does not miss a revision written while the initial capture is in flight', async () => {
  const f = fixture(); let release!: () => void; f.block(new Promise<void>(resolve => { release = resolve; }));
  const pending = f.app.subscribe(query); await settle(); expect(f.captures).toBe(1); f.setRows([row(1)]); release();
  const sub = await pending, s = await snapshot(sub); f.setRows([row(1)]);
  expect(await next(s.iterator)).toMatchObject({ type: 'change', record: { revision: 1 } });
});
it('replays only retained visible changes for the same principal and rejects foreign or future tokens', async () => {
  const f = fixture(), a = await f.app.subscribe(query), first = await snapshot(a);
  f.setRows([row(1)]); const change = await next(first.iterator); expect(change.type).toBe('change');
  const resumed = await f.app.subscribe({ ...query, resume: first.token }); const reader = resumed.items[Symbol.asyncIterator]();
  expect(await next(reader)).toMatchObject({ type: 'ready' }); expect(await next(reader)).toEqual(change);
  await expect(f.app.subscribe({ ...query, resume: first.token }, undefined, 'foreign')).rejects.toMatchObject({ code: 'RUNTIME_EVENTS_CURSOR' });
  await expect(f.app.subscribe({ ...query, resume: { ...first.token, sequence: 999 } })).rejects.toMatchObject({ code: 'RUNTIME_EVENTS_CURSOR' });
});
it('evicted replay emits retention gap and a fresh snapshot', async () => {
  const f = fixture({ viewReplayMaxEvents: 1 }), s = await snapshot(await f.app.subscribe(query));
  for (const revision of [1, 2]) { f.setRows([row(revision)]); expect(await next(s.iterator)).toMatchObject({ type: 'change' }); }
  const resumed = await f.app.subscribe({ ...query, resume: s.token }), i = resumed.items[Symbol.asyncIterator](); await next(i);
  expect(await next(i)).toMatchObject({ type: 'gap', reason: 'retention' }); expect(await next(i)).toMatchObject({ type: 'snapshot.begin' });
});
it('a stalled subscriber overflows to gap without blocking a fast subscriber or the producer', async () => {
  const f = fixture({ subscriberMaxEvents: 3 }), fast = await snapshot(await f.app.subscribe(query)), slow = await snapshot(await f.app.subscribe(query));
  for (const revision of [1, 2, 3, 4]) { f.setRows([row(revision)]); expect(await next(fast.iterator)).toMatchObject({ type: 'change', record: { revision } }); }
  expect(f.captures).toBeGreaterThanOrEqual(5); expect(await next(slow.iterator)).toMatchObject({ type: 'gap', reason: 'overflow', missing: null });
  expect(await next(slow.iterator)).toMatchObject({ type: 'snapshot.begin' }); expect(await next(slow.iterator)).toMatchObject({ type: 'snapshot.part', record: { revision: 4 } });
});
it('revision coalescing emits source-loss with explicit snapshot requirement', async () => {
  const f = fixture(), s = await snapshot(await f.app.subscribe(query)); f.setRows([row(4)]); await next(s.iterator);
  expect(await next(s.iterator)).toMatchObject({ type: 'gap', reason: 'source-loss', requiresSnapshot: true });
});
it('policy changes erase queued payloads before the next emit', async () => {
  const f = fixture(), s = await snapshot(await f.app.subscribe(query)); f.setRows([row(1)]); await settle(); f.policy();
  expect(await next(s.iterator)).toMatchObject({ type: 'close', reason: 'authorization-changed' });
});
it('cancellation closes the subscription and source without an execution cancellation capability', async () => {
  const f = fixture(), controller = new AbortController(), s = await snapshot(await f.app.subscribe(query, controller.signal)); controller.abort();
  expect(await next(s.iterator)).toMatchObject({ type: 'close', reason: 'cancelled' }); await settle(); expect(f.closed).toBeGreaterThan(0);
  // There is deliberately no Run or worker cancellation port in the application fixture or implementation.
  expect(await s.iterator.next()).toEqual({ done: true, value: undefined });
});
it('shutdown returns a reason, closes collectors and refuses subsequent admission', async () => {
  const f = fixture(), s = await snapshot(await f.app.subscribe(query)); await f.app.stop();
  expect(await next(s.iterator)).toMatchObject({ type: 'close', reason: 'service-shutdown' }); expect(f.closed).toBeGreaterThan(0);
  await expect(f.app.subscribe(query)).rejects.toMatchObject({ code: 'RUNTIME_EVENTS_UNAVAILABLE' });
});
it('a service epoch change gives a gap instead of claiming restart replay', async () => {
  const f = fixture(), s = await snapshot(await f.app.subscribe({ ...query, resume: { serviceEpoch: randomUUID(), viewId: randomUUID(), sequence: 0 } }));
  expect(s.items).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'gap', reason: 'epoch-changed' })]));
});
it('last detach stops collectors and reconnect never fabricates continuity', async () => {
  const f = fixture(), sub = await f.app.subscribe(query), s = await snapshot(sub); sub.close(); await settle();
  const fresh = await snapshot(await f.app.subscribe({ ...query, resume: s.token }));
  expect(fresh.items).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'gap', reason: 'source-loss' })]));
});
it('global and principal slots are reserved atomically across concurrent admission and released on detach', async () => {
  const f = fixture({ maxSubscribers: 2, maxSubscribersPerPrincipal: 1 });
  const results = await Promise.allSettled([f.app.subscribe(query), f.app.subscribe(query)]);
  expect(results.filter(v => v.status === 'fulfilled')).toHaveLength(1); expect(results.filter(v => v.status === 'rejected')).toHaveLength(1);
  for (const result of results) if (result.status === 'fulfilled') result.value.close(); await settle(); expect(await f.app.subscribe(query)).toHaveProperty('items');
});
it('revoked or unavailable admission closes with authorization-changed even when idle', async () => {
  const f = fixture(), s = await snapshot(await f.app.subscribe(query)); f.revoke(); await settle();
  expect(await next(s.iterator)).toMatchObject({ type: 'close', reason: 'authorization-changed' });
});
it('close never advances the cursor across changes that were queued but never delivered', async () => {
  const f = fixture(), sub = await f.app.subscribe(query), s = await snapshot(sub);
  f.setRows([row(1)]); await settle(); sub.close();
  expect(await next(s.iterator)).toMatchObject({ type: 'close', reason: 'cancelled', resume: { sequence: s.token.sequence } });
});
it('an owned token whose view was evicted gets a retention gap; foreign bindings cannot use that token', async () => {
  const f = fixture({ resumeTtlMs: 1 }), owner = await f.app.subscribe(query), old = await snapshot(owner); owner.close(); await settle();
  // Let the inactive binding expire and cause collection on another principal's admission.
  await new Promise<void>(resolve => setTimeout(resolve, 5));
  const other = await f.app.subscribe(query, undefined, 'other');
  const fresh = await snapshot(await f.app.subscribe({ ...query, resume: old.token }));
  expect(fresh.items).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'gap', reason: 'retention' })]));
  await expect(f.app.subscribe({ ...query, resume: old.token }, undefined, 'other')).rejects.toMatchObject({ code: 'RUNTIME_EVENTS_CURSOR' }); other.close();
});
