import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { hostname, userInfo } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDeliveryRun, deliverConfiguredWorkspaceIntegration, evaluateTask, prepareConfiguredWorkspaceIntegration } from '../../../src/index.js';
import { createConfiguredDeliveryRun, createConfiguredRun, reserveConfiguredRunTasks } from '../../../src/composition/core/runs/index.js';
import { executeConfiguredTask } from '../../../src/composition/core/execution/index.js';
import { DockerSupervisor, type SqliteAttemptStore } from '#adapters/index.js';
import { clearConfigCache, productResourcePath } from '#platform/index.js';
import { readyDeliveryFixture, type FixtureTracker } from '../support/workspace-patch-fixture.js';

const track: FixtureTracker = { roots: [], cleanup: [] };
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of track.cleanup.splice(0).reverse()) await close();
  clearConfigCache(); for (const root of track.roots.splice(0)) await rm(root, { recursive: true, force: true });
});
/** The container has no Git: it records the detached `.git/HEAD` (a raw object id) and the checked-out tree it sees. */
const observer = ['node', '-e', "const fs=require('node:fs');fs.writeFileSync('observed.json',JSON.stringify({head:fs.readFileSync('.git/HEAD','utf8').trim(),note:fs.readFileSync('note.txt','utf8'),added:fs.existsSync('added.txt')}))"];
const verifyGraph = { schemaVersion: 2 as const, revision: 1, tasks: [{ id: 'check', kind: 'verify', dependencies: [], acceptanceCriteria: ['exit'] }],
  criterionDefinitions: [{ id: 'exit', version: 1, description: 'Zero exit', evaluator: { id: 'process-exit', version: 1 }, parameters: { acceptedExitCodes: [0] } }] };

/** Delivered attempt (source HEAD stays at the delivery base) plus a `verify` kind whose container reports what it checked out. */
async function delivered(runIds = ['r', 'v', 'w']) {
  const f = await readyDeliveryFixture(track);
  await prepareConfiguredWorkspaceIntegration(f.project, f.command, f.options);
  const delivery = await deliverConfiguredWorkspaceIntegration(f.project,
    { schemaVersion: 1, commandId: 'delivery', identity: f.identity, integrationCommandId: 'candidate' }, f.options);
  // Settle the coding attempt so the single-slot pool admits the next Run's attempt.
  await f.policy(['read-output', 'evaluate']);
  const coding = (await f.runtime.store.loadRun(f.identity.scopeId, f.identity.runId))!;
  await evaluateTask(f.project, { schemaVersion: 1, commandId: 'evaluation', identity: f.identity, expectedRevision: coding.revision }, f.options);
  const config = JSON.parse(await readFile(f.configPath, 'utf8'));
  const profile = structuredClone(config.admission.registry.profiles[0]);
  profile.id = 'fixture-verify'; profile.parameters.argv = observer;
  config.admission.registry.profiles.push(profile);
  config.admission.registry.kinds.push({ kind: 'verify', profile: { id: 'fixture-verify', version: 1 } });
  await writeFile(f.configPath, JSON.stringify(config)); clearConfigCache();
  const principals = [{ issuer: hostname(), subject: String(userInfo().uid) }];
  const policy = (attempt = ['execute', 'read-output', 'recover-output']) => writeFile(productResourcePath(f.runtime.layout, 'policy'), JSON.stringify({
    schemaVersion: 1, revision: 'delivery-run', restrictions: [], grants: [
      { id: 'run', effect: 'allow', actions: ['create', 'reserve', 'inspect'], scopes: ['s', 'x'], principals, resource: { kind: 'run', ids: runIds } },
      { id: 'pool', effect: 'allow', actions: ['use'], scopes: ['s', 'x'], principals, resource: { kind: 'pool', ids: ['p'] } },
      { id: 'attempt', effect: 'allow', actions: attempt, scopes: ['s'], principals, resource: { kind: 'attempt', ids: 'all' } },
    ] }), { mode: 0o600 });
  await policy();
  const create = (runId: string, commandId = `create-${runId}`, deliveryCommandId = 'delivery', scopeId = 's') => createConfiguredDeliveryRun(f.project,
    { schemaVersion: 1, commandId, scopeId, runId, graph: verifyGraph, deliveryCommandId }, f.options);
  const execute = async (runId: string) => {
    const identity = (await reserveConfiguredRunTasks(f.project, { schemaVersion: 1, scopeId: 's', runId, commandId: `reserve-${runId}`, expectedRevision: 0 },
      f.options)).reservation.identities[0]!;
    track.cleanup.push(async () => {
      const record = await f.runtime.store.loadBoundDispatch(identity);
      if (record) { const supervisor = await DockerSupervisor.restoreProfile(record.profile); await supervisor.cancel(record.request); await supervisor.release(record.request); }
    });
    expect((await executeConfiguredTask(f.project, identity, f.options)).execution.terminal?.exitCode).toBe(0);
    const workspace = (await f.runtime.workspaces.openRecorded(identity))!.workspace;
    return { identity, workspace, observed: JSON.parse(await readFile(join(workspace, 'observed.json'), 'utf8')) as { head: string; note: string; added: boolean } };
  };
  const ledger = (sql: string, ...args: string[]) => {
    const db = new DatabaseSync(productResourcePath(f.runtime.layout, 'ledger'), { readOnly: true });
    try { return db.prepare(sql).all(...args); } finally { db.close(); }
  };
  const custody = (runId: string) => (ledger('SELECT record FROM run_workspace_custody WHERE scope_id=? AND run_id=?', 's', runId)
    .map(row => JSON.parse(String(row.record)) as { baseRevision: string }))[0];
  const runs = (runId: string) => ledger('SELECT run_id FROM runs WHERE scope_id=? AND run_id=?', 's', runId).length;
  const source = async () => ({ head: await f.git('rev-parse', 'HEAD'), index: await readFile(join(f.project, '.git/index')),
    status: await f.git('--no-optional-locks', 'status', '--porcelain') });
  return { ...f, plan: delivery.plan, create, execute, custody, runs, source, policy };
}

describe.skipIf(process.platform !== 'linux' || !process.env.DECKENT_TEST_DOCKER_IMAGE)('Run pinned to a delivery commit (B06-2a)', () => {
  it('runs the container on the delivered commit, not on the moving source HEAD, and never touches the live checkout', async () => {
    const f = await delivered();
    expect(f.plan.commit).not.toBe(f.base); expect(await f.git('rev-parse', 'HEAD')).toBe(f.base);
    const before = await f.source();
    const created = await f.create('v');
    expect(created.admission.run).toMatchObject({ runId: 'v', revision: 0 });
    // Custody is durable at admission, before any progression turn acquires a workspace.
    expect(f.custody('v')?.baseRevision).toBe(f.plan.commit);
    const { observed, workspace } = await f.execute('v');
    expect(observed).toEqual({ head: f.plan.commit, note: 'after\n', added: true });
    expect(await f.git('-C', workspace, 'rev-parse', 'HEAD')).toBe(f.plan.commit);
    expect(await f.source()).toEqual(before);
    // Replay: same command returns the same admission (SDK export is the same entry); another commit for the command is refused.
    expect(await createDeliveryRun(f.project, { schemaVersion: 1, commandId: 'create-v', scopeId: 's', runId: 'v', graph: verifyGraph,
      deliveryCommandId: 'delivery' }, f.options)).toEqual(created);
    expect(f.custody('v')?.baseRevision).toBe(f.plan.commit);
  });

  it('writes custody in the admission transaction: a progression turn right after admission still runs the delivered commit', async () => {
    const f = await delivered();
    // V1 with packed objects: the delivered commit is reachable only from refs/deckent/deliveries/* and now lives in a pack.
    await f.git('gc', '--quiet', '--prune=now');
    // Every configured store is the same SQLite adapter class; its prototype is what admission's writer calls.
    const prototype = Object.getPrototypeOf(f.runtime.store) as SqliteAttemptStore;
    const real = prototype.createRun;
    let turn: Promise<Awaited<ReturnType<typeof f.execute>>> | undefined;
    // The runtime service's progression may reserve and execute as soon as the Run commits; run that turn before admission returns.
    vi.spyOn(prototype, 'createRun').mockImplementation(async function(this: SqliteAttemptStore, ...args) {
      const receipt = await real.apply(this, args);
      if (receipt.snapshot.identity.runId === 'v' && !turn) { turn = f.execute('v'); await turn; }
      return receipt;
    });
    const admitted = await f.create('v').then(() => 'admitted', (error: { code?: string }) => error.code);
    expect(turn).toBeDefined();
    const { observed } = await turn!;
    expect.soft(observed).toEqual({ head: f.plan.commit, note: 'after\n', added: true });
    expect.soft(f.custody('v')?.baseRevision).toBe(f.plan.commit);
    expect(admitted).toBe('admitted');
  });

  it('refuses unknown, removed, moved and foreign deliveries, unauthorized reads and a plain Run replayed as pinned, without leaving a Run', async () => {
    const f = await delivered();
    await expect(f.create('v', 'unknown', 'missing')).rejects.toMatchObject({ code: 'ADOPTION_NOT_DELIVERED' });
    // H34: a scope pinned to another company is unknown to this installation (the delivery is never looked up there).
    const db = new DatabaseSync(productResourcePath(f.runtime.layout, 'ledger'));
    try { db.exec("INSERT OR IGNORE INTO companies(company_id) VALUES('other'); INSERT INTO scope_registry(scope_id,company_id,origin) VALUES('x','other','start');"); }
    finally { db.close(); }
    await expect(f.create('v', 'foreign', 'delivery', 'x')).rejects.toMatchObject({ code: 'SCOPE_UNKNOWN' });
    await f.policy(['execute', 'recover-output']);
    await expect(f.create('v', 'unreadable')).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    await f.policy();
    const moved = await f.git('commit-tree', `${f.base}^{tree}`, '-p', f.base, '-m', 'someone moves the delivery reference');
    await f.git('update-ref', f.plan.ref, moved);
    await expect(f.create('v', 'moved')).rejects.toMatchObject({ code: 'PATCH_CONFLICT' });
    await f.git('update-ref', '-d', f.plan.ref);
    await expect(f.create('v', 'removed')).rejects.toMatchObject({ code: 'ADOPTION_NOT_DELIVERED' });
    expect(f.runs('v')).toBe(0); expect(f.custody('v')).toBeUndefined();
    await f.git('update-ref', f.plan.ref, f.plan.commit);
    // A plain Run (custody sampled later from HEAD) cannot be claimed as pinned by replaying its command with a delivery.
    await createConfiguredRun(f.project, { schemaVersion: 1, commandId: 'plain', scopeId: 's', runId: 'w', graph: verifyGraph }, f.options);
    await expect(f.create('w', 'plain')).rejects.toMatchObject({ code: 'RUN_COMMAND_CONFLICT' });
    expect(f.custody('w')).toBeUndefined();
    await f.create('v');
    expect(f.custody('v')?.baseRevision).toBe(f.plan.commit);
  });

  it('answers a pinned replay from the recorded custody before the delivery reference check (owner 2026-09-27, like adoption resume)', async () => {
    const f = await delivered();
    const admitted = await f.create('v');
    // The reference is deleted, then moved: the replay answer of the admitted command must not change.
    await f.git('update-ref', '-d', f.plan.ref);
    expect(await f.create('v').catch((error: { code?: string }) => error.code)).toEqual(admitted);
    const moved = await f.git('commit-tree', `${f.base}^{tree}`, '-p', f.base, '-m', 'someone moves the delivery reference');
    await f.git('update-ref', f.plan.ref, moved);
    expect(await f.create('v').catch((error: { code?: string }) => error.code)).toEqual(admitted);
    expect(f.custody('v')?.baseRevision).toBe(f.plan.commit);
    // A first admission still runs the full check, and a replay still needs the same custody and the read grant.
    await expect(f.create('w')).rejects.toMatchObject({ code: 'PATCH_CONFLICT' });
    expect(f.runs('w')).toBe(0);
    await f.policy(['execute', 'recover-output']);
    await expect(f.create('v')).rejects.toMatchObject({ code: 'POLICY_DENIED' });
  });
});
