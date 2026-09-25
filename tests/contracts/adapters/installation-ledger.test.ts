import { CURRENT_LEDGER_VERSION } from '#adapters/core/sqlite-ledger/index.js';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { initializeInstallationLedger, verifyInstallationLedger } from '../../../src/adapters/core/attempt-store/index.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const options = { busyTimeoutMs: 100, journalMode: 'delete' as const, durability: 'full' as const };
const digest = (char: string) => char.repeat(64);
const ownership = { schemaVersion: 1 as const, transactionId: 'tx-1', planDigest: digest('a'), profileDigest: digest('b'), proposalDigest: digest('c') };
const pool = { schemaVersion: 1 as const, poolId: 'pool-1', capacity: { executionSlots: 2, inFlightSlots: 3 } };
async function path() { const root = await mkdtemp(join(tmpdir(), 'installation-ledger-')); roots.push(root); return join(root, 'ledger.db'); }

it('atomically initializes schema ownership and pool, then replays the exact transaction', async () => {
  const file = await path();
  await expect(initializeInstallationLedger(file, options, ownership, pool)).resolves.toEqual({ ownership, pool });
  await expect(initializeInstallationLedger(file, options, ownership, pool)).resolves.toEqual({ ownership, pool });
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(CURRENT_LEDGER_VERSION);
    expect(db.prepare('SELECT count(*) AS count FROM installation_ownership').get()?.count).toBe(1);
    expect(db.prepare('SELECT policy FROM execution_pools').get()?.policy).toBe(JSON.stringify(pool));
  } finally { db.close(); }
});

it('rejects foreign transactions, markerless current ledgers, and nonempty schema-zero databases', async () => {
  const initialized = await path(); await initializeInstallationLedger(initialized, options, ownership, pool);
  await expect(initializeInstallationLedger(initialized, options, { ...ownership, transactionId: 'tx-2' }, pool))
    .rejects.toMatchObject({ code: 'INSTALLATION_LEDGER_CONFLICT' });
  const markerless = await path(); const current = new DatabaseSync(markerless); current.exec('DROP TABLE IF EXISTS workspace_integrations; DROP TABLE IF EXISTS workspace_deliveries; DROP TABLE IF EXISTS workspace_adoptions; DROP TABLE IF EXISTS effect_intents; DROP TABLE IF EXISTS agent_turn_tool_calls; DROP TABLE IF EXISTS agent_turns; DROP TABLE IF EXISTS worker_event_logs; DROP TABLE IF EXISTS approval_outbox; DROP TABLE IF EXISTS approval_receipts; DROP TABLE IF EXISTS approvals; PRAGMA user_version=11'); current.close();
  await expect(initializeInstallationLedger(markerless, options, ownership, pool)).rejects.toMatchObject({ code: 'INSTALLATION_LEDGER_CONFLICT' });
  const nonempty = await path(); const foreign = new DatabaseSync(nonempty); foreign.exec('CREATE TABLE foreign_data(value TEXT)'); foreign.close();
  const foreignBytes = await readFile(nonempty);
  await expect(initializeInstallationLedger(nonempty, { ...options, journalMode: 'wal' }, ownership, pool)).rejects.toMatchObject({ code: 'INSTALLATION_LEDGER_CONFLICT' });
  expect(await readFile(nonempty)).toEqual(foreignBytes);
  const reopened = new DatabaseSync(nonempty); try { expect(reopened.prepare('PRAGMA journal_mode').get()?.journal_mode).toBe('delete'); } finally { reopened.close(); }
  const missingPool = await path(); await initializeInstallationLedger(missingPool, options, ownership, pool);
  const damaged = new DatabaseSync(missingPool); damaged.exec('DELETE FROM execution_pools'); damaged.close();
  await expect(initializeInstallationLedger(missingPool, options, ownership, pool)).rejects.toMatchObject({ code: 'INSTALLATION_LEDGER_CONFLICT' });
});

it('rejects accessor-bearing inputs without invoking them or creating a database', async () => {
  const file = await path(); let invoked = false;
  const hostile = Object.defineProperty({}, 'schemaVersion', { enumerable: true, get() { invoked = true; return 1; } });
  await expect(initializeInstallationLedger(file, options, hostile, pool)).rejects.toMatchObject({ code: 'INSTALLATION_LEDGER_INVALID' });
  expect(invoked).toBe(false);
  await expect(readFile(file)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('claims a pristine crash-residue file and leaves invalid input unmodified', async () => {
  const empty = await path(); await writeFile(empty, '');
  await expect(initializeInstallationLedger(empty, options, ownership, pool)).resolves.toEqual({ ownership, pool });
  const failed = await path();
  await expect(initializeInstallationLedger(failed, options, ownership, { ...pool, poolId: '' }))
    .rejects.toMatchObject({ code: 'INSTALLATION_LEDGER_INVALID' });
  const db = new DatabaseSync(failed);
  try { expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(0); expect(db.prepare("SELECT count(*) AS count FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").get()?.count).toBe(0); }
  finally { db.close(); }
});

it('verifies exact ownership and pool without changing database bytes or mode', async () => {
  const file = await path(); await initializeInstallationLedger(file, options, ownership, pool);
  const before = await readFile(file);
  await expect(verifyInstallationLedger(file, ownership, pool)).resolves.toEqual({ ownership, pool });
  expect(await readFile(file)).toEqual(before);
  const db = new DatabaseSync(file); try { expect(db.prepare('PRAGMA journal_mode').get()?.journal_mode).toBe('delete'); } finally { db.close(); }
  await expect(verifyInstallationLedger(file, { ...ownership, proposalDigest: digest('d') }, pool))
    .rejects.toMatchObject({ code: 'INSTALLATION_LEDGER_CONFLICT' });
});

it('does not create a missing verification path and rejects a missing pool', async () => {
  const missing = await path();
  await expect(verifyInstallationLedger(missing, ownership, pool)).rejects.toMatchObject({ code: 'INSTALLATION_LEDGER_UNAVAILABLE' });
  await expect(readFile(missing)).rejects.toMatchObject({ code: 'ENOENT' });
  const file = await path(); await initializeInstallationLedger(file, options, ownership, pool);
  const db = new DatabaseSync(file); db.exec('DELETE FROM execution_pools'); db.close();
  await expect(verifyInstallationLedger(file, ownership, pool)).rejects.toMatchObject({ code: 'INSTALLATION_LEDGER_CONFLICT' });
});
