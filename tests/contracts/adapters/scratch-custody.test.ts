import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Controlled IO schedule (Astra 2149): the sweep's asynchronous removal, or its first measurement of an area, waits at a barrier
// until the test lets it go; every other call is the real one. No product result is fabricated.
const barriers = new Map<string, { readonly op: 'rm' | 'lstat'; readonly reached: () => void; readonly proceed: Promise<void>; readonly fail: boolean }>();
vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  const at = async (op: 'rm' | 'lstat', path: unknown) => {
    const barrier = barriers.get(`${op}:${String(path)}`);
    if (!barrier) return;
    barriers.delete(`${op}:${String(path)}`); barrier.reached(); await barrier.proceed;
    if (barrier.fail) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
  };
  return { ...actual,
    rm: async (...args: Parameters<typeof actual.rm>) => { await at('rm', args[0]); return actual.rm(...args); },
    lstat: async (...args: Parameters<typeof actual.lstat>) => { await at('lstat', args[0]); return actual.lstat(...args); } };
});
import { createScratchActivity, ensureScratchDirectories, openScratchSession, scratchSessionKey, scratchUsage, startScratchSweeper, sweepScratch, type ScratchSession } from '#adapters/index.js';
import { EffectTargetError } from '#engine/index.js';

const DAY_MS = 86_400_000;
const limits = { writeMaxBytes: 2_000, sessionMaxBytes: 1_500, installationMaxBytes: 1_500, retentionDays: 7, sweepIntervalMs: 60_000 };
const bases: string[] = [];
afterEach(async () => { barriers.clear(); await Promise.all(bases.splice(0).map(base => rm(base, { recursive: true, force: true }))); });

function barrier(op: 'rm' | 'lstat', path: string, fail = false) {
  let reached!: () => void, proceed!: () => void;
  const entered = new Promise<void>(resolve => { reached = resolve; }), released = new Promise<void>(resolve => { proceed = resolve; });
  barriers.set(`${op}:${path}`, { op, reached, proceed: released, fail });
  return { entered, proceed };
}
/** 'pending' when `promise` has not settled within a short real delay (the removal or lane it waits on is still held). */
const pending = (promise: Promise<unknown>, ms = 60) => Promise.race([promise.then(() => 'settled', () => 'settled'),
  new Promise(resolve => setTimeout(() => resolve('pending'), ms))]);
const within = <T>(promise: Promise<T>, ms = 5_000) => Promise.race([promise,
  new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`still waiting after ${ms} ms (a hold or lane was never released)`)), ms))]);
const age = async (path: string, atMs: number) => {
  const when = new Date(atMs);
  for (const entry of await readdir(path, { withFileTypes: true, recursive: true })) await utimes(join(entry.parentPath, entry.name), when, when);
  await utimes(path, when, when);
};
const keyOf = (sessionId: string, subject = 'same') => scratchSessionKey({ scopeId: 's', principal: { issuer: 'fixture', subject }, sessionId });
let journal = '';
async function fixture() {
  const base = await mkdtemp(join(tmpdir(), 'dn-scratch-custody-')); bases.push(base);
  const root = join(base, 'scratch'); await mkdir(root, { mode: 0o700 });
  journal = join(base, 'journal');
  return { base, root };
}
/** An area past retention holding one note (as a finished turn of long ago left it). */
async function stale(root: string, sessionId = 'one') {
  const key = keyOf(sessionId);
  await ensureScratchDirectories(root, key.split('/'));
  const dir = join(root, ...key.split('/'));
  await writeFile(join(dir, 'notes.txt'), 'retained conversation data'); await age(dir, Date.now() - 8 * DAY_MS);
  return { key, dir };
}
const write = (session: ScratchSession, path: string, bytes: number, commandId: string, expectedVersion = 'absent') => session.writes.target(journal).apply({
  target: { kind: 'scratch-file', id: session.writes.targetId(path) }, operation: { id: 'workspace.scratch.write', version: 1 },
  idempotencyKey: commandId.repeat(64).slice(0, 64), expectedVersion, input: { content: 'x'.repeat(bytes) } });
const outcome = (settled: PromiseSettledResult<unknown>) => settled.status === 'fulfilled' ? 'written'
  : (settled.reason as EffectTargetError).cause instanceof Error && ((settled.reason as EffectTargetError).cause as { code?: string }).code === 'SCRATCH_QUOTA_EXCEEDED' ? 'quota' : 'other';

describe.skipIf(process.platform !== 'linux')('scratch custody (Astra 2149): one owner for open/hold and measure/remove, one lane for the budgets', () => {
  it('R1: a turn starting while the area is being removed waits for the removal, then opens a fresh area the sweep never touches', async () => {
    const f = await fixture(), old = await stale(f.root), activity = createScratchActivity();
    const removal = barrier('rm', old.dir);
    const sweeping = sweepScratch(f.root, limits, Date.now(), activity);
    await removal.entered;
    const opening = openScratchSession(f.root, old.key, limits, activity);
    expect(await pending(opening)).toBe('pending');
    removal.proceed();
    expect(await sweeping).toMatchObject({ removedSessions: 1, kept: 0 });
    const session = await opening;
    expect(activity.has(old.key)).toBe(true);
    expect(await readdir(session.dir)).toEqual([]);
    await writeFile(join(session.dir, 'new.txt'), 'this turn'); await age(session.dir, Date.now() - 30 * DAY_MS);
    expect(await sweepScratch(f.root, limits, Date.now(), activity)).toMatchObject({ removedSessions: 0, kept: 1 });
    expect(await readFile(join(session.dir, 'new.txt'), 'utf8')).toBe('this turn');
    session.release();
  });

  it('R1: a turn starting after the sweep claimed the area but before removal (while it is measured) waits for the removal too', async () => {
    const f = await fixture(), old = await stale(f.root), activity = createScratchActivity();
    const measuring = barrier('lstat', old.dir);
    const sweeping = sweepScratch(f.root, limits, Date.now(), activity);
    await measuring.entered;
    const opening = openScratchSession(f.root, old.key, limits, activity);
    expect(await pending(opening)).toBe('pending');
    measuring.proceed();
    expect(await sweeping).toMatchObject({ removedSessions: 1 });
    const session = await opening;
    expect(await readdir(session.dir)).toEqual([]);
    session.release();
  });

  it('R1: an area a turn holds first is kept whatever its age; two parallel holds keep it until both are released', async () => {
    const f = await fixture(), old = await stale(f.root), activity = createScratchActivity();
    const [a, b] = await Promise.all([openScratchSession(f.root, old.key, limits, activity), openScratchSession(f.root, old.key, limits, activity)]);
    await age(old.dir, Date.now() - 30 * DAY_MS);
    expect(await sweepScratch(f.root, limits, Date.now(), activity)).toMatchObject({ removedSessions: 0, kept: 1 });
    a.release(); a.release();
    expect(await sweepScratch(f.root, limits, Date.now(), activity)).toMatchObject({ removedSessions: 0, kept: 1 });
    expect(await readFile(join(old.dir, 'notes.txt'), 'utf8')).toBe('retained conversation data');
    b.release();
    expect(await sweepScratch(f.root, limits, Date.now(), activity)).toMatchObject({ removedSessions: 1, kept: 0 });
  });

  it('R1: two turns arriving during one removal both wait, then share the fresh area; the owner directory is never removed under them', async () => {
    const f = await fixture(), old = await stale(f.root), activity = createScratchActivity();
    const removal = barrier('rm', old.dir);
    const sweeping = sweepScratch(f.root, limits, Date.now(), activity);
    await removal.entered;
    const openings = [openScratchSession(f.root, old.key, limits, activity), openScratchSession(f.root, old.key, limits, activity)];
    expect(await pending(Promise.race(openings))).toBe('pending');
    removal.proceed(); await sweeping;
    const [a, b] = await Promise.all(openings);
    expect(a.dir).toBe(b.dir); expect((await stat(a.dir)).isDirectory()).toBe(true);
    expect(activity.claim(old.key)).toBeNull(); expect(activity.claim(old.key.split('/')[0]!)).toBeNull();
    a.release(); b.release();
    expect(activity.has(old.key)).toBe(false);
  });

  it('R1: a failed open and a failed removal release what they took: the next sweep or turn never waits forever', async () => {
    const f = await fixture(), activity = createScratchActivity(), key = keyOf('broken'), [owner, session] = key.split('/') as [string, string];
    await mkdir(join(f.root, owner), { mode: 0o700 }); await symlink(f.base, join(f.root, owner, session));
    await expect(openScratchSession(f.root, key, limits, activity)).rejects.toMatchObject({ code: 'SCRATCH_UNSAFE' });
    expect(activity.has(key)).toBe(false);
    const claimed = activity.claim(key); expect(claimed).not.toBeNull(); claimed!();
    await rm(join(f.root, owner), { recursive: true });
    // The removal itself fails: its claim is released all the same.
    const old = await stale(f.root), failing = barrier('rm', old.dir, true);
    const sweeping = sweepScratch(f.root, limits, Date.now(), activity);
    await failing.entered; failing.proceed();
    await expect(sweeping).rejects.toMatchObject({ code: 'EACCES' });
    const reopened = await within(openScratchSession(f.root, old.key, limits, activity));
    expect(activity.has(old.key)).toBe(true); reopened.release();
  });

  it('R1 shutdown: close waits for the removal in flight; afterwards no area is removed, by the stopped sweeper or any sweep', async () => {
    const f = await fixture(), old = await stale(f.root, 'one'), activity = createScratchActivity(), stop = new AbortController();
    const removal = barrier('rm', old.dir), swept: unknown[] = [];
    startScratchSweeper({ root: async () => f.root, limits: { retentionDays: 7, sweepIntervalMs: 5 }, active: activity, signal: stop.signal,
      onSweep: result => swept.push(result) });
    await removal.entered;
    stop.abort();
    const closing = activity.close();
    expect(await pending(closing)).toBe('pending');
    removal.proceed(); await closing;
    await expect(stat(old.dir)).rejects.toMatchObject({ code: 'ENOENT' });
    const later = await stale(f.root, 'two');
    expect(activity.claim(later.key)).toBeNull();
    expect(await sweepScratch(f.root, limits, Date.now(), activity)).toMatchObject({ removedSessions: 0 });
    await new Promise(resolve => setTimeout(resolve, 40));
    expect((await stat(later.dir)).isDirectory()).toBe(true);
    expect(await readFile(join(later.dir, 'notes.txt'), 'utf8')).toBe('retained conversation data');
  });

  it('R2: two sessions share the installation budget — of two concurrent writes that each fit alone, exactly one is written', async () => {
    const f = await fixture(), activity = createScratchActivity();
    const [one, two] = await Promise.all(['one', 'two'].map(id => openScratchSession(f.root, keyOf(id, id), { ...limits, sessionMaxBytes: 4_000 }, activity)));
    const planned = await Promise.all([one!, two!].map(s => s.writes.plan('scratch_write', { path: 'n.txt', content: 'x'.repeat(1_000) })));
    expect(planned.map(p => p.ok)).toEqual([true, true]); // planning is advisory; the effect decides in the lane
    const results = await Promise.allSettled([write(one!, 'n.txt', 1_000, '1'), write(two!, 'n.txt', 1_000, '2')]);
    expect(results.map(outcome).sort()).toEqual(['quota', 'written']);
    expect(await scratchUsage(f.root)).toBe(1_000);
  });

  it('R2: two files of one session share the session budget', async () => {
    const f = await fixture(), activity = createScratchActivity();
    const session = await openScratchSession(f.root, keyOf('one'), { ...limits, installationMaxBytes: 10_000 }, activity);
    const results = await Promise.allSettled([write(session, 'a.txt', 1_000, 'a'), write(session, 'b/c.txt', 1_000, 'b')]);
    expect(results.map(outcome).sort()).toEqual(['quota', 'written']);
    expect(await scratchUsage(session.dir)).toBe(1_000);
  });

  it('R2: replacing a file counts only the difference, also against a concurrent write', async () => {
    const f = await fixture(), activity = createScratchActivity();
    const session = await openScratchSession(f.root, keyOf('one'), limits, activity), ref = { kind: 'scratch-file', id: session.writes.targetId('a.txt') };
    await write(session, 'a.txt', 1_000, 'a');
    const grown = await write(session, 'a.txt', 1_400, 'b', (await session.writes.target(journal).observe(ref)).version);
    expect(await scratchUsage(f.root)).toBe(1_400);
    await expect(write(session, 'a.txt', 1_600, 'c', grown.version)).rejects.toBeInstanceOf(EffectTargetError);
    const results = await Promise.allSettled([write(session, 'a.txt', 1_450, 'd', grown.version), write(session, 'b.txt', 100, 'e')]);
    expect(results.map(outcome).sort()).toEqual(['quota', 'written']);
    expect(await scratchUsage(f.root)).toBeLessThanOrEqual(1_500);
  });

  it('R2: a refused, failed, unknown or cancelled write never keeps the budget nor lets its bytes be spent twice', async () => {
    const f = await fixture(), activity = createScratchActivity();
    const [one, two] = await Promise.all(['one', 'two'].map(id => openScratchSession(f.root, keyOf(id, id), limits, activity))) as [ScratchSession, ScratchSession];
    // Failed inside the lane (a link where a directory must be created): the lane is handed on.
    await symlink(f.base, join(one.dir, 'sub'));
    await expect(write(one, 'sub/x.txt', 100, 'f')).rejects.toBeInstanceOf(EffectTargetError);
    // Refused by the quota: nothing written, the lane handed on.
    await expect(within(write(one, 'big.txt', 1_600, '9'))).rejects.toBeInstanceOf(EffectTargetError);
    await within(write(two, 'ok.txt', 500, '8'));
    // Unknown outcome: the bytes reached the disk, the writer failed; the next admission measures them (no double spend).
    await expect(one.spend('u.txt', 800, async () => { await writeFile(join(one.dir, 'u.txt'), 'u'.repeat(800)); throw new Error('outcome unknown'); }))
      .rejects.toThrow('outcome unknown');
    expect(await within(two.spend('more.txt', 300, async () => 'ran'))).toMatchObject({ ok: false, error: expect.stringContaining('installation: 1300 + 300 > 1500') });
    // Cancelled while waiting for the lane: it leaves the queue without the lane; the holder's release reaches the next writer.
    let letGo!: () => void;
    const holding = one.spend('slow.txt', 100, () => new Promise<string>(resolve => { letGo = () => resolve('slow'); }));
    const cancel = new AbortController(), cancelled = two.spend('c.txt', 100, async () => 'must not run', cancel.signal);
    const queued = two.spend('q.txt', 100, async () => 'queued');
    cancel.abort(new Error('turn cancelled'));
    await expect(cancelled).rejects.toThrow('turn cancelled');
    expect(await pending(queued)).toBe('pending');
    letGo();
    expect(await holding).toEqual({ ok: true, value: 'slow' });
    expect(await within(queued)).toEqual({ ok: true, value: 'queued' });
  });
});
