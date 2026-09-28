import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { hostname, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { adoptConfiguredWorkspaceIntegration, deliverConfiguredWorkspaceIntegration, evaluateTask, prepareConfiguredWorkspaceIntegration } from '../../../src/index.js';
import { createConfiguredDeliveryRun, reserveConfiguredRunTasks } from '../../../src/composition/core/runs/index.js';
import { executeConfiguredTask } from '../../../src/composition/core/execution/index.js';
import { DockerSupervisor } from '#adapters/index.js';
import type { AttemptIdentity } from '#domain/index.js';
import { clearConfigCache, productResourcePath } from '#platform/index.js';
import { readyDeliveryFixture, type FixtureTracker } from '../support/workspace-patch-fixture.js';

const exec = promisify(execFile);
const track: FixtureTracker = { roots: [], cleanup: [] };
afterEach(async () => {
  for (const close of track.cleanup.splice(0).reverse()) await close();
  clearConfigCache(); for (const root of track.roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const target = 'refs/heads/adopted';
const graph = (kind: string, acceptedExitCodes = [0]) => ({ schemaVersion: 2 as const, revision: 1,
  tasks: [{ id: 'check', kind, dependencies: [], acceptanceCriteria: ['exit'] }],
  criterionDefinitions: [{ id: 'exit', version: 1, description: 'Accepted exit', evaluator: { id: 'process-exit', version: 1 }, parameters: { acceptedExitCodes } }] });
const requirement = { kind: 'verify', required: true, criteria: [{ evaluator: { id: 'process-exit', version: 1 }, parameters: { acceptedExitCodes: [0] } }] };
/** `npm test` of the delivered tree: the script needs the dependency's bin and module (bound read-only from the host project) and the
 * delivered-only `added.txt`, so exit 0 proves both the dependency bind and the delivered commit. npm writes cache/logs to tmpfs only. */
const npmTest = ['npm', '--cache', '/tmp/.npm', '--logs-dir', '/tmp/.npm-logs', '--update-notifier=false', 'test'];
const baseFiles = {
  'package.json': JSON.stringify({ name: 'loop', version: '1.0.0', private: true, scripts: { test: 'check-dep && node test.js' } }),
  'test.js': "const dep=require('dep');const fs=require('node:fs');if(dep.value!==42||!fs.existsSync('added.txt'))process.exit(3);console.log('verified',dep.value);\n",
};
/** Host-prepared dependencies in the project (untracked): a module and its `.bin` link, like an `npm ci` result. */
async function dependencies(project: string) {
  const modules = join(project, 'node_modules');
  await mkdir(join(modules, 'dep', 'bin'), { recursive: true }); await mkdir(join(modules, '.bin'));
  await writeFile(join(modules, 'dep', 'index.js'), 'module.exports={value:42};\n');
  await writeFile(join(modules, 'dep', 'package.json'), JSON.stringify({ name: 'dep', version: '1.0.0', bin: { 'check-dep': 'bin/check.js' } }));
  await writeFile(join(modules, 'dep', 'bin', 'check.js'), '#!/usr/bin/env node\nconsole.log("dependency bin");\n'); await chmod(join(modules, 'dep', 'bin', 'check.js'), 0o755);
  await symlink('../dep/bin/check.js', join(modules, '.bin', 'check-dep'));
  await writeFile(join(project, '.git', 'info', 'exclude'), 'node_modules/\n', { flag: 'a' });
  const snapshot = async () => JSON.stringify(await Promise.all((await readdir(modules, { recursive: true })).sort()
    .map(async path => [path, await readFile(join(modules, path)).then(value => value.toString('base64'), () => null)])));
  return snapshot;
}

/** Delivered and accepted coding attempt of a project whose delivered tree has an `npm test`, host dependencies, verification kinds
 * (`verify`: npm test with the dependency bind, `verify-other`: same command under another kind, `verify-write`: bind write probe)
 * and the installation's verification requirement. Operator commands go through the built CLI. */
async function loop(verification: unknown = requirement) {
  const f = await readyDeliveryFixture(track, { adoptionTargets: [target], baseFiles });
  await f.policy(['read-output', 'prepare-integration', 'deliver-integration', 'evaluate']);
  await prepareConfiguredWorkspaceIntegration(f.project, f.command, f.options);
  const delivery = await deliverConfiguredWorkspaceIntegration(f.project,
    { schemaVersion: 1, commandId: 'delivery', identity: f.identity, integrationCommandId: 'candidate' }, f.options);
  const coding = (await f.runtime.store.loadRun(f.identity.scopeId, f.identity.runId))!;
  await evaluateTask(f.project, { schemaVersion: 1, commandId: 'evaluation', identity: f.identity, expectedRevision: coding.revision }, f.options);
  const snapshot = await dependencies(f.project);
  const config = JSON.parse(await readFile(f.configPath, 'utf8'));
  const kind = (name: string, argv: string[]) => {
    const profile = structuredClone(config.admission.registry.profiles[0]); profile.id = `fixture-${name}`;
    profile.parameters.argv = argv; profile.parameters.readOnlyMounts = [{ source: 'node_modules', target: '/node_modules' }];
    config.admission.registry.profiles.push(profile); config.admission.registry.kinds.push({ kind: name, profile: { id: profile.id, version: 1 } });
  };
  kind('verify', npmTest); kind('verify-other', npmTest);
  kind('verify-write', ['node', '-e', "try{require('node:fs').writeFileSync('/node_modules/probe','x')}catch(e){process.exit(e.code==='EROFS'?0:4)}process.exit(1)"]);
  const configure = async (value: unknown) => {
    const next = structuredClone(config); if (value === undefined) delete next.execution.adoption.verification; else next.execution.adoption.verification = value;
    await writeFile(f.configPath, JSON.stringify(next)); clearConfigCache();
  };
  await configure(verification);
  const principals = [{ issuer: hostname(), subject: String(userInfo().uid) }];
  await writeFile(productResourcePath(f.runtime.layout, 'policy'), JSON.stringify({ schemaVersion: 1, revision: 'verification-loop', restrictions: [], grants: [
    { id: 'run', effect: 'allow', actions: ['create', 'reserve', 'inspect'], scopes: ['s'], principals, resource: { kind: 'run', ids: ['r', 'v', 'weak', 'other', 'probe'] } },
    { id: 'pool', effect: 'allow', actions: ['use'], scopes: ['s'], principals, resource: { kind: 'pool', ids: ['p'] } },
    { id: 'attempt', effect: 'allow', actions: ['execute', 'read-output', 'recover-output', 'evaluate', 'prepare-integration', 'deliver-integration',
      'adopt-integration', 'rollback-integration'], scopes: ['s'], principals, resource: { kind: 'attempt', ids: 'all' } },
  ] }), { mode: 0o600 });
  const entry = resolve('dist/composition/core/cli/internal/entry.js');
  const cli = async (args: string[]) => {
    try { const { stdout } = await exec(process.execPath, [entry, ...args], { cwd: f.project, env: { ...process.env, ...f.options.env } }); return { exit: 0, stdout, code: null };
    } catch (error) { const failure = error as { code: number; stdout: string; stderr: string };
      return { exit: failure.code, stdout: failure.stdout, code: (JSON.parse(failure.stderr) as { code: string }).code }; }
  };
  const identityFlags = ['--scope', 's', '--run', f.identity.runId, '--task', f.identity.taskId, '--attempt', f.identity.attemptId,
    '--generation', String(f.identity.generation), '--layout-revision', f.identity.layoutRevision];
  const adoptCli = (commandId: string, runId?: string, json = true) => cli(['task', 'integration-adopt', ...identityFlags, '--command-id', commandId,
    '--delivery-command-id', 'delivery', '--target', target, ...(runId ? ['--verification-run', runId] : []), ...(json ? ['--json'] : [])]);
  const adopt = (commandId: string, verificationRunId?: string, verificationKind = 'verify') => adoptConfiguredWorkspaceIntegration(f.project,
    { schemaVersion: 2, commandId, identity: f.identity, deliveryCommandId: 'delivery', targetRef: target,
      ...(verificationRunId === undefined ? {} : { verificationRunId, verificationKind }) } as never, f.options);
  /** Delivery-pinned verification Run through the CLI (`run create --delivery-command-id`). */
  const createCli = async (runId: string, kindName = 'verify', codes = [0]) => {
    const path = join(f.root, `graph-${runId}.json`); await writeFile(path, JSON.stringify(graph(kindName, codes)));
    return cli(['run', 'create', '--scope', 's', '--id', runId, '--command-id', `create-${runId}`, '--graph', path, '--delivery-command-id', 'delivery', '--json']);
  };
  const reserve = async (runId: string): Promise<AttemptIdentity> => {
    const identity = (await reserveConfiguredRunTasks(f.project, { schemaVersion: 1, scopeId: 's', runId, commandId: `reserve-${runId}`, expectedRevision: 0 },
      f.options)).reservation.identities[0]!;
    track.cleanup.push(async () => {
      const record = await f.runtime.store.loadBoundDispatch(identity);
      if (record) { const supervisor = await DockerSupervisor.restoreProfile(record.profile); await supervisor.cancel(record.request); await supervisor.release(record.request); }
    });
    return identity;
  };
  /** Reserve, execute and evaluate a created Run (the composition functions the runtime service progression uses). */
  const settle = async (runId: string, exitCode = 0) => {
    const identity = await reserve(runId);
    expect((await executeConfiguredTask(f.project, identity, f.options)).execution.terminal?.exitCode).toBe(exitCode);
    const run = (await f.runtime.store.loadRun('s', runId))!;
    const phase = (await evaluateTask(f.project, { schemaVersion: 1, commandId: `evaluate-${runId}`, identity, expectedRevision: run.revision }, f.options))
      .evaluation.run.tasks[0]!.phase;
    return { identity, phase };
  };
  const ledger = (sql: string) => {
    const db = new DatabaseSync(productResourcePath(f.runtime.layout, 'ledger'), { readOnly: true });
    try { return db.prepare(sql).all(); } finally { db.close(); }
  };
  const tip = () => f.git('rev-parse', target);
  const fence = () => f.git('for-each-ref', '--format=%(refname) %(objectname)', 'refs/deckent/adoption-fences/');
  const unchanged = async (fenceBefore: string) => {
    expect(await tip()).toBe(f.base); expect(await fence()).toBe(fenceBefore);
    expect(ledger('SELECT command_id FROM workspace_adoptions')).toEqual([]);
  };
  await f.git('branch', 'adopted', f.base);
  return { ...f, plan: delivery.plan, snapshot, configure, cli, adoptCli, adopt, createCli, settle, ledger, tip, fence, unchanged };
}

describe.skipIf(process.platform !== 'linux' || !process.env.DECKENT_TEST_DOCKER_IMAGE)('verification precondition and operator loop (B06-2c)', () => {
  it('runs the operator loop through the CLI: required verification refuses, a pinned npm test with read-only dependencies verifies, adoption moves the branch', async () => {
    const f = await loop();
    const dependenciesBefore = await f.snapshot(); const fenceBefore = await f.fence();
    // Required by the installation: adoption without a verification Run is refused, by the CLI and the SDK alike.
    expect(await f.adoptCli('unverified')).toMatchObject({ exit: 1, code: 'ADOPTION_NOT_VERIFIED' });
    await expect(f.adopt('unverified-sdk')).rejects.toMatchObject({ code: 'ADOPTION_NOT_VERIFIED' });
    await f.unchanged(fenceBefore);
    // The operator pins a verification Run to the delivery through the CLI (the delivery command, never a commit).
    const created = await f.createCli('v');
    expect(created.exit).toBe(0);
    expect(JSON.parse(created.stdout)).toMatchObject({ schemaVersion: 1, admission: { commandId: 'create-v', run: { runId: 'v', revision: 0 } } });
    const custody = await f.runtime.store.loadRunWorkspaceCustody('s', 'v');
    expect(custody?.baseRevision).toBe(f.plan.commit);
    const { identity, phase } = await f.settle('v');
    expect(phase).toBe('accepted');
    // The dependency bind is read-only and outside /workspace: the verification clone is exactly the delivered tree, host dependencies untouched.
    const workspace = (await f.runtime.workspaces.openRecorded(identity))!.workspace;
    expect(await exec('/usr/bin/git', ['-C', workspace, 'rev-parse', 'HEAD']).then(result => result.stdout.trim())).toBe(f.plan.commit);
    expect(await exec('/usr/bin/git', ['-C', workspace, 'status', '--porcelain', '--ignored']).then(result => result.stdout)).toBe('');
    expect(await f.snapshot()).toBe(dependenciesBefore);
    // The operator adopts with the verification Run; the kind comes from the installation's configuration.
    const adopted = await f.adoptCli('adopt', 'v');
    expect(adopted.exit).toBe(0);
    const result = JSON.parse(adopted.stdout);
    expect(result).toMatchObject({ schemaVersion: 2, status: 'adopted', targetRef: target, fromCommit: f.base, toCommit: f.plan.commit, sequence: 1,
      basis: 'task-acceptance', verification: { status: 'verified', runId: 'v', taskId: 'check', attemptId: identity.attemptId, kind: 'verify', commit: f.plan.commit } });
    expect(await f.tip()).toBe(f.plan.commit);
    expect(await f.fence()).toMatch(/^refs\/deckent\/adoption-fences\/[a-f0-9]{64} [a-f0-9]{40}$/);
    const intent = JSON.parse(String(f.ledger("SELECT intent FROM workspace_adoptions WHERE command_id='adopt'")[0]!.intent));
    expect(intent).toMatchObject({ schemaVersion: 2, command: { verificationRunId: 'v', verificationKind: 'verify' }, verification: { runId: 'v', commit: f.plan.commit } });
    // Human output of the same (replayed) command states the verification, never the "not verification" basis text.
    const human = await f.adoptCli('adopt', 'v', false);
    expect(human.exit).toBe(0);
    expect(human.stdout).toContain(f.plan.commit); expect(human.stdout).toMatch(/verified/i);
    expect(human.stdout).not.toMatch(/not verification/i);
  });

  it('refuses weaker criteria, another kind and an unconfigured CLI binding; the dependency bind cannot be written', async () => {
    const f = await loop();
    const fenceBefore = await f.fence(); const dependenciesBefore = await f.snapshot();
    // A Run whose criterion also accepts exit 1 is weaker than the installation's `[0]`: refused before its phase counts.
    expect((await f.createCli('weak', 'verify', [0, 1])).exit).toBe(0);
    expect((await f.settle('weak')).phase).toBe('accepted');
    await expect(f.adopt('weak', 'weak')).rejects.toMatchObject({ code: 'ADOPTION_VERIFICATION_CRITERIA_WEAKER' });
    expect(await f.adoptCli('weak-cli', 'weak')).toMatchObject({ exit: 1, code: 'ADOPTION_VERIFICATION_CRITERIA_WEAKER' });
    await f.unchanged(fenceBefore);
    // An accepted Run of another kind is not the installation's verification.
    await createConfiguredDeliveryRun(f.project, { schemaVersion: 1, commandId: 'create-other', scopeId: 's', runId: 'other', graph: graph('verify-other'),
      deliveryCommandId: 'delivery' }, f.options);
    expect((await f.settle('other')).phase).toBe('accepted');
    await expect(f.adopt('other', 'other', 'verify-other')).rejects.toMatchObject({ code: 'ADOPTION_VERIFICATION_MISMATCH' });
    await f.unchanged(fenceBefore);
    // The container cannot write the bound dependencies (EROFS), and the host directory is unchanged.
    await createConfiguredDeliveryRun(f.project, { schemaVersion: 1, commandId: 'create-probe', scopeId: 's', runId: 'probe', graph: graph('verify-write'),
      deliveryCommandId: 'delivery' }, f.options);
    expect((await f.settle('probe')).phase).toBe('accepted');
    expect(await f.snapshot()).toBe(dependenciesBefore);
    // Without a configured verification the CLI cannot choose a kind: typed refusal, nothing written.
    await f.configure(undefined);
    expect(await f.adoptCli('unconfigured', 'weak')).toMatchObject({ exit: 78, code: 'ADOPTION_VERIFICATION_NOT_CONFIGURED' });
    await f.unchanged(fenceBefore);
    // Configured but not required: adoption without verification stays possible and says so.
    await f.configure({ ...requirement, required: false });
    expect(await f.adopt('optional')).toMatchObject({ status: 'adopted', verification: { status: 'not-verified' } });
    expect(await f.tip()).toBe(f.plan.commit);
  });
});
