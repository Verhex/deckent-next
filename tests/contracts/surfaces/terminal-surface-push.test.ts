import { writeFile } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import {
  acceptSurfaceEvent, openSurfacePush, releaseSurfacePush, SURFACE_PUSH_QUEUE, SURFACE_WATCH_OWNER,
  type SurfacePushEvent,
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
    async function* followEvents() {
      await gate;
      yield event(1, { text: 'pushed-worker-1' });
      yield event(3, { text: 'skipped-worker-3' });
      yield event(2, { scopeId: 'other', text: 'foreign-worker' });
      yield { kind: 'approval' as const, scopeId: 'scope-a', sequence: 1, id: 'a1', text: 'pushed-approval-1' };
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
});
