import { terminalApproval } from '../support/terminal-runtime-client.js';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as platform from '#platform/index.js';
import { clearConfigCache, createHmacIntegrity, MAX_WALL_SKEW_MS } from '#platform/index.js';
import { openSqliteAttemptStore, openSqliteApprovalStore, LocalOsSessionAuthority } from '#adapters/index.js';
import { ApprovalApplication, RunReservationApplication, TaskApprovalAdmission } from '#engine/index.js';
import { configuredApproval } from '#composition/core/approvals/index.js';
import { createConfiguredRun, reserveConfiguredRunTasks } from '#composition/core/runs/index.js';
import { openConfiguredAttemptStore } from '#composition/core/storage/index.js';
import { fixtureDockerRegistry, fixtureExecution } from '../support/execution-registry.js';

// I40 time contract. A host wall clock steps backwards (measured 2.0-2.2 s on WSL2). Inside one process the platform
// SystemTrustedClock floor absorbs any step; across processes only a bounded, versioned skew is tolerated. Raw steps are
// injected under the product floor through the clock port; Date.now is never pinned.
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const graph = { schemaVersion: 2 as const, revision: 1, tasks: ['held', 'free'].map(id => ({ id, kind: 'selected', dependencies: [], acceptanceCriteria: ['exit'] })),
  criterionDefinitions: [{ id: 'exit', version: 1, description: 'zero exit', evaluator: { id: 'process-exit', version: 1 }, parameters: { acceptedExitCodes: [0] } }] };

describe('platform wall floor', () => {
  it('floors an injected raw wall sequence and still advances with it', () => {
    const raw = [1000, 999, 998, 1001], clock = new platform.SystemTrustedClock(() => raw.shift()!);
    expect([1, 2, 3, 4].map(() => clock.sample().wallMs)).toEqual([1000, 1000, 1000, 1001]);
    expect(MAX_WALL_SKEW_MS).toBe(5_000);
  });
});

describe.skipIf(process.platform !== 'linux')('configured reservation after a backward step in the same process', () => {
  it('reserves an approved task after the host wall steps back beyond the cross-process allowance', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deckent-wall-step-')); roots.push(root);
    const project = join(root, 'project'), data = join(root, 'data'); await mkdir(join(project, '.deckent'), { recursive: true, mode: 0o700 });
    await writeFile(join(project, '.deckent/config.json'), JSON.stringify({ layout: { root: data }, admission: { poolId: 'p', executionSlots: 2,
      inFlightSlots: 2, ordering: 'input-order', registry: fixtureDockerRegistry(['selected']) } }));
    const options = { env: { HOME: join(root, 'home') } };
    const opened = await openConfiguredAttemptStore(project, options);
    try { await opened.store.createExecutionPool({ schemaVersion: 1, poolId: 'p', capacity: { executionSlots: 2, inFlightSlots: 2 } }); } finally { opened.store.close(); }
    const principals = [{ issuer: hostname(), subject: String(userInfo().uid) }];
    await writeFile(join(data, 'policy.json'), JSON.stringify({ schemaVersion: 1, revision: 'p', restrictions: [], grants: [
      { id: 'run', effect: 'allow', actions: ['create', 'inspect', 'reserve'], scopes: ['s'], principals, resource: { kind: 'run', ids: ['r'] } },
      { id: 'pool', effect: 'allow', actions: ['use'], scopes: ['s'], principals, resource: { kind: 'pool', ids: ['p'] } },
      { id: 'wait', effect: 'require-approval', actions: ['execute'], scopes: ['s'], principals, resource: { kind: 'task', ids: ['held'] } },
      { id: 'decide', effect: 'allow', actions: ['inspect', 'decide'], scopes: ['s'], principals, resource: { kind: 'approval', ids: 'all' } },
    ] }), { mode: 0o600 });
    await createConfiguredRun(project, { schemaVersion: 1, scopeId: 's', runId: 'r', commandId: 'create', graph }, options);
    // One hour ahead of the host: a reservation reading raw Date.now instead of the trusted clock cannot pass by accident.
    const base = Date.now() + 3_600_000, wall = { raw: base, samples: [] as number[] };
    const RealClock = platform.SystemTrustedClock, clock = new RealClock(() => { wall.samples.push(wall.raw); return wall.raw; });
    vi.spyOn(platform, 'SystemTrustedClock').mockImplementation(function () { return clock; } as never);
    const first = await reserveConfiguredRunTasks(project, { schemaVersion: 1, scopeId: 's', runId: 'r', commandId: 'reserve-1', expectedRevision: 0 }, options);
    expect(first.reservation.identities.map(value => value.taskId)).toEqual(['free']);
    const pending = await configuredApproval(project, 'list', { schemaVersion: 1, scopeId: 's', afterId: null, limit: 10 }, options) as
      { request: { approvalId: string; createdAt: number; taskId: string } }[];
    expect(pending).toHaveLength(1); expect(pending[0]!.request).toMatchObject({ taskId: 'held', createdAt: base });
    wall.raw = base + 10;
    const decided = await terminalApproval(project, 'decide', { schemaVersion: 1, scopeId: 's', approvalId: pending[0]!.request.approvalId,
      commandId: 'allow-held', expectedRevision: 0, decision: 'allow', reason: 'Reviewed' }, options) as { decision: { decidedAt: number } };
    expect(decided.decision.decidedAt).toBe(base + 10);
    wall.raw = base + 10 - 2 * MAX_WALL_SKEW_MS; // a step larger than the cross-process allowance; only the floor can absorb it
    const next = await reserveConfiguredRunTasks(project, { schemaVersion: 1, scopeId: 's', runId: 'r', commandId: 'reserve-2', expectedRevision: 1 }, options);
    expect(next.reservation.identities.map(value => value.taskId)).toEqual(['held']);
    expect(wall.samples.at(-1)).toBe(base + 10 - 2 * MAX_WALL_SKEW_MS);
  });
});

describe.skipIf(process.platform !== 'linux')('task approval decided by another process clock', () => {
  async function fixture(decidedAtWall: number) {
    const root = await mkdtemp(join(tmpdir(), 'deckent-wall-skew-')); roots.push(root);
    const path = join(root, 'ledger.db'), options = { busyTimeoutMs: 1000, journalMode: 'wal', durability: 'full' } as const;
    const store = await openSqliteAttemptStore(path, options, { now: Date.now, timeoutMs: 86400000 }), journal = openSqliteApprovalStore(path, options);
    // The deciding process clock; the reserving process below receives its own explicit wall sample.
    const clock = { sample: () => ({ wallMs: decidedAtWall, monotonicMs: 100 }) };
    const sessions = await LocalOsSessionAuthority.create(['scope'], 10_000, clock);
    const { principal, session } = await sessions.verifySession(undefined), actor = session.principalRef;
    await store.createExecutionPool({ schemaVersion: 1, poolId: 'pool', capacity: { executionSlots: 1, inFlightSlots: 1 } });
    const held = { ...graph, tasks: [graph.tasks[0]!] };
    await store.createRun({ commandId: 'create', actor, identity: { scopeId: 'scope', runId: 'run', layoutRevision: 'layout' },
      graph: held, execution: fixtureExecution(held), now: 1000,
      policy: { schemaVersion: 2, poolId: 'pool', capacity: { executionSlots: 1, inFlightSlots: 1 }, ordering: ['held'] } });
    const policy = { schemaVersion: 1, revision: 'p', restrictions: [], grants: [
      { id: 'wait', effect: 'require-approval', principals: 'all', scopes: ['scope'], actions: ['execute'], resource: { kind: 'task', ids: ['held'] } },
      { id: 'decide', effect: 'allow', principals: 'all', scopes: ['scope'], actions: 'all', resource: { kind: 'approval', ids: 'all' } },
    ] };
    const integrity = createHmacIntegrity('key', randomBytes(32));
    const gate = new TaskApprovalAdmission(policy, principal, journal.store, integrity, 60_000); store.setRunAdmissionFilter(gate);
    const run = (await store.loadRun('scope', 'run'))!;
    await gate.prepare(run, principal, decidedAtWall);
    const pending = journal.store.list('scope', null, 10)[0]!;
    const decided = await new ApprovalApplication(journal.store, { verify: async () => principal }, sessions, { load: async () => policy }, integrity, clock, 'sdk', 10)
      .decide({ schemaVersion: 1, scopeId: 'scope', approvalId: pending.request.approvalId, commandId: 'approve', expectedRevision: 0, decision: 'allow', reason: 'Reviewed' });
    expect(decided.decision?.decidedAt).toBe(decidedAtWall);
    const reserve = (now: number) => new RunReservationApplication(store, { verify: async () => principal }, { authorize: async () => undefined },
      { authorize: async () => undefined }, { now: () => now, attemptId: () => 'attempt' }, gate)
      .reserve({ schemaVersion: 1, scopeId: 'scope', runId: 'run', commandId: `reserve-${now}`, expectedRevision: 0 });
    return { path, store, gate, run, actor, reserve, close() { journal.close(); store.close(); } };
  }

  it('reserves when this process samples 1 ms before the other process decision (L5 repro: approval 1000, reserve 999)', async () => {
    const f = await fixture(10_000);
    try { expect((await f.reserve(9_999)).identities.map(value => value.taskId)).toEqual(['held']); } finally { f.close(); }
  });

  it('accepts exactly the allowance and excludes a decision further in the future without a durable reservation', async () => {
    const f = await fixture(10_000);
    try {
      expect(f.gate.excluded(f.run, f.actor, 10_000 - MAX_WALL_SKEW_MS)).toEqual([]);
      expect(f.gate.excluded(f.run, f.actor, 10_000 - MAX_WALL_SKEW_MS - 1)).toEqual(['held']);
      await expect(f.reserve(10_000 - MAX_WALL_SKEW_MS - 1)).rejects.toMatchObject({ code: 'RUN_CAPACITY_OR_ORDER' });
      expect(await f.store.loadRunReceipt('scope', `reserve-${10_000 - MAX_WALL_SKEW_MS - 1}`)).toBeNull();
    } finally { f.close(); }
  });

  it('never lets the allowance admit a rewritten decision time', async () => {
    const f = await fixture(10_000);
    try {
      const db = new DatabaseSync(f.path);
      try {
        const row = db.prepare('SELECT snapshot FROM approvals').get() as { snapshot: string };
        const record = JSON.parse(row.snapshot) as { decision: { decidedAt: number } };
        db.prepare('UPDATE approvals SET snapshot=?').run(JSON.stringify({ ...record, decision: { ...record.decision, decidedAt: 9_999 } }));
      } finally { db.close(); }
      expect(() => f.gate.excluded(f.run, f.actor, 10_000)).toThrow('APPROVAL_INTEGRITY');
    } finally { f.close(); }
  });
});
