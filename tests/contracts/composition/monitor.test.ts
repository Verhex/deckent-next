import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { hostname, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Socket } from 'node:net';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { chmod } from 'node:fs/promises';
import { main } from '../../../src/surfaces/index.js';
import { type WorkerEvent } from '#domain/index.js';
import { PassThrough, Writable } from 'node:stream';
import { createElement } from 'react';
import { render } from 'ink';
import { resolveWorklinePalette } from '#surfaces/core/terminal-kit/index.js';
import { createConfiguredRuntimeClient, inspectConfiguredWorkers, inspectConfiguredRun, inspectMonitor } from '#composition/index.js';
import { openConfiguredAttemptStore } from '../../../src/composition/core/storage/index.js';
import { openSqliteAttemptStore } from '#adapters/index.js';
import { CURRENT_LEDGER_VERSION } from '#adapters/core/sqlite-ledger/index.js';
import { loadConfig, clearConfigCache, prepareProductDirectory, productResourcePath } from '#platform/index.js';
import { readMonitorRunResults, FileArtifactStore } from '#adapters/index.js';
import { loadMonitorSurface } from '#surfaces/core/monitor/index.js';
import { patchExclusions, patchFile } from '#engine/index.js';
import { fixtureExecution } from '../support/execution-registry.js';
import { custodyProfiles, dispatchAdmission, grantTestLaunch } from '../support/custody.js';

// MONITOR-DATA: the one composed monitor snapshot over real project ledgers (current + a configured next-project source).
beforeEach(context => {
  if (process.platform === 'win32') context.skip('LOCAL_OS_PRINCIPAL_UNSUPPORTED: monitor policy fixture requires verified POSIX UID; native local capability refusal is tested separately');
});
const roots: string[] = [];
afterEach(async () => { clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const actor = { id: 'fixture', issuer: 'test', subject: 'service' };
const graph = { schemaVersion: 2 as const, revision: 1, tasks: [{ id: 't', kind: 'fixture', dependencies: [], acceptanceCriteria: ['verified'] }],
  criterionDefinitions: [{ id: 'verified', version: 1, description: 'fixture', evaluator: { id: 'test', version: 1 }, parameters: {} }] };
const capacity = { executionSlots: 4, inFlightSlots: 4 };

async function project(root: string, name: string, scopes: readonly string[], granted: readonly string[], extra: readonly ('output' | 'approvals' | 'runs')[] = [], workspace = '/monitor-fixture') {
  const dir = join(root, name); await mkdir(join(dir, '.deckent'), { recursive: true, mode: 0o700 });
  const config = { layout: { root: join(root, name + '-data') }, inspection: { workers: { sources: [] as { id: string; kind: string; path: string; scopeId: string }[] } } };
  const configPath = join(dir, '.deckent/config.json'); await writeFile(configPath, JSON.stringify(config));
  const options = { env: { HOME: join(root, 'home') } };
  const opened = await openConfiguredAttemptStore(dir, options); opened.store.close();
  await writeFile(productResourcePath(opened.layout, 'policy'), JSON.stringify({ schemaVersion: 1, revision: 'monitor', restrictions: [], grants: [
    { id: 'inspect', effect: 'allow', scopes: [...granted], principals: [{ issuer: hostname(), subject: String(userInfo().uid) }], actions: ['inspect'], resource: { kind: 'scope', ids: [...granted] } },
    ...(extra.includes('runs') ? [{ id: 'runs', effect: 'allow', scopes: [...granted], principals: [{ issuer: hostname(), subject: String(userInfo().uid) }], actions: ['inspect'], resource: { kind: 'run', ids: 'all' } }] : []),
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
      await store.claimDispatch(dispatchAdmission({ owner: 'worker', request: { protocolVersion: 1, identity, workspace, argv: ['x'] } }));
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

describe('inspectMonitor composition', () => {
  it('shows the installation ceiling as effective pool capacities while retaining actual occupancy', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deckent-monitor-ceiling-')); roots.push(root);
    const current = await project(root, 'current', ['s'], ['s']);
    await writeFile(current.configPath, JSON.stringify({ ...current.config, max_workers: 1 })); clearConfigCache();
    const snapshot = await inspectMonitor(current.dir, current.options);
    expect(snapshot.installs[0]!.pools).toMatchObject([{ poolId: 'p', capacity: 1, inFlight: 1, executionCapacity: 1, executing: 1 }]);
    await writeFile(current.configPath, JSON.stringify({ ...current.config, max_workers: 'auto' })); clearConfigCache();
    expect((await inspectMonitor(current.dir, current.options)).installs[0]!.pools).toMatchObject([{ poolId: 'p', capacity: 4, executionCapacity: 4 }]);
  });
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
    expect(mine).toMatchObject({ path: current.dir, status: 'available', scopeIds: ['s', 's2'], ledgerVersion: CURRENT_LEDGER_VERSION, service: { state: process.platform === 'linux' ? 'stopped' : 'unknown', build: null } });
    expect(mine!.diagnostics).toContain('scope-denied:hidden');
    if (process.platform !== 'linux') expect(mine!.diagnostics).toContain('service-unavailable:LOCAL_RUNTIME_UNSUPPORTED');
    const runs = Object.fromEntries(mine!.runs.map(run => [run.runId, run]));
    expect(Object.keys(runs).sort()).toEqual(['current-s', 'current-s2']);
    expect(runs['current-s2']).toMatchObject({ scopeId: 's2', state: 'progressing', createdAtMs: 10_001, phaseCounts: { pending: 1 },
      blocker: { code: 'none', taskId: 't', detail: 'reservation-pending' }, tasks: [{ taskId: 't', phase: 'pending', attempts: 0, lastAttempt: null }] });
    expect(runs['current-s']).toMatchObject({ state: 'progressing', blocker: { code: 'none', detail: 'launch-pending', sinceMs: 20_000 },
      tasks: [{ phase: 'active', attempts: 1, lastAttempt: { attemptId: 'current-s-t', launch: 'pending', startedAtMs: null } }] });
    expect(mine!.workers.map(worker => worker.identity?.attemptId)).toEqual(['current-s-t']);
    expect(mine!.pools).toMatchObject([{ poolId: 'p', capacity: 4, inFlight: 1, held: false, executionCapacity: 4, executing: 1 }]);
    expect(dogfood).toMatchObject({ path: other.dir, status: 'available', scopeIds: ['s'], service: { state: process.platform === 'linux' ? 'stopped' : 'unknown' } });
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
  it('describes the service with one current-protocol attempt: an unanswering endpoint is unknown + diagnostic, no version fan-out', async context => {
    if (process.platform !== 'linux') context.skip('LOCAL_RUNTIME_UNSUPPORTED: authenticated runtime socket and live peer identity require Linux');
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
describe('inspectMonitor content authorization (security)', () => {
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
    const run = async (name: string, extra: readonly ('output' | 'approvals' | 'runs')[], resultAttempt = 'verify-t') => {
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
    expect(await run('granted', ['output'])).toMatchObject({ startedAtMs: 30_800,
      endedAtMs: process.platform === 'linux' ? 498_000 : null, endedAtSource: process.platform === 'linux' ? 'observed' : null });
    // macOS has no /proc/self/fd custody: the same sidecar cannot prove a host-observed end there.
    expect(await run('denied', [])).toMatchObject({ endedAtMs: null, endedAtSource: null, diagnostics: ['output-denied'] });
    // Sidecars bound to another attempt prove nothing about this one.
    expect(await run('mismatch', ['output'], 'other-attempt')).toMatchObject({ endedAtMs: null, endedAtSource: null });
  });
});

// MONITOR-H1: retained artifacts survive finished-worker sidecar release on the real composed read path.
describe('monitor human worker evidence', () => {
  it.each([{ allowed: true, count: 0, transcript: 'sealed', noChange: false }, { allowed: true, count: 1, transcript: 'missing', noChange: false }, { allowed: true, count: 1, transcript: 'invalid', noChange: false }, { allowed: false, count: 0, transcript: 'sealed', noChange: false }, { allowed: true, count: 0, transcript: 'sealed', noChange: true }])('reads retained results/claims with $allowed / $count files / $transcript transcript', async ({ allowed, count, transcript, noChange }) => {
    const root = await mkdtemp(join(tmpdir(), 'deckent-monitor-h1-')); roots.push(root);
    const current = await project(root, 'current', ['s'], ['s'], allowed ? ['output', 'runs'] : ['runs']);
    const input = { schemaVersion: 1 as const, task: 'Fix the worker result', scope: { paths: ['src/**'] }, acceptance: 'No missing results',
      model: { channelId: 'fixture', modelId: 'fixture-model-1', auxiliaryModelIds: [] }, effort: 'high' as const, noChangeAllowed: !noChange };
    const humanGraph = { ...graph, schemaVersion: 3 as const, tasks: graph.tasks.map(task => ({ ...task, workInput: input })) };
    const identity = { scopeId: 's', runId: 'r-human', taskId: 't', attemptId: 'human-t', layoutRevision: 'layout', generation: 1 };
    const store = await openSqliteAttemptStore(current.ledger, { busyTimeoutMs: 100, journalMode: 'wal', durability: 'full' }, { now: Date.now, timeoutMs: 86400000 }, 'allow', custodyProfiles);
    const artifacts = new FileArtifactStore({ root: await prepareProductDirectory(current.layout, 'artifacts'), maxBytes: 1_048_576 });
    try {
      await store.createRun({ commandId: 'create-human', actor, identity: { scopeId: 's', runId: 'r-human', layoutRevision: 'layout' }, graph: humanGraph, execution: fixtureExecution(graph), now: 10_000,
        policy: { schemaVersion: 2, poolId: 'p', capacity, ordering: ['t'] } });
      await store.reserveRunTasks({ commandId: 'reserve-human', actor, scopeId: 's', runId: 'r-human', expectedRevision: 0, now: 20_000, identities: [identity] });
      const claim = { owner: 'worker', request: { protocolVersion: 1 as const, identity, workspace: join(root, 'gone', 'workspace'), argv: ['x'] } };
      await store.claimDispatch(dispatchAdmission(claim)); await grantTestLaunch(store, claim, 30_000);
      const report = { schemaVersion: 1, kind: 'native-worker-report', status: 'reported', report: { schemaVersion: 1, summary: 'tests passed secret=private-value', changedFiles: [], checks: [{ command: 'test', outcome: 'passed' }], openIssues: [] } };
      await store.retainDispatchOutput(claim, await artifacts.put('s', Buffer.from(JSON.stringify({ schemaVersion: 1, identity, completeness: 'complete', stdout: JSON.stringify(report), stderr: '' }))));
      const events = [{ schemaVersion: 1, sequence: 1, atMs: 5, kind: 'message', role: 'assistant', excerpt: 'checked secret=private-value', textBytes: 34, thinking: false },
        { schemaVersion: 1, sequence: 2, atMs: 7, kind: 'session.ended', outcome: 'success', turns: 3, durationMs: 2000, apiDurationMs: null, costUsd: null, costBasis: null, tokens: null, permissionDenials: 0 }];
      if (transcript !== 'missing') await store.saveWorkerEventLog({ schemaVersion: 1, identity, events: await artifacts.put('s', Buffer.from(transcript === 'invalid' ? 'broken log' : events.map(e => JSON.stringify(e)).join('\n') + '\n')), eventCount: 2, sealedAt: 40_000 });
      await store.finishDispatch(claim, { handle: 'human-handle', exitCode: 0, interrupted: false });
      const patchReceipt = await artifacts.put('s', Buffer.from(JSON.stringify({ schemaVersion: 1, kind: 'workspace-patch', identity,
        source: { schemaVersion: 1, adapter: { id: 'fixture', version: 1 }, sourceFingerprint: 'a'.repeat(64) }, baseCommit: 'b'.repeat(40), snapshotDigest: 'c'.repeat(64), exclusions: patchExclusions,
        changes: count ? [{ path: 'note.txt', before: null, after: patchFile(Buffer.from('written'), '100644') }] : [] })));
      await store.retainDispatchPatch(claim, patchReceipt);
      const dispatch = (await store.readDispatch(claim.request))!, run = (await store.loadRun('s', 'r-human'))!;
      await store.commitTaskEvaluation({ commandId: 'evaluate-human', actor, expectedRevision: run.revision, dispatch,
        evaluation: { schemaVersion: 1, evaluationId: 'evaluate-human', identity, graphRevision: 1, attemptRevision: 1, criteria: [{ criterionId: 'verified', verdict: noChange ? 'pass' : 'fail', evidenceIds: ['fixture-failure'] }], ...(noChange ? { workspaceChange: { schemaVersion: 1, patchDigest: patchReceipt.digest, changedFiles: 0 } } : {}) } });
    } finally { store.close(); }
    const before = await files(current.ledger), configBefore = await readFile(current.configPath);
    const snapshot = await inspectMonitor(current.dir, current.options), install = snapshot.installs[0]!;
    const inspected = await inspectConfiguredRun(current.dir, { schemaVersion: 1, scopeId: 's', runId: 'r-human' }, current.options);
    expect(inspected.run!.tasks[0]!.taskBrief).toMatchObject({ schemaVersion: 1, task: input.task, scopePaths: ['src/**'], acceptance: input.acceptance, effort: 'high', contextRefs: [] });
    expect(inspected.run!.tasks[0]!.resultBrief).toMatchObject({ schemaVersion: 1, claimLabel: 'CLAIM', evaluation: { verdict: 'rejected' }, openIssues: allowed ? [] : null });
    expect(install.workers.find(worker => worker.identity?.attemptId === identity.attemptId)!.human!.taskBrief).toEqual(inspected.run!.tasks[0]!.taskBrief);
    const config = await loadConfig(current.dir, { ...current.options, heal: false });
    for (const expected of [{ revision: inspected.run!.revision + 1, layoutRevision: inspected.run!.layoutRevision }, { revision: inspected.run!.revision, layoutRevision: 'foreign-layout' }]) {
      let outputDecisions = 0;
      const refused = await readMonitorRunResults(config, current.options.env, { scopeId: 's', runId: 'r-human' }, expected, async () => { outputDecisions++; return true; });
      expect(refused.size).toBe(0); expect(outputDecisions).toBe(0);
    }

    const humanText = (await loadMonitorSurface()).renderMonitorText(snapshot, { locale: 'tr', width: 80, ascii: true });
    const worker = install.workers.find(w => w.identity?.attemptId === identity.attemptId)!;
    if (allowed) {
      expect(worker).toMatchObject({ human: { transcript: { state: transcript === 'invalid' ? 'unavailable' : transcript }, patch: { state: 'recorded', fileCount: count, files: count ? ['note.txt'] : [] }, finalReport: { status: 'reported' }, evaluation: 'rejected', title: input.task, titleEvidence: 'task' } });
      if (transcript === 'sealed') expect(worker).toMatchObject({ usageEvidence: 'sealed', usage: { turns: 3 } });
      else expect(worker).not.toHaveProperty('usage');
      expect(JSON.stringify(worker)).toContain('tests passed');
      expect(humanText).toContain('İDDİA'); expect(humanText).toContain('tests passed'); expect(humanText).toContain('Değerlendirme: ret');
      if (noChange) expect(worker.human!.resultBrief!.evaluation.reason).toBe('no-change-produced');
      else expect(humanText).toContain(count ? 'note.txt' : 'Boş yama');
      expect(humanText).not.toContain('private-value');
      expect(JSON.stringify(worker)).not.toContain('private-value');
    } else {
      expect(worker).not.toHaveProperty('usage');
      expect(worker).toMatchObject({ human: { transcript: { state: 'denied' }, finalReport: null } });
      expect(JSON.stringify(worker)).not.toContain('tests passed');
      expect(humanText).toContain('policy izin vermedi'); expect(humanText).not.toContain('tests passed');
    }
    for (const lang of ['en', 'tr']) {
      let output = ''; const stdout = new Writable({ write(chunk, _encoding, done) { output += chunk.toString(); done(); } });
      expect(await main(['run', 'inspect', '--scope', 's', '--id', 'r-human', '--lang', lang, '--no-color'], { root: current.dir, env: current.options.env, stdout, inspectRun: inspectConfiguredRun })).toBe(0);
      expect(output).toContain(input.task); expect(output).toContain('src/**');
      if (allowed) expect(output).toContain(lang === 'en' ? 'CLAIM' : 'İDDİA');
      expect(output).not.toContain('private-value'); expect(output).not.toContain('\u001b');
    }
    unchanged(before, await files(current.ledger)); expect(await readFile(current.configPath)).toEqual(configBefore);
    await expect(stat(join(root, 'gone'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

// REVIEW 2304: real ledger/artifact + live sidecar producers, composed through the production observation and monitor paths.
describe('MONITOR-H1-R usage evidence', () => {
  const start: WorkerEvent = { schemaVersion: 1, sequence: 1, atMs: 1, kind: 'session.started', provider: 'codex', model: null, cliVersion: null };
  const tokenEvent = (amount: number | null, ended = false): WorkerEvent[] => amount === null && !ended ? [start] : [start, ended
    ? { schemaVersion: 1, sequence: 2, atMs: 2, kind: 'session.ended', outcome: 'success', turns: 2, durationMs: 1000, apiDurationMs: null,
      costUsd: amount === null ? null : amount === 0 ? 0 : amount === 987 ? 0.1234 : 0.0017, costBasis: null, tokens: amount === null ? null : { input: amount, output: amount, cacheRead: 0, cacheWrite: 0, thinking: null }, permissionDenials: 0 }
    : { schemaVersion: 1, sequence: 2, atMs: 2, kind: 'usage', tokens: { input: amount!, output: amount!, cacheRead: 0, cacheWrite: 0, thinking: null } }];
  async function evidence(sealed: readonly WorkerEvent[] | 'invalid' | 'mismatch' | 'unreadable' | 'unavailable' | null, live: readonly WorkerEvent[], finished = false) {
    const root = await mkdtemp(join(tmpdir(), 'deckent-monitor-h1-r-')); roots.push(root);
    const directory = join(root, 'attempt'); await mkdir(directory, { mode: 0o700 });
    const current = await project(root, 'current', ['s'], ['s'], ['output'], join(directory, 'workspace'));
    const identity = { scopeId: 's', runId: 'current-s', taskId: 't', attemptId: 'current-s-t', layoutRevision: 'layout', generation: 1 };
    await writeFile(join(directory, 'worker.events'), live.map(event => JSON.stringify({ receivedAt: Date.now(), event })).join('\n') + '\n', { mode: 0o600 });
    await writeFile(join(directory, 'worker.hb'), JSON.stringify({ identity, provider: 'codex', process: 'running' }), { mode: 0o600 });
    const store = await openSqliteAttemptStore(current.ledger, { busyTimeoutMs: 100, journalMode: 'wal', durability: 'full' }, { now: Date.now, timeoutMs: 86400000 }, 'allow', custodyProfiles);
    const artifactRoot = await prepareProductDirectory(current.layout, 'artifacts');
    const artifacts = new FileArtifactStore({ root: artifactRoot, maxBytes: 1_048_576 });
    try {
      if (sealed !== null) {
        const events = await artifacts.put('s', Buffer.from(typeof sealed === 'string' ? 'broken log' : sealed.map(event => JSON.stringify(event)).join('\n') + '\n'));
        const record = await store.saveWorkerEventLog({ schemaVersion: 1, identity, events, eventCount: typeof sealed === 'string' ? 1 : sealed.length, sealedAt: 40_000 });
        if (sealed === 'unreadable') await rm(join(artifactRoot, createHash('sha256').update('s').digest('hex'), events.digest));
        if (sealed === 'unavailable') {
          const db = new DatabaseSync(current.ledger);
          try { db.exec('ALTER TABLE worker_event_logs RENAME TO unavailable_event_logs'); } finally { db.close(); }
        }
        if (sealed === 'mismatch') {
          const db = new DatabaseSync(current.ledger);
          try { db.prepare('UPDATE worker_event_logs SET record=? WHERE scope_id=? AND attempt_id=?').run(JSON.stringify({ ...record, identity: { ...identity, generation: 2 } }), 's', identity.attemptId); }
          finally { db.close(); }
        }
      }
      if (finished) {
        const claim = { owner: 'worker', request: { protocolVersion: 1 as const, identity, workspace: join(directory, 'workspace'), argv: ['x'] } };
        await grantTestLaunch(store, claim, 30_000); await store.finishDispatch(claim, { handle: 'usage-handle', exitCode: 0, interrupted: false });
      }
    } finally { store.close(); }
    return current;
  }
  async function workers(current: Awaited<ReturnType<typeof project>>, command: 'list' | 'watch', locale: 'en' | 'tr') {
    const out: string[] = [];
    const code = await main(['workers', command, '--scope', 's', '--lang', locale, ...(command === 'watch' ? ['--samples', '1'] : [])], {
      root: current.dir, env: current.options.env, initialize() {}, stdout: { write(value: string) { out.push(value); } }, stderr: { write() {} },
      inspectWorkers: inspectConfiguredWorkers,
    });
    expect(code).toBe(0); return out.join('');
  }
  it.each(['invalid', 'mismatch', 'unreadable', 'unavailable'] as const)('R1: %s sealed + differing live tokens/cost cannot fill usage (unpinned worker, EN/TR list/watch)', async sealed => {
    const current = await evidence(sealed, tokenEvent(987, true));
    const reason = sealed === 'unavailable' ? { en: 'sealed evidence unavailable', tr: 'mühürlü kanıt alınamıyor' } : { en: 'sealed log invalid', tr: 'mühürlü günlük geçersiz' };
    for (const command of ['list', 'watch'] as const) for (const locale of ['en', 'tr'] as const) {
      const text = await workers(current, command, locale);
      expect(text).toContain(reason[locale]);
      expect(text).not.toMatch(/(?:tokens? 987|987 (?:in|giriş))/); expect(text).not.toContain('$0.1234');
    }
    const value = (await inspectConfiguredWorkers(current.dir, { schemaVersion: 1, scopeId: 's' }, current.options)).sources[0]!.workers[0]!;
    expect(value).toMatchObject({ usageEvidence: sealed === 'unavailable' ? 'unavailable' : 'invalid', files: { heartbeat: { state: 'available' }, activity: { phase: 'finished' }, usage: { tokens: { input: 987 } } } });
    expect(value).not.toHaveProperty('usage');
    const snapshot = await inspectMonitor(current.dir, current.options), surface = await loadMonitorSurface();
    for (const locale of ['en', 'tr'] as const) {
      const text = surface.renderMonitorText(snapshot, { locale, width: 120, ascii: true });
      if (sealed === 'unavailable') expect(snapshot.installs[0]).toMatchObject({ status: 'unavailable', workers: [] });
      else {
        expect(text).toContain(reason[locale]); expect(await inkDetail(snapshot, locale)).toContain(reason[locale]);
        const legacyView = { ...snapshot, installs: snapshot.installs.map(install => ({ ...install, workers: install.workers.map(worker => { const { human, ...observation } = worker; void human; return observation; }) })) };
        const detail = surface.buildMonitorView(legacyView, locale, true).tabs.workers.flatMap(block => block.kind === 'table' ? block.rows : [])[0]!.detail().flat().map(span => span.text).join('\n');
        expect(detail).toContain(reason[locale]); expect(detail).not.toMatch(/(?:tokens? 987|987 (?:in|giriş))/);
      }
      expect(text).not.toMatch(/(?:tokens? 987|987 (?:in|giriş))/); expect(text).not.toContain('0.1234');
    }
  });
  async function inkDetail(snapshot: Awaited<ReturnType<typeof inspectMonitor>>, locale: 'en' | 'tr') {
    const surface = await loadMonitorSurface(); let frame = '';
    const stdout = Object.assign(new Writable({ write(chunk, _encoding, done) { if (String(chunk).trim()) frame = String(chunk); done(); } }), { isTTY: true, columns: 120, rows: 36 });
    const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() { return stdin; }, ref() { return stdin; }, unref() { return stdin; } });
    const instance = render(createElement(surface.MonitorApp, { initial: snapshot, load: async () => snapshot, intervalMs: 60_000, locale, ascii: true,
      palette: resolveWorklinePalette('none'), errorText: () => 'unexpected monitor failure', size: { columns: 120, rows: 36 } }),
    { stdout: stdout as NodeJS.WriteStream, stdin: stdin as NodeJS.ReadStream, debug: true, exitOnCtrlC: false, patchConsole: false });
    const settle = () => new Promise(resolve => setTimeout(resolve, 30));
    try { await settle(); stdin.write('3'); await settle(); stdin.write('\r'); await settle(); return frame; }
    finally { instance.unmount(); stdin.destroy(); stdout.destroy(); }
  }
  const cases = (['live', 'sealed', 'finished-sealed'] as const).flatMap(source => [null, 0, 17].flatMap(amount => [false, true].map(ended => ({ source, amount, ended }))));
  it.each(cases)('R2: $source tokens=$amount ended=$ended through production inference → shared JSON/text/Ink detail and list/watch', async ({ source, amount, ended }) => {
    const current = await evidence(source === 'live' ? null : tokenEvent(amount, ended), source === 'live' ? tokenEvent(amount, ended) : tokenEvent(987, true), source === 'finished-sealed');
    const snapshot = await inspectMonitor(current.dir, current.options), worker = snapshot.installs[0]!.workers[0]!, surface = await loadMonitorSurface();
    const expected = amount === null ? '—/—' : `${amount}/${amount}`;
    for (const locale of ['en', 'tr'] as const) {
      expect(surface.renderMonitorText(snapshot, { locale, width: 120, ascii: true })).toContain(`token${locale === 'en' ? 's' : ''} ${expected}`);
      expect(await inkDetail(snapshot, locale)).toContain(`token${locale === 'en' ? 's' : ''} ${expected}`);
      // The Ink detail renderer reads this same production snapshot; no hand-set usage flag.
      const detail = surface.buildMonitorView(snapshot, locale, true).tabs.workers.flatMap(block => block.kind === 'table' ? block.rows : [])[0]!.detail().flat().map(span => span.text).join('\n');
      expect(detail).toContain(`token${locale === 'en' ? 's' : ''} ${expected}`);
      const legacyView = { ...snapshot, installs: snapshot.installs.map(install => ({ ...install, workers: install.workers.map(worker => { const { human, ...observation } = worker; void human; return observation; }) })) };
      const legacyDetail = surface.buildMonitorView(legacyView, locale, true).tabs.workers.flatMap(block => block.kind === 'table' ? block.rows : [])[0]!.detail().flat().map(span => span.text).join('\n');
      const count = amount === null ? '—' : String(amount);
      expect(legacyDetail).toContain(locale === 'en' ? `${count} in / ${count} out tokens` : `${count} giriş / ${count} çıkış token`);
      expect(legacyDetail).not.toMatch(/(?:tokens? 987|987 (?:in|giriş))/);
      for (const command of ['list', 'watch'] as const) {
        const text = await workers(current, command, locale), count = amount === null ? '-' : String(amount);
        expect(text).toContain(locale === 'en' ? `tokens ${count} in / ${count} out` : `token ${count} giriş / ${count} çıkış`);
        expect(text).not.toMatch(/(?:tokens? 987|987 (?:in|giriş))/);
        if (source !== 'live' && ended && amount !== null) { expect(text).toContain(amount === 0 ? '$0.0000' : '$0.0017'); expect(text).not.toContain('$0.1234'); }
      }
    }
    expect(JSON.parse(JSON.stringify(worker))).toMatchObject({ usageEvidence: source === 'live' ? 'live' : 'sealed',
      usage: { tokenUsageRecorded: amount !== null }, human: { tokenUsageRecorded: amount !== null } });
  });
});

// MONITOR-H1B RED: history artifacts must follow the finished-worker viewport, never precede it.
it('reads artifacts only for shown workers when finished history exceeds the limit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deckent-monitor-h1b-')); roots.push(root);
  const current = await project(root, 'current', ['s'], ['s'], ['output']);
  const artifacts = new FileArtifactStore({ root: await prepareProductDirectory(current.layout, 'artifacts'), maxBytes: 1_048_576 });
  const store = await openSqliteAttemptStore(current.ledger, { busyTimeoutMs: 100, journalMode: 'wal', durability: 'full' }, { now: Date.now, timeoutMs: 86400000 }, 'allow', custodyProfiles);
  try {
    await store.createExecutionPool({ schemaVersion: 1, poolId: 'history', capacity: { executionSlots: 64, inFlightSlots: 64 } });
    for (let n = 0; n < 31; n++) {
      const runId = 'history-' + n, identity = { scopeId: 's', runId, taskId: 't', attemptId: runId + '-t', layoutRevision: 'layout', generation: 1 };
      await store.createRun({ commandId: 'create-' + runId, actor, identity: { scopeId: 's', runId, layoutRevision: 'layout' }, graph, execution: fixtureExecution(graph), now: n,
        policy: { schemaVersion: 2, poolId: 'history', capacity: { executionSlots: 64, inFlightSlots: 64 }, ordering: ['t'] } });
      await store.reserveRunTasks({ commandId: 'reserve-' + runId, actor, scopeId: 's', runId, expectedRevision: 0, now: n, identities: [identity] });
      const claim = { owner: 'worker', request: { protocolVersion: 1 as const, identity, workspace: join(root, runId, 'workspace'), argv: ['x'] } };
      await store.claimDispatch(dispatchAdmission(claim)); await grantTestLaunch(store, claim, n);
      await store.retainDispatchOutput(claim, await artifacts.put('s', Buffer.from(JSON.stringify({ schemaVersion: 1, identity, completeness: 'complete', stdout: '', stderr: '' }))));
      await store.saveWorkerEventLog({ schemaVersion: 1, identity, events: await artifacts.put('s', Buffer.from('')), eventCount: 0, sealedAt: n });
      await store.finishDispatch(claim, { handle: runId, exitCode: 0, interrupted: false });
      await store.retainDispatchPatch(claim, await artifacts.put('s', Buffer.from(JSON.stringify({ schemaVersion: 1, kind: 'workspace-patch', identity,
        source: { schemaVersion: 1, adapter: { id: 'fixture', version: 1 }, sourceFingerprint: 'a'.repeat(64) }, baseCommit: 'b'.repeat(40), snapshotDigest: 'c'.repeat(64), exclusions: patchExclusions, changes: [] }))));
    }
  } finally { store.close(); }
  const reads: string[] = [], original = FileArtifactStore.reader;
  const spy = vi.spyOn(FileArtifactStore, 'reader').mockImplementation((...args) => {
    const reader = original(...args);
    return { read: async (scopeId, receipt) => { reads.push(receipt.digest); return reader.read(scopeId, receipt); } };
  });
  try {
    const install = (await inspectMonitor(current.dir, current.options)).installs[0]!;
    expect(install.workers.filter(worker => worker.terminal)).toHaveLength(20);
    expect(install.workers.find(worker => worker.identity?.attemptId === 'history-30-t')).toBeDefined();
    expect(reads).toHaveLength(20 * 3);
    expect(install.diagnostics).toContain('info:workers-finished-capped:11');
  } finally { spy.mockRestore(); }
});
