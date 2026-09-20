import { CURRENT_LEDGER_VERSION } from '#adapters/core/sqlite-ledger/index.js';
import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { openSqliteAttemptStore, type SqliteAttemptStore } from '../../../src/adapters/index.js';
import type { ShutdownAdmission, ShutdownOutcome } from '../../../src/engine/index.js';

const roots: string[] = [], stores: SqliteAttemptStore[] = [], workers = new Set<Worker>();
const options = { busyTimeoutMs: 1000, journalMode: 'wal', durability: 'full' } as const;

afterEach(async () => {
  await Promise.all([...workers].map(worker => worker.terminate())); workers.clear();
  for (const store of stores.splice(0)) { try { store.close(); } catch { /* Already closed by a test. */ } }
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'deckent-shutdown-store-')); roots.push(root);
  return join(root, 'execution.db');
}
async function open(path: string, migration: 'allow' | 'forbid' = 'allow') {
  const store = await openSqliteAttemptStore(path, options, migration); stores.push(store); return store;
}
function admission(overrides: Partial<ShutdownAdmission> = {}): ShutdownAdmission {
  return {
    schemaVersion: 1,
    scopeId: 'scope-a',
    command: { schemaVersion: 1, commandId: 'command-a', serviceId: 'service-a', instanceId: 'instance-a', reason: 'operator maintenance' },
    actor: {
      principal: { id: 'principal-a', issuer: 'local-os', subject: '1000', assurance: 'os-user', scopeIds: ['scope-a'] },
      evidence: { method: 'os-peer', pid: 100, uid: 1000, gid: 1000 },
    },
    authorization: { revision: 'revision-a', ruleId: 'rule-a' },
    admittedAtMs: 1000,
    ...overrides,
  };
}
function outcome(overrides: Partial<ShutdownOutcome> = {}): ShutdownOutcome {
  return { schemaVersion: 1, scopeId: 'scope-a', serviceId: 'service-a', instanceId: 'instance-a', commandId: 'command-a', state: 'clean', remainingRequests: 0, recoveryPending: false, observedAtMs: 2000, ...overrides };
}
function code(error: unknown) { return error && typeof error === 'object' && 'code' in error ? error.code : null; }

function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`${label}_TIMEOUT`)), 5000);
    promise.then(value => { clearTimeout(timeout); resolve(value); }, error => { clearTimeout(timeout); reject(error); });
  });
}

function concurrentAdmission(path: string, input: ShutdownAdmission) {
  const gate = new SharedArrayBuffer(4), view = new Int32Array(gate);
  const workerSource = `
    const { parentPort, workerData } = require('node:worker_threads');
    (async () => {
      const { openSqliteAttemptStore } = await import(workerData.module);
      const store = await openSqliteAttemptStore(workerData.path, workerData.options);
      parentPort.postMessage({ ready: true }); Atomics.wait(new Int32Array(workerData.gate), 0, 0);
      try { parentPort.postMessage({ result: await store.admitServiceShutdown(workerData.input) }); }
      catch (error) { parentPort.postMessage({ error: error && error.code || String(error) }); }
      finally { store.close(); }
    })();`;
  const worker = new Worker(workerSource, { eval: true, workerData: {
    gate, path, input, options, module: pathToFileURL(join(process.cwd(), 'dist/adapters/index.js')).href,
  } });
  workers.add(worker);
  let readySettled = false, resultSettled = false;
  let readyResolve!: () => void, readyReject!: (error: Error) => void;
  let resultResolve!: (value: unknown) => void, resultReject!: (error: Error) => void;
  const ready = bounded(new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; }), 'WORKER_READY');
  const result = bounded(new Promise<unknown>((resolve, reject) => { resultResolve = resolve; resultReject = reject; }), 'WORKER_RESULT');
  // Observe early startup failures even before the caller awaits readiness.
  void result.catch(() => undefined);
  worker.on('message', message => {
    if (message.ready && !readySettled) { readySettled = true; readyResolve(); return; }
    if (resultSettled) return;
    resultSettled = true;
    if (message.error) resultReject(new Error(message.error)); else resultResolve(message.result);
  });
  worker.once('error', error => {
    if (!readySettled) { readySettled = true; readyReject(error); }
    if (!resultSettled) { resultSettled = true; resultReject(error); }
  });
  worker.once('exit', exitCode => {
    const error = new Error(`WORKER_EXIT_${exitCode}`);
    if (!readySettled) { readySettled = true; readyReject(error); }
    if (!resultSettled) { resultSettled = true; resultReject(error); }
  });
  return { ready, result, release: () => { Atomics.store(view, 0, 1); Atomics.notify(view); } };
}

describe('SQLite service shutdown journal', () => {
  it('atomically admits once across connections and replays the original audit despite fresh peer evidence', async () => {
    const path = await fixture(), seed = await open(path); seed.close(); stores.splice(stores.indexOf(seed), 1);
    const fresh = admission({
      actor: { ...admission().actor, evidence: { method: 'os-peer', pid: 200, uid: 1000, gid: 2000 } },
      authorization: { revision: 'revision-b', ruleId: 'rule-b' }, admittedAtMs: 2000,
    });
    const first = concurrentAdmission(path, admission()), second = concurrentAdmission(path, fresh);
    await Promise.all([first.ready, second.ready]);
    const results = Promise.all([first.result, second.result]);
    first.release(); second.release();
    const [left, right] = await results as Array<Awaited<ReturnType<SqliteAttemptStore['admitServiceShutdown']>>>;
    expect([left.replayed, right.replayed].sort()).toEqual([false, true]);
    expect(left.admission).toEqual(right.admission);
    const reader = await open(path);
    expect((await reader.readServiceShutdown({ scopeId: 'scope-a', serviceId: 'service-a', commandId: 'command-a' }))?.admission).toEqual(left.admission);
  });

  it('rejects changed stable actor, reason, or instance under the admitted key', async () => {
    const store = await open(await fixture()); await store.admitServiceShutdown(admission());
    const variants = [
      admission({ command: { ...admission().command, reason: 'different' } }),
      admission({ command: { ...admission().command, instanceId: 'instance-b' } }),
      admission({ actor: { ...admission().actor, principal: { ...admission().actor.principal, issuer: 'other-os' } } }),
    ];
    for (const changed of variants) await expect(store.admitServiceShutdown(changed)).rejects.toSatisfy(error => code(error) === 'SERVICE_SHUTDOWN_CONFLICT');
  });

  it('retains one matching outcome and rejects orphan, wrong-instance, and changed outcomes', async () => {
    const path = await fixture(), store = await open(path);
    await expect(store.retainServiceShutdownOutcome(outcome())).rejects.toSatisfy(error => code(error) === 'SERVICE_SHUTDOWN_NOT_ADMITTED');
    await store.admitServiceShutdown(admission());
    await expect(store.retainServiceShutdownOutcome(outcome({ instanceId: 'instance-b' }))).rejects.toSatisfy(error => code(error) === 'SERVICE_SHUTDOWN_INSTANCE');
    const original = await store.retainServiceShutdownOutcome(outcome());
    expect(await store.retainServiceShutdownOutcome(outcome())).toEqual(original);
    await expect(store.retainServiceShutdownOutcome(outcome({ observedAtMs: 3000 }))).rejects.toSatisfy(error => code(error) === 'SERVICE_SHUTDOWN_OUTCOME_CONFLICT');
    expect((await store.readServiceShutdown({ scopeId: 'scope-a', serviceId: 'service-a', commandId: 'command-a' }))?.outcome).toEqual(original);
    const db = new DatabaseSync(path);
    db.prepare('UPDATE service_shutdown_outcomes SET record=?').run(JSON.stringify(outcome({ instanceId: 'instance-b' }))); db.close();
    await expect(store.readServiceShutdown({ scopeId: 'scope-a', serviceId: 'service-a', commandId: 'command-a' })).rejects.toSatisfy(error => code(error) === 'SERVICE_SHUTDOWN_CORRUPT');
  });

  it('rejects invalid wire inputs and corrupt stored identities', async () => {
    const path = await fixture(), store = await open(path);
    await expect(store.admitServiceShutdown({ ...admission(), unexpected: true } as ShutdownAdmission)).rejects.toSatisfy(error => code(error) === 'SERVICE_SHUTDOWN_INVALID');
    await store.admitServiceShutdown(admission());
    const db = new DatabaseSync(path);
    db.prepare('UPDATE service_shutdown_commands SET record=?').run(JSON.stringify(admission({ scopeId: 'scope-b' }))); db.close();
    await expect(store.readServiceShutdown({ scopeId: 'scope-a', serviceId: 'service-a', commandId: 'command-a' })).rejects.toSatisfy(error => code(error) === 'SERVICE_SHUTDOWN_CORRUPT');
  });

  it('leaves no admission when the atomic audit write fails', async () => {
    const path = await fixture(), store = await open(path), db = new DatabaseSync(path);
    db.exec("CREATE TRIGGER reject_shutdown BEFORE INSERT ON service_shutdown_commands BEGIN SELECT RAISE(ABORT,'reject'); END"); db.close();
    await expect(store.admitServiceShutdown(admission())).rejects.toSatisfy(error => code(error) === 'SERVICE_SHUTDOWN_AUDIT_UNAVAILABLE');
    expect(await store.readServiceShutdown({ scopeId: 'scope-a', serviceId: 'service-a', commandId: 'command-a' })).toBeNull();
  });

  it('migrates version 9 through shutdown and ownership tables without data loss, while future versions remain typed', async () => {
    const path = await fixture(), seeded = await open(path); seeded.close(); stores.splice(stores.indexOf(seeded), 1);
    const old = new DatabaseSync(path);
    old.prepare('INSERT INTO execution_pools(pool_id,policy) VALUES(?,?)').run('preserved', '{"marker":true}');
    old.exec('DROP TABLE provider_spend_audits; DROP TABLE model_invocation_spend_reservations; DROP TABLE provider_spend_accounts; DROP TABLE model_invocation_allocation_checkpoints; DROP INDEX model_invocations_allocation_identity; DROP TABLE model_invocation_cancellations; DROP TABLE model_invocation_controls; DROP INDEX model_invocations_allocation_state; DROP TABLE model_invocation_contents; DROP TABLE model_invocation_content_purges; DROP TABLE model_invocations; DROP TABLE model_invocation_allocations; DROP TABLE model_activation_receipts; DROP TABLE model_activations; DROP TABLE installation_ownership; DROP TABLE service_shutdown_commands; DROP TABLE service_shutdown_outcomes; PRAGMA user_version=9'); old.close();
    await expect(openSqliteAttemptStore(path, options, 'forbid')).rejects.toThrow('ATTEMPT_STORE_VERSION');
    const migrated = await open(path);
    expect(await migrated.readServiceShutdown({ scopeId: 'scope-a', serviceId: 'service-a', commandId: 'command-a' })).toBeNull();
    const check = new DatabaseSync(path, { readOnly: true });
    expect(check.prepare('PRAGMA user_version').get()?.user_version).toBe(CURRENT_LEDGER_VERSION);
    expect(check.prepare('SELECT policy FROM execution_pools WHERE pool_id=?').get('preserved')?.policy).toBe('{"marker":true}'); check.close();
    migrated.close(); stores.splice(stores.indexOf(migrated), 1);
    const future = new DatabaseSync(path); future.exec(`PRAGMA user_version=${CURRENT_LEDGER_VERSION + 1}`); future.close();
    await expect(openSqliteAttemptStore(path, options)).rejects.toThrow('ATTEMPT_STORE_VERSION');
  });
});
