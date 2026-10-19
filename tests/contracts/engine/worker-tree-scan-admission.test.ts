import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { classifyLaunchRefusal, enforceAdmittedWorkerTreeGate, mergeWorkerTreeScans, WorkerTreeScanAdmission, type AttemptStore, type WorkerTreeScan, type WorkerTreeScanView } from '#engine/index.js';
import type { AuditEvent } from '#domain/index.js';

// R2 (owner/lead D3a 2026-10-18): S6 scan admission, the in-flight shared dependency scan, and the bounded `time` refusal.
const SETTINGS = { maxConcurrentScans: 2, admissionTimeoutMs: 60_000, maxTimeRefusals: 2 } as const;
const DEPS = { source: '/host/deps', label: '/deps', dependencyTree: { lockfile: 'package-lock.json' } } as const;
const CLEAN: WorkerTreeScan = Object.freeze({ status: 'clean' });
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
const identity = (attemptId = randomUUID()) => ({ scopeId: 's', runId: 'r', taskId: `t-${attemptId.slice(0, 8)}`, attemptId, generation: 1, layoutRevision: 'layout' });
const shared = (views: readonly WorkerTreeScanView[]) => views.some(view => view.label === DEPS.label);

/** One fixture world: audit records, journal commits, released checkouts, time-refusal records and the scan port's calls. */
function world(scan: (views: readonly WorkerTreeScanView[]) => Promise<WorkerTreeScan>, options: { lock?: string; fingerprint?: unknown; settings?: typeof SETTINGS | { maxConcurrentScans: number; admissionTimeoutMs: number; maxTimeRefusals: number } } = {}) {
  const audits: AuditEvent[] = [], commits: string[] = [], released: string[] = [], records = new Map<string, unknown>(), calls: string[][] = [];
  const admission = new WorkerTreeScanAdmission();
  const journal = { receipt: async () => null, commit: async (command: { commandId: string }) => { commits.push(command.commandId); },
    load: async (_scope: string, attemptId: string) => ({ identity: attempts.get(attemptId), revision: 0, lastObservation: null, cancelRequested: false }) } as unknown as AttemptStore;
  const attempts = new Map<string, ReturnType<typeof identity>>();
  const refusals = (name: string) => ({ read: async () => records.has(name) ? (records.get(name) === 'corrupt' ? { kind: 'corrupt' as const } : { kind: 'ready' as const, value: records.get(name) }) : { kind: 'absent' as const },
    write: async (value: unknown) => { records.set(name, value); }, remove: async () => { records.delete(name); } });
  const gate = (attempt = identity(), lock = options.lock ?? 'lock-v1', fingerprint: unknown = options.fingerprint ?? ['config']) => {
    attempts.set(attempt.attemptId, attempt);
    return enforceAdmittedWorkerTreeGate({ views: [{ source: `/ws/${attempt.attemptId}`, label: '' }, DEPS, { text: 'argv', label: 'argv' }],
      scan: async views => { calls.push(views.map(view => view.label)); return scan(views); }, settings: options.settings ?? SETTINGS, fingerprint,
      lockfile: async () => Buffer.from(lock), sharesTree: async () => false, refusals, admission },
    { identity: attempt, principal: { issuer: 'i', subject: 'p' }, policyRevision: 'rev', now: Date.now, journal },
    async event => { audits.push(event); }, async () => { released.push(attempt.attemptId); }).then(() => 'passed', (error: { code?: string; params?: Record<string, unknown> }) => error);
  };
  return { gate, admission, audits, commits, released, records, calls };
}
const excluded = { path: 'deps/zod/tests/a.ts', rule: 'pattern:url-userinfo', by: 'dependencyTree:/deps' };

it('13 concurrent dispatches over the same dependency bind scan it once; each passes with its own audit and journal entry', async () => {
  const release = deferred<void>();
  const w = world(async views => { if (shared(views)) { await release.promise; return Object.freeze({ status: 'clean', excluded: [excluded] }); } return CLEAN; });
  const results = Array.from({ length: 13 }, () => w.gate());
  // The shared scan is held until all 13 dispatches have reached it: one started it, twelve joined.
  await vi.waitFor(() => expect(w.admission.statistics()).toMatchObject({ started: 1, joined: 12, inFlight: 1 }));
  release.resolve();
  expect(await Promise.all(results)).toEqual(Array(13).fill('passed'));
  expect(w.calls.filter(labels => labels.includes('/deps'))).toEqual([['/deps']]);
  // Every dispatch scanned its own checkout and argv (never shared), each in an admitted slot.
  expect(w.calls.filter(labels => labels.includes(''))).toHaveLength(13);
  expect(w.calls.filter(labels => labels.includes('')).every(labels => labels.join() === ',argv')).toBe(true);
  expect(w.audits.map(event => event.subject.kind)).toEqual(Array(13).fill('worker-tree-excluded'));
  expect(new Set(w.audits.map(event => (event.subject as { attemptId: string }).attemptId)).size).toBe(13);
  expect(new Set(w.commits).size).toBe(13);
  expect(w.admission.statistics()).toMatchObject({ active: 0, waiting: 0, inFlight: 0 });
});

it('a secret found in the shared scan refuses every Attempt that awaited it: each audited and released, each refusal permanent', async () => {
  const release = deferred<void>();
  const w = world(async views => { if (!shared(views)) return CLEAN; await release.promise;
    return Object.freeze({ status: 'refused', findings: [{ path: 'deps/.npmrc', rule: 'deny-path:**/.npmrc' }], count: 1 }); });
  const results = Array.from({ length: 5 }, () => w.gate());
  await vi.waitFor(() => expect(w.admission.statistics()).toMatchObject({ started: 1, joined: 4 }));
  release.resolve();
  const failures = await Promise.all(results);
  expect(failures.map(failure => typeof failure === 'string' ? failure : failure.code)).toEqual(Array(5).fill('WORKER_TREE_SECRET_REFUSED'));
  for (const failure of failures) expect(classifyLaunchRefusal(failure)).toEqual({ disposition: 'permanent', code: 'WORKER_TREE_SECRET_REFUSED' });
  expect(w.audits.map(event => event.subject)).toEqual(w.released.map(attemptId => expect.objectContaining({ kind: 'worker-tree-refused', attemptId, code: 'WORKER_TREE_SECRET_REFUSED', count: 1 })));
  expect(w.released).toHaveLength(5); expect(w.commits).toEqual([]);
});

it('a changed input forces a new scan: other lockfile bytes or another configuration never join the scan in flight', async () => {
  const release = deferred<void>();
  const w = world(async views => { if (shared(views)) await release.promise; return CLEAN; });
  // Another configuration (gate bounds and lists, configured secret values, cache directory, checkout) is another key, even over the same bytes.
  const results = [w.gate(identity(), 'lock-v1'), w.gate(identity(), 'lock-v2'), w.gate(identity(), 'lock-v1'), w.gate(identity(), 'lock-v1', ['config-b'])];
  await vi.waitFor(() => expect(w.admission.statistics()).toMatchObject({ started: 3, joined: 1, inFlight: 3 }));
  release.resolve(); expect(await Promise.all(results)).toEqual(Array(4).fill('passed'));
  expect(w.calls.filter(labels => labels.includes('/deps'))).toHaveLength(3);
});

it('nothing is reused after the shared scan settles (no stat/ctime or completed-result reuse): the next dispatch reads the bind again', async () => {
  const w = world(async () => CLEAN);
  expect(await w.gate()).toBe('passed'); expect(await w.gate()).toBe('passed'); expect(await w.gate()).toBe('passed');
  expect(w.calls.filter(labels => labels.includes('/deps'))).toHaveLength(3);
  expect(w.admission.statistics()).toMatchObject({ started: 3, joined: 0, inFlight: 0 });
});

it('admits at most maxConcurrentScans scans; a waiting scan starts (and its deadline starts) only once admitted', async () => {
  const admission = new WorkerTreeScanAdmission(), gates = [deferred<void>(), deferred<void>(), deferred<void>()], started: number[] = [];
  const runs = gates.map((gate, index) => admission.admit(SETTINGS, async () => { started.push(index); await gate.promise; return index; }));
  await vi.waitFor(() => expect(started).toEqual([0, 1]));
  expect(admission.statistics()).toMatchObject({ active: 2, waiting: 1, waited: 1 });
  gates[0]!.resolve(); await vi.waitFor(() => expect(started).toEqual([0, 1, 2]));
  gates[1]!.resolve(); gates[2]!.resolve(); expect(await Promise.all(runs)).toEqual([0, 1, 2]);
  expect(admission.statistics()).toMatchObject({ active: 0, waiting: 0 });
});

it('one slot never deadlocks: a dispatch never waits for a slot while holding one (own and shared scans are admitted separately)', async () => {
  const w = world(async () => CLEAN, { settings: { ...SETTINGS, maxConcurrentScans: 1 } });
  expect(await Promise.all(Array.from({ length: 4 }, () => w.gate()))).toEqual(Array(4).fill('passed'));
  expect(w.admission.statistics()).toMatchObject({ active: 0, waiting: 0, inFlight: 0 });
});

it('a time refusal is audited and deferred (transient) up to maxTimeRefusals per Attempt; the one beyond the bound is the final typed refusal', async () => {
  const w = world(async views => shared(views) ? Object.freeze({ status: 'incomplete', limit: 'time', observed: 120_500, bound: 120_000 }) : CLEAN);
  const attempt = identity(), codes: unknown[] = [];
  for (let turn = 0; turn < 3; turn++) codes.push(await w.gate(attempt));
  expect(codes.slice(0, 2)).toEqual([1, 2].map(refusals => expect.objectContaining({ code: 'WORKER_TREE_SCAN_DEFERRED',
    params: { limit: 'timeoutMs', observed: 120_500, bound: 120_000, refusals, maxTimeRefusals: 2 } })));
  for (const failure of codes.slice(0, 2)) expect(classifyLaunchRefusal(failure)).toEqual({ disposition: 'transient' });
  expect(codes[2]).toMatchObject({ code: 'WORKER_TREE_SCAN_INCOMPLETE', params: { limit: 'timeoutMs', observed: 120_500, bound: 120_000 } });
  expect(classifyLaunchRefusal(codes[2])).toEqual({ disposition: 'permanent', code: 'WORKER_TREE_SCAN_INCOMPLETE' });
  // Every refusal was audited and its checkout released; the spent count is removed once final.
  expect(w.audits.map(event => event.subject)).toEqual(Array(3).fill(expect.objectContaining({ kind: 'worker-tree-refused', code: 'WORKER_TREE_SCAN_INCOMPLETE', limit: 'time' })));
  expect(w.released).toHaveLength(3); expect(w.records.size).toBe(0);
  // Bound 0 keeps the old behaviour (final at once); other bounds than time are never deferred.
  const strict = world(async () => Object.freeze({ status: 'incomplete', limit: 'time', observed: 2, bound: 1 }), { settings: { ...SETTINGS, maxTimeRefusals: 0 } });
  expect(await strict.gate()).toMatchObject({ code: 'WORKER_TREE_SCAN_INCOMPLETE' });
  const bytes = world(async views => shared(views) ? Object.freeze({ status: 'incomplete', limit: 'total-bytes', observed: 9, bound: 8 }) : CLEAN);
  expect(await bytes.gate()).toMatchObject({ code: 'WORKER_TREE_SCAN_INCOMPLETE', params: { limit: 'maxTotalBytes' } }); expect(bytes.records.size).toBe(0);
});

it('a pass clears the Attempt\'s time count; an unreadable or foreign count is never a clean slate (final at once)', async () => {
  let slow = true;
  const w = world(async views => slow && shared(views) ? Object.freeze({ status: 'incomplete', limit: 'time', observed: 2, bound: 1 }) : CLEAN);
  const attempt = identity();
  expect(await w.gate(attempt)).toMatchObject({ code: 'WORKER_TREE_SCAN_DEFERRED', params: { refusals: 1 } }); expect(w.records.size).toBe(1);
  slow = false; expect(await w.gate(attempt)).toBe('passed'); expect(w.records.size).toBe(0);
  slow = true; const name = [...(await (async () => { await w.gate(attempt); return w.records.keys(); })())][0]!;
  w.records.set(name, 'corrupt'); expect(await w.gate(attempt)).toMatchObject({ code: 'WORKER_TREE_SCAN_INCOMPLETE' });
  w.records.set(name, { schemaVersion: 1, identity: identity(), refusals: 0 }); expect(await w.gate(attempt)).toMatchObject({ code: 'WORKER_TREE_SCAN_INCOMPLETE' });
});

it('the wait for a slot is bounded: an admission timeout is a deferred time refusal, then a final one naming admissionTimeoutMs', async () => {
  const hold = deferred<void>(), settings = { maxConcurrentScans: 1, admissionTimeoutMs: 30, maxTimeRefusals: 1 };
  const w = world(async () => CLEAN, { settings });
  const blocker = w.admission.admit(settings, () => hold.promise), attempt = identity();
  expect(await w.gate(attempt)).toMatchObject({ code: 'WORKER_TREE_SCAN_DEFERRED', params: { limit: 'admissionTimeoutMs', bound: 30, refusals: 1, maxTimeRefusals: 1 } });
  expect(await w.gate(attempt)).toMatchObject({ code: 'WORKER_TREE_SCAN_INCOMPLETE', params: { limit: 'admissionTimeoutMs', bound: 30 } });
  // Nothing was scanned while waiting; both refusals were audited (`time`) and their checkouts released.
  expect(w.calls).toEqual([]); expect(w.released).toHaveLength(2);
  expect(w.audits.map(event => event.subject)).toEqual(Array(2).fill(expect.objectContaining({ kind: 'worker-tree-refused', code: 'WORKER_TREE_SCAN_INCOMPLETE', limit: 'time', count: 0 })));
  hold.resolve(); await blocker; expect(w.admission.statistics()).toMatchObject({ active: 0, waiting: 0 });
});

it('a failed shared scan reaches every joiner (nothing passes); an audit failure is thrown as it is and counts nothing', async () => {
  const release = deferred<void>();
  const w = world(async views => { if (shared(views)) { await release.promise; throw Object.assign(new Error('WORKER_TREE_ENTRY_CHANGED'), { code: 'WORKER_TREE_ENTRY_CHANGED' }); } return CLEAN; });
  const results = Array.from({ length: 3 }, () => w.gate());
  await vi.waitFor(() => expect(w.admission.statistics()).toMatchObject({ started: 1, joined: 2 }));
  release.resolve();
  expect((await Promise.all(results)).map(failure => (failure as { message: string }).message)).toEqual(Array(3).fill('WORKER_TREE_ENTRY_CHANGED'));
  expect(w.admission.statistics()).toMatchObject({ inFlight: 0, active: 0 });
});

it('merges own and shared scans: a refusal wins, then a bound other than time, then time; findings and lifted hits keep their order', () => {
  const own = Object.freeze({ status: 'refused', findings: [{ path: '.env', rule: 'deny-path:.env' }], count: 1, excluded: [{ ...excluded, by: 'allowPatternPaths:tests/**' }] }) as WorkerTreeScan;
  const theirs = Object.freeze({ status: 'refused', findings: [{ path: 'deps/.npmrc', rule: 'deny-path:**/.npmrc' }], count: 1, excluded: [excluded], dependencyTrees: [{ label: '/deps', reused: 0, evaluated: 2, saved: true }] }) as WorkerTreeScan;
  expect(mergeWorkerTreeScans(own, theirs)).toEqual({ status: 'refused', findings: [{ path: '.env', rule: 'deny-path:.env' }, { path: 'deps/.npmrc', rule: 'deny-path:**/.npmrc' }], count: 2,
    excluded: [{ ...excluded, by: 'allowPatternPaths:tests/**' }, excluded], dependencyTrees: [{ label: '/deps', reused: 0, evaluated: 2, saved: true }] });
  const time = Object.freeze({ status: 'incomplete', limit: 'time', observed: 2, bound: 1 }) as WorkerTreeScan, files = Object.freeze({ status: 'incomplete', limit: 'files', observed: 9, bound: 8 }) as WorkerTreeScan;
  expect(mergeWorkerTreeScans(time, own)).toMatchObject({ status: 'refused', count: 1 });
  expect(mergeWorkerTreeScans(time, files)).toBe(files); expect(mergeWorkerTreeScans(files, time)).toBe(files);
  expect(mergeWorkerTreeScans(CLEAN, time)).toBe(time);
  expect(mergeWorkerTreeScans(CLEAN, Object.freeze({ status: 'clean', excluded: [excluded] }))).toEqual({ status: 'clean', excluded: [excluded] });
  expect(mergeWorkerTreeScans(CLEAN, CLEAN)).toEqual({ status: 'clean' });
});

it('a bind sharing the checkout\'s tree, or one whose lockfile cannot be read, is scanned with the dispatch and never shared', async () => {
  const calls: string[][] = [], admission = new WorkerTreeScanAdmission(), attempt = identity();
  const journal = {} as AttemptStore, context = { identity: attempt, principal: { issuer: 'i', subject: 'p' }, policyRevision: 'rev', now: Date.now, journal };
  const input = (sharesTree: boolean, lock: Buffer | null) => ({ views: [{ source: '/ws', label: '' }, DEPS], scan: async (views: readonly WorkerTreeScanView[]) => { calls.push(views.map(view => view.label)); return CLEAN; },
    settings: SETTINGS, fingerprint: [], lockfile: async () => lock, sharesTree: async () => sharesTree, admission,
    refusals: () => ({ read: async () => ({ kind: 'absent' as const }), write: async () => undefined, remove: async () => undefined }) });
  await enforceAdmittedWorkerTreeGate(input(true, Buffer.from('lock')), context, async () => undefined, async () => undefined);
  await enforceAdmittedWorkerTreeGate(input(false, null), context, async () => undefined, async () => undefined);
  expect(calls).toEqual([['', '/deps'], ['', '/deps']]); expect(admission.statistics()).toMatchObject({ started: 0, joined: 0 });
});
