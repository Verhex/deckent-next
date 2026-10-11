import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir, hostname, userInfo } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createRun, inspectRun, inspectConfiguredWorkerTranscript } from '../../../src/index.js';
import { advanceConfiguredRunLifecycle, evaluateConfiguredTask } from '../../../src/composition/core/runs/index.js';
import { openConfiguredAttemptStore } from '../../../src/composition/core/storage/index.js';
import { FileArtifactStore, openSqliteAttemptStore, readMonitorRunResults } from '#adapters/index.js';
import { clearConfigCache, loadConfig, prepareProductDirectory } from '#platform/index.js';
import { fixtureDockerRegistry } from '../support/execution-registry.js';
import { custodyProfiles, dispatchAdmission, grantTestLaunch } from '../support/custody.js';

const roots: string[] = [];
afterEach(async () => { clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture(exitCode: number, acceptedExitCodes = [0], stdout = 'private output', twoTasks = false) {
  const root = await mkdtemp(join(tmpdir(), 'deckent-configured-evaluation-')); roots.push(root);
  const project = join(root, 'project'); const data = join(root, 'data'); await mkdir(join(project, '.deckent'), { recursive: true, mode: 0o700 });
  const configPath = join(project, '.deckent/config.json'); const registry = fixtureDockerRegistry(['purchase']);
  await writeFile(configPath, JSON.stringify({ layout: { root: data }, artifacts: { maxBytes: 16_777_216 },
    admission: { poolId: 'p', executionSlots: 1, inFlightSlots: 1, ordering: 'input-order', registry } }));
  const options = { env: { HOME: join(root, 'home'), USERPROFILE: join(root, 'home') } }; const opened = await openConfiguredAttemptStore(project, options);
  await opened.store.createExecutionPool({ schemaVersion: 1, poolId: 'p', capacity: { executionSlots: 1, inFlightSlots: 1 } }); opened.store.close();
  const os = userInfo(); const principals = [{ issuer: hostname(), subject: String(os.uid) }];
  const policy = async (evaluate: boolean, readOutput: boolean | readonly string[] = true, inspect: boolean | 'require-approval' = true) => writeFile(join(data, 'policy.json'), JSON.stringify({ schemaVersion: 1, revision: evaluate ? 'allow' : 'deny', restrictions: [], grants: [
    { id: 'run', effect: 'allow', actions: inspect === true ? ['create', 'inspect'] : ['create'], scopes: ['s'], principals, resource: { kind: 'run', ids: ['r'] } },
    ...(inspect === 'require-approval' ? [{ id: 'inspect-approval', effect: 'require-approval', actions: ['inspect'], scopes: ['s'], principals, resource: { kind: 'run', ids: ['r'] } }] : []),
    { id: 'pool', effect: 'allow', actions: ['use'], scopes: ['s'], principals, resource: { kind: 'pool', ids: ['p'] } },
    ...(evaluate ? [{ id: 'evaluation', effect: 'allow', actions: readOutput === true ? ['evaluate', 'read-output'] : ['evaluate'], scopes: ['s'], principals, resource: { kind: 'attempt', ids: twoTasks ? ['a', 'a2'] : ['a'] } }] : []),
    ...(Array.isArray(readOutput) ? [{ id: 'selected-output', effect: 'allow', actions: ['read-output'], scopes: ['s'], principals, resource: { kind: 'attempt', ids: readOutput } }] : []),
  ] }), { mode: 0o600 });
  await policy(true);
  const graph = { schemaVersion: 2 as const, revision: 1, tasks: [{ id: 't', kind: 'purchase', dependencies: [], acceptanceCriteria: ['exit'] }],
    criterionDefinitions: [{ id: 'exit', version: 1, description: 'Accept configured process exits', evaluator: { id: 'process-exit', version: 1 }, parameters: { acceptedExitCodes } }] };
  if (twoTasks) graph.tasks.push({ id: 't2', kind: 'purchase', dependencies: [], acceptanceCriteria: ['exit'] });
  await createRun(project, { schemaVersion: 1, commandId: 'create', scopeId: 's', runId: 'r', graph }, options);
  const identity = { scopeId: 's', runId: 'r', taskId: 't', attemptId: 'a', generation: 1, layoutRevision: opened.layout.revision };
  const store = await openSqliteAttemptStore(opened.path, { busyTimeoutMs: 20, journalMode: 'wal', durability: 'full' }, { now: Date.now, timeoutMs: 86400000 }, 'forbid', custodyProfiles);
  const actor = { id: 'fixture', issuer: 'test', subject: 'service' };
  expect((await store.loadRun('s', 'r'))!.progress[0]!.eligibility).toEqual({ kind: 'immediate' });
  await store.reserveRunTasks({ commandId: 'reserve', actor, scopeId: 's', runId: 'r', expectedRevision: 0, now: 0, identities: [identity] });
  const request = { protocolVersion: 1 as const, identity, workspace: '/private/workspace', argv: ['private-task-command'] }; const claim = { owner: 'fixture-worker', request };
  await store.claimDispatch(dispatchAdmission(claim)); await grantTestLaunch(store, claim);
  const artifactRoot = await prepareProductDirectory(opened.layout, 'artifacts'); const artifacts = new FileArtifactStore({ root: artifactRoot, maxBytes: 65536 });
  const envelope = { schemaVersion: 1, identity, completeness: 'complete', stdout, stderr: '' };
  const receipt = await artifacts.put('s', Buffer.from(JSON.stringify(envelope))); await store.retainDispatchOutput(claim, receipt);
  await store.finishDispatch(claim, { handle: 'fixture-handle', exitCode, interrupted: false }); store.close();
  const command = { schemaVersion: 1 as const, commandId: 'evaluation', identity, expectedRevision: 2 };
  return { project, data, configPath, options, path: opened.path, command, policy };
}

describe.skipIf(process.platform === 'win32')('configured task evaluation', () => {
  it('returns both Tasks exactly as inspection including resultBrief, and replays the earlier revision', async () => {
    const report = (summary: string) => ({ schemaVersion: 1, kind: 'native-worker-report', status: 'reported',
      report: { schemaVersion: 1, summary, changedFiles: [], checks: [], openIssues: [] } });
    const f = await fixture(0, [0], JSON.stringify(report('private first task claim')), true);
    const first = await evaluateConfiguredTask(f.project, f.command, f.options);
    expect(first.evaluation.run.tasks).toEqual((await inspectRun(f.project, { schemaVersion: 1, scopeId: 's', runId: 'r' }, f.options)).run!.tasks);
    const identity = { ...f.command.identity, taskId: 't2', attemptId: 'a2' };
    const opened = await openConfiguredAttemptStore(f.project, f.options); opened.store.close();
    const store = await openSqliteAttemptStore(opened.path, { busyTimeoutMs: 20, journalMode: 'wal', durability: 'full' },
      { now: Date.now, timeoutMs: 86400000 }, 'forbid', custodyProfiles);
    try {
      await store.reserveRunTasks({ commandId: 'reserve-second', actor: { id: 'fixture', issuer: 'test', subject: 'service' },
        scopeId: 's', runId: 'r', expectedRevision: first.evaluation.run.revision, now: 0, identities: [identity] });
      const claim = { owner: 'fixture-worker', request: { protocolVersion: 1 as const, identity, workspace: '/private/workspace', argv: ['private-task-command'] } };
      await store.claimDispatch(dispatchAdmission(claim)); await grantTestLaunch(store, claim);
      const artifacts = new FileArtifactStore({ root: await prepareProductDirectory(opened.layout, 'artifacts'), maxBytes: 65536 });
      const output = await artifacts.put('s', Buffer.from(JSON.stringify({ schemaVersion: 1, identity, completeness: 'complete', stdout: JSON.stringify(report('private second task claim')), stderr: '' })));
      await store.retainDispatchOutput(claim, output); await store.finishDispatch(claim, { handle: 'fixture-second', exitCode: 0, interrupted: false });
    } finally { store.close(); }
    const secondCommand = { ...f.command, commandId: 'evaluation-second', identity, expectedRevision: first.evaluation.run.revision + 2 };
    const second = await evaluateConfiguredTask(f.project, secondCommand, f.options);
    const inspected = await inspectRun(f.project, { schemaVersion: 1, scopeId: 's', runId: 'r' }, f.options);
    expect(second.evaluation.run.tasks).toEqual(inspected.run!.tasks);
    const { pool, ...inspectedRun } = inspected.run!; void pool;
    expect(second.evaluation.run).toEqual(inspectedRun);
    expect(second.evaluation.run.tasks.map(task => task.resultBrief)).toEqual(['a', 'a2'].map((attemptId, index) => ({
      schemaVersion: 1, attemptId, claimLabel: 'CLAIM', report: report(index ? 'private second task claim' : 'private first task claim'),
      evaluation: { verdict: 'accepted' }, openIssues: [], runDelivery: null, deliveryOutlook: 'none',
    })));
    expect(second.evaluation.run.tasks.map(task => task.acceptance!.evaluationId)).toEqual(['evaluation', 'evaluation-second']);
    expect(await evaluateConfiguredTask(f.project, secondCommand, f.options)).toEqual(second);
    expect(await evaluateConfiguredTask(f.project, f.command, f.options)).toEqual(first);
    expect(first.evaluation.run.tasks[1]!.acceptance!.evaluationId).toBeNull();
    await f.policy(true, ['a2']);
    const restricted = await evaluateConfiguredTask(f.project, secondCommand, f.options);
    expect(restricted.evaluation.run.tasks).toEqual((await inspectRun(f.project, { schemaVersion: 1, scopeId: 's', runId: 'r' }, f.options)).run!.tasks);
    expect(restricted.evaluation.run.tasks[0]!.resultBrief).toMatchObject({ report: null, openIssues: null });
    expect(restricted.evaluation.run.tasks[1]!.resultBrief!.report).toEqual(report('private second task claim'));
    expect(JSON.stringify(restricted)).not.toContain('private first task claim');
    await f.policy(true, true, false);
    const hidden = await evaluateConfiguredTask(f.project, secondCommand, f.options);
    for (const task of hidden.evaluation.run.tasks) expect(task).not.toHaveProperty('resultBrief');
    expect(JSON.stringify(hidden)).not.toContain('private first task claim');
    expect(JSON.stringify(hidden)).not.toContain('private second task claim');
  });
  it.each([[0, 'accepted', [0]], [7, 'failed', [0]], [7, 'accepted', [7]]] as const)(
    'derives exit %s from the pinned evaluator and projects %s for accepted codes %j', async (exitCode, phase, acceptedExitCodes) => {
    const f = await fixture(exitCode, [...acceptedExitCodes]); const config = JSON.parse(await readFile(f.configPath, 'utf8')); config.admission = null;
    await writeFile(f.configPath, JSON.stringify(config)); clearConfigCache();
    const result = await evaluateConfiguredTask(f.project, f.command, f.options);
    expect(result.evaluation.run.tasks[0]!.phase).toBe(phase);
    expect(result.evaluation.run.registryRevision).toBe('fixture-docker-registry');
    expect(JSON.stringify(result)).not.toContain('private-task-command'); expect(JSON.stringify(result)).not.toContain('parameters');
    expect(JSON.stringify(result)).not.toContain('/private/workspace');
  });

  it('checks current evaluate policy before mutation and replay while ignoring changed admission registry', async () => {
    const f = await fixture(0); const beforeStore = await openSqliteAttemptStore(f.path,
      { busyTimeoutMs: 20, journalMode: 'wal', durability: 'full' }, { now: Date.now, timeoutMs: 86400000 }, 'forbid', custodyProfiles);
    const before = await beforeStore.loadRun('s', 'r'); beforeStore.close();
    await f.policy(false); await expect(evaluateConfiguredTask(f.project, f.command, f.options)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    const deniedStore = await openSqliteAttemptStore(f.path, { busyTimeoutMs: 20, journalMode: 'wal', durability: 'full' }, { now: Date.now, timeoutMs: 86400000 }, 'forbid', custodyProfiles);
    expect(await deniedStore.loadRun('s', 'r')).toEqual(before); deniedStore.close();
    await f.policy(true); const config = JSON.parse(await readFile(f.configPath, 'utf8'));
    config.admission.registry.revision = 'current-registry-changed'; config.admission.registry.evaluators[0].implementation.version = 99;
    await writeFile(f.configPath, JSON.stringify(config)); clearConfigCache();
    const first = await evaluateConfiguredTask(f.project, f.command, f.options); expect(first.evaluation.run.tasks[0]!.phase).toBe('accepted');
    expect(await evaluateConfiguredTask(f.project, f.command, f.options)).toEqual(first);
    await f.policy(false); await expect(evaluateConfiguredTask(f.project, f.command, f.options)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
  });
  it.each([false, 'require-approval'] as const)('omits report observations with Run inspect %s on mutation and replay, retaining the evaluate principal', async inspect => {
    const report = { schemaVersion: 1, kind: 'native-worker-report', status: 'reported', report: { schemaVersion: 1,
      summary: 'Private worker claim', changedFiles: [], checks: [], openIssues: ['Private open issue'] } };
    const f = await fixture(0, [0], JSON.stringify(report) + '\n');
    await f.policy(true, true, inspect);
    const first = await evaluateConfiguredTask(f.project, f.command, f.options);
    expect(first.evaluation.run.tasks[0]!.phase).toBe('accepted');
    expect(first.evaluation.run.tasks[0]).not.toHaveProperty('resultBrief');
    expect(JSON.stringify(first)).not.toContain('Private worker claim');
    expect(JSON.stringify(first)).not.toContain('Private open issue');
    await expect(inspectRun(f.project, { schemaVersion: 1, scopeId: 's', runId: 'r' }, f.options)).rejects.toMatchObject({ code: inspect === false ? 'POLICY_DENIED' : 'POLICY_APPROVAL_UNSUPPORTED' });
    expect(await evaluateConfiguredTask(f.project, f.command, f.options)).toEqual(first);
    await f.policy(true);
    expect((await evaluateConfiguredTask(f.project, f.command, f.options)).evaluation.run.tasks[0]!.resultBrief!.report).toEqual(report);
    await f.policy(true, true, inspect);
    expect(await evaluateConfiguredTask(f.project, f.command, f.options)).toEqual(first);
    await f.policy(true, false);
    const replay = await evaluateConfiguredTask(f.project, f.command, f.options);
    expect(replay.evaluation.run.tasks[0]!.resultBrief).toMatchObject({ report: null, openIssues: null });
    expect(JSON.stringify(replay)).not.toContain('Private worker claim'); expect(JSON.stringify(replay)).not.toContain('Private open issue');
    expect(replay.evaluation.run.tasks).toEqual((await inspectRun(f.project, { schemaVersion: 1, scopeId: 's', runId: 'r' }, f.options)).run!.tasks);
    const denied = await fixture(0, [0], JSON.stringify(report) + '\n'); await denied.policy(true, false);
    const evaluated = await evaluateConfiguredTask(denied.project, denied.command, denied.options);
    expect(evaluated.evaluation.run.tasks[0]!.phase).toBe('accepted');
    expect(evaluated.evaluation.run.tasks[0]!.resultBrief).toMatchObject({ report: null, openIssues: null });
    expect(JSON.stringify(evaluated)).not.toContain('Private worker claim');
  });
  it('refuses a foreign retained scope and ignores a future snapshot before any output read', async () => {
    const f = await fixture(0), result = await evaluateConfiguredTask(f.project, f.command, f.options);
    const opened = await openConfiguredAttemptStore(f.project, f.options);
    const snapshot = (await opened.store.loadRun('s', 'r'))!; opened.store.close();
    const config = await loadConfig(f.project, { ...f.options, heal: false });
    const readOutput = async () => { throw new Error('output read before snapshot validation'); };
    await expect(readMonitorRunResults(config, f.options.env, { scopeId: 'foreign', runId: 'r' }, result.evaluation.run, readOutput, snapshot))
      .rejects.toMatchObject({ code: 'ATTEMPT_STORE_OPTIONS' });
    expect(await readMonitorRunResults(config, f.options.env, { scopeId: 's', runId: 'r' },
      { revision: snapshot.revision + 1, layoutRevision: snapshot.identity.layoutRevision }, readOutput, { ...snapshot, revision: snapshot.revision + 1 })).toEqual(new Map());
  });
});


it.skipIf(process.platform === 'win32')('requires POSIX managed storage: shows a sealed final report through configured custody while task acceptance still rejects a failed process', async () => {
  const report = { schemaVersion: 1, kind: 'native-worker-report', status: 'reported', report: { schemaVersion: 1,
    summary: 'All done according to the worker', changedFiles: ['note.txt'], checks: [{ command: 'npm test', outcome: 'passed' }], openIssues: [] } };
  const f = await fixture(7, [0], JSON.stringify(report) + '\n');
  const transcript = await inspectConfiguredWorkerTranscript(f.project, f.command.identity, f.options);
  expect(transcript).toMatchObject({ schemaVersion: 2, finalReport: report });
  const result = await evaluateConfiguredTask(f.project, f.command, f.options);
  expect(result.evaluation.run.tasks[0]!.phase).toBe('failed');
  expect(result.evaluation.run.tasks[0]!.resultBrief).toMatchObject({ report, evaluation: { verdict: 'rejected' } });
  expect(result.evaluation.run.tasks).toEqual((await inspectRun(f.project, { schemaVersion: 1, scopeId: 's', runId: 'r' }, f.options)).run!.tasks);
  await f.policy(false);
  await expect(inspectConfiguredWorkerTranscript(f.project, f.command.identity, f.options)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
});

it.skipIf(process.platform === 'win32')('maintenance with no due deadline never opens a writer under another ledger write lock', async () => {
  const f = await fixture(0);
  await evaluateConfiguredTask(f.project, f.command, f.options);
  const writer = new DatabaseSync(f.path); writer.exec('BEGIN IMMEDIATE');
  try { expect(await advanceConfiguredRunLifecycle(f.project, { schemaVersion: 1, scopeId: 's', runId: 'r' }, f.options)).toBeNull(); }
  finally { writer.exec('ROLLBACK'); writer.close(); }
});
