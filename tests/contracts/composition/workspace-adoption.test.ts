import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { adoptConfiguredWorkspaceIntegration, deliverConfiguredWorkspaceIntegration, evaluateTask, prepareConfiguredWorkspaceIntegration,
  rollbackConfiguredWorkspaceIntegration } from '../../../src/index.js';
import { GitIntegrationAdoption } from '#adapters/index.js';
import { clearConfigCache, productResourcePath } from '#platform/index.js';
import { readyDeliveryFixture, type FixtureTracker } from '../support/workspace-patch-fixture.js';

const track: FixtureTracker = { roots: [], cleanup: [] };
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of track.cleanup.splice(0).reverse()) await close();
  clearConfigCache(); for (const root of track.roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const target = 'refs/heads/adopted';
const actions = ['read-output', 'prepare-integration', 'deliver-integration', 'evaluate', 'adopt-integration', 'rollback-integration'];

/** Delivered (reference-only) attempt, not yet evaluated, with a not-checked-out adoption branch at the delivery base. */
async function delivered() {
  const f = await readyDeliveryFixture(track, { adoptionTargets: [target] }); await f.policy(actions);
  await prepareConfiguredWorkspaceIntegration(f.project, f.command, f.options);
  const delivery = await deliverConfiguredWorkspaceIntegration(f.project,
    { schemaVersion: 1, commandId: 'delivery', identity: f.identity, integrationCommandId: 'candidate' }, f.options);
  const evaluate = async () => {
    const run = (await f.runtime.store.loadRun(f.identity.scopeId, f.identity.runId))!;
    const result = await evaluateTask(f.project, { schemaVersion: 1, commandId: 'evaluation', identity: f.identity, expectedRevision: run.revision }, f.options);
    expect(result.evaluation.run.tasks[0]!.phase).toBe('accepted');
  };
  const adopt = (commandId: string, extra: Record<string, unknown> = {}) => adoptConfiguredWorkspaceIntegration(f.project,
    { schemaVersion: 1, commandId, identity: f.identity, deliveryCommandId: 'delivery', targetRef: target, ...extra } as never, f.options);
  const rollback = (commandId: string, adoptionCommandId: string) => rollbackConfiguredWorkspaceIntegration(f.project,
    { schemaVersion: 1, commandId, identity: f.identity, adoptionCommandId }, f.options);
  const tip = () => f.git('rev-parse', target);
  const ledger = (commandId: string) => {
    const db = new DatabaseSync(productResourcePath(f.runtime.layout, 'ledger'), { readOnly: true });
    try { return db.prepare('SELECT sequence,settled FROM workspace_adoptions WHERE command_id=?').get(commandId); } finally { db.close(); }
  };
  return { ...f, plan: delivery.plan, evaluate, adopt, rollback, tip, ledger };
}

describe.skipIf(process.platform !== 'linux' || !process.env.DECKENT_TEST_DOCKER_IMAGE)('verified-delivery branch adoption and rollback', () => {
  it('adopts through competing SDK/CLI onto a not-checked-out branch, rolls back once, and never touches the live checkout', async () => {
    const f = await delivered(); await f.evaluate();
    await f.git('branch', 'adopted', f.base);
    const head = await f.git('rev-parse', 'HEAD'), index = await readFile(join(f.project, '.git/index')), status = await f.git('--no-optional-locks', 'status', '--porcelain');
    const [sdk, cli] = await Promise.all([f.adopt('adopt'), f.cli('integration-adopt',
      ['--command-id', 'adopt', '--delivery-command-id', 'delivery', '--target', target]) as unknown as ReturnType<typeof f.adopt>]);
    expect(cli).toEqual(sdk);
    expect(sdk).toMatchObject({ status: 'adopted', targetRef: target, fromCommit: f.base, toCommit: f.plan.commit, sequence: 1,
      basis: 'task-acceptance', verification: 'not-verified', application: 'branch-reference' });
    expect(await f.tip()).toBe(f.plan.commit);
    expect(await f.git('rev-parse', 'HEAD')).toBe(head); expect(await readFile(join(f.project, '.git/index'))).toEqual(index);
    expect(await f.git('--no-optional-locks', 'status', '--porcelain')).toBe(status); expect(await readFile(join(f.project, 'note.txt'), 'utf8')).toBe('before\n');
    expect(await f.adopt('adopt')).toEqual(sdk);

    const rolled = await f.rollback('rollback', 'adopt');
    expect(rolled).toMatchObject({ status: 'rolled-back', fromCommit: f.plan.commit, toCommit: f.base, sequence: 2 });
    expect(await f.tip()).toBe(f.base); expect(await f.rollback('rollback', 'adopt')).toEqual(rolled);
    await expect(f.rollback('rollback-again', 'adopt')).rejects.toMatchObject({ code: 'ADOPTION_TARGET_MOVED' });
    // Re-adopting the same delivery is a new command; the older adoption is then superseded and can no longer be undone.
    expect(await f.adopt('adopt-2')).toMatchObject({ status: 'adopted', sequence: 3 });
    await expect(f.rollback('rollback-old', 'adopt')).rejects.toMatchObject({ code: 'ADOPTION_SUPERSEDED' });
    expect(await f.tip()).toBe(f.plan.commit);
    expect(await f.git('rev-parse', 'HEAD')).toBe(head); expect(await readFile(join(f.project, '.git/index'))).toEqual(index);

    await f.policy(actions.filter(action => action !== 'rollback-integration'));
    await expect(f.rollback('rollback-2', 'adopt-2')).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    await f.policy(actions.filter(action => action !== 'adopt-integration'));
    await expect(f.adopt('adopt-3')).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    expect(await f.tip()).toBe(f.plan.commit);
  });

  it('refuses unaccepted, undelivered, unlisted, missing, checked-out and moved targets without changing any reference', async () => {
    const f = await delivered();
    await f.git('branch', 'adopted', f.base);
    await expect(f.adopt('early')).rejects.toMatchObject({ code: 'ADOPTION_NOT_ACCEPTED' });
    await f.evaluate();
    await expect(f.adopt('unknown', { deliveryCommandId: 'missing' })).rejects.toMatchObject({ code: 'ADOPTION_NOT_DELIVERED' });
    await expect(f.adopt('unlisted', { targetRef: 'refs/heads/other' })).rejects.toMatchObject({ code: 'ADOPTION_TARGET_DENIED' });
    await f.git('branch', '-D', 'adopted');
    await expect(f.adopt('missing')).rejects.toMatchObject({ code: 'ADOPTION_TARGET_MISSING' });
    await f.git('branch', 'adopted', f.base);
    const worktree = join(f.root, 'adopted-worktree'); await f.git('worktree', 'add', worktree, 'adopted');
    await expect(f.adopt('checked-out')).rejects.toMatchObject({ code: 'ADOPTION_TARGET_CHECKED_OUT' });
    await f.git('worktree', 'remove', '--force', worktree);
    const moved = await f.git('commit-tree', `${f.base}^{tree}`, '-p', f.base, '-m', 'owner moves the target');
    await f.git('branch', '-f', 'adopted', moved);
    await expect(f.adopt('moved')).rejects.toMatchObject({ code: 'ADOPTION_BASE_CHANGED' });
    expect(await f.tip()).toBe(moved);
    for (const command of ['early', 'unknown', 'unlisted', 'missing', 'checked-out', 'moved']) expect(f.ledger(command)).toBeUndefined();
    await f.git('branch', '-f', 'adopted', f.base);
    await f.adopt('adopt');
    await f.git('branch', '-f', 'adopted', moved);
    await expect(f.rollback('rollback', 'adopt')).rejects.toMatchObject({ code: 'ADOPTION_TARGET_MOVED' });
    expect(await f.tip()).toBe(moved);
  });

  it('settles an interrupted adoption from the observed tip: moves when unmoved, finishes without a second move, blocks the target meanwhile', async () => {
    const f = await delivered(); await f.evaluate();
    await f.git('branch', 'adopted', f.base);
    const move = vi.spyOn(GitIntegrationAdoption.prototype, 'move');
    // Crash after the ledger claim, before the Git effect.
    move.mockImplementationOnce(async () => { throw new Error('crash before move'); });
    await expect(f.adopt('adopt')).rejects.toBeDefined();
    expect(f.ledger('adopt')).toEqual({ sequence: 1, settled: 0 }); expect(await f.tip()).toBe(f.base);
    await expect(f.adopt('other')).rejects.toMatchObject({ code: 'ADOPTION_TARGET_BUSY' });
    const resumed = await f.adopt('adopt');
    expect(resumed).toMatchObject({ status: 'adopted', sequence: 1 }); expect(await f.tip()).toBe(f.plan.commit);
    expect(move).toHaveBeenCalledTimes(2); expect(f.ledger('adopt')).toEqual({ sequence: 1, settled: 1 });

    // Crash after the Git effect, before ledger settlement: the real CAS runs, then the process dies.
    move.mockRestore();
    const real = GitIntegrationAdoption.prototype.move;
    const effect = vi.spyOn(GitIntegrationAdoption.prototype, 'move').mockImplementationOnce(async function(this: GitIntegrationAdoption, ...args) {
      await real.apply(this, args); throw new Error('crash before settle');
    });
    await expect(f.rollback('rollback', 'adopt')).rejects.toBeDefined();
    expect(await f.tip()).toBe(f.base); expect(f.ledger('rollback')).toEqual({ sequence: 2, settled: 0 });
    expect(await f.rollback('rollback', 'adopt')).toMatchObject({ status: 'rolled-back', sequence: 2 });
    expect(effect).toHaveBeenCalledTimes(1); // settled from the observed tip, no second Git move
    expect(f.ledger('rollback')).toEqual({ sequence: 2, settled: 1 });

    // An unsettled intent whose tip is neither side is a conflict, not a guess.
    effect.mockImplementationOnce(async () => { throw new Error('crash before move'); });
    await expect(f.adopt('adopt-2')).rejects.toBeDefined();
    const foreign = await f.git('commit-tree', `${f.base}^{tree}`, '-p', f.base, '-m', 'foreign writer');
    await f.git('branch', '-f', 'adopted', foreign);
    await expect(f.adopt('adopt-2')).rejects.toMatchObject({ code: 'ADOPTION_CONFLICT' });
    expect(await f.tip()).toBe(foreign);
  });
});
