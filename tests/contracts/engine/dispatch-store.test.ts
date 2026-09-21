import { CURRENT_LEDGER_VERSION } from '#adapters/core/sqlite-ledger/index.js';
import { admitRunAttempts } from '../support/admission.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { afterEach, expect, it } from 'vitest';
import { openSqliteAttemptStore, type SqliteAttemptStore } from '#adapters/index.js';
import { createAttempt, requestRunCancellation } from '#domain/index.js';
import { custodyProfiles, dispatchAdmission, grantTestLaunch } from '../support/custody.js';
const roots: string[] = []; const stores: SqliteAttemptStore[] = [];
const options = { busyTimeoutMs: 20, journalMode: 'wal' as const, durability: 'full' as const };
const identity = { runId: 'r', taskId: 't', attemptId: 'a', scopeId: 's', generation: 1, layoutRevision: 'l' };
const claim = { owner: 'owner-1', request: { protocolVersion: 1 as const, identity, workspace: '/private/workspace', argv: ['node', 'task.js'] } };
const terminal = { handle: 'container', exitCode: 0, interrupted: false };
afterEach(async () => { for (const store of stores.splice(0)) store.close(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'deckent-dispatch-')); roots.push(root);
  const path = join(root, 'ledger.db');
  const open = async () => { const store = await openSqliteAttemptStore(path, options, 'allow', custodyProfiles); stores.push(store); return store; };
  return { path, open };
}
async function admit(store: SqliteAttemptStore) { await admitRunAttempts(store, [identity]); }
it('grants exactly one launch across connections, reopen and terminal recording', async () => {
  const f = await fixture(); const a = await f.open(); await admit(a); const b = await f.open();
  const results = await Promise.all([a.claimDispatch(dispatchAdmission(claim)), b.claimDispatch(dispatchAdmission({ ...claim, owner: 'owner-2' }))]);
  expect(results.map(x => x.acquired)).toEqual([true, false]);
  await expect(b.finishDispatch({ ...claim, owner: 'owner-2' }, terminal)).rejects.toThrow('DISPATCH_CONFLICT');
  expect((await a.claimDispatch(dispatchAdmission(claim))).acquired).toBe(false); await grantTestLaunch(a, claim);
  await a.finishDispatch(claim, terminal);
  const c = await f.open(); const replay = await c.claimDispatch(dispatchAdmission(claim));
  expect(replay.acquired).toBe(false); expect(replay.record.terminal).toEqual(terminal);
  expect(await c.finishDispatch(claim, terminal)).toEqual(replay.record);
  await expect(c.finishDispatch(claim, { ...terminal, exitCode: 1 })).rejects.toThrow('DISPATCH_CONFLICT');
});
it('linearizes launch across two writer processes, denies replay, and prevents launch after cancellation', async () => {
  const f = await fixture(); const store = await f.open(); await admit(store); await store.claimDispatch(dispatchAdmission(claim));
  const program = `
    import { openSqliteAttemptStore } from './dist/adapters/index.js';
    const [path, claimText, profileText, principalText] = process.argv.slice(1);
    const profile = JSON.parse(profileText); const claim = JSON.parse(claimText); const principal = JSON.parse(principalText);
    const store = await openSqliteAttemptStore(path, { busyTimeoutMs: 1000, journalMode: 'wal', durability: 'full' }, 'allow', {
      validate(value) { if (JSON.stringify(value) !== JSON.stringify(profile)) throw new Error('TEST_SUPERVISOR_PROFILE_INVALID'); return undefined; }
    });
    process.stdout.write('READY\\n');
    process.stdin.once('data', async () => {
      try { const decision = await store.grantLaunch({ claim, principal, now: 10 }); process.stdout.write(JSON.stringify({ ok: true, kind: decision.kind })); }
      catch (error) { process.stdout.write(JSON.stringify({ ok: false, code: error?.code ?? error?.message })); }
      finally { store.close(); }
    });
  `;
  const launch = () => spawn(process.execPath, ['--input-type=module', '-e', program, f.path, JSON.stringify(claim),
    JSON.stringify(dispatchAdmission(claim).profile), JSON.stringify({ id: 'launcher', issuer: 'test', subject: 'process', assurance: 'os-user', scopeIds: ['s'] })],
  { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'inherit'] });
  const children = [launch(), launch()];
  const buffers = ['', ''];
  const ready = children.map((child, index) => new Promise<void>((resolve, reject) => {
    let announced = false; child.once('error', reject); child.stdout.on('data', chunk => {
      buffers[index] += String(chunk); if (!announced && buffers[index]!.startsWith('READY\n')) { announced = true; resolve(); }
    });
    child.once('close', code => { if (!announced) reject(new Error(`grant child exited before READY: ${code}`)); });
  }));
  const outcomes = children.map((child, index) => new Promise<{ ok: boolean; kind?: string; code?: string }>((resolve, reject) => {
    child.once('error', reject); child.once('close', code => code === 0
      ? resolve(JSON.parse(buffers[index]!.slice('READY\n'.length))) : reject(new Error(`grant child exited ${code}`)));
  }));
  try {
    await Promise.all(ready);
    for (const child of children) child.stdin.end('go');
    const decisions = await Promise.all(outcomes);
    expect(decisions.filter(value => value.ok && value.kind === 'granted')).toHaveLength(1);
    expect(decisions.filter(value => !value.ok && value.code === 'DISPATCH_CONFLICT')).toHaveLength(1);
    await expect(grantTestLaunch(store, claim, 11)).rejects.toThrow('DISPATCH_CONFLICT');
  } finally {
    for (const child of children) {
      if (!child.stdin.destroyed) child.stdin.end();
      if (child.exitCode === null && child.signalCode === null) {
        await Promise.race([new Promise<void>(resolve => child.once('close', () => resolve())),
          new Promise<void>(resolve => setTimeout(resolve, 2_000))]);
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }
    }
  }

  const second = await fixture(); const cancelled = await second.open(); await admit(cancelled);
  await cancelled.claimDispatch(dispatchAdmission(claim));
  await cancelled.requestDispatchCancellation(claim.request, { id: 'canceller', issuer: 'test', subject: 'operator', assurance: 'os-user', scopeIds: ['s'] });
  const prevented = await grantTestLaunch(cancelled, claim, 12);
  expect(prevented).toMatchObject({ kind: 'prevented', record: { launch: 'prevented-before-launch', cancellation: { id: 'canceller' }, prevention: { reason: 'cancel-requested' } } });
});
it('requires a trusted profile validator and leaves no row for rejected profiles', async () => {
  const f = await fixture();
  const absent = await openSqliteAttemptStore(f.path, options); stores.push(absent); await admit(absent);
  await expect(absent.claimDispatch(dispatchAdmission(claim))).rejects.toThrow('DISPATCH_PROFILE_VALIDATION_REQUIRED');
  const strict = await f.open();
  for (const profile of [{ ...dispatchAdmission(claim).profile, adapterId: 'unknown-adapter' },
    { ...dispatchAdmission(claim).profile, parameters: { fixture: 'wrong-parameters' } }]) {
    await expect(strict.claimDispatch({ ...claim, profile })).rejects.toThrow('TEST_SUPERVISOR_PROFILE_INVALID');
  }
  const db = new DatabaseSync(f.path, { readOnly: true });
  try { expect(db.prepare('SELECT count(*) AS n FROM dispatches').get()?.n).toBe(0); } finally { db.close(); }
});
it('retains unresolved custody across restart and rejects request or generation substitution', async () => {
  const f = await fixture(); const a = await f.open(); await admit(a); await a.claimDispatch(dispatchAdmission(claim));
  a.close(); stores.splice(stores.indexOf(a), 1);
  const b = await f.open(); expect((await b.claimDispatch(dispatchAdmission(claim))).acquired).toBe(false);
  await expect(b.claimDispatch(dispatchAdmission({ ...claim, request: { ...claim.request, argv: ['other'] } }))).rejects.toThrow('DISPATCH_CONFLICT');
  await expect(b.claimDispatch(dispatchAdmission({ ...claim, request: { ...claim.request, identity: { ...identity, generation: 2 } } }))).rejects.toThrow('DISPATCH_CONFLICT');
});
it('refuses absent, cancelled and foreign-scope attempts before creating a dispatch', async () => {
  const f = await fixture(); const store = await f.open();
  await expect(store.claimDispatch(dispatchAdmission(claim))).rejects.toThrow('DISPATCH_NOT_ADMITTED'); await admit(store);
  await expect(store.claimDispatch(dispatchAdmission({ ...claim, request: { ...claim.request, identity: { ...identity, scopeId: 'foreign' } } }))).rejects.toThrow('DISPATCH_NOT_ADMITTED');
  await store.commit({ commandId: 'cancel', command: 'cancel', expectedRevision: 0, snapshot: { ...createAttempt(identity), revision: 1, cancelRequested: true } });
  await expect(store.claimDispatch(dispatchAdmission(claim))).rejects.toThrow('DISPATCH_NOT_ADMITTED');
  const db = new DatabaseSync(f.path); expect(db.prepare('SELECT count(*) AS n FROM dispatches').get()?.n).toBe(0); db.close();
});
it('upgrades Next schema1 atomically without losing existing attempt and receipt evidence', async () => {
  const f = await fixture(); const db = new DatabaseSync(f.path);
  db.exec('CREATE TABLE attempts(scope_id TEXT,attempt_id TEXT,revision INTEGER,snapshot TEXT,PRIMARY KEY(scope_id,attempt_id)); CREATE TABLE attempt_receipts(scope_id TEXT,command_id TEXT,command TEXT,snapshot TEXT,PRIMARY KEY(scope_id,command_id)); DROP TABLE IF EXISTS workspace_integrations; DROP TABLE IF EXISTS approval_outbox; DROP TABLE IF EXISTS approval_receipts; DROP TABLE IF EXISTS approvals; PRAGMA user_version=1;');
  const snapshot = createAttempt(identity);
  db.prepare('INSERT INTO attempts VALUES(?,?,?,?)').run('s','a',0,JSON.stringify(snapshot));
  db.prepare('INSERT INTO attempt_receipts VALUES(?,?,?,?)').run('s','create','admission',JSON.stringify(snapshot)); db.close();
  const store = await f.open(); expect(await store.load('s','a')).toEqual(snapshot);
  expect((await store.receipt('s','create'))?.command).toBe('admission'); await expect(store.claimDispatch(dispatchAdmission(claim))).rejects.toThrow('DISPATCH_NOT_ADMITTED');
  const check = new DatabaseSync(f.path); expect(check.prepare('PRAGMA user_version').get()?.user_version).toBe(CURRENT_LEDGER_VERSION); check.close();
});

it('atomically rolls back terminal projection with journal failure, then preserves cancellation intent on settlement', async () => {
  const f = await fixture(); const store = await f.open(); await admit(store); await store.claimDispatch(dispatchAdmission(claim)); await grantTestLaunch(store, claim);
  await store.commit({ commandId: 'cancel-after-claim', command: 'cancel', expectedRevision: 0,
    snapshot: { ...createAttempt(identity), revision: 1, cancelRequested: true } });
  const db = new DatabaseSync(f.path);
  db.exec("CREATE TRIGGER fail_terminal BEFORE UPDATE ON dispatches BEGIN SELECT RAISE(ABORT,'injected'); END;");
  await expect(store.finishDispatch(claim, terminal)).rejects.toThrow();
  expect((await store.load('s', 'a'))?.lastObservation).toBeNull();
  expect((await store.load('s', 'a'))?.revision).toBe(1);
  expect((await store.readDispatch(claim.request))?.terminal).toBeNull();
  expect((await store.loadRun('s', 'r'))!.revision).toBe(1);
  db.exec('DROP TRIGGER fail_terminal'); db.close();
  await store.finishDispatch(claim, terminal);
  const settled = await store.load('s', 'a');
  expect(settled).toMatchObject({ revision: 2, cancelRequested: true, lastObservation: { sequence: 1, result: { kind: 'exited', exitCode: 0 } } });
  expect(settled).not.toHaveProperty('accepted');
  const run = (await store.loadRun('s', 'r'))!; expect(run.revision).toBe(2); expect(run.progress[0]!.phase).toBe('evaluating');
  await store.finishDispatch(claim, terminal);
  expect(await store.load('s', 'a')).toEqual(settled);
  expect((await store.loadRun('s', 'r'))!.revision).toBe(2);
});

it('rejects contradictory terminal causes without writing terminal evidence', async () => {
  const f = await fixture(); const store = await f.open(); await admit(store); await store.claimDispatch(dispatchAdmission(claim)); await grantTestLaunch(store, claim);
  await expect(store.finishDispatch(claim, { ...terminal, exitCode: null })).rejects.toThrow();
  await expect(store.finishDispatch(claim, { ...terminal, signal: 'SIGTERM' })).rejects.toThrow();
  expect((await store.readDispatch(claim.request))?.terminal).toBeNull();
});

it('maps a competing terminal writer to dispatch conflict without altering either existing evidence', async () => {
  const f = await fixture(); const store = await f.open(); await admit(store); await store.claimDispatch(dispatchAdmission(claim)); await grantTestLaunch(store, claim);
  const snapshot = { ...createAttempt(identity), revision: 1, lastObservation: { protocolVersion: 1 as const, identity,
    sequence: 1, eventId: 'other-terminal', result: { kind: 'exited' as const, exitCode: 9 } } };
  await store.commit({ commandId: 'other', command: 'other', expectedRevision: 0, snapshot });
  await expect(store.finishDispatch(claim, terminal)).rejects.toThrow('DISPATCH_CONFLICT');
  expect(await store.load('s', 'a')).toEqual(snapshot);
  expect((await store.readDispatch(claim.request))?.terminal).toBeNull();
});

it.each([true, false])('merges compatible recovery/execution evidence without a second Attempt transition (recoveryFirst=%s)', async recoveryFirst => {
  const f = await fixture(); const a = await f.open(); const b = await f.open(); await admit(a); await a.claimDispatch(dispatchAdmission(claim)); await grantTestLaunch(a, claim);
  const unknown = { ...terminal, interrupted: null };
  await a.finishDispatch(claim, recoveryFirst ? unknown : terminal);
  const snapshot = await a.load('s', 'a');
  const merged = await b.finishDispatch(claim, recoveryFirst ? terminal : unknown);
  expect(merged.terminal).toEqual(terminal);
  expect(await b.load('s', 'a')).toEqual(snapshot);
  await expect(b.finishDispatch(claim, { ...terminal, interrupted: true })).rejects.toThrow('DISPATCH_CONFLICT');
  expect((await a.readDispatch(claim.request))?.terminal).toEqual(terminal);
});

it('refuses a real attempt row without a Run reservation', async () => {
  const f = await fixture(); const store = await f.open();
  await store.commit({ commandId: 'orphan', command: 'orphan', expectedRevision: null, snapshot: createAttempt(identity) });
  await expect(store.claimDispatch(dispatchAdmission(claim))).rejects.toThrow('DISPATCH_NOT_ADMITTED');
  expect(await store.readDispatch(claim.request)).toBeNull();
});
it.each(['cancelled-run', 'missing-pool'])('refuses fresh dispatch with %s despite an existing attempt', async reason => {
  const f = await fixture(); const store = await f.open(); await admit(store);
  const db = new DatabaseSync(f.path);
  try {
    if (reason === 'missing-pool') db.exec('DELETE FROM execution_pools');
    else {
      const run = (await store.loadRun('s', 'r'))!; const cancelled = requestRunCancellation(run, run.revision);
      db.prepare('UPDATE runs SET revision=?,snapshot=? WHERE scope_id=? AND run_id=?').run(cancelled.revision, JSON.stringify(cancelled), 's', 'r');
    }
  } finally { db.close(); }
  await expect(store.claimDispatch(dispatchAdmission(claim))).rejects.toThrow('DISPATCH_NOT_ADMITTED');
  expect(await store.readDispatch(claim.request)).toBeNull();
});
it('rolls back attempt terminal evidence if Run binding projection fails, then settles all three records together', async () => {
  const f = await fixture(); const store = await f.open(); await admit(store); await store.claimDispatch(dispatchAdmission(claim)); await grantTestLaunch(store, claim);
  const run = (await store.loadRun('s', 'r'))!; const db = new DatabaseSync(f.path);
  try {
    db.prepare('UPDATE runs SET snapshot=? WHERE scope_id=? AND run_id=?').run(JSON.stringify({ ...run, bindings: run.bindings.map(binding => ({ ...binding, identity: { ...binding.identity, generation: 2 } })) }), 's', 'r');
    await expect(store.finishDispatch(claim, terminal)).rejects.toThrow('DISPATCH_NOT_ADMITTED');
    expect((await store.load('s', 'a'))!.lastObservation).toBeNull(); expect((await store.readDispatch(claim.request))!.terminal).toBeNull();
    db.prepare('UPDATE runs SET snapshot=? WHERE scope_id=? AND run_id=?').run(JSON.stringify(run), 's', 'r');
    await store.finishDispatch(claim, terminal);
    expect((await store.load('s', 'a'))!.lastObservation!.result.kind).toBe('exited');
    expect((await store.readDispatch(claim.request))!.terminal!.exitCode).toBe(0);
    expect((await store.loadRun('s', 'r'))!.progress[0]!.phase).toBe('evaluating');
  } finally { db.close(); }
});
