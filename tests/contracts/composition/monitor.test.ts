import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { hostname, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Socket } from 'node:net';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { chmod } from 'node:fs/promises';
import { createConfiguredRuntimeClient, inspectConfiguredWorkers, inspectMonitor } from '#composition/index.js';
import { openConfiguredAttemptStore } from '../../../src/composition/core/storage/index.js';
import { openSqliteAttemptStore } from '#adapters/index.js';
import { CURRENT_LEDGER_VERSION } from '#adapters/core/sqlite-ledger/index.js';
import { clearConfigCache, prepareProductDirectory, productResourcePath } from '#platform/index.js';
import { FileArtifactStore } from '#adapters/index.js';
import { fixtureExecution } from '../support/execution-registry.js';
import { custodyProfiles, dispatchAdmission, grantTestLaunch } from '../support/custody.js';

// MONITOR-DATA: the one composed monitor snapshot over real project ledgers (current + a configured next-project source).
const roots: string[] = [];
afterEach(async () => { clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const actor = { id: 'fixture', issuer: 'test', subject: 'service' };
const graph = { schemaVersion: 2 as const, revision: 1, tasks: [{ id: 't', kind: 'fixture', dependencies: [], acceptanceCriteria: ['verified'] }],
  criterionDefinitions: [{ id: 'verified', version: 1, description: 'fixture', evaluator: { id: 'test', version: 1 }, parameters: {} }] };
const capacity = { executionSlots: 4, inFlightSlots: 4 };

async function project(root: string, name: string, scopes: readonly string[], granted: readonly string[], extra: readonly ('output' | 'approvals')[] = []) {
  const dir = join(root, name); await mkdir(join(dir, '.deckent'), { recursive: true, mode: 0o700 });
  const config = { layout: { root: join(root, name + '-data') }, inspection: { workers: { sources: [] as { id: string; kind: string; path: string; scopeId: string }[] } } };
  const configPath = join(dir, '.deckent/config.json'); await writeFile(configPath, JSON.stringify(config));
  const options = { env: { HOME: join(root, 'home') } };
  const opened = await openConfiguredAttemptStore(dir, options); opened.store.close();
  await writeFile(productResourcePath(opened.layout, 'policy'), JSON.stringify({ schemaVersion: 1, revision: 'monitor', restrictions: [], grants: [
    { id: 'inspect', effect: 'allow', scopes: [...granted], principals: [{ issuer: hostname(), subject: String(userInfo().uid) }], actions: ['inspect'], resource: { kind: 'scope', ids: [...granted] } },
    ...(extra.includes('output') ? [{ id: 'output', effect: 'allow', scopes: [...granted], principals: [{ issuer: hostname(), subject: String(userInfo().uid) }], actions: ['read-output'], resource: { kind: 'attempt', ids: 'all' } }] : []),
    ...(extra.includes('approvals') ? [{ id: 'approvals', effect: 'allow', scopes: [...granted], principals: [{ issuer: hostname(), subject: String(userInfo().uid) }], actions: ['inspect'], resource: { kind: 'approval', ids: [...granted] } }] : []),
  ] }), { mode: 0o600 });
  const store = await openSqliteAttemptStore(opened.path, { busyTimeoutMs: 100, journalMode: 'wal', durability: 'full' }, { now: Date.now, timeoutMs: 86400000 }, 'allow', custodyProfiles);
  try {
    await store.createExecutionPool({ schemaVersion: 1, poolId: 'p', capacity });
    for (const [index, scopeId] of scopes.entries()) {
      const runId = `${name}-${scopeId}`;
      await store.createRun({ commandId: 'create-' + runId, actor, identity: { scopeId, runId, layoutRevision: 'layout' }, graph, execution: fixtureExecution(graph),
        now: 10_000 + index, policy: { schemaVersion: 2, poolId: 'p', capacity, ordering: ['t'] } });
      if (index !== 0) continue;
      // The first scope's Run is reserved and claimed (launch still pending); every other Run is never dispatched.
      const identity = { scopeId, runId, taskId: 't', attemptId: runId + '-t', layoutRevision: 'layout', generation: 1 };
      await store.reserveRunTasks({ commandId: 'reserve-' + runId, actor, scopeId, runId, expectedRevision: 0, now: 20_000, identities: [identity] });
      await store.claimDispatch(dispatchAdmission({ owner: 'worker', request: { protocolVersion: 1, identity, workspace: '/monitor-fixture', argv: ['x'] } }));
    }
  } finally { store.close(); }
  return { dir, config, configPath, options, ledger: opened.path, layout: opened.layout };
}
const files = async (path: string) => Promise.all(['', '-wal'].map(async suffix => {
  try { const info = await stat(path + suffix); return { suffix, mtimeMs: info.mtimeMs, bytes: (await readFile(path + suffix)).toString('base64') }; }
  catch { return { suffix, missing: true }; }
}));
/** Read-only proof: the ledger file is byte- and mtime-identical; its WAL is unchanged, or — when no writer had it open — created empty by
 * SQLite's WAL reader bookkeeping (no frame, so no content), as for the existing read-only inventory reader. */
const unchanged = (before: Awaited<ReturnType<typeof files>>, after: Awaited<ReturnType<typeof files>>) => {
  expect(after[0]).toEqual(before[0]);
  if (!('missing' in before[1]!) || 'missing' in after[1]!) expect(after[1]).toEqual(before[1]); else expect(after[1]).toMatchObject({ bytes: '' });
};

describe.skipIf(process.platform === 'win32')('inspectMonitor composition', () => {
  it('lists never-dispatched Runs of every admitted scope across installs, read-only, without a running service', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deckent-monitor-')); roots.push(root);
    const current = await project(root, 'current', ['s', 's2', 'hidden'], ['s', 's2']), other = await project(root, 'other', ['s'], ['s']);
    const gone = join(root, 'gone');
    current.config.inspection.workers.sources = [{ id: 'dogfood', kind: 'next-project', path: other.dir, scopeId: 's' },
      { id: 'legacy', kind: 'legacy-tasks', path: join(root, 'legacy'), scopeId: 's' }, { id: 'gone', kind: 'next-project', path: gone, scopeId: 's' }];
    await writeFile(current.configPath, JSON.stringify(current.config)); clearConfigCache();
    const before = [await files(current.ledger), await files(other.ledger)];
    const snapshot = await inspectMonitor(current.dir, current.options);
    unchanged(before[0]!, await files(current.ledger)); unchanged(before[1]!, await files(other.ledger));
    await expect(stat(gone)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(snapshot).toMatchObject({ schemaVersion: 1, control: 'observe-only' }); expect(snapshot.installs.map(install => install.id)).toEqual(['current', 'dogfood', 'gone']);
    const [mine, dogfood, missing] = snapshot.installs;
    expect(mine).toMatchObject({ path: current.dir, status: 'available', scopeIds: ['s', 's2'], ledgerVersion: CURRENT_LEDGER_VERSION, service: { state: 'stopped', build: null } });
    expect(mine!.diagnostics).toContain('scope-denied:hidden');
    const runs = Object.fromEntries(mine!.runs.map(run => [run.runId, run]));
    expect(Object.keys(runs).sort()).toEqual(['current-s', 'current-s2']);
    expect(runs['current-s2']).toMatchObject({ scopeId: 's2', state: 'progressing', createdAtMs: 10_001, phaseCounts: { pending: 1 },
      blocker: { code: 'none', taskId: 't', detail: 'reservation-pending' }, tasks: [{ taskId: 't', phase: 'pending', attempts: 0, lastAttempt: null }] });
    expect(runs['current-s']).toMatchObject({ state: 'progressing', blocker: { code: 'none', detail: 'launch-pending', sinceMs: 20_000 },
      tasks: [{ phase: 'active', attempts: 1, lastAttempt: { attemptId: 'current-s-t', launch: 'pending', startedAtMs: null } }] });
    expect(mine!.workers.map(worker => worker.identity?.attemptId)).toEqual(['current-s-t']);
    expect(mine!.pools).toMatchObject([{ poolId: 'p', capacity: 4, inFlight: 1, held: false, executionCapacity: 4, executing: 1 }]);
    expect(dogfood).toMatchObject({ path: other.dir, status: 'available', scopeIds: ['s'], service: { state: 'stopped' } });
    expect(dogfood!.runs.map(run => run.runId)).toEqual(['other-s']);
    expect(missing).toMatchObject({ status: 'unavailable', runs: [], service: { state: expect.stringMatching(/stopped|unknown/) } });
    expect(missing!.diagnostics.some(code => code.startsWith('ledger-unavailable:'))).toBe(true);
  });
  it('reports a fully denied install as denied instead of failing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deckent-monitor-')); roots.push(root);
    const current = await project(root, 'current', ['s'], ['other-scope']);
    const snapshot = await inspectMonitor(current.dir, current.options);
    expect(snapshot.installs[0]).toMatchObject({ status: 'denied', runs: [], approvals: [], pools: [], scopeIds: [] });
    expect(snapshot.installs[0]!.diagnostics).toContain('scope-denied:s');
  });
  it('opt-in open filter: finished dispatches come from the ledger only (no Docker/sidecar/authorization reads); the default listing is unchanged', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deckent-monitor-')); roots.push(root);
    const current = await project(root, 'current', ['s'], ['s']);
    const store = await openSqliteAttemptStore(current.ledger, { busyTimeoutMs: 100, journalMode: 'wal', durability: 'full' }, { now: Date.now, timeoutMs: 86400000 }, 'allow', custodyProfiles);
    try {
      const identity = { scopeId: 's', runId: 'r-done', taskId: 't', attemptId: 'done-t', layoutRevision: 'layout', generation: 1 };
      await store.createRun({ commandId: 'create-r-done', actor, identity: { scopeId: 's', runId: 'r-done', layoutRevision: 'layout' }, graph, execution: fixtureExecution(graph),
        now: 10_500, policy: { schemaVersion: 2, poolId: 'p', capacity, ordering: ['t'] } });
      await store.reserveRunTasks({ commandId: 'reserve-r-done', actor, scopeId: 's', runId: 'r-done', expectedRevision: 0, now: 20_500, identities: [identity] });
      const claim = { owner: 'worker', request: { protocolVersion: 1 as const, identity, workspace: '/monitor-fixture-done', argv: ['x'] } };
      await store.claimDispatch(dispatchAdmission(claim)); await grantTestLaunch(store, claim, 30_000);
      await store.finishDispatch(claim, { handle: 'h-done', exitCode: 3, interrupted: false });
    } finally { store.close(); }
    const query = { schemaVersion: 1 as const, scopeId: 's', source: 'current' };
    const byId = (list: readonly { identity: { attemptId: string } | null }[]) => Object.fromEntries(list.map(worker => [worker.identity!.attemptId, worker]));
    const all = byId((await inspectConfiguredWorkers(current.dir, query, current.options)).sources[0]!.workers);
    const open = byId((await inspectConfiguredWorkers(current.dir, { ...query, open: true }, current.options)).sources[0]!.workers);
    // Default: every entry goes through the attempt read-output decision (denied here) and Docker/sidecar inspection.
    expect(all['done-t']).toMatchObject({ terminal: { exitCode: 3 }, diagnostics: ['output-denied'] });
    expect(open['done-t']).toEqual({ ...all['done-t'], diagnostics: ['info:ledger-only'] });
    expect(open['current-s-t']).toEqual(all['current-s-t']);
    const monitor = (await inspectMonitor(current.dir, current.options)).installs[0]!;
    expect(monitor.workers.find(worker => worker.identity?.attemptId === 'done-t')).toMatchObject({ terminal: { exitCode: 3 }, diagnostics: ['info:ledger-only'] });
    expect(monitor.runs.find(run => run.runId === 'r-done')!.tasks[0]!.lastAttempt).toMatchObject({ exitCode: 3, startedAtMs: 30_000 });
  });
  it.skipIf(process.platform !== 'linux')('describes the service with one current-protocol attempt: an unanswering endpoint is unknown + diagnostic, no version fan-out', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deckent-monitor-')); roots.push(root);
    const current = await project(root, 'current', ['s'], ['s']); const endpoint = productResourcePath(current.layout, 'runtimeSocket');
    await mkdir(join(endpoint, '..'), { recursive: true, mode: 0o700 });
    let connections = 0; const sockets: Socket[] = [];
    const peer = createServer(socket => { connections++; sockets.push(socket); socket.on('error', () => undefined); socket.destroy(); });
    await new Promise<void>(done => peer.listen(endpoint, () => done())); await chmod(endpoint, 0o600);
    try {
      await expect(createConfiguredRuntimeClient(current.dir, current.options).describeService()).rejects.toMatchObject({ code: 'LOCAL_RUNTIME_TRANSPORT' });
      const windowed = connections; expect(windowed).toBeGreaterThan(1); connections = 0;
      await expect(createConfiguredRuntimeClient(current.dir, current.options).describeService(undefined, 'current')).rejects.toMatchObject({ code: 'LOCAL_RUNTIME_TRANSPORT' });
      expect(connections).toBe(1); connections = 0;
      const install = (await inspectMonitor(current.dir, current.options)).installs[0]!;
      expect(install.service).toEqual({ state: 'unknown', instanceId: null, processId: null, build: null });
      expect(install.diagnostics).toContain('service-unavailable:LOCAL_RUNTIME_TRANSPORT'); expect(connections).toBe(1);
    } finally { sockets.forEach(socket => socket.destroy()); await new Promise(done => peer.close(done)); }
  });
  it('v1.1: a failed attempt shows the first failing line of its recorded output, and the install map names layers, policy and memory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deckent-monitor-')); roots.push(root);
    const current = await project(root, 'current', ['s'], ['s'], ['output']);
    const artifacts = new FileArtifactStore({ root: await prepareProductDirectory(current.layout, 'artifacts'), maxBytes: 1_048_576 });
    const store = await openSqliteAttemptStore(current.ledger, { busyTimeoutMs: 100, journalMode: 'wal', durability: 'full' }, { now: Date.now, timeoutMs: 86400000 }, 'allow', custodyProfiles);
    const identity = { scopeId: 's', runId: 'r-fail', taskId: 't', attemptId: 'fail-t', layoutRevision: 'layout', generation: 1 };
    try {
      await store.createRun({ commandId: 'create-r-fail', actor, identity: { scopeId: 's', runId: 'r-fail', layoutRevision: 'layout' }, graph, execution: fixtureExecution(graph),
        now: 10_700, policy: { schemaVersion: 2, poolId: 'p', capacity, ordering: ['t'] } });
      await store.reserveRunTasks({ commandId: 'reserve-r-fail', actor, scopeId: 's', runId: 'r-fail', expectedRevision: 0, now: 20_700, identities: [identity] });
      const claim = { owner: 'worker', request: { protocolVersion: 1 as const, identity, workspace: '/monitor-fixture-fail', argv: ['x'] } };
      await store.claimDispatch(dispatchAdmission(claim)); await grantTestLaunch(store, claim, 30_700);
      const stdout = 'lint-arch: 870 src files\n\u001b[31m✗ [unit-budget] src/surfaces/core/cli — 2025 lines > unit budget 2000\u001b[39m\ncore-memory: 0 violation(s)\n';
      await store.retainDispatchOutput(claim, await artifacts.put('s', new TextEncoder().encode(JSON.stringify({ schemaVersion: 1, identity, completeness: 'complete', stdout, stderr: '' }))));
      await store.finishDispatch(claim, { handle: 'h-fail', exitCode: 1, interrupted: false });
      const event = { schemaVersion: 1, sequence: 1, atMs: 5, kind: 'tool.call', toolId: 't1', name: 'Bash', toolClass: 'shell', target: 'npm test', detail: null };
      await store.saveWorkerEventLog({ schemaVersion: 1, identity, events: await artifacts.put('s', new TextEncoder().encode(JSON.stringify(event) + '\n')), eventCount: 1, sealedAt: 40_000 });
    } finally { store.close(); }
    const install = (await inspectMonitor(current.dir, current.options)).installs[0]!;
    const failed = install.runs.find(run => run.runId === 'r-fail')!;
    expect(failed.tasks[0]!.lastAttempt).toMatchObject({ exitCode: 1, provider: 'test-supervisor', firstFailure: '✗ [unit-budget] src/surfaces/core/cli — 2025 lines > unit budget 2000' });
    expect(failed.tasks[0]!.lastAttempt).toMatchObject({ endedAtMs: 40_000, recentEvents: [{ atMs: 5, kind: 'tool.call', summary: 'shell Bash npm test' }] });
    expect(install.runs[0]!.runId).toBe('r-fail');
    expect(install.map).toMatchObject({ memory: { available: false }, models: [], registry: { profiles: [], kinds: [] },
      policy: { grants: 2, byResourceKind: { scope: 1, attempt: 1 }, separationOfDuties: 0, permissionModes: [] } });
    expect(install.map!.config.map(layer => layer.layer)).toEqual(['default', 'global', 'project', 'environment']);
    expect(install.map!.config[2]).toMatchObject({ path: current.configPath, sections: ['inspection', 'layout'] });
    expect(JSON.stringify(install.map)).not.toContain(join(root, 'current-data'));
  });
});
describe.skipIf(process.platform === 'win32')('inspectMonitor content authorization (security)', () => {
  async function failedAttempt(current: Awaited<ReturnType<typeof project>>) {
    const artifacts = new FileArtifactStore({ root: await prepareProductDirectory(current.layout, 'artifacts'), maxBytes: 1_048_576 });
    const store = await openSqliteAttemptStore(current.ledger, { busyTimeoutMs: 100, journalMode: 'wal', durability: 'full' }, { now: Date.now, timeoutMs: 86400000 }, 'allow', custodyProfiles);
    const identity = { scopeId: 's', runId: 'r-fail', taskId: 't', attemptId: 'fail-t', layoutRevision: 'layout', generation: 1 };
    try {
      await store.createRun({ commandId: 'create-r-fail', actor, identity: { scopeId: 's', runId: 'r-fail', layoutRevision: 'layout' }, graph, execution: fixtureExecution(graph),
        now: 10_700, policy: { schemaVersion: 2, poolId: 'p', capacity, ordering: ['t'] } });
      await store.reserveRunTasks({ commandId: 'reserve-r-fail', actor, scopeId: 's', runId: 'r-fail', expectedRevision: 0, now: 20_700, identities: [identity] });
      const claim = { owner: 'worker', request: { protocolVersion: 1 as const, identity, workspace: '/monitor-fixture-fail', argv: ['x'] } };
      await store.claimDispatch(dispatchAdmission(claim)); await grantTestLaunch(store, claim, 30_700);
      const output = await artifacts.put('s', new TextEncoder().encode(JSON.stringify({ schemaVersion: 1, identity, completeness: 'complete', stdout: '✗ [secret-rule] confidential detail', stderr: '' })));
      await store.retainDispatchOutput(claim, output); await store.finishDispatch(claim, { handle: 'h-fail', exitCode: 1, interrupted: false });
      const events = await artifacts.put('s', new TextEncoder().encode(JSON.stringify({ schemaVersion: 1, sequence: 1, atMs: 5, kind: 'tool.call', toolId: 't1', name: 'Bash',
        toolClass: 'shell', target: 'confidential', detail: null }) + '\n'));
      await store.saveWorkerEventLog({ schemaVersion: 1, identity, events, eventCount: 1, sealedAt: 40_000 });
      return { output, events };
    } finally { store.close(); }
  }
  it('security: without attempt read-output no recorded output or worker event is read; the attempt says output-denied', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deckent-monitor-')); roots.push(root);
    const current = await project(root, 'current', ['s'], ['s']); const { output, events } = await failedAttempt(current);
    // Remove the stored bytes: any read attempt would surface as attempt-files-unavailable instead of a clean denial.
    const directory = join(await prepareProductDirectory(current.layout, 'artifacts'), createHash('sha256').update('s').digest('hex'));
    await rm(join(directory, output.digest)); await rm(join(directory, events.digest));
    const install = (await inspectMonitor(current.dir, current.options)).installs[0]!;
    const attempt = install.runs.find(run => run.runId === 'r-fail')!.tasks[0]!.lastAttempt!;
    expect(attempt).toMatchObject({ exitCode: 1, firstFailure: null, diagnostics: ['output-denied'] }); expect(attempt.recentEvents).toBeUndefined();
    expect(install.diagnostics.filter(code => code.startsWith('attempt-files-unavailable'))).toEqual([]);
    expect(JSON.stringify(install)).not.toContain('confidential');
  });
  it('security: approval summaries need the approval list decision; without it the summary text is withheld', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deckent-monitor-')); roots.push(root);
    const insert = async (ledger: string) => {
      const record = { request: { schemaVersion: 1, approvalId: 'ap-1', scopeId: 's', runId: 'current-s', taskId: 't', requester: { id: 'r', issuer: 'test', subject: 'r' },
        actionDigest: 'a'.repeat(64), policyRevision: 'p1', summary: 'confidential approval text', createdAt: 1, expiresAt: 9_000_000_000_000 }, revision: 0, status: 'pending', decision: null,
        keyId: 'k1', mac: 'b'.repeat(64) };
      const writer = new DatabaseSync(ledger);
      writer.prepare('INSERT INTO approvals(scope_id,approval_id,subject_kind,run_id,task_id,action_digest,revision,snapshot,current) VALUES(?,?,?,?,?,?,?,?,1)')
        .run('s', 'ap-1', 'task', 'current-s', 't', 'a'.repeat(64), 0, JSON.stringify(record)); writer.close();
    };
    const hidden = await project(root, 'hidden', ['s'], ['s']); await insert(hidden.ledger);
    const withheld = (await inspectMonitor(hidden.dir, hidden.options)).installs[0]!;
    expect(withheld.approvals).toMatchObject([{ approvalId: 'ap-1', summary: '' }]); expect(withheld.diagnostics).toContain('approvals-denied:s');
    expect(JSON.stringify(withheld)).not.toContain('confidential');
    const shown = await project(root, 'shown', ['s'], ['s'], ['approvals']); await insert(shown.ledger);
    expect((await inspectMonitor(shown.dir, shown.options)).installs[0]!.approvals).toMatchObject([{ approvalId: 'ap-1', summary: 'confidential approval text' }]);
  });
  it('a finished attempt without a sealed log ends at its host-observed exit (sidecar), read only under read-output', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deckent-monitor-')); roots.push(root);
    const run = async (name: string, extra: readonly ('output' | 'approvals')[], resultAttempt = 'verify-t') => {
      const current = await project(root, name, ['s'], ['s'], extra);
      const attemptDir = join(root, name + '-attempt'); await mkdir(attemptDir, { mode: 0o700 }); await chmod(attemptDir, 0o700);
      const identity = { scopeId: 's', runId: 'r-verify', taskId: 't', attemptId: 'verify-t', layoutRevision: 'layout', generation: 1 };
      await writeFile(join(attemptDir, 'worker.log'), [JSON.stringify({ schemaVersion: 1, sequence: 1, observedAt: 30_900, process: 'running', terminal: null, outputRecorded: false }),
        JSON.stringify({ schemaVersion: 1, sequence: 2, observedAt: 498_000, process: 'exited', terminal: { handle: 'h', exitCode: 0, interrupted: false }, outputRecorded: true })].join('\n') + '\n', { mode: 0o600 });
      await writeFile(join(attemptDir, 'worker.result'), JSON.stringify({ schemaVersion: 1, identity: { ...identity, attemptId: resultAttempt }, backend: 'docker', provider: 'docker', terminal: { handle: 'h', exitCode: 0, interrupted: false } }), { mode: 0o600 });
      const store = await openSqliteAttemptStore(current.ledger, { busyTimeoutMs: 100, journalMode: 'wal', durability: 'full' }, { now: Date.now, timeoutMs: 86400000 }, 'allow', custodyProfiles);
      try {
        await store.createRun({ commandId: 'create-r-verify', actor, identity: { scopeId: 's', runId: 'r-verify', layoutRevision: 'layout' }, graph, execution: fixtureExecution(graph),
          now: 10_800, policy: { schemaVersion: 2, poolId: 'p', capacity, ordering: ['t'] } });
        await store.reserveRunTasks({ commandId: 'reserve-r-verify', actor, scopeId: 's', runId: 'r-verify', expectedRevision: 0, now: 20_800, identities: [identity] });
        const claim = { owner: 'worker', request: { protocolVersion: 1 as const, identity, workspace: join(attemptDir, 'tree'), argv: ['x'] } };
        await store.claimDispatch(dispatchAdmission(claim)); await grantTestLaunch(store, claim, 30_800);
        await store.finishDispatch(claim, { handle: 'h', exitCode: 0, interrupted: false });
      } finally { store.close(); }
      return (await inspectMonitor(current.dir, current.options)).installs[0]!.runs.find(value => value.runId === 'r-verify')!.tasks[0]!.lastAttempt!;
    };
    expect(await run('granted', ['output'])).toMatchObject({ startedAtMs: 30_800, endedAtMs: 498_000, endedAtSource: 'observed' });
    expect(await run('denied', [])).toMatchObject({ endedAtMs: null, endedAtSource: null, diagnostics: ['output-denied'] });
    // Sidecars bound to another attempt prove nothing about this one.
    expect(await run('mismatch', ['output'], 'other-attempt')).toMatchObject({ endedAtMs: null, endedAtSource: null });
  });
});
