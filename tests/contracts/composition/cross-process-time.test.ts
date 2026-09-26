import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { hostname, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as platform from '#platform/index.js';
import * as clocks from '#platform/core/clock/index.js';
import * as adapters from '#adapters/index.js';
import { DispatchApplication } from '#engine/index.js';
import { deliverConfiguredRunCancellation, recoverConfiguredCancellations } from '#composition/core/runs/index.js';
import { inspectConfiguredWorkers } from '#composition/core/worker-observation/index.js';
import { openConfiguredAttemptStore } from '#composition/core/storage/index.js';
import { formatDuration } from '#surfaces/core/terminal/index.js';
import { admitRunAttempts } from '../support/admission.js';
import { custodyProfiles, dispatchAdmission } from '../support/custody.js';

const roots: string[] = [];
const { MAX_WALL_SKEW_MS: skew } = platform;
const limits = { maxAttempts: 3, retryDelayMs: 100, claimTtlMs: 1000 };
const dbOptions = { busyTimeoutMs: 100, journalMode: 'wal', durability: 'full' } as const;
const identity = { scopeId: 's', runId: 'r', taskId: 't', attemptId: 'a', generation: 1, layoutRevision: 'l' };
afterEach(async () => { vi.restoreAllMocks(); platform.clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function root() { const path = await mkdtemp(join(tmpdir(), 'deckent-cross-time-')); roots.push(path); return path; }
async function seed(path: string) {
  const store = await adapters.openSqliteAttemptStore(path, dbOptions, 'allow', custodyProfiles);
  await admitRunAttempts(store, [identity]);
  await store.claimDispatch(dispatchAdmission({ owner: 'worker', request: { protocolVersion: 1, identity, workspace: '/w', argv: ['tool'] } }));
  await store.cancelRun({ commandId: 'cancel', actor: { id: 'operator', issuer: 'test', subject: 'fixture' }, scopeId: 's', runId: 'r', expectedRevision: 1 });
  return store;
}

describe('cross-process cancellation leases', () => {
  it.each(['claimed', 'queued'] as const)('does not discover or acquire %s early from an ahead process, then recovers at the exact safe boundary', async state => {
    const path = join(await root(), 'ledger.db'), writer = await seed(path);
    const reader = await adapters.openSqliteAttemptStore(path, dbOptions, 'allow', custodyProfiles);
    try {
      const writerClock = new platform.SystemTrustedClock(() => 1000);
      const first = await writer.claimCancellationDelivery({ identity, token: 'writer', now: writerClock.sample().wallMs, limits });
      const record = state === 'claimed' ? first.record : await writer.finishCancellationDelivery({ identity, token: 'writer', now: 1000, limits, outcome: 'unresolved' });
      const deadline = state === 'claimed' ? record.claimUntil : record.nextEligibleAt;
      let raw = deadline + 2000;
      const readerClock = new platform.SystemTrustedClock(() => raw);
      for (const sample of [deadline + 2000, deadline, deadline + skew - 1]) {
        raw = sample;
        const now = readerClock.sample().wallMs;
        expect((await reader.discoverCancellationRecovery({ scopeId: 's', afterAttemptId: null, limit: 10, now })).identities).toEqual([]);
        expect(await reader.claimCancellationDelivery({ identity, token: 'reader', now, limits })).toMatchObject({ acquired: false, record: { token: 'writer', attempts: 1 } });
      }
      raw = deadline + skew;
      expect((await reader.discoverCancellationRecovery({ scopeId: 's', afterAttemptId: null, limit: 10, now: readerClock.sample().wallMs })).identities).toEqual([identity]);
      expect(await reader.claimCancellationDelivery({ identity, token: 'reader', now: readerClock.sample().wallMs, limits })).toMatchObject({ acquired: true, record: { token: 'reader', attempts: 2 } });
    } finally { reader.close(); writer.close(); }
  });

  it.each(['deliver', 'recover'] as const)('wires the platform floor through configured %s into durable claim and finish times', async mode => {
    const project = await root(), data = join(project, 'data'); await mkdir(join(project, '.deckent'), { mode: 0o700 });
    await writeFile(join(project, '.deckent/config.json'), JSON.stringify({ layout: { root: data }, cancellation: { ...limits, maxConcurrentDeliveries: 1, recoveryPageSize: 10 } }));
    const options = { env: { HOME: join(project, 'home') } };
    const opened = await openConfiguredAttemptStore(project, options);
    await platform.prepareProductDirectory(opened.layout, 'artifacts'); opened.store.close();
    const store = await seed(opened.path); store.close();
    const principals = [{ issuer: hostname(), subject: String(userInfo().uid) }];
    await writeFile(join(data, 'policy.json'), JSON.stringify({ schemaVersion: 1, revision: 'p', restrictions: [], grants: [
      { id: 'scope', effect: 'allow', principals, actions: ['inspect'], scopes: ['s'], resource: { kind: 'scope', ids: ['s'] } },
      { id: 'run', effect: 'allow', principals, actions: ['cancel'], scopes: ['s'], resource: { kind: 'run', ids: ['r'] } },
    ] }), { mode: 0o600 });
    // Real persistence and delivery worker; only the external supervisor boundary is replaced.
    const open = adapters.openSqliteAttemptStore;
    vi.spyOn(adapters, 'openSqliteAttemptStore').mockImplementation((path, settings, policy) => open(path, settings, policy, custodyProfiles));
    let raw = 1000;
    const clock = new platform.SystemTrustedClock(() => raw);
    vi.spyOn(platform, 'SystemTrustedClock').mockImplementation(function () { return clock; } as never);
    const cancel = vi.fn(async () => { raw = 999; return { kind: 'unresolved' as const }; });
    vi.spyOn(DispatchApplication.prototype, 'authorizeCancellation').mockResolvedValue(undefined);
    vi.spyOn(DispatchApplication.prototype, 'cancel').mockImplementation(cancel as never);
    const act = async () => mode === 'deliver'
      ? deliverConfiguredRunCancellation(project, { schemaVersion: 1, action: 'cancel', commandId: 'repeat', scopeId: 's', runId: 'r', expectedRevision: 2 }, options)
      : recoverConfiguredCancellations(project, { schemaVersion: 1, scopeId: 's', afterAttemptId: null }, options);
    await act(); expect(cancel).toHaveBeenCalledTimes(1);
    const proof = await open(opened.path, dbOptions, 'allow', custodyProfiles);
    try {
      const held = await proof.claimCancellationDelivery({ identity, token: 'inspect', now: 1000, limits });
      expect(held).toMatchObject({ acquired: false, record: { claimUntil: 2000, nextEligibleAt: 1100, attempts: 1, state: 'queued' } });
    } finally { proof.close(); }
    raw = 3000; await act(); expect(cancel).toHaveBeenCalledTimes(1);
    raw = 1100 + skew; await act(); expect(cancel).toHaveBeenCalledTimes(2);
  });
});

describe('config lock elapsed budget and conservative age', () => {
  it('times out on monotonic elapsed time across a backward wall step and reports the advancing lock age', async () => {
    const path = join(await root(), 'config.json'), lock = `${path}.write-lock`;
    await writeFile(lock, JSON.stringify({ pid: process.pid, hostname: hostname(), createdAt: new Date(1000).toISOString() }));
    await utimes(lock, 1, 1);
    const samples = [{ wallMs: 11000, monotonicMs: 0 }, { wallMs: 9000, monotonicMs: 2000 }];
    let reads = 0;
    const sample = vi.fn(() => { if (++reads > 8) throw new Error('CLOCK_BUDGET_NOT_ENFORCED'); return samples.shift() ?? { wallMs: 9000, monotonicMs: 2000 }; });
    vi.spyOn(clocks, 'SystemTrustedClock').mockImplementation(function () { return { sample }; } as never);
    let entered = false;
    await expect(platform.withConfigWriteLock(path, async () => { entered = true; }, 2000)).rejects.toMatchObject({ code: 'CONFIG_WRITE_LOCKED', params: { ageSeconds: 7 } });
    expect(entered).toBe(false); expect(sample).toHaveBeenCalled();
  });
  it('does not reclaim unpublished locks early within skew but reclaims genuinely stale locks', async () => {
    const path = join(await root(), 'config.json'), lock = `${path}.write-lock`;
    await mkdir(lock); await utimes(lock, 1, 1);
    let wallMs = 1000 + 600000 + 2000, monotonicMs = 0;
    vi.spyOn(clocks, 'SystemTrustedClock').mockImplementation(function () { return { sample: () => ({ wallMs, monotonicMs: monotonicMs++ }) }; } as never);
    await expect(platform.withConfigWriteLock(path, async () => undefined, 1)).rejects.toMatchObject({ code: 'CONFIG_WRITE_LOCKED' });
    wallMs = 1000 + 600000 + skew + 1;
    const warnings: string[] = [];
    await platform.withConfigWriteLock(path, async () => undefined, 100, { onWarning: w => warnings.push(w.code) });
    expect(warnings).toEqual(['CONFIG_LOCK_STALE_RECLAIMED']);
  });
});

describe('worker observation clocks', () => {
  it('stamps the configured observation report with the trusted clock', async () => {
    const project = await root(), data = join(project, 'data'); await mkdir(join(project, '.deckent'), { mode: 0o700 });
    await writeFile(join(project, '.deckent/config.json'), JSON.stringify({ layout: { root: data } }));
    const options = { env: { HOME: join(project, 'home') } };
    const opened = await openConfiguredAttemptStore(project, options); opened.store.close();
    await writeFile(join(data, 'policy.json'), JSON.stringify({ schemaVersion: 1, revision: 'p', restrictions: [], grants: [
      { id: 'scope', effect: 'allow', actions: ['inspect'], scopes: ['s'], principals: [{ issuer: hostname(), subject: String(userInfo().uid) }], resource: { kind: 'scope', ids: ['s'] } },
    ] }), { mode: 0o600 });
    const clock = new platform.SystemTrustedClock(() => 1000);
    vi.spyOn(platform, 'SystemTrustedClock').mockImplementation(function () { return clock; } as never);
    const report = await inspectConfiguredWorkers(project, { schemaVersion: 1, scopeId: 's' }, options);
    expect(report).toMatchObject({ observedAt: 1000, sources: [{ status: 'available', workers: [] }] });
  });
  it('never exposes negative heartbeat age, tolerates ahead readers and still identifies stale and far-future records', async () => {
    const directory = await root(); await writeFile(join(directory, 'worker.hb'), JSON.stringify({ process: 'running' }), { mode: 0o600 });
    await utimes(join(directory, 'worker.hb'), 10, 10);
    const limits = { maxFileBytes: 4096, maxEntries: 10, staleMs: 1000 };
    for (const [now, ageMs, freshness] of [[8000, 0, 'fresh'], [12000, 0, 'fresh'], [16000, 1000, 'fresh'], [16001, 1001, 'stale'], [4999, 0, 'future']] as const) {
      expect((await adapters.readWorkerSidecars(directory, 'worker', limits, now)).heartbeat).toMatchObject({ ageMs, freshness });
    }
  });
  it('floors event receipt times and preserves future evidence while the terminal displays nonnegative age', async () => {
    const directory = await root(); let raw = 10000;
    const clock = new platform.SystemTrustedClock(() => raw);
    vi.spyOn(platform, 'SystemTrustedClock').mockImplementation(function () { return clock; } as never);
    const sink = await adapters.openWorkerEventSink(directory);
    const event = { schemaVersion: 1 as const, sequence: 1, atMs: 1, kind: 'message' as const, role: 'assistant' as const, textBytes: 1, thinking: false, excerpt: 'x' };
    sink.accept([event]); raw = 8000; sink.accept([{ ...event, sequence: 2 }]); await sink.close();
    const lines = (await readFile(join(directory, 'worker.events'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(lines.map(line => line.receivedAt)).toEqual([10000, 10000]);
    const files = await adapters.readWorkerSidecars(directory, 'worker', { maxFileBytes: 4096, maxEntries: 10, staleMs: 1000 }, 8000);
    expect(files.activity?.receivedAt).toBe(10000);
    expect(formatDuration(8000 - files.activity!.receivedAt!, { durationSeconds: '{n} s', durationMinutes: '{n} min', durationHours: '{n} h' })).toBe('0 s');
  });
});
