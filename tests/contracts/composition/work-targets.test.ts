import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { hostname, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { adoptConfiguredWorkspaceIntegration, checkConfiguredWorkspaceIntegration, createConfiguredRuntimeClient, deliverConfiguredWorkspaceIntegration,
  evaluateTask, inspectConfiguredWorkspaceIntegration, prepareConfiguredWorkspaceIntegration, prepareConfiguredWorkspacePatch, previewConfiguredWorkspacePatch,
  rollbackConfiguredWorkspaceIntegration,
  startConfiguredRuntimeService } from '../../../src/index.js';
import { executeConfiguredTask } from '../../../src/composition/core/execution/index.js';
import { createConfiguredDeliveryRun, createConfiguredRun, reserveConfiguredRunTasks } from '../../../src/composition/core/runs/index.js';
import { openConfiguredAttemptStore } from '../../../src/composition/core/storage/index.js';
import { openConfiguredWorkspaceBroker } from '../../../src/composition/core/workspaces/index.js';
import { evaluatePolicy, getPolicyVocabulary, type AttemptIdentity } from '#domain/index.js';
import { DockerSupervisor, fingerprintGitSource } from '#adapters/index.js';
import { RunWorkspaceAcquisitionApplication } from '#engine/index.js';
import { clearConfigCache, productResourcePath } from '#platform/index.js';
import { fixtureDockerRegistry } from '../support/execution-registry.js';

// WORK-TARGETS slice 1 (owner 2026-09-30 K1 = W2, K2 = A, K4 = A): a separate "live project" repository runs the installation; the
// configured work target is an independent clone whose base branch is also the adoption target, with a detached checkout.
const exec = promisify(execFile);
const roots: string[] = [], cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) await close();
  clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
const git = async (cwd: string, ...args: string[]) => (await exec('/usr/bin/git', ['-C', cwd, ...args])).stdout.trim();
const BASE = 'refs/heads/dogfood/adopted';
const principals = [{ issuer: hostname(), subject: String(userInfo().uid) }];
const attemptActions = ['execute', 'read-output', 'recover-output', 'prepare-integration', 'deliver-integration', 'evaluate', 'adopt-integration', 'rollback-integration'];
const graph = { schemaVersion: 2 as const, revision: 1, tasks: [{ id: 't', kind: 'coding', dependencies: [], acceptanceCriteria: ['exit'] }],
  criterionDefinitions: [{ id: 'exit', version: 1, description: 'Zero exit', evaluator: { id: 'process-exit', version: 1 }, parameters: { acceptedExitCodes: [0] } }] };
const docker = !!process.env.DECKENT_TEST_DOCKER_IMAGE;

/** Every reference, HEAD, index and config of a repository: equal digests mean nothing Deckent writes reached it. */
async function repositoryDigest(repository: string) {
  const refs = await git(repository, 'for-each-ref', '--format=%(refname) %(objectname) %(symref)');
  const head = await git(repository, 'rev-parse', 'HEAD'), symbolic = await git(repository, 'symbolic-ref', '-q', 'HEAD').catch(() => 'detached');
  const worktrees = await git(repository, 'worktree', 'list', '--porcelain');
  const files = await Promise.all(['index', 'config'].map(name => readFile(join(repository, '.git', name))));
  return createHash('sha256').update(JSON.stringify({ refs, head, symbolic, worktrees })).update(files[0]!).update(files[1]!).digest('hex');
}

async function fixture({ workTarget = 'clone' as 'clone' | 'none' | ((r: { root: string; project: string; target: string; data: string }) => Promise<unknown>),
  targetActions = ['use', 'adopt'] as readonly string[] } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dn-work-target-')); roots.push(root);
  const project = join(root, 'project'), target = join(root, 'target'), data = join(root, 'data');
  await mkdir(join(project, '.deckent'), { recursive: true, mode: 0o700 });
  await git(project, 'init', '-q'); await git(project, 'config', 'user.email', 'live@example.invalid'); await git(project, 'config', 'user.name', 'Live');
  await writeFile(join(project, 'note.txt'), 'before\n'); await writeFile(join(project, 'removed.txt'), 'remove\n');
  await git(project, 'add', 'note.txt', 'removed.txt'); await git(project, 'commit', '-q', '-m', 'base'); const base = await git(project, 'rev-parse', 'HEAD');
  await exec('/usr/bin/git', ['clone', '-q', project, target]);
  await git(target, 'config', 'user.email', 'target@example.invalid'); await git(target, 'config', 'user.name', 'Target');
  await git(target, 'branch', 'dogfood/adopted', base); await git(target, 'checkout', '-q', '--detach', base);
  let path: unknown = target;
  if (typeof workTarget === 'function') path = await workTarget({ root, project, target, data });
  const registry = fixtureDockerRegistry(['coding']); registry.profiles[0]!.parameters.argv = ['node', '-e',
    "const fs=require('node:fs');fs.appendFileSync('note.txt','more\\n');if(fs.existsSync('removed.txt'))fs.unlinkSync('removed.txt');fs.writeFileSync('added.txt','new\\n');"];
  registry.profiles[0]!.parameters.imageId = process.env.DECKENT_TEST_DOCKER_IMAGE ?? 'sha256:' + 'a'.repeat(64);
  const { argv: _argv, ...bounds } = registry.profiles[0]!.parameters; void _argv;
  const options = { env: { HOME: join(root, 'home') } };
  const config = (targets: unknown) => writeFile(join(project, '.deckent/config.json'), JSON.stringify({ layout: { root: data }, artifacts: { maxBytes: 16_777_216 },
    admission: { poolId: 'p', executionSlots: 2, inFlightSlots: 2, ordering: 'input-order', registry },
    execution: { docker: { executable: '/usr/bin/docker', ...bounds }, git: { gitExecutable: '/usr/bin/git', timeoutMs: 10000, outputBytes: 65536 },
      adoption: { targets: [BASE] }, ...(targets === null ? {} : { workTargets: { schemaVersion: JSON.stringify(targets).includes('"scope"') ? 2 : 1, targets } }) },
    cancellation: { maxConcurrentDeliveries: 1, recoveryPageSize: 1, maxAttempts: 1, retryDelayMs: 1, claimTtlMs: 10 },
    cancellationRuntime: { scopeIds: ['s'], pollIntervalMs: 1000, failureBackoffMs: 1000 },
    service: { inputMaxBytes: 65536, responseMaxBytes: 65536, maxConnections: 4, maxConcurrentRequests: 2, maxConcurrentExecutions: 1, headerTimeoutMs: 1000, shutdownGraceMs: 1000 } }));
  await config(workTarget === 'none' ? null : [{ id: 'n1', kind: 'git', path, baseRef: BASE }]);
  const opened = await openConfiguredAttemptStore(project, options);
  await opened.store.createExecutionPool({ schemaVersion: 1, poolId: 'p', capacity: { executionSlots: 2, inFlightSlots: 2 } }); opened.store.close();
  const policy = (actions: readonly string[] = targetActions, attempts: readonly string[] = attemptActions, targetEffect = 'allow') => writeFile(productResourcePath(opened.layout, 'policy'), JSON.stringify({
    schemaVersion: 1, revision: `work-target-${actions.join('-')}`, restrictions: [], grants: [
      { id: 'run', effect: 'allow', actions: ['create', 'reserve', 'inspect'], scopes: ['s'], principals, resource: { kind: 'run', ids: 'all' } },
      { id: 'pool', effect: 'allow', actions: ['use'], scopes: ['s'], principals, resource: { kind: 'pool', ids: ['p'] } },
      { id: 'attempt', effect: 'allow', actions: attempts, scopes: ['s'], principals, resource: { kind: 'attempt', ids: 'all' } },
      ...(actions.length ? [{ id: 'target', effect: targetEffect, actions, scopes: ['s'], principals, resource: { kind: 'work-target', ids: ['n1'] } }] : []),
    ] }), { mode: 0o600 });
  await policy();
  const runs = () => { const db = new DatabaseSync(opened.path, { readOnly: true }); try { return db.prepare('SELECT count(*) AS n FROM runs').get()!.n; } finally { db.close(); } };
  /** The trusted policy's own decision for one request of this principal (proves which gate refused). */
  const decision = async (kind: string, action: string, id: string) => evaluatePolicy(JSON.parse(await readFile(productResourcePath(opened.layout, 'policy'), 'utf8')),
    { principal: { id: 'p', issuer: principals[0]!.issuer, subject: principals[0]!.subject, assurance: 'os-user', scopeIds: ['s'] } as never, action, scopeId: 's',
      resource: { kind, id } }).decision;
  /** Nothing of the target was consumed for this attempt: no Run workspace custody, no lease/clone, no dispatch claim or launch. */
  const unconsumed = async (identity: AttemptIdentity) => {
    const store = await openConfiguredAttemptStore(project, options);
    try {
      expect(await store.store.loadRunWorkspaceCustody(identity.scopeId, identity.runId)).toBeNull();
      expect(await store.store.loadBoundDispatch(identity)).toBeNull();
    } finally { store.store.close(); }
    // `toolchains` is the worker image refresh's own home (WORKER-AUTO-REFRESH), not an attempt workspace: nothing else may exist.
    expect((await readdir(join(data, 'workspaces')).catch(() => [])).filter(name => name !== 'toolchains')).toEqual([]);
  };
  /** A second independent clone with its own base branch (the config may switch to it). */
  const secondTarget = async () => { const path = join(root, 'target2'); await exec('/usr/bin/git', ['clone', '-q', project, path]);
    await git(path, 'branch', 'dogfood/adopted', base); await git(path, 'checkout', '-q', '--detach', base); return path; };
  return { root, project, target, data, base, options, policy, config, runs, layout: opened.layout, decision, unconsumed, secondTarget };
}

describe.skipIf(process.platform !== 'linux')('work target registry: typed refusals and work-target:use through the runtime service', () => {
  it('advertises the versioned work-target resource kind with use and adopt', () => {
    expect(getPolicyVocabulary()).toMatchObject({ schemaVersion: 1 });
    expect(getPolicyVocabulary().resources).toContainEqual({ kind: 'work-target', actions: ['use', 'adopt'] });
  });

  const refusals: [string, (r: { root: string; project: string; target: string; data: string }) => Promise<unknown>][] = [
    ['WORK_TARGET_PATH_INVALID', async () => 'relative/target'],
    ['WORK_TARGET_PATH_INVALID', async ({ root, target }) => { await symlink(target, join(root, 'link')); return join(root, 'link'); }],
    ['WORK_TARGET_UNSAFE', async ({ target }) => { await chmod(target, 0o777); return target; }],
    ['WORK_TARGET_IN_DATA_ROOT', async ({ project, data }) => { await mkdir(data, { recursive: true, mode: 0o700 }); await exec('/usr/bin/git', ['clone', '-q', project, join(data, 'n1')]);
      await git(join(data, 'n1'), 'branch', 'dogfood/adopted', 'HEAD'); return join(data, 'n1'); }],
    ['WORK_TARGET_IS_PROJECT', async ({ project }) => { await git(project, 'branch', 'dogfood/adopted', 'HEAD'); return project; }],
    ['WORK_TARGET_NOT_WORKTREE', async ({ root, target }) => { await exec('/usr/bin/git', ['clone', '-q', '--bare', target, join(root, 'bare.git')]); return join(root, 'bare.git'); }],
    ['WORK_TARGET_NOT_WORKTREE', async ({ target }) => { await mkdir(join(target, 'sub')); return join(target, 'sub'); }],
    // A worktree of the running project shares its refs: Deckent never targets its running source.
    ['WORK_TARGET_SHARES_PROJECT_REPOSITORY', async ({ root, project }) => { await git(project, 'worktree', 'add', '-q', '-b', 'dogfood/adopted', join(root, 'live-worktree'));
      return join(root, 'live-worktree'); }],
    ['WORK_TARGET_ALTERNATES', async ({ root, target }) => { await exec('/usr/bin/git', ['clone', '-q', '--shared', target, join(root, 'shared')]);
      await git(join(root, 'shared'), 'branch', 'dogfood/adopted', 'HEAD'); return join(root, 'shared'); }],
    ['WORK_TARGET_BASE_MISSING', async ({ target }) => { await git(target, 'branch', '-D', 'dogfood/adopted'); return target; }],
  ];
  for (const [code, arrange] of refusals) {
    it(`refuses ${code} at service start and at an acquisition site, before any custody (${refusals.findIndex(entry => entry[1] === arrange)})`, async () => {
      const f = await fixture({ workTarget: arrange });
      await expect(startConfiguredRuntimeService(f.project, { async onPage() {}, async onError() {} }, f.options)).rejects.toMatchObject({ code });
      const execution = { gitExecutable: '/usr/bin/git', timeoutMs: 10000, outputBytes: 65536 };
      await expect(openConfiguredWorkspaceBroker(f.project, execution, f.options)).rejects.toMatchObject({ code });
    });
  }
  it('refuses more than one target in slice 1 as invalid configuration', async () => {
    const f = await fixture();
    await f.config([{ id: 'n1', kind: 'git', path: f.target, baseRef: BASE }, { id: 'n2', kind: 'git', path: f.target, baseRef: BASE }]); clearConfigCache();
    await expect(startConfiguredRuntimeService(f.project, { async onPage() {}, async onError() {} }, f.options)).rejects.toMatchObject({ code: expect.stringMatching(/^CONFIG_/) });
  });

  it('checks work-target:use at admission and reservation through the real runtime service; grants admit and reserve', async () => {
    const f = await fixture({ targetActions: ['adopt'] });
    const service = await startConfiguredRuntimeService(f.project, { async onPage() {}, async onError() {} }, f.options);
    const client = createConfiguredRuntimeClient(f.project, f.options);
    try {
      await expect(client.createRun({ schemaVersion: 1, commandId: 'create-denied', scopeId: 's', runId: 'r1', graph })).rejects.toMatchObject({ code: 'POLICY_DENIED' });
      expect(f.runs()).toBe(0);
      await f.policy(['use', 'adopt']);
      expect((await client.createRun({ schemaVersion: 1, commandId: 'create', scopeId: 's', runId: 'r1', graph })).admission.run.runId).toBe('r1');
      await f.policy(['adopt']);
      await expect(client.reserveRunTasks({ schemaVersion: 1, commandId: 'reserve-denied', scopeId: 's', runId: 'r1', expectedRevision: 0 })).rejects.toMatchObject({ code: 'POLICY_DENIED' });
      await f.policy(['use']);
      expect((await client.reserveRunTasks({ schemaVersion: 1, commandId: 'reserve', scopeId: 's', runId: 'r1', expectedRevision: 0 })).reservation.identities).toHaveLength(1);
    } finally { await service.stop(); await service.done; }
  });

  // Sol WT-R1: execution consumes the target, so it needs work-target:use on the target of the same config snapshot, before any Git.
  async function reserved(f: Awaited<ReturnType<typeof fixture>>, client: ReturnType<typeof createConfiguredRuntimeClient>, runId: string) {
    await client.createRun({ schemaVersion: 1, commandId: `create-${runId}`, scopeId: 's', runId, graph });
    return (await client.reserveRunTasks({ schemaVersion: 1, commandId: `reserve-${runId}`, scopeId: 's', runId, expectedRevision: 0 })).reservation.identities[0]!;
  }
  it('refuses execution through the runtime service when only target use was revoked after reservation; nothing is consumed', async () => {
    const f = await fixture();
    const service = await startConfiguredRuntimeService(f.project, { async onPage() {}, async onError() {} }, f.options);
    const client = createConfiguredRuntimeClient(f.project, f.options);
    try {
      const identity = await reserved(f, client, 'r1');
      await f.policy(['adopt']);
      expect(await f.decision('attempt', 'execute', identity.attemptId)).toBe('allow');
      expect(await f.decision('work-target', 'use', 'n1')).toBe('deny');
      await expect(client.executeTask(identity)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
      await f.unconsumed(identity);
      // require-approval on the target never becomes allow (no approval broker outside the operation catalog).
      await f.policy(['use', 'adopt'], attemptActions, 'require-approval');
      await expect(client.executeTask(identity)).rejects.toMatchObject({ code: 'POLICY_APPROVAL_UNSUPPORTED' });
      // The target grant does not bypass a missing attempt:execute.
      await f.policy(['use', 'adopt'], attemptActions.filter(action => action !== 'execute'));
      expect(await f.decision('work-target', 'use', 'n1')).toBe('allow');
      await expect(client.executeTask(identity)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
      await f.unconsumed(identity);
    } finally { await service.stop(); await service.done; }
  });
  it('refuses execution when the config switched to another target without use before the first acquisition; nothing is consumed', async () => {
    const f = await fixture();
    const service = await startConfiguredRuntimeService(f.project, { async onPage() {}, async onError() {} }, f.options);
    const client = createConfiguredRuntimeClient(f.project, f.options);
    try {
      const identity = await reserved(f, client, 'r1');
      await f.config([{ id: 'n2', kind: 'git', path: await f.secondTarget(), baseRef: BASE }]); clearConfigCache();
      expect(await f.decision('attempt', 'execute', identity.attemptId)).toBe('allow');
      expect(await f.decision('work-target', 'use', 'n1')).toBe('allow');
      expect(await f.decision('work-target', 'use', 'n2')).toBe('deny');
      await expect(client.executeTask(identity)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
      await f.unconsumed(identity);
    } finally { await service.stop(); await service.done; }
  });
  it('re-checks target use at the launch gate: a revocation between the first check and acquisition prevents any launch', async () => {
    const f = await fixture();
    await createConfiguredRun(f.project, { schemaVersion: 1, commandId: 'create', scopeId: 's', runId: 'r1', graph }, f.options);
    const identity = (await reserveConfiguredRunTasks(f.project, { schemaVersion: 1, commandId: 'reserve', scopeId: 's', runId: 'r1', expectedRevision: 0 }, f.options)).reservation.identities[0]!;
    const acquire = RunWorkspaceAcquisitionApplication.prototype.acquire;
    const spy = vi.spyOn(RunWorkspaceAcquisitionApplication.prototype, 'acquire').mockImplementationOnce(async function (this: RunWorkspaceAcquisitionApplication, input: unknown) {
      await f.policy(['adopt']); return acquire.call(this, input);
    });
    await expect(executeConfiguredTask(f.project, identity, f.options)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    expect(await f.decision('attempt', 'execute', identity.attemptId)).toBe('allow');
    // Existing freshness contract (as for attempt:execute): acquisition is not an effect; the launch gate refuses before any claim.
    const store = await openConfiguredAttemptStore(f.project, f.options);
    try {
      expect(spy).toHaveBeenCalledTimes(1); // the first check passed and acquisition ran: the refusal came from the later gate
      expect(await store.store.loadRunWorkspaceCustody('s', 'r1')).not.toBeNull();
      expect(await store.store.loadBoundDispatch(identity)).toBeNull();
    } finally { store.store.close(); }
  });

  it('without a configured target needs no work-target grant (unchanged admission)', async () => {
    const f = await fixture({ workTarget: 'none', targetActions: [] });
    await createConfiguredRun(f.project, { schemaVersion: 1, commandId: 'create', scopeId: 's', runId: 'r1', graph }, f.options);
    expect((await reserveConfiguredRunTasks(f.project, { schemaVersion: 1, commandId: 'reserve', scopeId: 's', runId: 'r1', expectedRevision: 0 }, f.options)).reservation.identities).toHaveLength(1);
  });
});

describe.skipIf(process.platform !== 'linux' || !docker)('work target cycle: refs only in the target, base advanced, work-target:adopt', () => {
  async function executed(f: Awaited<ReturnType<typeof fixture>>, runId: string) {
    await createConfiguredRun(f.project, { schemaVersion: 1, scopeId: 's', runId, commandId: `create-${runId}`, graph }, f.options);
    const identity = (await reserveConfiguredRunTasks(f.project, { schemaVersion: 1, scopeId: 's', runId, commandId: `reserve-${runId}`, expectedRevision: 0 }, f.options)).reservation.identities[0]!;
    cleanup.push(async () => {
      const opened = await openConfiguredAttemptStore(f.project, f.options);
      try { const record = await opened.store.loadBoundDispatch(identity);
        if (record) { const supervisor = await DockerSupervisor.restoreProfile(record.profile); await supervisor.cancel(record.request); await supervisor.release(record.request); } }
      finally { opened.store.close(); }
    });
    expect((await executeConfiguredTask(f.project, identity, f.options)).execution.terminal?.exitCode).toBe(0);
    await prepareConfiguredWorkspacePatch(f.project, identity, f.options);
    const checked = await checkConfiguredWorkspaceIntegration(f.project, identity, f.options);
    const prepareIntegration = () => prepareConfiguredWorkspaceIntegration(f.project, { schemaVersion: 1, commandId: `candidate-${runId}`, identity, proposal: checked.proposal }, f.options);
    await prepareIntegration();
    const deliver = () => deliverConfiguredWorkspaceIntegration(f.project, { schemaVersion: 1, commandId: `delivery-${runId}`, identity, integrationCommandId: `candidate-${runId}` }, f.options);
    const evaluate = async () => {
      const opened = await openConfiguredAttemptStore(f.project, f.options);
      let revision; try { revision = (await opened.store.loadRun('s', runId))!.revision; } finally { opened.store.close(); }
      expect((await evaluateTask(f.project, { schemaVersion: 1, commandId: `evaluation-${runId}`, identity, expectedRevision: revision }, f.options)).evaluation.run.tasks[0]!.phase).toBe('accepted');
    };
    const adopt = (commandId: string) => adoptConfiguredWorkspaceIntegration(f.project, { schemaVersion: 2, commandId, identity, deliveryCommandId: `delivery-${runId}`, targetRef: BASE }, f.options);
    return { identity, deliver, evaluate, adopt, prepareIntegration };
  }

  it('runs a full cycle against the target: live project refs, HEAD, index and config unchanged; adoption advances the base; next Run starts there', async () => {
    const f = await fixture();
    const liveBefore = await repositoryDigest(f.project), targetHead = await git(f.target, 'rev-parse', 'HEAD');
    // Owner WIP in the target checkout is not a precondition (nothing is applied to that checkout).
    await writeFile(join(f.target, 'note.txt'), 'owner-wip-in-target\n');
    const first = await executed(f, 'r1');
    // Lead 2026-09-30 (WT-R1 extension): every operation that reads or writes the target needs work-target:use; the attempt action
    // never substitutes for it. Ledger/artifact-only reads (patch preview, integration inspect) do not touch the target.
    await f.policy(['adopt']);
    expect(await f.decision('attempt', 'deliver-integration', first.identity.attemptId)).toBe('allow');
    await expect(first.deliver()).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    expect(await git(f.target, 'for-each-ref', '--format=%(refname)', 'refs/deckent/')).toBe('');
    await expect(checkConfiguredWorkspaceIntegration(f.project, first.identity, f.options)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    await expect(prepareConfiguredWorkspacePatch(f.project, first.identity, f.options)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    await expect(first.prepareIntegration()).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    expect((await previewConfiguredWorkspacePatch(f.project, first.identity, f.options)).patch.changes.length).toBeGreaterThan(0);
    expect(await inspectConfiguredWorkspaceIntegration(f.project, { schemaVersion: 1, identity: first.identity, commandId: 'candidate-r1' }, f.options)).toBeDefined();
    await f.policy(['use', 'adopt']);
    const delivered = await first.deliver();
    expect(delivered).toMatchObject({ status: 'reference-delivered', plan: { baseCommit: f.base } });
    expect(await git(f.target, 'for-each-ref', '--format=%(objectname)', delivered.plan.ref)).toBe(delivered.plan.commit);
    // A Run pinned to the delivery reads the target to pin its base: use first, before any target Git.
    const pinned = (commandId: string) => createConfiguredDeliveryRun(f.project, { schemaVersion: 1, commandId, scopeId: 's', runId: 'rv', graph, deliveryCommandId: 'delivery-r1' }, f.options);
    await f.policy(['adopt']);
    await expect(pinned('verify-denied')).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    await f.policy(['use', 'adopt']);
    expect((await pinned('verify')).admission.run.runId).toBe('rv');
    await first.evaluate();
    // work-target:adopt is checked for adoption and rollback; the attempt grant alone does not move the target's branch.
    await f.policy(['use']);
    await expect(first.adopt('adopt-denied')).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    expect(await git(f.target, 'rev-parse', BASE)).toBe(f.base);
    await f.policy(['use', 'adopt']);
    expect(await first.adopt('adopt')).toMatchObject({ status: 'adopted', targetRef: BASE, fromCommit: f.base, toCommit: delivered.plan.commit });
    expect(await git(f.target, 'rev-parse', BASE)).toBe(delivered.plan.commit);
    await f.policy(['use']);
    await expect(rollbackConfiguredWorkspaceIntegration(f.project, { schemaVersion: 1, commandId: 'rollback-denied', identity: first.identity, adoptionCommandId: 'adopt' }, f.options))
      .rejects.toMatchObject({ code: 'POLICY_DENIED' });
    await f.policy(['use', 'adopt']);
    // K4 = A: the adopted base branch is the next Run's base; the target checkout stays detached where it was.
    const second = await executed(f, 'r2');
    const next = await second.deliver();
    expect(next.plan.baseCommit).toBe(delivered.plan.commit);
    expect(await git(f.target, 'rev-parse', 'HEAD')).toBe(targetHead);
    expect(await readFile(join(f.target, 'note.txt'), 'utf8')).toBe('owner-wip-in-target\n');
    expect(await repositoryDigest(f.project)).toBe(liveBefore);
    expect(await git(f.project, 'for-each-ref', '--format=%(refname)', 'refs/deckent/')).toBe('');
  }, 120_000);

  it('executes through the runtime service against the target of the same config snapshot once its use is granted', async () => {
    const f = await fixture();
    const service = await startConfiguredRuntimeService(f.project, { async onPage() {}, async onError() {} }, f.options);
    const client = createConfiguredRuntimeClient(f.project, f.options);
    try {
      await client.createRun({ schemaVersion: 1, commandId: 'create', scopeId: 's', runId: 'r1', graph });
      const identity = (await client.reserveRunTasks({ schemaVersion: 1, commandId: 'reserve', scopeId: 's', runId: 'r1', expectedRevision: 0 })).reservation.identities[0]!;
      cleanup.push(async () => { const opened = await openConfiguredAttemptStore(f.project, f.options);
        try { const record = await opened.store.loadBoundDispatch(identity);
          if (record) { const supervisor = await DockerSupervisor.restoreProfile(record.profile); await supervisor.cancel(record.request); await supervisor.release(record.request); } }
        finally { opened.store.close(); } });
      const n2 = await f.secondTarget();
      await f.config([{ id: 'n2', kind: 'git', path: n2, baseRef: BASE }]); clearConfigCache();
      await expect(client.executeTask(identity)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
      await f.unconsumed(identity);
      await writeFile(productResourcePath(f.layout, 'policy'), (await readFile(productResourcePath(f.layout, 'policy'), 'utf8')).replace('"ids":["n1"]', '"ids":["n2"]'));
      expect((await client.executeTask(identity)).execution.terminal?.exitCode).toBe(0);
      const opened = await openConfiguredAttemptStore(f.project, f.options);
      try { expect((await opened.store.loadRunWorkspaceCustody('s', 'r1'))!.source.sourceFingerprint)
        .toBe(fingerprintGitSource({ schemaVersion: 1, sourceRoot: n2, repositoryRoot: n2 })); } finally { opened.store.close(); }
    } finally { await service.stop(); await service.done; }
  }, 120_000);

  it('turns a moved base branch into PATCH_BASE_ADVANCED (not PATCH_CONFLICT) and refuses a target made unsafe after admission', async () => {
    const f = await fixture();
    const liveBefore = await repositoryDigest(f.project);
    const run = await executed(f, 'r1');
    const moved = await git(f.target, 'commit-tree', `${f.base}^{tree}`, '-p', f.base, '-m', 'owner advances the base');
    await git(f.target, 'update-ref', BASE, moved);
    await expect(run.deliver()).rejects.toMatchObject({ code: 'PATCH_BASE_ADVANCED' });
    expect(await git(f.target, 'for-each-ref', '--format=%(refname)', 'refs/deckent/deliveries/')).toBe('');
    // Each acquisition re-applies the typed refusals: borrowed objects appear after admission and reservation.
    await createConfiguredRun(f.project, { schemaVersion: 1, scopeId: 's', runId: 'r2', commandId: 'create-r2', graph }, f.options);
    const identity = (await reserveConfiguredRunTasks(f.project, { schemaVersion: 1, scopeId: 's', runId: 'r2', commandId: 'reserve-r2', expectedRevision: 0 }, f.options)).reservation.identities[0]!;
    await writeFile(join(f.target, '.git/objects/info/alternates'), join(f.project, '.git/objects') + '\n');
    await expect(executeConfiguredTask(f.project, identity, f.options)).rejects.toMatchObject({ code: 'WORK_TARGET_ALTERNATES' });
    expect(await repositoryDigest(f.project)).toBe(liveBefore);
  }, 120_000);
});

// K6 = A (owner 2026-09-30): patches are classified against the task scope; the work target switches warn -> enforce (lane Jev c93ceea4).
describe.skipIf(process.platform !== 'linux' || !docker)('work target scope mode: warn classifies, enforce refuses before any integration or delivery write', () => {
  const target = (path: string, mode?: 'warn' | 'enforce') => [{ id: 'n1', kind: 'git', path, baseRef: BASE, ...(mode ? { scope: { mode } } : {}) }];
  async function attempt(f: Awaited<ReturnType<typeof fixture>>, runId: string, scopePaths: readonly string[] | null) {
    await createConfiguredRun(f.project, { schemaVersion: 1, scopeId: 's', runId, commandId: `create-${runId}`, graph }, f.options);
    const identity = (await reserveConfiguredRunTasks(f.project, { schemaVersion: 1, scopeId: 's', runId, commandId: `reserve-${runId}`, expectedRevision: 0 }, f.options)).reservation.identities[0]!;
    cleanup.push(async () => {
      const opened = await openConfiguredAttemptStore(f.project, f.options);
      try { const record = await opened.store.loadBoundDispatch(identity);
        if (record) { const supervisor = await DockerSupervisor.restoreProfile(record.profile); await supervisor.cancel(record.request); await supervisor.release(record.request); } }
      finally { opened.store.close(); }
    });
    if (scopePaths) {
      // Test-only stand-in for a template Run (its native CLI does not run in the test image): the stored Run graph becomes v3 with a work input,
      // exactly the shape admission freezes for a template task. Execution, patch, integration and delivery read it through the real ledger.
      const { path, store } = await openConfiguredAttemptStore(f.project, f.options); store.close();
      const db = new DatabaseSync(path);
      try {
        const row = db.prepare('SELECT snapshot FROM runs WHERE scope_id=? AND run_id=?').get('s', runId) as { snapshot: string };
        const snapshot = JSON.parse(row.snapshot);
        snapshot.graph.schemaVersion = 3; snapshot.graph.tasks[0].workInput = { schemaVersion: 1, task: 'Append to note.txt and remove removed.txt.',
          scope: { paths: scopePaths }, acceptance: 'Zero exit.', model: { channelId: 'c', modelId: 'claude-sonnet-5-5', auxiliaryModelIds: [] } };
        db.prepare('UPDATE runs SET snapshot=? WHERE scope_id=? AND run_id=?').run(JSON.stringify(snapshot), 's', runId);
      } finally { db.close(); }
    }
    expect((await executeConfiguredTask(f.project, identity, f.options)).execution.terminal?.exitCode).toBe(0);
    const prepareIntegration = (proposal: string) => prepareConfiguredWorkspaceIntegration(f.project, { schemaVersion: 1, commandId: `candidate-${runId}`, identity, proposal }, f.options);
    const inspect = () => inspectConfiguredWorkspaceIntegration(f.project, { schemaVersion: 1, identity, commandId: `candidate-${runId}` }, f.options);
    const deliver = () => deliverConfiguredWorkspaceIntegration(f.project, { schemaVersion: 1, commandId: `delivery-${runId}`, identity, integrationCommandId: `candidate-${runId}` }, f.options);
    return { identity, prepareIntegration, inspect, deliver };
  }
  const deliveries = (f: Awaited<ReturnType<typeof fixture>>) => git(f.target, 'for-each-ref', '--format=%(refname)', 'refs/deckent/deliveries/');
  /** Delivery intents in the ledger: a refusal before the claim leaves none. */
  const deliveryIntents = async (f: Awaited<ReturnType<typeof fixture>>) => { const { path, store } = await openConfiguredAttemptStore(f.project, f.options); store.close();
    const db = new DatabaseSync(path, { readOnly: true }); try { return (db.prepare('SELECT count(*) AS n FROM workspace_deliveries').get() as { n: number }).n; } finally { db.close(); } };

  it('enforce: out-of-scope paths stay prepared and visible, integration and delivery refuse with the bounded paths; warn delivers the same work', async () => {
    const f = await fixture(); await f.config(target(f.target, 'enforce')); clearConfigCache();
    const run = await attempt(f, 'r1', ['note.txt', 'removed.txt']);
    const prepared = await prepareConfiguredWorkspacePatch(f.project, run.identity, f.options);
    expect(prepared.patch.changes.map(change => change.path)).toEqual(['added.txt', 'note.txt', 'removed.txt']);
    expect(prepared.scope).toEqual({ schemaVersion: 1, matcher: 1, mode: 'enforce', status: 'out-of-scope', declared: ['note.txt', 'removed.txt'], outOfScope: ['added.txt'] });
    expect((await previewConfiguredWorkspacePatch(f.project, run.identity, f.options)).scope).toEqual(prepared.scope);
    const checked = await checkConfiguredWorkspaceIntegration(f.project, run.identity, f.options);
    expect(checked.scope).toEqual(prepared.scope);
    await expect(run.prepareIntegration(checked.proposal)).rejects.toMatchObject({ code: 'PATCH_SCOPE_VIOLATION', params: { count: 1, paths: 'added.txt', omitted: 0 } });
    expect((await run.inspect()).status).toBe('absent'); // no intent, no candidate
    // Warn: the same prepared patch integrates; switching back to enforce refuses the delivery before its intent or any Git reference.
    await f.config(target(f.target, 'warn')); clearConfigCache();
    await run.prepareIntegration(checked.proposal);
    await f.config(target(f.target, 'enforce')); clearConfigCache();
    await expect(run.deliver()).rejects.toMatchObject({ code: 'PATCH_SCOPE_VIOLATION' });
    expect(await deliveries(f)).toBe(''); expect(await deliveryIntents(f)).toBe(0);
    await f.config(target(f.target)); clearConfigCache(); // absent setting = warn
    const delivered = await run.deliver();
    expect(await deliveries(f)).toBe(delivered.plan.ref);
  }, 120_000);

  it('enforce: a task without a declared scope is unscoped and refused; in-scope work delivers', async () => {
    const f = await fixture(); await f.config(target(f.target, 'enforce')); clearConfigCache();
    const unscoped = await attempt(f, 'r1', null);
    const prepared = await prepareConfiguredWorkspacePatch(f.project, unscoped.identity, f.options);
    expect(prepared.scope).toEqual({ schemaVersion: 1, matcher: 1, mode: 'enforce', status: 'unscoped' });
    const checked = await checkConfiguredWorkspaceIntegration(f.project, unscoped.identity, f.options);
    await expect(unscoped.prepareIntegration(checked.proposal)).rejects.toMatchObject({ code: 'PATCH_SCOPE_UNDECLARED' });
    expect((await unscoped.inspect()).status).toBe('absent');
    const scoped = await attempt(f, 'r2', ['*.txt']);
    expect((await prepareConfiguredWorkspacePatch(f.project, scoped.identity, f.options)).scope).toMatchObject({ mode: 'enforce', status: 'in-scope' });
    await scoped.prepareIntegration((await checkConfiguredWorkspaceIntegration(f.project, scoped.identity, f.options)).proposal);
    expect((await scoped.deliver()).status).toBe('reference-delivered');
  }, 120_000);
});
