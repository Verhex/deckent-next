import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { inspectMonitor } from '#composition/index.js';
import { openConfiguredAttemptStore } from '../../../src/composition/core/storage/index.js';
import { openSqliteAttemptStore, readMonitorLedger } from '#adapters/index.js';
import { AuditApplication, ExecutionPoolHoldApplication, PoolControlPolicyAuthorization } from '#engine/index.js';
import { clearConfigCache, createHmacIntegrity, productResourcePath } from '#platform/index.js';
import { loadMonitorSurface } from '#surfaces/core/monitor/index.js';
import { fixtureExecution } from '../support/execution-registry.js';
import { custodyProfiles, dispatchAdmission } from '../support/custody.js';

// M-VIS (owner 2026-10-19, PB-POOL-VIS): the monitor shows only pools the viewer may `pool inspect`; other pools are a count, never a name,
// capacity, occupancy or holder; and the ledger reader does not read Runs/occupancy outside the viewer's admitted scopes and pools.
beforeEach(context => {
  if (process.platform === 'win32') context.skip('LOCAL_OS_PRINCIPAL_UNSUPPORTED: monitor policy fixture requires verified POSIX UID');
});
const roots: string[] = [];
afterEach(async () => { clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const actor = { id: 'fixture', issuer: 'test', subject: 'service' };
const me = { issuer: hostname(), subject: String(userInfo().uid) };
// Distinctive ids so a leak is found by text search in the whole snapshot (paths are random temp names).
const SEEN = 'pool-visible-alpha', SECRET = 'pool-secret-beta', HOLDER = 'holder-secret-x', OTHER_SCOPE = 'scope-other-q';
const graph = { schemaVersion: 2 as const, revision: 1, tasks: [{ id: 't', kind: 'fixture', dependencies: [], acceptanceCriteria: ['verified'] }],
  criterionDefinitions: [{ id: 'verified', version: 1, description: 'fixture', evaluator: { id: 'test', version: 1 }, parameters: {} }] };
const capacity = { executionSlots: 4, inFlightSlots: 5 };

/** One install: scope `s` has Runs in both pools (one reserved in each); scope OTHER_SCOPE has a Run in SECRET; SECRET is held by HOLDER. */
async function install() {
  const root = await mkdtemp(join(tmpdir(), 'deckent-monitor-vis-')); roots.push(root);
  const dir = join(root, 'current'); await mkdir(join(dir, '.deckent'), { recursive: true, mode: 0o700 });
  await writeFile(join(dir, '.deckent/config.json'), JSON.stringify({ layout: { root: join(root, 'data') }, inspection: { workers: { sources: [] } } }));
  const options = { env: { HOME: join(root, 'home') } };
  const opened = await openConfiguredAttemptStore(dir, options); opened.store.close();
  const store = await openSqliteAttemptStore(opened.path, { busyTimeoutMs: 100, journalMode: 'wal', durability: 'full' }, { now: Date.now, timeoutMs: 86400000 }, 'allow', custodyProfiles);
  try {
    for (const poolId of [SEEN, SECRET]) await store.createExecutionPool({ schemaVersion: 1, poolId, capacity });
    const runs = [['s', 'r-seen', SEEN], ['s', 'r-secret', SECRET], [OTHER_SCOPE, 'r-other', SECRET]] as const;
    for (const [index, [scopeId, runId, poolId]] of runs.entries()) {
      await store.createRun({ commandId: 'create-' + runId, actor, identity: { scopeId, runId, layoutRevision: 'layout' }, graph, execution: fixtureExecution(graph),
        now: 10_000 + index, policy: { schemaVersion: 2, poolId, capacity, ordering: ['t'] } });
      const identity = { scopeId, runId, taskId: 't', attemptId: runId + '-t', layoutRevision: 'layout', generation: 1 };
      await store.reserveRunTasks({ commandId: 'reserve-' + runId, actor, scopeId, runId, expectedRevision: 0, now: 20_000 + index, identities: [identity] });
      await store.claimDispatch(dispatchAdmission({ owner: 'worker', request: { protocolVersion: 1, identity, workspace: '/monitor-fixture', argv: ['x'] } }));
    }
    const holder = { id: HOLDER, issuer: 'test', subject: HOLDER, assurance: 'os-user', scopeIds: ['s'] };
    await new ExecutionPoolHoldApplication({ async verify() { return holder; } }, new PoolControlPolicyAuthorization({ async load() { return { schemaVersion: 1, revision: 'h', restrictions: [],
      grants: [{ id: 'hold', effect: 'allow', actions: ['hold', 'inspect'], scopes: 'all', principals: [{ issuer: 'test', subject: HOLDER }], resource: { kind: 'pool', ids: [SECRET] } }] }; } }),
    store, audit => new AuditApplication(audit, createHmacIntegrity('audit-key', randomBytes(32))), () => 30_000, SECRET)
      .apply({ schemaVersion: 1, scopeId: 's', commandId: 'hold-secret', action: 'hold', reason: 'fixture' });
  } finally { store.close(); }
  /** The viewer's policy: scope `s` (Runs, approvals, workers) and `pool inspect` on `pools` ('all' = an owner/admin). */
  const viewer = async (pools: readonly string[] | 'all' | null, scopes: readonly string[] = ['s']) => {
    await writeFile(productResourcePath(opened.layout, 'policy'), JSON.stringify({ schemaVersion: 1, revision: 'vis', restrictions: [], grants: [
      { id: 'scope', effect: 'allow', scopes: [...scopes], principals: [me], actions: ['inspect'], resource: { kind: 'scope', ids: [...scopes] } },
      { id: 'runs', effect: 'allow', scopes: [...scopes], principals: [me], actions: ['inspect'], resource: { kind: 'run', ids: 'all' } },
      ...(pools ? [{ id: 'pools', effect: 'allow', scopes: [...scopes], principals: [me], actions: ['inspect'], resource: { kind: 'pool', ids: pools === 'all' ? 'all' : [...pools] } }] : []),
    ] }), { mode: 0o600 });
    clearConfigCache();
    return (await inspectMonitor(dir, options)).installs[0]!;
  };
  return { dir, options, ledger: opened.path, viewer };
}

describe('monitor pool visibility (M-VIS)', () => {
  it('admin: every pool with capacity, installation-wide occupancy and holder — the same numbers as the unscoped ledger read', async () => {
    const f = await install(), admin = await f.viewer('all', ['s', OTHER_SCOPE]);
    const whole = await readMonitorLedger(f.ledger, { busyTimeoutMs: 100, maxRuns: 64 });
    expect(admin.hiddenPools).toBeUndefined();
    expect(admin.pools).toEqual(whole.pools.map(pool => ({ poolId: pool.poolId, capacity: pool.inFlightSlots, inFlight: pool.inFlight, held: pool.hold?.state === 'held',
      heldBy: pool.hold?.state === 'held' ? pool.hold.changedBy : null, executionCapacity: pool.executionSlots, executing: pool.execution })));
    expect(admin.pools).toMatchObject([{ poolId: SECRET, inFlight: 2, held: true, heldBy: HOLDER }, { poolId: SEEN, inFlight: 1, held: false }]);
    expect(admin.runs.map(run => run.runId).sort()).toEqual(['r-other', 'r-secret', 'r-seen']);
  });

  it('negative: a viewer without `pool inspect` sees no pool name, capacity, occupancy or holder — only a count', async () => {
    const f = await install(), viewer = await f.viewer(null);
    expect(viewer).toMatchObject({ status: 'available', scopeIds: ['s'], pools: [], hiddenPools: 2 });
    expect(viewer.runs.map(run => run.runId).sort()).toEqual(['r-secret', 'r-seen']);
    const text = JSON.stringify(viewer);
    // (A refused scope is still named by the existing `scope-denied:<id>` diagnostic; pools never are.)
    for (const secret of [SEEN, SECRET, HOLDER, 'r-other']) expect(text).not.toContain(secret);
    // An admitted Run in a hidden pool shows no pool wait (it would name the pool).
    for (const run of viewer.runs) expect(JSON.stringify(run.blocker ?? null)).not.toMatch(/pool/);
  });

  it('negative: `pool inspect` on one pool shows that pool only; the aggregate is a bare count with no identity', async () => {
    const f = await install(), viewer = await f.viewer([SEEN]);
    // The pools tab and the plain-text monitor show the count in both languages, never a hidden pool's name.
    const surface = await loadMonitorSurface(), snapshot = { schemaVersion: 1 as const, observedAt: 40_000, control: 'observe-only' as const, sourcesRead: ['current'], installs: [viewer] };
    for (const [locale, words] of [['en', 'Other work: 1 pool(s) not shown to you'], ['tr', 'Diğer işler: 1 havuz size gösterilmiyor']] as const) {
      const text = surface.renderMonitorText(snapshot, { locale, width: 400, ascii: true });
      expect(text).toContain(words); expect(text).toContain(SEEN); expect(text).not.toContain(SECRET);
    }
    expect(viewer.pools).toMatchObject([{ poolId: SEEN, capacity: 5, inFlight: 1, held: false, heldBy: null }]); expect(viewer.pools).toHaveLength(1);
    expect(viewer.hiddenPools).toBe(2 - 1);
    const text = JSON.stringify(viewer);
    for (const secret of [SECRET, HOLDER, 'r-other']) expect(text).not.toContain(secret);
    expect(viewer.diagnostics.some(code => /pool/.test(code))).toBe(false);
  });

  it('negative: the reader does not read hidden pools or other scopes — their corrupt rows are never seen, while the admin read reports them', async () => {
    const f = await install();
    const writer = new DatabaseSync(f.ledger);
    writer.exec(`UPDATE runs SET snapshot='{"broken":true}' WHERE run_id='r-other'; UPDATE execution_pools SET policy='{"broken":true}' WHERE pool_id='${SECRET}'`); writer.close();
    const viewer = await f.viewer([SEEN]);
    expect(viewer.diagnostics.filter(code => !code.startsWith('info:'))).toEqual([`scope-denied:${OTHER_SCOPE}`]);
    expect(JSON.stringify(viewer)).not.toContain(SECRET);
    const admin = await f.viewer('all', ['s', OTHER_SCOPE]);
    expect(admin.diagnostics).toEqual(expect.arrayContaining([`run-corrupt:${OTHER_SCOPE}/r-other`, `pool-corrupt:${SECRET}`]));
  });
});
