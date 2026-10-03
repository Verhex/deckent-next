import { mkdtemp, mkdir, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir, hostname, userInfo } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, type TestContext } from 'vitest';
import { FileArtifactStore, readMonitorLedger, openSqliteAttemptStore } from '#adapters/index.js';
import { patchDigest, patchExclusions, projectRunView, projectMonitorRun } from '#engine/index.js';
import { evaluateConfiguredTask } from '../../../src/composition/core/runs/index.js';
import { openConfiguredAttemptStore } from '../../../src/composition/core/storage/index.js';
import { main } from '#surfaces/index.js';
import { inspectMonitor } from '../../../src/composition/core/monitor/index.js';
import { t } from '#platform/index.js';
import { loadMonitorSurface } from '#surfaces/core/monitor/index.js';
import { emptySnapshot } from '../../fixtures/monitor/snapshots.js';
import { clearConfigCache, prepareProductDirectory, resolveGlobalScopePaths } from '#platform/index.js';
import { fixtureExecution } from '../support/execution-registry.js';
import { custodyProfiles, dispatchAdmission, grantTestLaunch } from '../support/custody.js';
const roots: string[] = [];
afterEach(async () => { clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixtureConfig() {
  const root = await mkdtemp(join(tmpdir(), 'coding-change-')); roots.push(root);
  const project = join(root, 'project'); await mkdir(join(project, '.deckent'), { recursive: true });
  await writeFile(join(project, '.deckent/config.json'), JSON.stringify({ layout: { root: join(root, 'data') } }));
  const home = join(root, 'home'), options = { env: { HOME: home, USERPROFILE: home } };
  return { root, project, options };
}
async function assertUnsupported(f: Awaited<ReturnType<typeof fixtureConfig>>, platform = process.platform) {
  await expect(openConfiguredAttemptStore(f.project, { ...f.options, platform })).rejects.toMatchObject({ code: 'MANAGED_FILE_UNSUPPORTED' });
  expect(() => new FileArtifactStore({ root: join(f.root, 'data', 'artifacts'), maxBytes: 65536 })).toThrow(expect.objectContaining({ code: 'ARTIFACT_UNSUPPORTED' }));
  await expect(stat(join(f.root, 'data'))).rejects.toMatchObject({ code: 'ENOENT' });
}
async function fixture(context: TestContext, files: number | null, noChangeAllowed?: boolean) {
  const { root, project, options } = await fixtureConfig();
  if (process.platform === 'win32') {
    await assertUnsupported({ root, project, options });
    context.skip('MANAGED_FILE_UNSUPPORTED / ARTIFACT_UNSUPPORTED: coding evaluation requires POSIX managed ledger/artifacts; refusal before storage effects verified');
  }
  const opened = await openConfiguredAttemptStore(project, options); opened.store.close();
  const identity = { scopeId: 's', runId: 'r', taskId: 't', attemptId: 'a', generation: 1, layoutRevision: opened.layout.revision };
  const graph = { schemaVersion: 3 as const, revision: 1, tasks: [{ id: 't', kind: 'coding', dependencies: [], acceptanceCriteria: ['exit'] }],
    criterionDefinitions: [{ id: 'exit', version: 1, description: 'Zero exit', evaluator: { id: 'process-exit', version: 1 }, parameters: { acceptedExitCodes: [0] } }] };
  const execution = structuredClone(fixtureExecution(graph));
  const codingGraph = { ...graph, tasks: graph.tasks.map(task => ({ ...task, workInput: { schemaVersion: 1, task: 'Write a test', scope: { paths: ['test.txt'] }, acceptance: 'Test added',
    model: { channelId: 'test-channel', modelId: 'test-model', auxiliaryModelIds: [] }, ...(noChangeAllowed === undefined ? {} : { noChangeAllowed }) } })) };
  // Trusted ledger fixture: only evaluation composition is under test; admission compilation has its own tests.
  execution.criteria[0]!.evaluator.implementation = { id: 'process-exit', version: 1 };
  const store = await openSqliteAttemptStore(opened.path, { busyTimeoutMs: 20, journalMode: 'wal', durability: 'full' }, { now: Date.now, timeoutMs: 86400000 }, 'forbid', custodyProfiles);
  const actor = { id: 'fixture', issuer: 'test', subject: 'fixture' };
  await store.createExecutionPool({ schemaVersion: 1, poolId: 'p', capacity: { executionSlots: 1, inFlightSlots: 1 } });
  await store.createRun({ commandId: 'create', actor, identity: { runId: 'r', scopeId: 's', layoutRevision: identity.layoutRevision }, graph: codingGraph, execution, now: 0,
    policy: { schemaVersion: 2, poolId: 'p', capacity: { executionSlots: 1, inFlightSlots: 1 }, ordering: ['t'] } });
  await store.reserveRunTasks({ commandId: 'reserve', actor, scopeId: 's', runId: 'r', expectedRevision: 0, now: 0, identities: [identity] });
  const claim = { owner: 'fixture', request: { protocolVersion: 1 as const, identity, workspace: '/private/workspace', argv: ['test'] } };
  await store.claimDispatch(dispatchAdmission(claim)); await grantTestLaunch(store, claim);
  const artifacts = new FileArtifactStore({ root: await prepareProductDirectory(opened.layout, 'artifacts'), maxBytes: 65536 });
  await store.retainDispatchOutput(claim, await artifacts.put('s', Buffer.from(JSON.stringify({ schemaVersion: 1, identity, completeness: 'complete', stdout: '', stderr: '' }))));
  await store.finishDispatch(claim, { handle: 'h', exitCode: 0, interrupted: false });
  if (files !== null) await store.retainDispatchPatch(claim, await artifacts.put('s', Buffer.from(JSON.stringify({ schemaVersion: 1, kind: 'workspace-patch', identity: files === 2 ? { ...identity, generation: 2 } : identity,
    source: { schemaVersion: 1, adapter: { id: 'git', version: 1 }, sourceFingerprint: 'c'.repeat(64) }, baseCommit: 'a'.repeat(40), snapshotDigest: 'b'.repeat(64), exclusions: patchExclusions,
    changes: files ? [{ path: 'test.txt', before: null, after: { mode: '100644', text: 'test\n', digest: patchDigest('test\n') } }] : [] }))));
  store.close();
  const principals = [{ issuer: hostname(), subject: String(userInfo().uid) }];
  await writeFile(join(root, 'data/policy.json'), JSON.stringify({ schemaVersion: 1, revision: 'test', restrictions: [], grants: [
    { id: 'inspect', effect: 'allow', actions: ['inspect'], scopes: ['s'], principals, resource: { kind: 'scope', ids: ['s'] } },
    { id: 'evaluation', effect: 'allow', actions: ['evaluate', 'read-output', 'recover-output'], scopes: ['s'], principals, resource: { kind: 'attempt', ids: ['a'] } },
  ] }), { mode: 0o600 });
  return { project, options, identity, path: opened.path, layout: opened.layout, claim, artifacts, command: { schemaVersion: 1 as const, commandId: 'evaluation', identity, expectedRevision: 2 } };
}
it('resolves Windows fixture home and refuses ledger/artifacts before effects (native Windows or platform-property simulation)', async () => {
  const f = await fixtureConfig(), original = Object.getOwnPropertyDescriptor(process, 'platform')!, platform = process.platform;
  const home = platform === 'win32' ? f.options.env.USERPROFILE : 'C:\\fixture\\home';
  expect(resolveGlobalScopePaths('win32', { ...f.options.env, USERPROFILE: home }).home).toBe(home);
  expect(() => resolveGlobalScopePaths('win32', { HOME: f.options.env.HOME })).toThrow(expect.objectContaining({ code: 'HOME_NOT_RESOLVED' }));
  // Keep native path/config parsing on POSIX; simulate only the storage capability branch.
  Object.defineProperty(process, 'platform', { ...original, value: 'win32' });
  try { await assertUnsupported(f, platform); }
  finally { Object.defineProperty(process, 'platform', original); }
});
it.for([[0, undefined, 'failed'], [1, undefined, 'accepted'], [0, true, 'accepted'], [0, false, 'failed']] as const)(
  'coding patch files=%s noChangeAllowed=%s -> %s and immutable replay', async ([files, allowed, phase], context) => {
    const f = await fixture(context, files, allowed); const first = await evaluateConfiguredTask(f.project, f.command, f.options);
    expect(first.evaluation.run.tasks[0]!.phase).toBe(phase);
    if (phase === 'failed') expect(first.evaluation.run.tasks[0]).toHaveProperty('notAcceptedReason', 'no-change-produced');
    expect(await evaluateConfiguredTask(f.project, f.command, f.options)).toEqual(first);
    const snapshot = await inspectMonitor(f.project, f.options), worker = snapshot.installs[0]!.workers[0]!;
    expect(worker.human?.evaluation).toBe(phase === 'failed' ? 'rejected' : 'accepted');
    if (phase === 'failed') expect(worker.human?.evaluationReason).toBe('no-change-produced');
    else expect(worker.human).not.toHaveProperty('evaluationReason');
    const surface = await loadMonitorSurface();
    for (const locale of ['en', 'tr'] as const) {
      const detail = surface.buildMonitorView(snapshot, locale, true).tabs.workers.flatMap(block => block.kind === 'table' ? block.rows : [])[0]!.detail().flat().map(span => span.text).join('\n');
      const reason = t('task.acceptance.noChangeProduced', {}, locale), empty = t('monitor.human.emptyPatch', {}, locale);
      if (phase === 'failed') { expect(detail.split(reason)).toHaveLength(2); expect(detail).not.toContain(empty); }
      else { expect(detail).not.toContain(reason); if (files === 0) expect(detail).toContain(empty); }
    }
    const reader = await openSqliteAttemptStore(f.path, { busyTimeoutMs: 20, journalMode: 'wal', durability: 'full' }, { now: Date.now, timeoutMs: 86400000 }, 'forbid');
    try { expect(projectRunView(await reader.loadRun('s', 'r'))).toEqual(first.evaluation.run); } finally { reader.close(); }
  });

it('missing coding patch is parked; a new retained patch returns once without extending the deadline', async context => {
  const f = await fixture(context, null, true);
  const first = await evaluateConfiguredTask(f.project, f.command, f.options);
  expect(first.evaluation.run.tasks[0]).toMatchObject({ phase: 'awaiting-decision', decision: { reason: 'evaluation-not-ready' } });
  const store = await openSqliteAttemptStore(f.path, { busyTimeoutMs: 20, journalMode: 'wal', durability: 'full' }, { now: Date.now, timeoutMs: 86400000 }, 'forbid');
  try { await store.retainDispatchPatch(f.claim, await f.artifacts.put('s', Buffer.from(JSON.stringify({ schemaVersion: 1, kind: 'workspace-patch', identity: f.identity,
    source: { schemaVersion: 1, adapter: { id: 'git', version: 1 }, sourceFingerprint: 'c'.repeat(64) }, baseCommit: 'a'.repeat(40), snapshotDigest: 'b'.repeat(64), exclusions: patchExclusions, changes: [] })))); }
  finally { store.close(); }
  const command = { ...f.command, commandId: 'return', expectedRevision: first.evaluation.run.revision };
  const accepted = await evaluateConfiguredTask(f.project, command, f.options);
  expect(accepted.evaluation.run.tasks[0]!.phase).toBe('accepted');
  expect(await evaluateConfiguredTask(f.project, command, f.options)).toEqual(accepted);
});
it.for(['en', 'tr'] as const)('real acceptance ledger reaches inspect and monitor text (%s)', async (locale, context) => {
  const f = await fixture(context, 0); const result = await evaluateConfiguredTask(f.project, f.command, f.options);
  const message = locale === 'en' ? 'Not accepted: no change produced.' : 'Kabul edilmedi: değişiklik üretilmedi.';
  const reading = await readMonitorLedger(f.path, { busyTimeoutMs: 20, maxRuns: 10 });
  const run = projectMonitorRun({ run: reading.runs[0]!, approvals: [], pool: reading.pools[0]!, workers: new Map(), observedAt: Date.now() });
  expect(run.tasks[0]!.evaluation.reason).toBe('no-change-produced');
  const snapshot = { ...emptySnapshot, installs: [{ ...emptySnapshot.installs[0]!, runs: [run] }] };
  const surface = await loadMonitorSurface();
  expect(surface.renderMonitorText(snapshot, { locale, width: 200, ascii: true })).toContain(message);
  const out: string[] = [], err: string[] = [];
  expect(await main(['run', 'inspect', '--scope', 's', '--id', 'r', '--lang', locale], { env: { NO_COLOR: '1' },
    stdout: { write(value: string) { out.push(value); } }, stderr: { write(value: string) { err.push(value); } },
    async inspectRun() { return { schemaVersion: 1 as const, layout: f.layout, run: result.evaluation.run }; } })).toBe(0);
  expect(out.join('')).toContain(message); expect(err).toEqual([]);
});

it('an explicitly allowed no-change task still refuses a foreign retained patch without mutation', async context => {
  const f = await fixture(context, 2, true);
  await expect(evaluateConfiguredTask(f.project, f.command, f.options)).rejects.toMatchObject({ code: 'TASK_EVIDENCE_INVALID' });
  const store = await openSqliteAttemptStore(f.path, { busyTimeoutMs: 20, journalMode: 'wal', durability: 'full' }, { now: Date.now, timeoutMs: 86400000 }, 'forbid');
  try { expect((await store.loadRun('s', 'r'))!.progress[0]!.phase).toBe('evaluating'); expect(await store.loadRunReceipt('s', 'evaluation')).toBeNull(); }
  finally { store.close(); }
});
