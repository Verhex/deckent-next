import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { openSqliteAttemptStore, upgradeExistingProductLedger, type SqliteAttemptStore } from '#adapters/index.js';
import { openSqliteAuditStore } from '#adapters/core/audit-store/index.js';
import { CURRENT_LEDGER_VERSION, POOL_HOLD_LEDGER_VERSION, openSqliteLedger } from '#adapters/core/sqlite-ledger/index.js';
import { AuditApplication, ExecutionPoolHoldApplication, PoolControlPolicyAuthorization, RunProgressionTurn, RunReservationApplication, reservationRefusalOutcome,
  RunStoreError, type RunProgressionOperations } from '#engine/index.js';
import { createHmacIntegrity } from '#platform/index.js';
import { getPolicyVocabulary, installationOwnerPermissions, INSTALLATION_OWNER_ROLE_ID, resolvePolicyBindings } from '#domain/index.js';
import { fixtureExecution } from '../support/execution-registry.js';
import { custodyProfiles, dispatchAdmission, grantTestLaunch } from '../support/custody.js';
import { DOWNGRADE_TO_V43_LEDGER_SQL, PREVIOUS_LEDGER_VERSION } from '../../fixtures/ledger-previous.js';

// K5 typed execution pool hold (owner 2026-09-30 option A; lane Jev 2e7be700): no new reservation while held, already reserved work runs,
// finishes and is evaluated, resume re-enables; installation-level authority; every decision sealed in the audit; replay is exact.
const roots: string[] = [], stores: SqliteAttemptStore[] = [];
afterEach(async () => { stores.splice(0).forEach(store => store.close()); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const options = { busyTimeoutMs: 100, journalMode: 'wal' as const, durability: 'full' as const };
const actor = { id: 'operator', issuer: 'test', subject: 'operator' };
const principal = { ...actor, assurance: 'os-user', scopeIds: ['s', 't'] };
const query = { schemaVersion: 1 as const, scopeId: 's', runId: 'r' };
const integrity = createHmacIntegrity('audit-key', randomBytes(32));
const rule = (id: string, effect: 'allow' | 'deny' | 'require-approval', actions: readonly string[], scopes: readonly string[] | 'all') =>
  ({ id, effect, actions, scopes, principals: [{ issuer: 'test', subject: 'operator' }], resource: { kind: 'pool', ids: ['p'] } });
const policy = (grants: readonly unknown[], restrictions: readonly unknown[] = []) => ({ schemaVersion: 1, revision: 'p1', grants, restrictions });
const owner = policy([rule('pool-control', 'allow', ['hold', 'resume', 'inspect'], 'all')]);
const hold = (commandId: string, extra: Record<string, unknown> = {}) => ({ schemaVersion: 1, scopeId: 's', commandId, action: 'hold', reason: 'dev-release switch', ...extra });
const resume = (commandId: string) => ({ schemaVersion: 1, scopeId: 's', commandId, action: 'resume' });
const status = { schemaVersion: 1, scopeId: 's' };

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'deckent-pool-hold-')); roots.push(root);
  const path = join(root, 'ledger.db');
  const store = await openSqliteAttemptStore(path, options, { now: Date.now, timeoutMs: 86400000 }, 'allow', custodyProfiles); stores.push(store);
  const graph = { schemaVersion: 2 as const, revision: 1, tasks: ['a', 'b', 'c'].map(id => ({ id, kind: 'fixture', dependencies: id === 'c' ? ['a', 'b'] : [], acceptanceCriteria: ['verified'] })),
    criterionDefinitions: [{ id: 'verified', version: 1, description: 'fixture', evaluator: { id: 'test', version: 1 }, parameters: {} }] };
  const capacity = { executionSlots: 2, inFlightSlots: 2 };
  await store.createExecutionPool({ schemaVersion: 1, poolId: 'p', capacity });
  await store.createRun({ commandId: 'create', actor, identity: { scopeId: 's', runId: 'r', layoutRevision: 'layout' },
    graph, execution: fixtureExecution(graph), now: 0, policy: { schemaVersion: 2, poolId: 'p', capacity, ordering: ['a', 'b', 'c'] } });
  let sequence = 0;
  const id = () => `id-${++sequence}`;
  const reservation = new RunReservationApplication(store, { async verify() { return principal; } }, { async authorize() {} }, { async authorize() {} },
    { now: () => 0, attemptId: id });
  const control = (document: unknown = owner) => new ExecutionPoolHoldApplication({ async verify() { return principal; } },
    new PoolControlPolicyAuthorization({ async load() { return document; } }), store, audit => new AuditApplication(audit, integrity), () => 1_000, 'p');
  const hooks: { beforeExecute?: () => Promise<void> } = {};
  const operations: RunProgressionOperations = {
    async read() { return (await store.loadRun('s', 'r'))!; },
    evaluationRecorded: (identity, revision) => store.hasTaskEvaluation(identity, revision),
    async reserve(command) {
      try { await reservation.reserve(command); return 'reserved'; }
      catch (error) { const outcome = error instanceof RunStoreError ? reservationRefusalOutcome(error.code) : null; if (outcome) return outcome; throw error; }
    },
    async execute(identity) {
      await hooks.beforeExecute?.();
      const claim = { request: { protocolVersion: 1 as const, identity, workspace: '/fixture', argv: ['fixture'] }, owner: 'worker' };
      await store.claimDispatch(dispatchAdmission(claim)); await grantTestLaunch(store, claim);
      await store.retainDispatchOutput(claim, { schemaVersion: 1, scopeId: 's', digest: 'a'.repeat(64), byteLength: 1 });
      await store.finishDispatch(claim, { handle: identity.attemptId, exitCode: 0, interrupted: false });
    },
    async evaluate(command) {
      const attempt = (await store.load('s', command.identity.attemptId))!;
      await store.commitTaskEvaluation({ commandId: command.commandId, actor, expectedRevision: command.expectedRevision,
        dispatch: (await store.loadBoundDispatch(command.identity))!, evaluation: { schemaVersion: 1, evaluationId: command.commandId,
          identity: command.identity, graphRevision: 1, attemptRevision: attempt.revision, criteria: [{ criterionId: 'verified', verdict: 'pass', evidenceIds: ['evidence'] }] } });
      return 'recorded';
    },
  };
  const rows = (sql: string) => { const db = new DatabaseSync(path, { readOnly: true }); try { return db.prepare(sql).all(); } finally { db.close(); } };
  const audit = async (scopeId = 's') => {
    const auditStore = await openSqliteAuditStore(path, options);
    try { return new AuditApplication(auditStore, integrity).list(scopeId, 0, 100).map(record => record.event.subject); } finally { auditStore.close(); }
  };
  return { path, store, reservation, control, operations, hooks, rows, audit, turn: new RunProgressionTurn(operations, 2, { commandId: id }) };
}

// Sol 2210 K5-R1: a second connection commits between the status read of the hold row and the occupancy read. The interleaving is
// interposed on node:sqlite's own statement API (the product code is unchanged): right after the hold row is read, `sql` commits.
async function interleaved<T>(path: string, sql: readonly (readonly [string, ...unknown[]])[], read: () => Promise<T>): Promise<T> {
  const prepare = DatabaseSync.prototype.prepare; let done = false;
  const commit = () => {
    const other = new DatabaseSync(path, { timeout: 1_000 });
    try { other.exec('BEGIN IMMEDIATE'); for (const [text, ...params] of sql) prepare.call(other, text).run(...(params as never[])); other.exec('COMMIT'); } finally { other.close(); }
  };
  DatabaseSync.prototype.prepare = function (this: DatabaseSync, text: string) {
    const statement = prepare.call(this, text);
    if (done || !text.startsWith('SELECT pool_id,revision,state,record FROM execution_pool_holds')) return statement;
    return new Proxy(statement, { get: (target, key) => key === 'get'
      ? (...args: never[]) => { const row = target.get(...args); done = true; commit(); return row; }
      : (value => typeof value === 'function' ? value.bind(target) : value)(Reflect.get(target, key)) });
  } as typeof prepare;
  try { const value = await read(); expect(done).toBe(true); return value; } finally { DatabaseSync.prototype.prepare = prepare; }
}
const runRow = (f: { rows: (sql: string) => unknown[] }) => f.rows("SELECT snapshot,revision FROM runs WHERE scope_id='s' AND run_id='r'")[0] as { snapshot: string; revision: number };

describe('K5 typed execution pool hold', () => {
  it('refuses a reservation while held with no partial write, keeps admission open, and resume re-enables reservation', async () => {
    const f = await fixture();
    const held = await f.control().apply(hold('h1'));
    expect(held).toMatchObject({ changed: true, state: 'held', poolId: 'p', hold: { state: 'held', revision: 1, reason: 'dev-release switch',
      changedBy: { issuer: 'test', subject: 'operator' }, changedAtMs: 1_000, scopeId: 's', commandId: 'h1' } });
    await expect(f.reservation.reserve({ ...query, commandId: 'reserve-1', expectedRevision: 0 })).rejects.toMatchObject({ code: 'RUN_POOL_HELD' });
    expect(f.rows('SELECT count(*) AS n FROM attempts')[0]!.n).toBe(0);
    expect(f.rows("SELECT count(*) AS n FROM run_receipts WHERE json_extract(command,'$.action')='reserve-run-tasks'")[0]!.n).toBe(0);
    expect((await f.store.loadRun('s', 'r'))!.revision).toBe(0);
    // Admission is not gated: a new Run is accepted while held (owner K5 option A).
    const graph = { schemaVersion: 2 as const, revision: 1, tasks: [{ id: 'x', kind: 'fixture', dependencies: [], acceptanceCriteria: ['verified'] }],
      criterionDefinitions: [{ id: 'verified', version: 1, description: 'fixture', evaluator: { id: 'test', version: 1 }, parameters: {} }] };
    await f.store.createRun({ commandId: 'create-2', actor, identity: { scopeId: 't', runId: 'r2', layoutRevision: 'layout' }, graph, execution: fixtureExecution(graph),
      now: 0, policy: { schemaVersion: 2, poolId: 'p', capacity: { executionSlots: 2, inFlightSlots: 2 }, ordering: ['x'] } });
    expect(await f.control().inspect(status)).toEqual({ schemaVersion: 1, poolId: 'p', state: 'held', hold: held.hold, occupancy: { execution: 0, inFlight: 0 }, drained: true });
    expect(await f.control().apply(resume('r1'))).toMatchObject({ changed: true, state: 'open', hold: { state: 'open', revision: 2, commandId: 'r1', reason: null } });
    const reserved = await f.reservation.reserve({ ...query, commandId: 'reserve-2', expectedRevision: 0 });
    expect(reserved.identities.map(identity => identity.taskId)).toEqual(['a', 'b']);
    expect(await f.control().inspect(status)).toMatchObject({ state: 'open', occupancy: { execution: 2, inFlight: 2 }, drained: false });
  });

  it('lets already reserved attempts launch, finish and be evaluated while held; the turn waits quietly and drains, resume finishes the Run', async () => {
    const f = await fixture();
    let held = false;
    f.hooks.beforeExecute = async () => { if (!held) { held = true; await f.control().apply(hold('h-during')); } };
    const first = await f.turn.advance(query, new AbortController().signal); // no throw: RUN_POOL_HELD is a quiet `waiting`
    expect(first.run.tasks.map(task => task.phase)).toEqual(['accepted', 'accepted', 'pending']);
    expect(first.attempted).toBe(2);
    expect(f.rows('SELECT count(*) AS n FROM attempts')[0]!.n).toBe(2); // c was never reserved
    expect(await f.control().inspect(status)).toMatchObject({ state: 'held', occupancy: { execution: 0, inFlight: 0 }, drained: true });
    const again = await f.turn.advance(query, new AbortController().signal);
    expect(again.attempted).toBe(0); expect(again.run.tasks.map(task => task.phase)).toEqual(['accepted', 'accepted', 'pending']);
    await f.control().apply(resume('r-after'));
    const resumed = await f.turn.advance(query, new AbortController().signal);
    expect(resumed.run.tasks.map(task => task.phase)).toEqual(['accepted', 'accepted', 'accepted']);
    expect(reservationRefusalOutcome('RUN_POOL_HELD')).toBe('waiting'); expect(reservationRefusalOutcome('POLICY_DENIED')).toBeNull();
  });

  it('reports occupancy of reserved work under a hold and is not drained until it is evaluated', async () => {
    const f = await fixture();
    const reserved = await f.reservation.reserve({ ...query, commandId: 'reserve', expectedRevision: 0 });
    await f.control().apply(hold('h1'));
    expect(await f.control().inspect(status)).toMatchObject({ state: 'held', occupancy: { execution: 2, inFlight: 2 }, drained: false });
    // Dispatch admission of an attempt reserved before the hold is not refused.
    const identity = reserved.identities[0]!;
    const claim = { request: { protocolVersion: 1 as const, identity, workspace: '/fixture', argv: ['fixture'] }, owner: 'worker' };
    await f.store.claimDispatch(dispatchAdmission(claim)); await grantTestLaunch(f.store, claim);
    await f.store.retainDispatchOutput(claim, { schemaVersion: 1, scopeId: 's', digest: 'a'.repeat(64), byteLength: 1 });
    await f.store.finishDispatch(claim, { handle: identity.attemptId, exitCode: 0, interrupted: false });
    expect(await f.control().inspect(status)).toMatchObject({ occupancy: { execution: 1, inFlight: 2 }, drained: false });
  });

  it('replays a command exactly, refuses a conflicting body, and treats hold-while-held / resume-while-open as recorded no-ops', async () => {
    const f = await fixture(), control = f.control();
    const first = await control.apply(hold('h1'));
    expect(await control.apply(hold('h1'))).toEqual(first);
    await expect(control.apply(hold('h1', { reason: 'another reason' }))).rejects.toMatchObject({ code: 'RUN_COMMAND_CONFLICT' });
    const again = await control.apply(hold('h2'));
    expect(again).toMatchObject({ changed: false, state: 'held', hold: first.hold });
    expect(f.rows('SELECT revision,state FROM execution_pool_holds')).toEqual([{ revision: 1, state: 'held' }]);
    expect((await control.apply(resume('r1'))).hold!.revision).toBe(2);
    expect(await control.apply(resume('r2'))).toMatchObject({ changed: false, state: 'open' });
    // One sealed event per new command (the replay and the conflict add none); a no-op names previous = next.
    expect((await f.audit()).map(subject => subject.kind === 'pool-hold' ? `${subject.action}:${subject.commandId}:${subject.state?.previous}>${subject.state?.next}` : subject.kind))
      .toEqual(['hold:h1:open>held', 'hold:h2:held>held', 'resume:r1:held>open', 'resume:r2:open>open']);
    expect(f.rows('SELECT count(*) AS n FROM execution_pool_hold_receipts')[0]!.n).toBe(4);
  });

  it('requires installation-level authority: refusals write no hold state and are sealed in the audit', async () => {
    const f = await fixture();
    const refused = async (document: unknown, code: string, ruleId: string | null, effect = 'deny') => {
      await expect(f.control(document).apply(hold(`h-${code}-${ruleId}`))).rejects.toMatchObject({ code });
      expect(f.rows('SELECT count(*) AS n FROM execution_pool_holds')[0]!.n).toBe(0);
      expect(f.rows('SELECT count(*) AS n FROM execution_pool_hold_receipts')[0]!.n).toBe(0);
      expect((await f.audit()).at(-1)).toMatchObject({ kind: 'pool-hold', action: 'hold', poolId: 'p', decision: { effect, ruleId }, state: null });
    };
    await refused(policy([]), 'POLICY_DENIED', null);
    // A grant in the caller's own scope is not enough: a hold stops every scope's reservations (WC-R1 installation bound).
    await refused(policy([rule('scoped', 'allow', ['hold'], ['s'])]), 'POLICY_DENIED', null);
    // A deny in any one scope refuses, even with a scopes 'all' grant.
    const lockT = { id: 'lock-t', actions: ['hold'], scopes: ['t'], principals: 'all', resource: { kind: 'pool', ids: ['p'] } };
    await refused(policy([rule('all', 'allow', ['hold'], 'all')], [lockT]), 'POLICY_DENIED', null);
    await refused(policy([rule('all', 'allow', ['hold'], 'all'), rule('deny-t', 'deny', ['hold'], ['t'])]), 'POLICY_DENIED', null);
    await refused(policy([rule('ask', 'require-approval', ['hold'], 'all')]), 'POLICY_APPROVAL_UNSUPPORTED', 'ask', 'require-approval');
    // A grant for `use` or `resume` does not grant `hold`.
    await refused(policy([rule('use-only', 'allow', ['use', 'resume'], 'all')]), 'POLICY_DENIED', null);
    // Reading the status needs only the scoped `inspect` decision; without it the read is refused.
    expect(await f.control(policy([rule('read', 'allow', ['inspect'], ['s'])])).inspect(status)).toMatchObject({ state: 'open', drained: false });
    await expect(f.control(policy([])).inspect(status)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    await expect(f.reservation.reserve({ ...query, commandId: 'still-open', expectedRevision: 0 })).resolves.toMatchObject({ identities: [{ taskId: 'a' }, { taskId: 'b' }] });
  });

  it('honours v2 role authority: the installation owner role bound over all scopes holds; a pool role bound to one scope is refused', async () => {
    const f = await fixture(), operator = { issuer: 'test', subject: 'operator' };
    const kinds = getPolicyVocabulary().resources.map(resource => resource.kind);
    const effective = (binding: { roles: string[]; scopes: 'all' | string[] }) => resolvePolicyBindings({ schemaVersion: 2, revision: 'p2', grants: [], restrictions: [],
      separationOfDuties: [], roles: [{ id: INSTALLATION_OWNER_ROLE_ID, permissions: installationOwnerPermissions(kinds) },
        { id: 'pool-operator', permissions: [{ id: 'pool-hold', effect: 'allow', actions: ['hold', 'resume', 'inspect'], resource: { kind: 'pool', ids: ['p'] } }] }] },
    { schemaVersion: 2, revision: 'b2', modes: [], bindings: [{ id: 'bound', principals: [operator], ...binding }] });
    await expect(f.control(effective({ roles: ['pool-operator'], scopes: ['s'] })).apply(hold('h-role-scoped'))).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    expect(f.rows('SELECT count(*) AS n FROM execution_pool_holds')[0]!.n).toBe(0);
    expect(await f.control(effective({ roles: ['pool-operator'], scopes: 'all' })).apply(hold('h-role-all'))).toMatchObject({ changed: true, state: 'held' });
    expect(await f.control(effective({ roles: [INSTALLATION_OWNER_ROLE_ID], scopes: 'all' })).apply(resume('r-owner'))).toMatchObject({ changed: true, state: 'open' });
  });

  it('refuses an unprovisioned pool, an invalid command and a missing default pool without writing', async () => {
    const f = await fixture();
    // Authority is decided before existence (an unauthorized caller learns nothing about pools); an authorized one gets the typed refusal.
    await expect(f.control().apply(hold('h0', { poolId: 'missing' }))).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    const anyPool = policy([{ ...rule('any', 'allow', ['hold', 'inspect'], 'all'), resource: { kind: 'pool', ids: 'all' } }]);
    await expect(f.control(anyPool).apply(hold('h1', { poolId: 'missing' }))).rejects.toMatchObject({ code: 'RUN_POOL_REQUIRED' });
    await expect(f.control(anyPool).inspect({ ...status, poolId: 'missing' })).rejects.toMatchObject({ code: 'RUN_POOL_REQUIRED' });
    await expect(f.control().apply(hold('h2', { reason: 'line\nbreak' }))).rejects.toThrow();
    await expect(f.control().apply({ ...hold('h3'), action: 'pause' })).rejects.toThrow();
    const noDefault = new ExecutionPoolHoldApplication({ async verify() { return principal; } }, new PoolControlPolicyAuthorization({ async load() { return owner; } }),
      f.store, audit => new AuditApplication(audit, integrity), () => 1, null);
    await expect(noDefault.apply(hold('h4'))).rejects.toMatchObject({ code: 'RUN_POOL_REQUIRED' });
    expect(f.rows('SELECT count(*) AS n FROM execution_pool_holds')[0]!.n).toBe(0);
    expect(f.rows('SELECT count(*) AS n FROM execution_pool_hold_receipts')[0]!.n).toBe(0);
  });
});

describe.skipIf(process.platform === 'win32')('ledger v44 pool hold tables', () => {
  async function ledger() {
    const root = await mkdtemp(join(tmpdir(), 'dn-pool-hold-ledger-')); roots.push(root);
    const path = join(root, 'ledger.db'), backups = join(root, 'backups'); await mkdir(backups, { mode: 0o700 });
    openSqliteLedger(path, options).close(); return { path, backups };
  }
  const read = (path: string, sql: string) => { const db = new DatabaseSync(path, { readOnly: true }); try { return db.prepare(sql).all(); } finally { db.close(); } };
  it('upgrades a v43 ledger losslessly: 0600 backup at v43, every existing table unchanged, two empty hold tables; a v43 open refuses v44', async () => {
    expect(CURRENT_LEDGER_VERSION).toBe(49); expect(POOL_HOLD_LEDGER_VERSION).toBe(44); expect(PREVIOUS_LEDGER_VERSION).toBe(48);
    const { path, backups } = await ledger();
    const db = new DatabaseSync(path); db.exec(DOWNGRADE_TO_V43_LEDGER_SQL);
    db.prepare('INSERT INTO execution_pools(pool_id,policy) VALUES(?,?)').run('p', '{"kept":true}');
    db.close();
    const tables = () => read(path, "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").map(row => String(row.name));
    const before = tables(), rows = Object.fromEntries(before.map(name => [name, read(path, `SELECT * FROM "${name}"`)]));
    expect(before.filter(name => name.startsWith('execution_pool_hold'))).toEqual([]);
    expect(() => openSqliteLedger(path, options, 'forbid')).toThrow(expect.objectContaining({ code: 'ATTEMPT_STORE_VERSION' }));
    const upgrade = await upgradeExistingProductLedger(path, options, backups, new Date('2026-10-01T08:00:00.000Z'));
    const backupPath = join(backups, 'ledger-v43-2026-10-01T08-00-00-000Z.db');
    expect(upgrade).toEqual({ from: 43, to: CURRENT_LEDGER_VERSION, backupPath });
    expect((await stat(backupPath)).mode & 0o777).toBe(0o600);
    expect(read(backupPath, 'PRAGMA user_version')[0]!.user_version).toBe(43); expect(read(path, 'PRAGMA user_version')[0]!.user_version).toBe(CURRENT_LEDGER_VERSION);
    expect(Object.fromEntries(before.map(name => [name, read(path, `SELECT * FROM "${name}"`)]))).toEqual(rows);
    expect(tables().filter(name => name.startsWith('execution_pool_hold'))).toEqual(['execution_pool_hold_receipts', 'execution_pool_holds']);
    // The rule a v43 build applies: a newer ledger is refused, never opened.
    const newer = await ledger(); const raw = new DatabaseSync(newer.path); raw.exec(`PRAGMA user_version=${CURRENT_LEDGER_VERSION + 1};`); raw.close();
    expect(() => openSqliteLedger(newer.path, options, 'forbid')).toThrow(expect.objectContaining({ code: 'ATTEMPT_STORE_VERSION' }));
  });
  it('rolls the v44 step back when a same-name object of another shape exists (ledger stays at v43)', async () => {
    const { path } = await ledger();
    const db = new DatabaseSync(path); db.exec(`${DOWNGRADE_TO_V43_LEDGER_SQL} CREATE TABLE execution_pool_holds(id INTEGER PRIMARY KEY, payload TEXT);`); db.close();
    expect(() => openSqliteLedger(path, options, 'allow')).toThrow(expect.objectContaining({ code: 'ATTEMPT_STORE_VERSION' }));
    expect(read(path, 'PRAGMA user_version')[0]!.user_version).toBe(43);
    expect(read(path, "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'execution_pool_hold%'").map(row => row.name)).toEqual(['execution_pool_holds']);
  });
  it('treats a hold row that disagrees with its record as corruption, never as open', async () => {
    const { path } = await ledger();
    const store = await openSqliteAttemptStore(path, options, { now: Date.now, timeoutMs: 86400000 }); stores.push(store);
    await store.createExecutionPool({ schemaVersion: 1, poolId: 'p', capacity: { executionSlots: 1, inFlightSlots: 1 } });
    const db = new DatabaseSync(path); db.prepare("INSERT INTO execution_pool_holds(pool_id,revision,state,record) VALUES('p',1,'open',?)")
      .run(JSON.stringify({ schemaVersion: 1, poolId: 'p', state: 'held', revision: 1, changedBy: { issuer: 'a', subject: 'b' }, changedAtMs: 1, scopeId: 's', commandId: 'c', reason: null })); db.close();
    await expect(store.readPoolHold('p')).rejects.toMatchObject({ code: 'RUN_STORE_CORRUPT' });
  });
  it('Sol 2210 K5-R1: status is one ledger snapshot — a resume and the last evaluation committed between its reads never yield held+drained', async () => {
    const f = await fixture(), empty = runRow(f);
    await f.reservation.reserve({ ...query, commandId: 'reserve', expectedRevision: 0 });
    await f.control().apply(hold('h1'));
    // Another connection resumes and the Run's last in-flight work ends (occupancy 0), both after the hold row was read.
    const view = await interleaved(f.path, [['DELETE FROM execution_pool_holds WHERE pool_id=?', 'p'],
      ["UPDATE runs SET snapshot=?, revision=? WHERE scope_id='s' AND run_id='r'", empty.snapshot, empty.revision]], () => f.control().inspect(status));
    expect(view).toMatchObject({ state: 'held', occupancy: { execution: 2, inFlight: 2 }, drained: false }); // the real earlier moment
    expect(await f.control().inspect(status)).toMatchObject({ state: 'open', occupancy: { execution: 0, inFlight: 0 }, drained: false }); // the later one
  });

  it('Sol 2210 K5-R1: a resume followed by a new reservation between its reads never yields a held pool with occupancy', async () => {
    const f = await fixture(), empty = runRow(f);
    await f.reservation.reserve({ ...query, commandId: 'reserve', expectedRevision: 0 });
    const reserved = runRow(f);
    const db = new DatabaseSync(f.path); try { db.prepare("UPDATE runs SET snapshot=?, revision=? WHERE scope_id='s' AND run_id='r'").run(empty.snapshot, empty.revision); } finally { db.close(); }
    await f.control().apply(hold('h1'));
    expect(await f.control().inspect(status)).toMatchObject({ state: 'held', occupancy: { execution: 0, inFlight: 0 }, drained: true });
    const view = await interleaved(f.path, [['DELETE FROM execution_pool_holds WHERE pool_id=?', 'p'],
      ["UPDATE runs SET snapshot=?, revision=? WHERE scope_id='s' AND run_id='r'", reserved.snapshot, reserved.revision]], () => f.control().inspect(status));
    expect(view).toMatchObject({ state: 'held', occupancy: { execution: 0, inFlight: 0 }, drained: true });
  });

  it('Sol 2210 K5-R1: a failed status read ends its read transaction; the next status and hold/resume on the same connection work', async () => {
    const f = await fixture();
    await f.control().apply(hold('h1'));
    const record = (f.rows("SELECT record FROM execution_pool_holds WHERE pool_id='p'")[0] as { record: string }).record;
    const write = (text: string, ...params: never[]) => { const db = new DatabaseSync(f.path); try { db.prepare(text).run(...params); } finally { db.close(); } };
    write("UPDATE execution_pool_holds SET record='{}' WHERE pool_id='p'");
    await expect(f.control().inspect(status)).rejects.toMatchObject({ code: 'RUN_STORE_CORRUPT' });
    write("UPDATE execution_pool_holds SET record=? WHERE pool_id='p'", record as never);
    expect(await f.control().inspect(status)).toMatchObject({ state: 'held', drained: true });
    expect(await f.control().apply(resume('r1'))).toMatchObject({ changed: true, state: 'open' });
  });
});
