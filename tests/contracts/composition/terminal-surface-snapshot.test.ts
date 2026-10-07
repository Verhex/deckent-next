import { rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { clearConfigCache } from '#platform/index.js';
import { createSurfaceFollowSession, type SurfaceFollowEvent, type SurfacePushStep } from '#surfaces/core/terminal-kit/index.js';
import { mountWorkline, settle, until, WORKLINE_TEST_LABELS } from '../support/workline-harness.js';
import { surfaceSnapshotFixture } from '../support/surface-snapshot-fixture.js';

const ESC = '\u001B';
const fixtures: Awaited<ReturnType<typeof surfaceSnapshotFixture>>[] = [];
const mounted: { unmount(): void }[] = [];
beforeEach(async context => {
  if (process.platform === 'win32') context.skip('Local OS identity requires POSIX UID');
  if (process.platform === 'darwin') {
    const f = await fixture();
    await expect(f.ports.readSurfaceSnapshot!(['approval'], new AbortController().signal)).rejects.toMatchObject({ code: 'SESSION_REQUIRED' });
    context.skip('SESSION_REQUIRED: snapshot session evidence requires Linux /proc; real surface refusal verified');
  }
});
afterEach(async () => { for (const view of mounted.splice(0)) view.unmount(); vi.restoreAllMocks(); clearConfigCache(); await Promise.all(fixtures.splice(0).map(async f => { await f.close(); await rm(f.root, { recursive: true, force: true }); })); });
async function fixture(initialWorker = true) { const f = await surfaceSnapshotFixture(initialWorker); fixtures.push(f); return f; }
const labels = { ...WORKLINE_TEST_LABELS, watchStep: 'STEP {status}', watchAccessStopped: 'ACCESS-STOPPED {kinds}', watchAccessDenied: 'ACCESS-DENIED {kinds}', watchDelivery: 'DELIVERY {mode}' };
async function type(stdin: { write(text: string): unknown }, text: string) { for (const char of text) { stdin.write(char); await settle(2); } }

async function snapshotDone(read: { mock: { results: { value: unknown }[] } }, count: number) {
  await until(() => read.mock.results.length >= count, 'snapshot called'); await read.mock.results[count - 1]!.value; await settle(10);
}

it('loads pending approval, Run (including never dispatched) and worker at open into the real surface and fills /watch-workers', async () => {
  const f = await fixture(), read = vi.fn(f.ports.readSurfaceSnapshot!);
  const view = mountWorkline({ labels, pollMs: 20, ledger: { ...f.ports, readSurfaceSnapshot: read } }); mounted.push(view.instance);
  await until(() => view.stdout.text.includes('A-NOTIFY 1') && view.stdout.text.includes('never-dispatched-run') && view.stdout.text.includes('worker 1 · '), 'opening snapshot');
  expect(read.mock.calls.map(call => call[0])).toEqual([['approval', 'run', 'worker']]);
  expect(view.stdout.text).not.toContain('foreign-run'); expect(view.stdout.text).not.toContain('foreign-approval');
  await type(view.stdin, '/watch-workers\r');
  await until(() => view.stdout.frame.includes('LIVE-PANEL') && view.stdout.frame.includes('worker 1'), 'actual WorkerPanel');
  await snapshotDone(read, 2); await settle(60);
  expect(read).toHaveBeenCalledTimes(2); // Opening/watch snapshots, before the first 100 ms heartbeat. Empty idle is tested below.
  await f.publishWorker();
  await until(() => view.stdout.frame.includes('246 tokens'), 'worker invalidation refreshes the actual panel');
  expect(read.mock.calls.some(call => call[0].length === 1 && call[0][0] === 'worker')).toBe(true);
  f.addApproval('new-pending');
  await until(() => read.mock.calls.some(call => call[0].length === 1 && call[0][0] === 'approval'), 'approval invalidation snapshot');
  expect(view.stdout.text).not.toContain('approval:'); // Payload is an invalidation, not surface data.
});

it.each(['finished', 'denied'] as const)('refreshes unsealed live sidecars through composition into Ink and stops when %s', async ending => {
  const f = await fixture(false), follow = vi.fn(f.follow);
  let revokeOnRefresh = false;
  const read = vi.fn(async (kinds: Parameters<NonNullable<typeof f.ports.readSurfaceSnapshot>>[0], signal: AbortSignal) => {
    if (revokeOnRefresh) await f.setGrants(undefined, true);
    return f.ports.readSurfaceSnapshot!(kinds, signal);
  });
  const view = mountWorkline({ labels, pollMs: 20, ledger: { ...f.ports, readSurfaceSnapshot: read, followEvents: follow } }); mounted.push(view.instance);
  const sealedCount = () => {
    const db = new DatabaseSync(f.ledger, { readOnly: true });
    try { return db.prepare('SELECT count(*) AS count FROM worker_event_logs').get()!.count; } finally { db.close(); }
  };
  await snapshotDone(read, 1);
  await type(view.stdin, '/watch-workers\r'); await snapshotDone(read, 2);
  expect(view.stdout.frame).not.toContain('worker 1');
  await settle(350); expect(read).toHaveBeenCalledTimes(2); // No active worker: no heartbeat snapshots.
  const connections = follow.mock.calls.length;
  const worker = await f.startLiveWorker(async () => {
    await until(() => read.mock.calls.some(call => call[0].join(',') === 'run,worker'), 'Run reaches the snapshot before sidecars exist');
    const index = read.mock.calls.findIndex(call => call[0].join(',') === 'run,worker');
    const snapshot = await read.mock.results[index]!.value;
    expect(snapshot.workers?.sources[0]?.workers[0]).toMatchObject({ process: 'unknown', files: { heartbeat: { state: 'missing' } } });
  });
  await until(() => view.stdout.frame.includes('LIVE-PANEL') && view.stdout.frame.includes('worker 1'), 'Run invalidation discovers the new unsealed worker');
  expect(read.mock.calls.some(call => call[0].join(',') === 'run,worker')).toBe(true);
  worker.usage(123);
  await until(() => view.stdout.frame.includes('246 tokens'), 'first live sidecar usage');
  worker.usage(200);
  await until(() => view.stdout.frame.includes('646 tokens'), 'subsequent live sidecar usage without ledger publication');
  expect(sealedCount()).toBe(0);
  expect(follow).toHaveBeenCalledTimes(connections);
  expect(read.mock.calls.some(call => call[0].join(',') === 'worker')).toBe(true);
  if (ending === 'denied') {
    revokeOnRefresh = true;
    worker.usage(9999);
    await until(() => view.stdout.text.includes('ACCESS-STOPPED'), 'fresh principal denial stops the feed');
    expect(view.stdout.frame).not.toContain('LIVE-PANEL');
    expect(view.stdout.text).not.toContain('20.6k tokens');
    const denied = await read.mock.results.at(-1)!.value;
    expect(denied.workers).toBeUndefined();
  } else {
    await worker.finish();
    await until(() => view.stdout.frame.includes('finished'), 'heartbeat reports worker completion');
  }
  const stopped = read.mock.calls.length;
  await settle(350); expect(read).toHaveBeenCalledTimes(stopped);
  expect(follow).toHaveBeenCalledTimes(connections); expect(sealedCount()).toBe(0);
  if (ending === 'denied') {
    await type(view.stdin, '/watch-stop\r'); await type(view.stdin, '/watch-workers\r'); await settle(250);
    expect(read).toHaveBeenCalledTimes(stopped); expect(follow).toHaveBeenCalledTimes(connections);
  }
});

it('serializes a Run invalidation behind a live heartbeat snapshot and stops heartbeat reads when watch closes', async () => {
  const f = await fixture(false); await f.startLiveWorker();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let held = false, holdNext = true, inFlight = 0, maximum = 0, runPublished = false;
  const read = vi.fn(async (kinds: Parameters<NonNullable<typeof f.ports.readSurfaceSnapshot>>[0], signal: AbortSignal) => {
    inFlight++; maximum = Math.max(maximum, inFlight);
    try {
      if (holdNext && kinds.join(',') === 'worker') { holdNext = false; held = true; await gate; }
      return await f.ports.readSurfaceSnapshot!(kinds, signal);
    } finally { inFlight--; }
  });
  async function* followEvents(signal: AbortSignal) {
    for await (const event of f.follow(signal)) { if ('kind' in event && event.kind === 'run') runPublished = true; yield event; }
  }
  const view = mountWorkline({ labels, pollMs: 20, ledger: { ...f.ports, readSurfaceSnapshot: read, followEvents } }); mounted.push(view.instance);
  try {
    await snapshotDone(read, 1); await type(view.stdin, '/watch-workers\r');
    await until(() => held, 'heartbeat held in snapshot');
    const before = read.mock.calls.length;
    f.advanceRun(2); await until(() => runPublished, 'real producer Run invalidation');
    await settle(150); expect(read).toHaveBeenCalledTimes(before); expect(maximum).toBe(1);
    release();
    await until(() => read.mock.calls.some(call => call[0].join(',') === 'run,worker') && inFlight === 0, 'queued invalidation settles');
    expect(maximum).toBe(1);
    view.stdin.write(ESC); await until(() => view.stdout.text.includes('Workers window closed'), 'Esc closes the window and stops the watch'); await settle(150);
    const stopped = read.mock.calls.length;
    await settle(350); expect(read).toHaveBeenCalledTimes(stopped);
  } finally { release(); }
});

it('resynchronizes a real two-revision Run gap once, then renders subsequent revisions normally', async () => {
  const f = await fixture(), read = vi.fn(f.ports.readSurfaceSnapshot!);
  const view = mountWorkline({ labels, pollMs: 20, ledger: { ...f.ports, readSurfaceSnapshot: read } }); mounted.push(view.instance);
  await until(() => view.stdout.text.includes('rev 1'), 'initial Run snapshot');
  await type(view.stdin, '/watch-runs\r'); await snapshotDone(read, 2);
  f.advanceRun(2); await until(() => view.stdout.text.includes('rev 2'), 'first Run publication');
  f.advanceRun(4); await until(() => view.stdout.text.includes('STEP gap') && view.stdout.text.includes('rev 4'), 'gap snapshot');
  f.advanceRun(5); await until(() => view.stdout.text.includes('rev 5'), 'post-gap publication');
  f.advanceRun(6); await until(() => view.stdout.text.includes('rev 6'), 'next normal publication');
  // Latest debug frame contains each static entry once; accumulated writes repeat old frames.
  expect(view.stdout.frame.match(/STEP gap/g)).toHaveLength(1);
  expect(read.mock.calls.map(call => call[0])).toEqual([['approval', 'run', 'worker'], ['approval', 'run', 'worker'], ['run', 'worker'], ['approval', 'run', 'worker'], ['run', 'worker'], ['run', 'worker']]);
  expect(view.stdout.text).not.toContain('rev 3');
});

it('reopens the real producer at zero and accepts its first new approval, worker and Run publications', async () => {
  const f = await fixture(), session = createSurfaceFollowSession(), steps: SurfacePushStep[] = [];
  for (const round of [1, 2]) {
    const controller = new AbortController();
    let ready!: () => void;
    const started = new Promise<void>(resolve => { ready = resolve; });
    let applied = 0;
    const reading = session.read(f.follow(controller.signal), 's', 20, controller.signal, step => {
      steps.push(step);
      if (step.status === 'ready') ready();
      if (step.status === 'applied' && ++applied === 3) controller.abort();
    }, async (kinds, signal) => (await f.ports.readSurfaceSnapshot!(kinds, signal)).denied);
    await started;
    f.addApproval(`new-approval-${round}`);
    // Publication for an unrelated finished attempt: it invalidates the collection, cannot forge a visible worker.
    await f.publishWorker(`published-worker-${round}`);
    f.advanceRun(round + 1);
    expect(await reading).toBe('abort');
  }
  expect(steps.filter(step => step.status === 'applied').map(step => step.event.sequence)).toEqual([1, 1, 1, 1, 1, 1]);
  expect(steps.filter(step => step.status === 'ready')).toHaveLength(2);
  expect(steps.filter(step => step.status === 'gap' || step.status === 'invalid')).toEqual([]);
});

it('reconnects the mounted workline through a new production baseline and shows the next event', async () => {
  const f = await fixture(); let connection: AbortController | undefined, calls = 0;
  async function* followEvents(signal: AbortSignal): AsyncGenerator<SurfaceFollowEvent> {
    calls++; connection = new AbortController(); const local = connection;
    const abort = () => local.abort(); signal.addEventListener('abort', abort, { once: true });
    try { yield* f.follow(local.signal); } finally { signal.removeEventListener('abort', abort); local.abort(); }
  }
  const read = vi.fn(f.ports.readSurfaceSnapshot!);
  const view = mountWorkline({ labels, pollMs: 20, ledger: { ...f.ports, followEvents, readSurfaceSnapshot: read } }); mounted.push(view.instance);
  await until(() => view.stdout.text.includes('rev 1'), 'initial');
  await type(view.stdin, '/watch-runs\r'); await snapshotDone(read, 2);
  f.advanceRun(2); await until(() => view.stdout.text.includes('rev 2'), 'old stream cursor one');
  const beforeReconnect = calls, beforeReads = read.mock.calls.length;
  connection!.abort(); await until(() => calls === beforeReconnect + 1 && read.mock.calls.length >= beforeReads + 2, 'new baseline and fallback snapshots'); await snapshotDone(read, beforeReads + 2);
  f.advanceRun(3); await until(() => view.stdout.text.includes('rev 3'), 'first event in new stream');
  expect(view.stdout.text).toContain('DELIVERY poll');
});

it('refuses foreign principal snapshots, startup and resync before publication SQL or any data port', async () => {
  const f = await fixture(); await f.setGrants(undefined, true);
  const sql = vi.spyOn(DatabaseSync.prototype, 'prepare');
  const snapshot = await f.ports.readSurfaceSnapshot!(['approval', 'run', 'worker'], new AbortController().signal);
  expect(snapshot).toEqual({ scopeId: 's', denied: ['approval', 'run', 'worker'] });
  const read = vi.fn(f.ports.readSurfaceSnapshot!), follow = vi.fn(f.follow);
  const view = mountWorkline({ labels, pollMs: 20, ledger: { ...f.ports, followEvents: follow, readSurfaceSnapshot: read } }); mounted.push(view.instance);
  await until(() => view.stdout.text.includes('ACCESS-STOPPED'), 'access stopped');
  await type(view.stdin, '/watch-workers\r'); await settle(80);
  expect(read).not.toHaveBeenCalled(); expect(follow).toHaveBeenCalledTimes(1);
  // The window may open (it is the person's own command) but shows nothing: no data port was read and no foreign row reached the screen.
  expect(view.stdout.text).not.toMatch(/snapshot-task|snapshot-run|A-NOTIFY/);
  expect(sql.mock.calls.map(call => String(call[0])).filter(statement => /SELECT/i.test(statement) && /\b(runs|approvals|approval_outbox|worker_event_logs|dispatches)\b/.test(statement))).toEqual([]);
});

it('stops on a denied gap resync without falling back into unguarded data ports', async () => {
  const f = await fixture();
  const read = vi.fn(async (kinds: Parameters<NonNullable<typeof f.ports.readSurfaceSnapshot>>[0], signal: AbortSignal) => {
    if (read.mock.calls.length === 4) await f.setGrants(undefined, true);
    return f.ports.readSurfaceSnapshot!(kinds, signal);
  });
  const follow = vi.fn(f.follow);
  const view = mountWorkline({ labels, pollMs: 20, ledger: { ...f.ports, followEvents: follow, readSurfaceSnapshot: read } }); mounted.push(view.instance);
  await until(() => view.stdout.text.includes('rev 1'), 'initial');
  await type(view.stdin, '/watch-runs\r'); await snapshotDone(read, 2);
  f.advanceRun(2); await until(() => view.stdout.text.includes('rev 2'), 'first');
  f.advanceRun(4); await until(() => view.stdout.text.includes('ACCESS-STOPPED'), 'resync denied');
  await settle(80);
  expect(read).toHaveBeenCalledTimes(4); expect(follow).toHaveBeenCalledTimes(2);
  expect(view.stdout.text).not.toContain('rev 4');
  expect(view.stdout.frame).not.toContain('LIVE-PANEL');
});

it('keeps partially admitted observations scoped across startup and reconnect', async () => {
  const f = await fixture(); await f.setGrants(['scope', 'run', 'output']);
  let calls = 0, connection: AbortController | undefined;
  async function* followEvents(signal: AbortSignal): AsyncGenerator<SurfaceFollowEvent> {
    calls++; const local = new AbortController(); connection = local;
    const abort = () => local.abort(); signal.addEventListener('abort', abort, { once: true });
    try { yield* f.follow(local.signal); } finally { local.abort(); signal.removeEventListener('abort', abort); }
  }
  const read = vi.fn(f.ports.readSurfaceSnapshot!);
  const view = mountWorkline({ labels, pollMs: 20, ledger: { ...f.ports, followEvents, readSurfaceSnapshot: read } }); mounted.push(view.instance);
  await until(() => view.stdout.text.includes('rev 1') && view.stdout.text.includes('ACCESS-DENIED approval'), 'partial startup');
  await type(view.stdin, '/watch-runs\r'); await snapshotDone(read, 2); const beforeReconnect = calls, beforeReads = read.mock.calls.length;
  connection!.abort(); await until(() => calls === beforeReconnect + 1 && read.mock.calls.length >= beforeReads + 2, 'partial reconnect'); await snapshotDone(read, beforeReads + 2);
  f.advanceRun(2); await until(() => view.stdout.text.includes('rev 2'), 'authorized run after reconnect');
  expect(read.mock.calls.every(call => !call[0].includes('approval'))).toBe(true);
  expect(view.stdout.text).not.toContain('ACCESS-STOPPED'); expect(view.stdout.text).not.toContain('A-NOTIFY');
});

it('stops watched cards without stopping approval observation and refreshes when the watch reopens', async () => {
  const f = await fixture(), read = vi.fn(f.ports.readSurfaceSnapshot!);
  const view = mountWorkline({ labels, pollMs: 20, ledger: { ...f.ports, readSurfaceSnapshot: read } }); mounted.push(view.instance);
  await until(() => view.stdout.text.includes('rev 1'), 'initial');
  await type(view.stdin, '/watch-runs\r'); await snapshotDone(read, 2);
  f.advanceRun(2); await until(() => view.stdout.text.includes('rev 2'), 'watched revision');
  await type(view.stdin, '/watch-stop\r'); await settle(100);
  f.advanceRun(3); f.addApproval('still-observed'); await settle(180);
  expect(view.stdout.text).not.toContain('rev 3');
  await type(view.stdin, '/watch-runs\r'); await until(() => view.stdout.text.includes('rev 3'), 'fresh watch activation');
  expect(view.stdout.text).toContain('A-NOTIFY');
});
