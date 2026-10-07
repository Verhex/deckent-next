import { writeFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { t } from '#platform/index.js';
import {
  acceptSurfaceEvent, openSurfacePush, releaseSurfacePush, SURFACE_PUSH_QUEUE, SURFACE_WATCH_OWNER,
  createSurfaceFollowSession, type SurfaceFollowEvent, type SurfacePushEvent, type SurfacePushStep,
} from '#surfaces/core/terminal-kit/index.js';
import { mountWorkline, settle, until, WORKLINE_TEST_LABELS } from '../support/workline-harness.js';
import { measureSurfacePush, surfacePushLatencyReport } from '../support/surface-push-latency.js';

const labels = { ...WORKLINE_TEST_LABELS,
  watchDelivery: 'DELIVERY {mode} timeout {timeoutMs} owner {owner} action {action}',
  watchStep: 'STEP {status} timeout {timeoutMs} owner {owner} action {action}',
  watchPushFailed: 'PUSH-FAILED' };
const mounted: { unmount: () => void }[] = [];
afterEach(() => { while (mounted.length) mounted.pop()!.unmount(); });

function event(sequence: number, overrides: Partial<SurfacePushEvent> = {}): SurfacePushEvent {
  return { kind: 'worker', scopeId: 'scope-a', sequence, id: `id-${sequence}`, text: `text-${sequence}`, ...overrides };
}
async function type(stdin: { write: (text: string) => unknown }, text: string) {
  for (const char of text) { stdin.write(char); await settle(2); }
}
const emptyWorkers = { schemaVersion: 1, scopeId: 'scope-a', sources: [], observedAt: 0, control: 'observe-only' } as never;

describe('surface push contract', () => {
  it('applies the next cursor and carries a wait on every result', () => {
    const first = acceptSurfaceEvent(openSurfacePush(), event(1), 'scope-a', 5_000);
    expect(first.status).toBe('applied');
    expect(first.wait).toEqual({ timeoutMs: 5_000, owner: SURFACE_WATCH_OWNER, action: 'read-next' });
    if (first.status !== 'applied') return;
    const gap = acceptSurfaceEvent(first.state, event(3, { text: 'missing' }), 'scope-a', 5_000);
    expect(gap).toMatchObject({ status: 'gap', expected: 2, sequence: 3, wait: { action: 'report-gap', owner: SURFACE_WATCH_OWNER } });
    expect(gap.state.cursors.worker).toBe(1);
    const foreign = acceptSurfaceEvent(gap.state, event(2, { scopeId: 'other', text: 'elsewhere' }), 'scope-a', 5_000);
    expect(foreign).toMatchObject({ status: 'foreign-scope', wait: { action: 'refuse-scope', owner: SURFACE_WATCH_OWNER } });
    expect(foreign.state.cursors.worker).toBe(1);
  });

  it('holds the event when the queue is full and applies it after a release', () => {
    let state = openSurfacePush();
    for (let sequence = 1; sequence <= SURFACE_PUSH_QUEUE; sequence++) {
      const step = acceptSurfaceEvent(state, event(sequence), 'scope-a', 5_000);
      expect(step.status).toBe('applied');
      if (step.status === 'applied') state = step.state;
    }
    const held = acceptSurfaceEvent(state, event(SURFACE_PUSH_QUEUE + 1), 'scope-a', 5_000);
    expect(held).toMatchObject({ status: 'backpressure', wait: { timeoutMs: 5_000, owner: SURFACE_WATCH_OWNER, action: 'hold-event' } });
    expect(held.state.queued).toBe(SURFACE_PUSH_QUEUE);
    const applied = acceptSurfaceEvent(releaseSurfacePush(held.state), event(SURFACE_PUSH_QUEUE + 1), 'scope-a', 5_000);
    expect(applied.status).toBe('applied');
  });

  it('does not invent a zero sample for an unreadable interval', async () => {
    const summary = await measureSurfacePush();
    expect(summary.samples).toBe(25);
    expect(summary.status).toBe('measured');
    expect(summary.p50Ms).toBeGreaterThan(0);
    expect(summary.p95Ms).toBeGreaterThan(0);
    const output = process.env['S18_LATENCY_OUTPUT'];
    if (output) await writeFile(output, `${JSON.stringify(surfacePushLatencyReport(summary), null, 2)}\n`, { flag: 'wx' });
  });
});

describe('surface push on the workline', () => {
  it('uses one feed when legacy follows coexist, polls on disconnect, and stops all fallback on denial', async () => {
    let cut!: () => void;
    const connected = new Promise<void>(resolve => { cut = resolve; });
    let deny!: () => void;
    const reconnected = new Promise<void>(resolve => { deny = resolve; });
    const followWorkers = vi.fn(async function* () { yield []; });
    const followRuns = vi.fn(async function* () { yield []; });
    const listWorkers = vi.fn(async () => emptyWorkers);
    const listRunIds = vi.fn(async () => []);
    const listApprovalPage = vi.fn(async () => ({ items: [], nextAfter: null }));
    let calls = 0;
    async function* followEvents(): AsyncGenerator<SurfaceFollowEvent> {
      calls++;
      if (calls === 1) { await connected; throw new Error('cut'); }
      await reconnected;
      yield { access: 'denied', scopeId: 'scope-a', kinds: ['approval', 'run', 'worker'], stopped: true };
    }
    const view = mountWorkline({ labels: { ...labels, watchAccessStopped: 'ACCESS-STOPPED {kinds}' }, pollMs: 30, approvalPollMs: 30,
      ledger: { scopeId: 'scope-a', followEvents, followWorkers, followRuns, listWorkers, listRunIds, listApprovalPage, async inspectRun() { return null; } } });
    mounted.push(view.instance);
    // The first watch window owns the keyboard, so both feeds are started by the one command that shows both (`/tasks`).
    await type(view.stdin, '/tasks\r');
    await until(() => view.stdout.text.includes('WATCH-ON'), 'worker and run watch');
    expect(listWorkers).not.toHaveBeenCalled();
    expect(listRunIds).not.toHaveBeenCalled();
    expect(listApprovalPage).not.toHaveBeenCalled();
    cut();
    await until(() => listWorkers.mock.calls.length > 0 && listRunIds.mock.calls.length > 0 && listApprovalPage.mock.calls.length > 0, 'all fallback polls');
    await until(() => calls === 2, 'reconnect');
    deny();
    await until(() => view.stdout.text.includes('ACCESS-STOPPED'), 'denied feed');
    const counts = [listWorkers.mock.calls.length, listRunIds.mock.calls.length, listApprovalPage.mock.calls.length];
    await settle(90);
    expect([listWorkers.mock.calls.length, listRunIds.mock.calls.length, listApprovalPage.mock.calls.length]).toEqual(counts);
    expect(calls).toBe(2);
    expect(followWorkers).not.toHaveBeenCalled();
    expect(followRuns).not.toHaveBeenCalled();
  });

  it('marks a watch with no push port as poll and does not call it live', async () => {
    let polls = 0;
    const view = mountWorkline({ labels, pollMs: 5, ledger: { scopeId: 'scope-a', async listWorkers() { polls += 1; return emptyWorkers; },
      async inspectRun() { return null; } } });
    mounted.push(view.instance);
    await type(view.stdin, '/watch-workers\r');
    await until(() => view.stdout.text.includes('DELIVERY poll timeout 5 owner terminal-watch action poll-scope'), 'poll mark');
    await until(() => polls > 0, 'poll ran');
    expect(view.stdout.text).not.toContain('DELIVERY push');
  });

  it('paints a pushed event, reports a gap, and does not poll or invent the missing event', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let polls = 0;
    async function* followEvents(signal: AbortSignal) {
      await gate;
      yield event(1, { text: 'pushed-worker-1' });
      yield event(3, { text: 'skipped-worker-3' });
      yield event(2, { scopeId: 'other', text: 'foreign-worker' });
      yield { kind: 'approval' as const, scopeId: 'scope-a', sequence: 1, id: 'a1', text: 'pushed-approval-1' };
      await new Promise<void>(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', () => resolve(), { once: true }); });
    }
    const view = mountWorkline({ labels, pollMs: 5, ledger: { scopeId: 'scope-a', followEvents, async listWorkers() { polls += 1; return emptyWorkers; },
      async inspectRun() { return null; } } });
    mounted.push(view.instance);
    await type(view.stdin, '/watch-workers\r');
    await until(() => view.stdout.text.includes('DELIVERY push timeout 5 owner terminal-watch action read-next'), 'push mark');
    release();
    await until(() => view.stdout.text.includes('pushed-worker-1') && view.stdout.text.includes('STEP gap') && view.stdout.text.includes('pushed-approval-1'), 'push surface');
    await settle(30);
    expect(polls).toBe(0);
    expect(view.stdout.text).not.toContain('skipped-worker-3');
    expect(view.stdout.text).not.toContain('foreign-worker');
    expect(view.stdout.text).toContain('action report-gap');
    expect(view.stdout.text).toContain('STEP foreign-scope');
  });

  it('falls back to poll when the stream cuts, reconnects, reports the gap, and does not paint another scope', async () => {
    let releaseYield!: () => void;
    const gate = new Promise<void>(resolve => { releaseYield = resolve; });
    let releaseCut!: () => void;
    const hold = new Promise<void>(resolve => { releaseCut = resolve; });
    let calls = 0;
    let polls = 0;
    async function* followEvents(signal: AbortSignal) {
      calls += 1;
      if (calls === 1) {
        await gate;
        yield event(1, { text: 'pushed-worker-1' });
        await hold;
        throw new Error('cut');
      }
      yield event(3, { text: 'skipped-worker-3' });
      yield event(2, { scopeId: 'other', text: 'foreign-worker' });
      await new Promise<void>(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', () => resolve(), { once: true }); });
    }
    const view = mountWorkline({ labels, pollMs: 5, ledger: { scopeId: 'scope-a', followEvents, async listWorkers() { polls += 1; return emptyWorkers; },
      async inspectRun() { return null; } } });
    mounted.push(view.instance);
    await type(view.stdin, '/watch-workers\r');
    await until(() => view.stdout.text.includes('DELIVERY push'), 'push mark');
    releaseYield();
    await until(() => view.stdout.text.includes('pushed-worker-1'), 'first push');
    expect(polls).toBe(0);
    releaseCut();
    await until(() => view.stdout.text.includes('DELIVERY poll') && view.stdout.text.includes('STEP gap') && polls > 0, 'poll fallback');
    await settle(40);
    expect(view.stdout.text).not.toContain('skipped-worker-3');
    expect(view.stdout.text).not.toContain('foreign-worker');
    expect(calls).toBeGreaterThan(1);
  });

  it('says poll and gap in English and Turkish catalog lines', async () => {
    const catalog = (locale: 'en' | 'tr') => ({
      watchDelivery: t('terminal.workline.watchDelivery', {}, locale),
      watchStep: t('terminal.workline.watchStep', {}, locale),
      watchPushFailed: t('terminal.workline.watchPushFailed', {}, locale),
    });
    for (const locale of ['en', 'tr'] as const) {
      let releaseYield!: () => void;
      const gate = new Promise<void>(resolve => { releaseYield = resolve; });
      let releaseCut!: () => void;
      const hold = new Promise<void>(resolve => { releaseCut = resolve; });
      async function* followEvents() {
        await gate;
        yield event(1, { text: 'pushed-worker-1' });
        await hold;
        throw new Error('cut');
      }
      const view = mountWorkline({ labels: { ...labels, ...catalog(locale) }, pollMs: 5, ledger: { scopeId: 'scope-a', followEvents,
        async listWorkers() { return emptyWorkers; }, async inspectRun() { return null; } } });
      mounted.push(view.instance);
      await type(view.stdin, '/watch-workers\r');
      const started = t('terminal.workline.watchDelivery', { mode: 'push', timeoutMs: 5, owner: 'terminal-watch', action: 'read-next' }, locale);
      await until(() => view.stdout.text.includes(started), `${locale} push mark`);
      releaseYield();
      await until(() => view.stdout.text.includes('pushed-worker-1'), `${locale} push`);
      releaseCut();
      const poll = t('terminal.workline.watchDelivery', { mode: 'poll', timeoutMs: 5, owner: 'terminal-watch', action: 'poll-scope' }, locale);
      const gap = t('terminal.workline.watchStep', { status: 'gap', timeoutMs: 5, owner: 'terminal-watch', action: 'report-gap' }, locale);
      await until(() => view.stdout.text.includes(poll) && view.stdout.text.includes(gap), `${locale} fallback`);
      view.instance.unmount();
      mounted.pop();
    }
  });
});

it('keeps cursors on a partial denial, ignores a foreign denial, and stops at a scoped terminal denial', async () => {
  const steps: SurfacePushStep[] = [];
  async function* events(): AsyncGenerator<SurfaceFollowEvent> {
    yield { access: 'denied', scopeId: 'other', kinds: ['run'], stopped: true };
    yield { access: 'denied', scopeId: 'scope-a', kinds: ['approval'], stopped: false };
    yield event(1);
    yield { access: 'denied', scopeId: 'scope-a', kinds: ['worker'], stopped: true };
    yield event(2, { text: 'must-not-be-painted' });
  }
  const outcome = await createSurfaceFollowSession().read(events(), 'scope-a', 5, new AbortController().signal, step => steps.push(step));
  expect(outcome).toBe('denied');
  expect(steps.map(step => step.status)).toEqual(['foreign-scope', 'denied', 'applied', 'denied']);
  expect(steps.at(-1)?.state.cursors).toEqual({ approval: null, run: null, worker: 1 });
});
