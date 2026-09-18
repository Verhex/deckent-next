import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir, hostname, userInfo } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createRun } from '../../../src/index.js';
import { evaluateConfiguredTask } from '../../../src/composition/core/runs/index.js';
import { openConfiguredAttemptStore } from '../../../src/composition/core/storage/index.js';
import { FileArtifactStore, openSqliteAttemptStore } from '#adapters/index.js';
import { clearConfigCache, prepareProductDirectory } from '#platform/index.js';
import { fixtureDockerRegistry } from '../support/execution-registry.js';
import { custodyProfiles, dispatchAdmission, grantTestLaunch } from '../support/custody.js';

const roots: string[] = [];
afterEach(async () => { clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture(exitCode: number, acceptedExitCodes = [0]) {
  const root = await mkdtemp(join(tmpdir(), 'deckent-configured-evaluation-')); roots.push(root);
  const project = join(root, 'project'); const data = join(root, 'data'); await mkdir(join(project, '.deckent'), { recursive: true, mode: 0o700 });
  const configPath = join(project, '.deckent/config.json'); const registry = fixtureDockerRegistry(['purchase']);
  await writeFile(configPath, JSON.stringify({ layout: { root: data }, artifacts: { maxBytes: 65536 },
    admission: { poolId: 'p', executionSlots: 1, inFlightSlots: 1, ordering: 'input-order', registry } }));
  const options = { env: { HOME: join(root, 'home') } }; const opened = await openConfiguredAttemptStore(project, options);
  await opened.store.createExecutionPool({ schemaVersion: 1, poolId: 'p', capacity: { executionSlots: 1, inFlightSlots: 1 } }); opened.store.close();
  const os = userInfo(); const principals = [{ issuer: hostname(), subject: String(os.uid) }];
  const policy = async (evaluate: boolean) => writeFile(join(data, 'policy.json'), JSON.stringify({ schemaVersion: 1, revision: evaluate ? 'allow' : 'deny', restrictions: [], grants: [
    { id: 'run', effect: 'allow', actions: ['create'], scopes: ['s'], principals, resource: { kind: 'run', ids: ['r'] } },
    { id: 'pool', effect: 'allow', actions: ['use'], scopes: ['s'], principals, resource: { kind: 'pool', ids: ['p'] } },
    ...(evaluate ? [{ id: 'evaluation', effect: 'allow', actions: ['evaluate'], scopes: ['s'], principals, resource: { kind: 'attempt', ids: ['a'] } }] : []),
  ] }), { mode: 0o600 });
  await policy(true);
  const graph = { schemaVersion: 2 as const, revision: 1, tasks: [{ id: 't', kind: 'purchase', dependencies: [], acceptanceCriteria: ['exit'] }],
    criterionDefinitions: [{ id: 'exit', version: 1, description: 'Accept configured process exits', evaluator: { id: 'process-exit', version: 1 }, parameters: { acceptedExitCodes } }] };
  await createRun(project, { schemaVersion: 1, commandId: 'create', scopeId: 's', runId: 'r', graph }, options);
  const identity = { scopeId: 's', runId: 'r', taskId: 't', attemptId: 'a', generation: 1, layoutRevision: opened.layout.revision };
  const store = await openSqliteAttemptStore(opened.path, { busyTimeoutMs: 20, journalMode: 'wal', durability: 'full' }, 'forbid', custodyProfiles);
  const actor = { id: 'fixture', issuer: 'test', subject: 'service' };
  const eligibleAt = (await store.loadRun('s', 'r'))!.progress[0]!.eligibleAt;
  await store.reserveRunTasks({ commandId: 'reserve', actor, scopeId: 's', runId: 'r', expectedRevision: 0, now: eligibleAt, identities: [identity] });
  const request = { protocolVersion: 1 as const, identity, workspace: '/private/workspace', argv: ['private-task-command'] }; const claim = { owner: 'fixture-worker', request };
  await store.claimDispatch(dispatchAdmission(claim)); await grantTestLaunch(store, claim);
  const artifactRoot = await prepareProductDirectory(opened.layout, 'artifacts'); const artifacts = new FileArtifactStore({ root: artifactRoot, maxBytes: 65536 });
  const envelope = { schemaVersion: 1, identity, completeness: 'complete', stdout: 'private output', stderr: '' };
  const receipt = await artifacts.put('s', Buffer.from(JSON.stringify(envelope))); await store.retainDispatchOutput(claim, receipt);
  await store.finishDispatch(claim, { handle: 'fixture-handle', exitCode, interrupted: false }); store.close();
  const command = { schemaVersion: 1 as const, commandId: 'evaluation', identity, expectedRevision: 2 };
  return { project, data, configPath, options, path: opened.path, command, policy };
}

describe.skipIf(process.platform === 'win32')('configured task evaluation', () => {
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
      { busyTimeoutMs: 20, journalMode: 'wal', durability: 'full' }, 'forbid', custodyProfiles);
    const before = await beforeStore.loadRun('s', 'r'); beforeStore.close();
    await f.policy(false); await expect(evaluateConfiguredTask(f.project, f.command, f.options)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    const deniedStore = await openSqliteAttemptStore(f.path, { busyTimeoutMs: 20, journalMode: 'wal', durability: 'full' }, 'forbid', custodyProfiles);
    expect(await deniedStore.loadRun('s', 'r')).toEqual(before); deniedStore.close();
    await f.policy(true); const config = JSON.parse(await readFile(f.configPath, 'utf8'));
    config.admission.registry.revision = 'current-registry-changed'; config.admission.registry.evaluators[0].implementation.version = 99;
    await writeFile(f.configPath, JSON.stringify(config)); clearConfigCache();
    const first = await evaluateConfiguredTask(f.project, f.command, f.options); expect(first.evaluation.run.tasks[0]!.phase).toBe('accepted');
    expect(await evaluateConfiguredTask(f.project, f.command, f.options)).toEqual(first);
    await f.policy(false); await expect(evaluateConfiguredTask(f.project, f.command, f.options)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
  });
});
