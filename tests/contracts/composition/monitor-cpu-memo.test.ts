import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { inspectMonitor } from '#composition/index.js';
import { mcpApplications } from '#composition/core/mcp/index.js';
import { openConfiguredAttemptStore } from '../../../src/composition/core/storage/index.js';
import { openSqliteAttemptStore } from '#adapters/index.js';
import { MonitorSourceMemo, type MonitorRecall } from '#engine/index.js';
import { clearConfigCache, productResourcePath, resolveGlobalConfigReadPath } from '#platform/index.js';
import { fixtureExecution } from '../support/execution-registry.js';
import { custodyProfiles, dispatchAdmission } from '../support/custody.js';

// MON-CPU-FIX (owner A48-D10, 2026-10-19): the live monitor skips the worker walk, ledger capture and policy decisions while the viewer and
// the ledger/policy/bindings stamps and config are unchanged — and a new Run, a worker state change, a config change or a revoked grant still
// shows on the very next read (one heartbeat). The memo is per viewer: another principal never gets an earlier read.
beforeEach(context => {
  if (process.platform === 'win32') context.skip('LOCAL_OS_PRINCIPAL_UNSUPPORTED: monitor policy fixture requires verified POSIX UID');
});
const roots: string[] = [];
afterEach(async () => { clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const HEARTBEAT_MS = 100;
const settle = () => new Promise(resolve => setTimeout(resolve, HEARTBEAT_MS + 60));
const actor = { id: 'fixture', issuer: 'test', subject: 'service' };
const me = { issuer: hostname(), subject: String(userInfo().uid) };
const graph = { schemaVersion: 2 as const, revision: 1, tasks: [{ id: 't', kind: 'fixture', dependencies: [], acceptanceCriteria: ['verified'] }],
  criterionDefinitions: [{ id: 'verified', version: 1, description: 'fixture', evaluator: { id: 'test', version: 1 }, parameters: {} }] };
const capacity = { executionSlots: 4, inFlightSlots: 4 };

/** Counts the reads the memo had to compute, by kind (`workers`, `ledger`, `pool`, `context`, `approvals`, `models`, `catalog` (S8-4 lines), `roles` (f2 pending
 * roles)). The f4 Brain quota waits stay a live read: a wait ends on the clock, not on a file change. */
class CountingMemo extends MonitorSourceMemo {
  computed: string[] = [];
  override recall(target: string, generation: string | null): MonitorRecall {
    const inner = super.recall(target, generation);
    return <T,>(key: string, compute: () => Promise<T>, keep?: (value: T) => boolean) =>
      inner(key, () => { this.computed.push(key.startsWith('[') ? (JSON.parse(key) as string[])[0]! : key.split('\0')[0]!); return compute(); }, keep);
  }
}

async function install() {
  const root = await mkdtemp(join(tmpdir(), 'deckent-monitor-memo-')); roots.push(root);
  const dir = join(root, 'current'), sidecars = join(root, 'w'); await mkdir(join(dir, '.deckent'), { recursive: true, mode: 0o700 }); await mkdir(sidecars, { mode: 0o700 });
  const configPath = join(dir, '.deckent/config.json'), config = { layout: { root: join(root, 'data') }, inspection: { workers: { sources: [], heartbeatMs: HEARTBEAT_MS } } };
  await writeFile(configPath, JSON.stringify(config));
  const options = { env: { HOME: join(root, 'home') } };
  const opened = await openConfiguredAttemptStore(dir, options); opened.store.close();
  const policy = (scopes: readonly string[]) => writeFile(productResourcePath(opened.layout, 'policy'), JSON.stringify({ schemaVersion: 1, revision: 'memo', restrictions: [], grants: [
    { id: 'scope', effect: 'allow', scopes: [...scopes], principals: [me], actions: ['inspect'], resource: { kind: 'scope', ids: [...scopes] } },
    { id: 'runs', effect: 'allow', scopes: [...scopes], principals: [me], actions: ['inspect'], resource: { kind: 'run', ids: 'all' } },
    { id: 'output', effect: 'allow', scopes: [...scopes], principals: [me], actions: ['read-output'], resource: { kind: 'attempt', ids: 'all' } },
    { id: 'pools', effect: 'allow', scopes: [...scopes], principals: [me], actions: ['inspect'], resource: { kind: 'pool', ids: 'all' } },
  ] }), { mode: 0o600 });
  await policy(['s', 'q']);
  const write = async (work: (store: Awaited<ReturnType<typeof openSqliteAttemptStore>>) => Promise<unknown>) => {
    const store = await openSqliteAttemptStore(opened.path, { busyTimeoutMs: 100, journalMode: 'wal', durability: 'full' }, { now: Date.now, timeoutMs: 86400000 }, 'allow', custodyProfiles);
    try { await work(store); } finally { store.close(); }
  };
  let created = 0;
  const run = (scopeId: string, runId: string, claim = false) => write(async store => {
    await store.createRun({ commandId: 'create-' + runId, actor, identity: { scopeId, runId, layoutRevision: 'layout' }, graph, execution: fixtureExecution(graph),
      now: 10_000 + created++, policy: { schemaVersion: 2, poolId: 'p', capacity, ordering: ['t'] } });
    if (!claim) return;
    const identity = { scopeId, runId, taskId: 't', attemptId: runId + '-t', layoutRevision: 'layout', generation: 1 };
    await store.reserveRunTasks({ commandId: 'reserve-' + runId, actor, scopeId, runId, expectedRevision: 0, now: 20_000, identities: [identity] });
    await store.claimDispatch(dispatchAdmission({ owner: 'worker', request: { protocolVersion: 1, identity, workspace: join(sidecars, 'ws'), argv: ['x'] } }));
  });
  await write(store => store.createExecutionPool({ schemaVersion: 1, poolId: 'p', capacity }));
  await run('s', 'r1', true); await run('q', 'q1');
  const inspect = async (memo?: MonitorSourceMemo) => (await inspectMonitor(dir, options, { schemaVersion: 1 }, memo)).installs[0]!;
  // With no service holding the ledger open, the first read creates its empty WAL (a source change); a running service keeps the WAL in place.
  await inspect();
  const heartbeat = (fields: Record<string, unknown>) => writeFile(join(sidecars, 'worker.hb'), JSON.stringify({ identity: { scopeId: 's', runId: 'r1', taskId: 't', attemptId: 'r1-t',
    layoutRevision: 'layout', generation: 1 }, ...fields }), { mode: 0o600 });
  return { dir, options, configPath, config, policy, run, inspect, heartbeat };
}
const runIds = (install: { runs: readonly { runId: string }[] }) => install.runs.map(value => value.runId).sort();

describe('monitor memo (MON-CPU-FIX)', () => {
  it('unchanged sources: the next read recomputes nothing and answers the same Runs, workers and pools', async () => {
    const f = await install(), memo = new CountingMemo(); await settle();
    const coldStart = performance.now(), first = await f.inspect(memo), coldMs = performance.now() - coldStart, cold = memo.computed.length;
    expect(new Set(memo.computed)).toEqual(new Set(['context', 'pool', 'workers', 'models', 'approvals', 'ledger', 'catalog', 'roles']));
    memo.computed = [];
    const idleStart = performance.now(), second = await f.inspect(memo), idleMs = performance.now() - idleStart;
    // Measurement (fs1, alpha.55): before the fix every idle read recomputed all 11 reads (the f2 role read's forced config load replaced the
    // composed config object the generation was keyed on; measured 11 reads, ~102 ms idle vs ~113 ms cold); now none (~34 ms).
    console.log('monitor-memo-measurement:', JSON.stringify({ cold: { computed: cold, ms: Math.round(coldMs) }, idle: { computed: memo.computed.length, ms: Math.round(idleMs) } }));
    expect(memo.computed).toEqual([]);
    expect(runIds(second)).toEqual(['q1', 'r1']);
    // Equal except the observation clock (`observedAtMs`, `ageMs` are projected against each read's own time).
    const timeless = (value: unknown) => JSON.parse(JSON.stringify(value, (key, field: unknown) => key === 'observedAtMs' || key === 'ageMs' ? undefined : field)) as unknown;
    expect(timeless(second.runs)).toEqual(timeless(first.runs));
    expect(second.workers.map(value => value.identity?.attemptId)).toEqual(['r1-t']);
    expect(second.pools).toEqual(first.pools);
    // Without a memo (one-shot reads, MCP, --once) the same answer is read fresh.
    expect(runIds(await f.inspect())).toEqual(['q1', 'r1']);
  });

  it('a new Run shows on the next read: right after the write, and through the changed ledger stamp once it settled', async () => {
    const f = await install(), memo = new CountingMemo(); await settle();
    await f.inspect(memo); await f.inspect(memo);
    await f.run('s', 'r2');
    expect(runIds(await f.inspect(memo))).toEqual(['q1', 'r1', 'r2']);
    await settle(); await f.inspect(memo);
    await f.run('q', 'q2'); await settle();
    memo.computed = [];
    expect(runIds(await f.inspect(memo))).toEqual(['q1', 'q2', 'r1', 'r2']);
    expect(memo.computed).toContain('ledger');
    // The new generation is kept: the following read is answered from the memo again.
    await settle(); await f.inspect(memo); // the writer closed last and removed the WAL; this read recreated it
    memo.computed = []; expect(runIds(await f.inspect(memo))).toEqual(['q1', 'q2', 'r1', 'r2']); expect(memo.computed).toEqual([]);
  });

  it('a worker state change shows on the next read: live sidecar heartbeat without any ledger write, and a newly claimed worker', async () => {
    const f = await install(), memo = new CountingMemo(); await settle();
    const before = (await f.inspect(memo)).workers[0]!;
    expect(before).toMatchObject({ provider: 'test-supervisor' }); expect(before.files?.heartbeat.phase ?? 'none').not.toBe('running');
    await f.heartbeat({ provider: 'claude', process: 'running' }); memo.computed = [];
    const running = (await f.inspect(memo)).workers[0]!;
    expect(memo.computed).toEqual([]); // the ledger part was recalled; the sidecar was read live
    expect(running).toMatchObject({ provider: 'claude', files: { heartbeat: { phase: 'running' } } });
    await f.heartbeat({ provider: 'claude', process: 'exited' });
    expect((await f.inspect(memo)).workers[0]).toMatchObject({ files: { heartbeat: { phase: 'exited' } } });
    await f.run('q', 'q9', true); await settle();
    expect((await f.inspect(memo)).workers.map(value => value.identity?.attemptId).sort()).toEqual(['q9-t', 'r1-t']);
  });

  it('a config change shows on the next read without clearing any cache', async () => {
    const f = await install(), memo = new CountingMemo(); await settle();
    const project = (install: Awaited<ReturnType<typeof f.inspect>>) => install.map?.config.find(layer => layer.layer === 'project')?.sections;
    expect(project(await f.inspect(memo))).not.toContain('language');
    await f.inspect(memo);
    await writeFile(f.configPath, JSON.stringify({ ...f.config, language: 'tr' }));
    expect(project(await f.inspect(memo))).toContain('language');
    // The installation layer (where tier/role rows live) is part of the generation too: a settled write recomputes the role read.
    await settle(); await f.inspect(memo); memo.computed = []; await f.inspect(memo); expect(memo.computed).toEqual([]);
    const global = await resolveGlobalConfigReadPath(f.options.env); await mkdir(dirname(global), { recursive: true, mode: 0o700 }); await writeFile(global, '{}', { mode: 0o600 });
    await settle(); memo.computed = []; await f.inspect(memo); expect(memo.computed).toContain('roles');
  });

  it('negative: a revoked grant hides the scope on the next read (the policy stamp is part of the generation)', async () => {
    const f = await install(), memo = new CountingMemo(); await settle();
    await f.inspect(memo); expect(runIds(await f.inspect(memo))).toEqual(['q1', 'r1']);
    await f.policy(['s']);
    const after = await f.inspect(memo);
    expect(runIds(after)).toEqual(['r1']);
    expect(after.diagnostics).toContain('scopes-denied:1');
    expect(after.scopeIds).toEqual(['s']); expect(after.workers.every(value => value.identity?.scopeId === 's')).toBe(true);
  });

  it('negative: per viewer — the MCP workload sharing the memo never gets the owner\'s recalled reads', async () => {
    const f = await install(), memo = new CountingMemo(); await settle();
    await f.inspect(memo); expect(runIds(await f.inspect(memo))).toEqual(['q1', 'r1']);
    const mcp = await mcpApplications({ inspectMonitor: () => inspectMonitor(f.dir, f.options, { schemaVersion: 1 }, memo) }).inspectMonitor();
    expect(mcp.installs[0]).toMatchObject({ status: 'denied', runs: [], workers: [], pools: [], scopeIds: [] });
    expect(runIds(await f.inspect(memo))).toEqual(['q1', 'r1']);
  });
});
