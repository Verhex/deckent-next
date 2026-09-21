import { CURRENT_LEDGER_VERSION } from '#adapters/core/sqlite-ledger/index.js';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { openSqliteAttemptStore } from '#adapters/index.js';
import { fixtureExecution } from '../support/execution-registry.js';
import { legacyRunEligibility } from '../support/legacy-run-eligibility.js';

const options = { busyTimeoutMs: 20, journalMode: 'wal' as const, durability: 'full' as const };

function createSchemaSeven(db: DatabaseSync) {
  db.exec(`CREATE TABLE attempts(scope_id TEXT NOT NULL, attempt_id TEXT NOT NULL, revision INTEGER NOT NULL, snapshot TEXT NOT NULL, PRIMARY KEY(scope_id, attempt_id));
    CREATE TABLE attempt_receipts(scope_id TEXT NOT NULL, command_id TEXT NOT NULL, command TEXT NOT NULL, snapshot TEXT NOT NULL, PRIMARY KEY(scope_id, command_id));
    CREATE TABLE dispatches(scope_id TEXT NOT NULL, attempt_id TEXT NOT NULL, record TEXT NOT NULL, PRIMARY KEY(scope_id, attempt_id));
    CREATE TABLE runs(scope_id TEXT NOT NULL, run_id TEXT NOT NULL, revision INTEGER NOT NULL, snapshot TEXT NOT NULL, policy TEXT NOT NULL, PRIMARY KEY(scope_id,run_id));
    CREATE TABLE run_receipts(scope_id TEXT NOT NULL, command_id TEXT NOT NULL, command TEXT NOT NULL, snapshot TEXT NOT NULL, PRIMARY KEY(scope_id,command_id));
    CREATE TABLE execution_pools(pool_id TEXT PRIMARY KEY NOT NULL, policy TEXT NOT NULL);
    CREATE TABLE cancellation_deliveries(scope_id TEXT NOT NULL,attempt_id TEXT NOT NULL,record TEXT NOT NULL,PRIMARY KEY(scope_id,attempt_id)); DROP TABLE IF EXISTS workspace_integrations; DROP TABLE IF EXISTS workspace_deliveries; DROP TABLE IF EXISTS approval_outbox; DROP TABLE IF EXISTS approval_receipts; DROP TABLE IF EXISTS approvals; PRAGMA user_version=7;`);
}

const identity = Object.freeze({ runId: 'r', scopeId: 's', layoutRevision: 'l' });
const graph = Object.freeze({ schemaVersion: 2 as const, revision: 1, tasks: Object.freeze([{ id: 't', kind: 'fixture', dependencies: Object.freeze([]), acceptanceCriteria: Object.freeze(['verified']) }]),
  criterionDefinitions: Object.freeze([{ id: 'verified', version: 1, description: 'Verify fixture task', evaluator: { id: 'test-evaluator', version: 1 }, parameters: {} }]) });

function currentSnapshot() {
  return Object.freeze({ schemaVersion: 3 as const, identity, revision: 0, graph, execution: fixtureExecution(graph),
    progress: Object.freeze([{ taskId: 't', phase: 'pending' as const, unresolvedEffects: false,
      eligibility: Object.freeze({ kind: 'immediate' as const }) }]), bindings: Object.freeze([]), cancelRequested: false });
}
const policy = Object.freeze({ schemaVersion: 2 as const, poolId: 'fixture-pool',
  capacity: Object.freeze({ executionSlots: 1, inFlightSlots: 1 }), ordering: Object.freeze(['t']) });
function creation(snapshot = currentSnapshot()) { return { commandId: 'create', actor: { id: 'fixture', issuer: 'test', subject: 'service' },
  identity, graph, execution: snapshot.execution, now: 0, policy }; }

it('advances an empty version-seven ledger to current version fourteen', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deckent-registry-migration-')); const path = join(root, 'ledger.db');
  try {
    const db = new DatabaseSync(path); createSchemaSeven(db); db.close();
    const store = await openSqliteAttemptStore(path, options); store.close();
    const check = new DatabaseSync(path, { readOnly: true });
    try { expect(check.prepare('PRAGMA user_version').get()!.user_version).toBe(CURRENT_LEDGER_VERSION); } finally { check.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('rejects an old Run schema without fabricating execution evidence or changing bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deckent-registry-migration-')); const path = join(root, 'ledger.db');
  try {
    const legacy = { schemaVersion: 1, identity, revision: 0, graph, progress: [{ taskId: 't', phase: 'pending', unresolvedEffects: false, eligibleAt: 0 }], bindings: [], cancelRequested: false };
    const db = new DatabaseSync(path); createSchemaSeven(db);
    db.prepare('INSERT INTO runs(scope_id,run_id,revision,snapshot,policy) VALUES(?,?,?,?,?)').run('s', 'r', 0, JSON.stringify(legacy), '{}'); db.close();
    const before = await readFile(path);
    await expect(openSqliteAttemptStore(path, options)).rejects.toMatchObject({ code: 'LEDGER_MIGRATION_EVIDENCE_REQUIRED' });
    expect(await readFile(path)).toEqual(before);
    const check = new DatabaseSync(path, { readOnly: true });
    try { expect(check.prepare('PRAGMA user_version').get()!.user_version).toBe(7); } finally { check.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('accepts a complete current Run and create receipt with selected registry evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deckent-registry-migration-')); const path = join(root, 'ledger.db');
  try {
    const snapshot = currentSnapshot(), create = creation(snapshot), historical = legacyRunEligibility(snapshot, create);
    const command = JSON.stringify({ action: 'create-run', ...create }); const db = new DatabaseSync(path); createSchemaSeven(db);
    db.prepare('INSERT INTO runs(scope_id,run_id,revision,snapshot,policy) VALUES(?,?,?,?,?)')
      .run('s', 'r', 0, JSON.stringify(historical), JSON.stringify(policy));
    db.prepare('INSERT INTO run_receipts(scope_id,command_id,command,snapshot) VALUES(?,?,?,?)')
      .run('s', 'create', command, JSON.stringify(historical));
    db.close();
    const store = await openSqliteAttemptStore(path, options); expect(await store.loadRun('s', 'r')).toEqual(snapshot); store.close();
    const check = new DatabaseSync(path, { readOnly: true });
    try {
      expect(check.prepare('PRAGMA user_version').get()!.user_version).toBe(CURRENT_LEDGER_VERSION);
      expect(check.prepare('SELECT command FROM run_receipts WHERE scope_id=? AND command_id=?').get('s', 'create')!.command).toBe(command);
    } finally { check.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('rejects a current-shaped Run whose stored fingerprint does not match its criterion definition', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deckent-registry-migration-')); const path = join(root, 'ledger.db');
  try {
    const snapshot = currentSnapshot(); const tampered = { ...snapshot, execution: { ...snapshot.execution,
      criteria: snapshot.execution.criteria.map(entry => ({ ...entry, fingerprint: '0'.repeat(64) })) } };
    const db = new DatabaseSync(path); createSchemaSeven(db);
    db.prepare('INSERT INTO runs(scope_id,run_id,revision,snapshot,policy) VALUES(?,?,?,?,?)').run('s', 'r', 0, JSON.stringify(tampered), '{}'); db.close();
    const before = await readFile(path);
    await expect(openSqliteAttemptStore(path, options)).rejects.toMatchObject({ code: 'LEDGER_MIGRATION_EVIDENCE_REQUIRED' });
    expect(await readFile(path)).toEqual(before);
    const check = new DatabaseSync(path, { readOnly: true });
    try { expect(check.prepare('PRAGMA user_version').get()!.user_version).toBe(7); } finally { check.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});
