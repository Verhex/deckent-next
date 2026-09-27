import { readFile, rm, writeFile } from 'node:fs/promises';
import { hostname, userInfo } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { adoptConfiguredWorkspaceIntegration, deliverConfiguredWorkspaceIntegration, evaluateTask, prepareConfiguredWorkspaceIntegration,
  rollbackConfiguredWorkspaceIntegration } from '../../../src/index.js';
import { createConfiguredDeliveryRun, createConfiguredRun, reserveConfiguredRunTasks } from '../../../src/composition/core/runs/index.js';
import { executeConfiguredTask } from '../../../src/composition/core/execution/index.js';
import { DockerSupervisor } from '#adapters/index.js';
import type { AttemptIdentity } from '#domain/index.js';
import { clearConfigCache, productResourcePath } from '#platform/index.js';
import { readyDeliveryFixture, type FixtureTracker } from '../support/workspace-patch-fixture.js';

const track: FixtureTracker = { roots: [], cleanup: [] };
afterEach(async () => {
  for (const close of track.cleanup.splice(0).reverse()) await close();
  clearConfigCache(); for (const root of track.roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const target = 'refs/heads/adopted';
const graph = (kind: string) => ({ schemaVersion: 2 as const, revision: 1, tasks: [{ id: 'check', kind, dependencies: [], acceptanceCriteria: ['exit'] }],
  criterionDefinitions: [{ id: 'exit', version: 1, description: 'Zero exit', evaluator: { id: 'process-exit', version: 1 }, parameters: { acceptedExitCodes: [0] } }] });
const runIds = ['r', 'v', 'v2', 'f', 'w', 'a', 'p', 'xr', 'nope'];
const attemptActions = ['execute', 'read-output', 'recover-output', 'evaluate', 'prepare-integration', 'deliver-integration', 'adopt-integration', 'rollback-integration'];

/** Delivered and accepted coding attempt, a not-checked-out adoption branch at the delivery base, and two verification kinds:
 * `verify` exits 0 only on the delivered tree (it needs the delivered `added.txt`), `verify-fail` always exits 1. */
async function delivered() {
  const f = await readyDeliveryFixture(track, { adoptionTargets: [target] });
  await f.policy(['read-output', 'prepare-integration', 'deliver-integration', 'evaluate']);
  await prepareConfiguredWorkspaceIntegration(f.project, f.command, f.options);
  const delivery = await deliverConfiguredWorkspaceIntegration(f.project,
    { schemaVersion: 1, commandId: 'delivery', identity: f.identity, integrationCommandId: 'candidate' }, f.options);
  const coding = (await f.runtime.store.loadRun(f.identity.scopeId, f.identity.runId))!;
  await evaluateTask(f.project, { schemaVersion: 1, commandId: 'evaluation', identity: f.identity, expectedRevision: coding.revision }, f.options);
  const config = JSON.parse(await readFile(f.configPath, 'utf8'));
  const kind = (name: string, argv: string[]) => {
    const profile = structuredClone(config.admission.registry.profiles[0]); profile.id = `fixture-${name}`; profile.parameters.argv = argv;
    config.admission.registry.profiles.push(profile); config.admission.registry.kinds.push({ kind: name, profile: { id: profile.id, version: 1 } });
  };
  kind('verify', ['node', '-e', "require('node:fs').readFileSync('added.txt')"]);
  kind('verify-fail', ['node', '-e', 'process.exit(1)']);
  const writeConfig = async (value: unknown) => { await writeFile(f.configPath, JSON.stringify(value)); clearConfigCache(); };
  await writeConfig(config);
  const principals = [{ issuer: hostname(), subject: String(userInfo().uid) }];
  const policy = (runActions = ['create', 'reserve', 'inspect']) => writeFile(productResourcePath(f.runtime.layout, 'policy'), JSON.stringify({
    schemaVersion: 1, revision: 'adoption-verification', restrictions: [], grants: [
      { id: 'run', effect: 'allow', actions: runActions, scopes: ['s', 'x'], principals, resource: { kind: 'run', ids: runIds } },
      { id: 'pool', effect: 'allow', actions: ['use'], scopes: ['s', 'x'], principals, resource: { kind: 'pool', ids: ['p'] } },
      { id: 'attempt', effect: 'allow', actions: attemptActions, scopes: ['s'], principals, resource: { kind: 'attempt', ids: 'all' } },
    ] }), { mode: 0o600 });
  await policy();
  const pinned = (runId: string, kindName = 'verify') => createConfiguredDeliveryRun(f.project,
    { schemaVersion: 1, commandId: `create-${runId}`, scopeId: 's', runId, graph: graph(kindName), deliveryCommandId: 'delivery' }, f.options);
  const reserve = async (runId: string): Promise<AttemptIdentity> => {
    const identity = (await reserveConfiguredRunTasks(f.project, { schemaVersion: 1, scopeId: 's', runId, commandId: `reserve-${runId}`, expectedRevision: 0 },
      f.options)).reservation.identities[0]!;
    track.cleanup.push(async () => {
      const record = await f.runtime.store.loadBoundDispatch(identity);
      if (record) { const supervisor = await DockerSupervisor.restoreProfile(record.profile); await supervisor.cancel(record.request); await supervisor.release(record.request); }
    });
    return identity;
  };
  const execute = async (identity: AttemptIdentity, exitCode = 0) =>
    expect((await executeConfiguredTask(f.project, identity, f.options)).execution.terminal?.exitCode).toBe(exitCode);
  const evaluate = async (identity: AttemptIdentity) => {
    const run = (await f.runtime.store.loadRun('s', identity.runId))!;
    return (await evaluateTask(f.project, { schemaVersion: 1, commandId: `evaluate-${identity.runId}`, identity, expectedRevision: run.revision }, f.options))
      .evaluation.run.tasks[0]!.phase;
  };
  /** Full verification Run: admitted, executed and evaluated. */
  const verified = async (runId: string, kindName = 'verify', exitCode = 0) => {
    await pinned(runId, kindName); const identity = await reserve(runId); await execute(identity, exitCode); return evaluate(identity);
  };
  const adopt = (commandId: string, verificationRunId?: string, verificationKind = 'verify') => adoptConfiguredWorkspaceIntegration(f.project,
    { schemaVersion: 2, commandId, identity: f.identity, deliveryCommandId: 'delivery', targetRef: target,
      ...(verificationRunId === undefined ? {} : { verificationRunId, verificationKind }) } as never, f.options);
  const ledger = (sql: string, ...args: string[]) => {
    const db = new DatabaseSync(productResourcePath(f.runtime.layout, 'ledger'), { readOnly: true });
    try { return db.prepare(sql).all(...args); } finally { db.close(); }
  };
  const adoptions = () => ledger('SELECT command_id,sequence,settled FROM workspace_adoptions ORDER BY sequence');
  const tip = () => f.git('rev-parse', target);
  const fence = () => f.git('for-each-ref', '--format=%(refname) %(objectname)', 'refs/deckent/adoption-fences/');
  await f.git('branch', 'adopted', f.base);
  return { ...f, plan: delivery.plan, config, writeConfig, policy, pinned, reserve, execute, evaluate, verified, adopt, adoptions, ledger, tip, fence };
}

describe.skipIf(process.platform !== 'linux' || !process.env.DECKENT_TEST_DOCKER_IMAGE)('adoption bound to a verification Run (B06-2b)', () => {
  it('adopts with an accepted verification Run on the delivered commit, records the binding, replays it and rolls back', async () => {
    const f = await delivered();
    expect(await f.verified('v')).toBe('accepted');
    const run = (await f.runtime.store.loadRun('s', 'v'))!;
    const adopted = await f.adopt('adopt', 'v');
    expect(adopted).toMatchObject({ schemaVersion: 2, status: 'adopted', targetRef: target, fromCommit: f.base, toCommit: f.plan.commit, sequence: 1,
      basis: 'task-acceptance', application: 'branch-reference',
      verification: { status: 'verified', runId: 'v', taskId: 'check', attemptId: run.bindings[0]!.identity.attemptId, kind: 'verify',
        runRevision: run.revision, commit: f.plan.commit } });
    const verification = (adopted as unknown as { verification: { profileFingerprint: string; criteria: string[] } }).verification;
    expect(verification.profileFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(verification.criteria).toEqual([run.execution.criteria[0]!.fingerprint]);
    expect(await f.tip()).toBe(f.plan.commit);
    // The durable intent carries the same binding (v2), not only the returned result.
    const intent = JSON.parse(String(f.ledger("SELECT intent FROM workspace_adoptions WHERE command_id='adopt'")[0]!.intent));
    expect(intent).toMatchObject({ schemaVersion: 2, kind: 'adopt', command: { schemaVersion: 2, verificationRunId: 'v', verificationKind: 'verify' },
      verification: { runId: 'v', commit: f.plan.commit, profileFingerprint: verification.profileFingerprint } });
    // Replay answers from the record; the same command with another verification Run or kind is a conflict.
    expect(await f.adopt('adopt', 'v')).toEqual(adopted);
    await expect(f.adopt('adopt', 'nope')).rejects.toMatchObject({ code: 'ADOPTION_CONFLICT' });
    await expect(f.adopt('adopt', 'v', 'verify-fail')).rejects.toMatchObject({ code: 'ADOPTION_CONFLICT' });
    await expect(f.adopt('adopt')).rejects.toMatchObject({ code: 'ADOPTION_CONFLICT' });
    const rolled = await rollbackConfiguredWorkspaceIntegration(f.project, { schemaVersion: 1, commandId: 'rollback', identity: f.identity, adoptionCommandId: 'adopt' }, f.options);
    expect(rolled).toMatchObject({ schemaVersion: 2, status: 'rolled-back', toCommit: f.base, sequence: 2, verification: { status: 'not-verified' } });
    expect(await f.tip()).toBe(f.base);
    // Adoption without a verification Run stays possible and says so.
    expect(await f.adopt('plain')).toMatchObject({ schemaVersion: 2, status: 'adopted', sequence: 3, verification: { status: 'not-verified' } });
  });

  it('refuses failed, pending, wrong-commit, wrong-kind, changed-profile, foreign and unreadable evidence without moving the branch or fence', async () => {
    const f = await delivered();
    expect(await f.verified('v')).toBe('accepted');
    const fence = await f.fence();
    const refuse = async (commandId: string, runId: string, code: string, kind = 'verify') => {
      await expect(f.adopt(commandId, runId, kind)).rejects.toMatchObject({ code });
      expect(await f.tip()).toBe(f.base); expect(await f.fence()).toBe(fence); expect(f.adoptions()).toEqual([]);
    };
    // The Run's single task failed on the delivered commit.
    expect(await f.verified('f', 'verify-fail', 1)).toBe('failed');
    await refuse('failed', 'f', 'ADOPTION_VERIFICATION_FAILED', 'verify-fail');
    // An accepted Run on another commit (custody sampled from the source HEAD, the delivery base) is not evidence for this commit.
    await createConfiguredRun(f.project, { schemaVersion: 1, commandId: 'create-w', scopeId: 's', runId: 'w',
      graph: graph('verify-fail') }, f.options);
    const plain = await f.reserve('w'); await f.execute(plain, 1); expect(await f.evaluate(plain)).toBe('failed');
    await refuse('wrong-commit-failed', 'w', 'ADOPTION_VERIFICATION_MISMATCH', 'verify-fail');
    // Kind named by the command differs from the Run's task kind.
    await refuse('wrong-kind', 'v', 'ADOPTION_VERIFICATION_MISMATCH', 'verify-fail');
    // Unknown Run, and a Run of another scope (never found in this scope).
    await refuse('unknown', 'nope', 'ADOPTION_VERIFICATION_MISMATCH');
    await createConfiguredRun(f.project, { schemaVersion: 1, commandId: 'create-xr', scopeId: 'x', runId: 'xr', graph: graph('verify') }, f.options);
    await refuse('foreign', 'xr', 'ADOPTION_VERIFICATION_MISMATCH');
    // The installation's profile for the kind changed after the Run: the Run did not run what `verify` means now.
    const changed = structuredClone(f.config);
    changed.admission.registry.profiles.find((profile: { id: string }) => profile.id === 'fixture-verify').parameters.argv = ['node', '-e', '0'];
    await f.writeConfig(changed);
    await refuse('changed-profile', 'v', 'ADOPTION_VERIFICATION_MISMATCH');
    await f.writeConfig(f.config);
    // Reading the verification Run needs run:inspect on it.
    await f.policy(['create', 'reserve']);
    await refuse('unreadable', 'v', 'POLICY_DENIED');
    await f.policy();
    // Admitted but not reserved, then reserved but not executed, then executed but not evaluated.
    await f.pinned('p');
    await refuse('pending', 'p', 'ADOPTION_VERIFICATION_PENDING');
    const active = await f.reserve('p');
    await refuse('active', 'p', 'ADOPTION_VERIFICATION_PENDING');
    await f.execute(active);
    await refuse('evaluating', 'p', 'ADOPTION_VERIFICATION_PENDING');
    // None of the refusals wedged the target: the accepted Run still adopts.
    expect(await f.adopt('adopt', 'v')).toMatchObject({ status: 'adopted', sequence: 1, verification: { status: 'verified', runId: 'v' } });
  });

  it('refuses an accepted Run on another commit: the commit comparison, not the phase, decides', async () => {
    const f = await delivered();
    // The plain Run's workspace is the source HEAD (delivery base), which has no added.txt: make the kind pass there too.
    const passing = structuredClone(f.config);
    passing.admission.registry.profiles.find((profile: { id: string }) => profile.id === 'fixture-verify').parameters.argv = ['node', '-e', '0'];
    await f.writeConfig(passing);
    await createConfiguredRun(f.project, { schemaVersion: 1, commandId: 'create-w', scopeId: 's', runId: 'w', graph: graph('verify') }, f.options);
    const plain = await f.reserve('w'); await f.execute(plain); expect(await f.evaluate(plain)).toBe('accepted');
    await expect(f.adopt('wrong-commit', 'w')).rejects.toMatchObject({ code: 'ADOPTION_VERIFICATION_MISMATCH' });
    expect(await f.tip()).toBe(f.base); expect(f.adoptions()).toEqual([]);
  });
});
