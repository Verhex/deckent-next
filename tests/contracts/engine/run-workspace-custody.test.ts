import { CURRENT_LEDGER_VERSION } from '#adapters/core/sqlite-ledger/index.js';
import { downgradeRunEligibilityFixtures } from '../support/legacy-run-eligibility.js';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { openSqliteAttemptStore, type SqliteAttemptStore } from '#adapters/index.js';
import { admitRunAttempts } from '../support/admission.js';

const roots: string[] = []; const stores: SqliteAttemptStore[] = [];
const options = { busyTimeoutMs: 100, journalMode: 'wal' as const, durability: 'full' as const };
const source = { schemaVersion: 1 as const, adapter: { id: 'git', version: 1 }, sourceFingerprint: 'a'.repeat(64) };
const candidate = (baseRevision = '1'.repeat(40), override = {}) => ({ schemaVersion: 1 as const, scopeId: 's', runId: 'r', source, baseRevision, ...override });
afterEach(async () => { for (const store of stores.splice(0)) store.close(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'deckent-run-workspace-custody-')); roots.push(root); const path = join(root, 'ledger.db');
  const store = await openSqliteAttemptStore(path, options); stores.push(store);
  await admitRunAttempts(store, [{ scopeId: 's', runId: 'r', taskId: 't', attemptId: 'a', layoutRevision: 'l', generation: 1 }]);
  return { path, store };
}

it('records one immutable custody value, returns it after reopen and never mutates the Run', async () => {
  const f = await fixture(); const before = await f.store.loadRun('s', 'r');
  expect(await f.store.loadRunWorkspaceCustody('s', 'r')).toBeNull();
  expect(await f.store.resolveRunWorkspaceCustody(candidate())).toEqual(candidate());
  expect(await f.store.resolveRunWorkspaceCustody(candidate('2'.repeat(40)))).toEqual(candidate());
  expect(await f.store.loadRun('s', 'r')).toEqual(before);
  f.store.close(); stores.splice(stores.indexOf(f.store), 1);
  const reopened = await openSqliteAttemptStore(f.path, options, 'forbid'); stores.push(reopened);
  expect(await reopened.loadRunWorkspaceCustody('s', 'r')).toEqual(candidate());
});

it('converges two connections and different base candidates on one same-source first writer', async () => {
  const f = await fixture(); const program = `
    import { openSqliteAttemptStore } from './dist/adapters/index.js';
    const [path,candidateText]=process.argv.slice(1); const store=await openSqliteAttemptStore(path,{busyTimeoutMs:1000,journalMode:'wal',durability:'full'},'forbid');
    process.stdout.write('READY\\n'); await new Promise(resolveInput=>process.stdin.once('data',resolveInput));
    const value=await store.resolveRunWorkspaceCustody(JSON.parse(candidateText)); store.close(); process.stdout.write(JSON.stringify(value));`;
  const children = [candidate('1'.repeat(40)), candidate('2'.repeat(40))].map(value => spawn(process.execPath,
    ['--input-type=module', '-e', program, f.path, JSON.stringify(value)], { cwd: resolve('.'), stdio: ['pipe', 'pipe', 'pipe'] }));
  const buffers = ['', ''];
  const ready = children.map((child, index) => new Promise<void>((resolveReady, reject) => {
    child.once('error', reject); child.stdout.on('data', chunk => { buffers[index] += String(chunk); if (buffers[index]!.startsWith('READY\n')) resolveReady(); });
    child.once('close', code => { if (!buffers[index]!.startsWith('READY\n')) reject(new Error(`custody child exited before READY: ${code}`)); });
  }));
  const outcomes = children.map((child, index) => new Promise<ReturnType<typeof candidate>>((resolveValue, reject) => {
    child.once('error', reject); child.once('close', code => code === 0
      ? resolveValue(JSON.parse(buffers[index]!.slice('READY\n'.length))) : reject(new Error(`custody child exited ${code}`)));
  }));
  try {
    await Promise.all(ready); for (const child of children) child.stdin.end('GO\n');
    const values = await Promise.all(outcomes);
  expect(values[0]).toEqual(values[1]); expect(['1'.repeat(40), '2'.repeat(40)]).toContain(values[0].baseRevision);
  } finally { for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }
});

it('rejects missing or foreign Runs and a conflicting source identity', async () => {
  const f = await fixture();
  await expect(f.store.loadRunWorkspaceCustody('other', 'r')).rejects.toMatchObject({ code: 'RUN_WORKSPACE_CUSTODY_CONFLICT' });
  await expect(f.store.resolveRunWorkspaceCustody(candidate('1'.repeat(40), { runId: 'missing' }))).rejects.toMatchObject({ code: 'RUN_WORKSPACE_CUSTODY_CONFLICT' });
  await f.store.resolveRunWorkspaceCustody(candidate());
  await expect(f.store.resolveRunWorkspaceCustody(candidate('1'.repeat(40), { source: { ...source, sourceFingerprint: 'b'.repeat(64) } })))
    .rejects.toMatchObject({ code: 'RUN_WORKSPACE_CUSTODY_CONFLICT' });
});

it.each(['record', 'run-revision', 'run-execution'] as const)('fails closed for corrupt persisted %s', async kind => {
  const f = await fixture(); await f.store.resolveRunWorkspaceCustody(candidate()); const db = new DatabaseSync(f.path);
  try {
    if (kind === 'record') db.exec("UPDATE run_workspace_custody SET record='{}'");
    if (kind === 'run-revision') db.exec('UPDATE runs SET revision=99');
    if (kind === 'run-execution') {
      const row = db.prepare("SELECT snapshot FROM runs WHERE scope_id='s' AND run_id='r'").get()!; const snapshot = JSON.parse(String(row.snapshot));
      snapshot.execution.criteria[0].fingerprint = '0'.repeat(64); db.prepare("UPDATE runs SET snapshot=? WHERE scope_id='s' AND run_id='r'").run(JSON.stringify(snapshot));
    }
  } finally { db.close(); }
  await expect(f.store.loadRunWorkspaceCustody('s', 'r')).rejects.toMatchObject({ code: 'RUN_WORKSPACE_CUSTODY_CORRUPT' });
});

it('rolls back a failed first insert without creating custody', async () => {
  const f = await fixture(); const db = new DatabaseSync(f.path);
  db.exec("CREATE TRIGGER reject_custody BEFORE INSERT ON run_workspace_custody BEGIN SELECT RAISE(ABORT,'fixture'); END;"); db.close();
  await expect(f.store.resolveRunWorkspaceCustody(candidate())).rejects.toThrow('fixture');
  expect(await f.store.loadRunWorkspaceCustody('s', 'r')).toBeNull();
});

it('migrates schema eight by adding an empty custody table without inventing records', async () => {
  const f = await fixture(); f.store.close(); stores.splice(stores.indexOf(f.store), 1); const db = new DatabaseSync(f.path);
  downgradeRunEligibilityFixtures(db);
  db.exec('DROP INDEX model_invocations_allocation_state; DROP TABLE model_invocation_contents; DROP TABLE model_invocations; DROP TABLE model_invocation_allocations; DROP TABLE model_activation_receipts; DROP TABLE model_activations; DROP TABLE installation_ownership; DROP TABLE service_shutdown_commands; DROP TABLE service_shutdown_outcomes; DROP TABLE run_workspace_custody; PRAGMA user_version=8'); db.close();
  const migrated = await openSqliteAttemptStore(f.path, options); stores.push(migrated);
  expect(await migrated.loadRunWorkspaceCustody('s', 'r')).toBeNull();
  const check = new DatabaseSync(f.path, { readOnly: true });
  try { expect(check.prepare('PRAGMA user_version').get()!.user_version).toBe(CURRENT_LEDGER_VERSION); expect(check.prepare('SELECT count(*) AS count FROM run_workspace_custody').get()!.count).toBe(0); }
  finally { check.close(); }
});

it('rejects a new adapter version after reopening without replacing the pinned Run source', async () => {
  const f = await fixture(); await f.store.resolveRunWorkspaceCustody(candidate());
  f.store.close(); stores.splice(stores.indexOf(f.store), 1);
  const reopened = await openSqliteAttemptStore(f.path, options, 'forbid'); stores.push(reopened);
  const changed = candidate('1'.repeat(40), { source: { ...source, adapter: { id: 'git', version: 2 } } });
  await expect(reopened.resolveRunWorkspaceCustody(changed)).rejects.toMatchObject({
    code: 'RUN_WORKSPACE_CUSTODY_CONFLICT', reason: 'adapter-version-mismatch',
  });
  expect(await reopened.loadRunWorkspaceCustody('s', 'r')).toEqual(candidate());
  expect(await reopened.resolveRunWorkspaceCustody(candidate())).toEqual(candidate());
});
