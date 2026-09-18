import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { openSqliteAttemptStore } from '#adapters/index.js';
import { admitRunAttempts } from '../support/admission.js';

const options = { busyTimeoutMs: 20, journalMode: 'wal' as const, durability: 'full' as const };

function createSchemaFour(db: DatabaseSync) {
  db.exec(`CREATE TABLE attempts(scope_id TEXT NOT NULL, attempt_id TEXT NOT NULL, revision INTEGER NOT NULL, snapshot TEXT NOT NULL, PRIMARY KEY(scope_id, attempt_id));
    CREATE TABLE attempt_receipts(scope_id TEXT NOT NULL, command_id TEXT NOT NULL, command TEXT NOT NULL, snapshot TEXT NOT NULL, PRIMARY KEY(scope_id, command_id));
    CREATE TABLE dispatches(scope_id TEXT NOT NULL, attempt_id TEXT NOT NULL, record TEXT NOT NULL, PRIMARY KEY(scope_id, attempt_id));
    CREATE TABLE runs(scope_id TEXT NOT NULL, run_id TEXT NOT NULL, revision INTEGER NOT NULL, snapshot TEXT NOT NULL, policy TEXT NOT NULL, PRIMARY KEY(scope_id,run_id));
    CREATE TABLE run_receipts(scope_id TEXT NOT NULL, command_id TEXT NOT NULL, command TEXT NOT NULL, snapshot TEXT NOT NULL, PRIMARY KEY(scope_id,command_id));
    CREATE TABLE execution_pools(pool_id TEXT PRIMARY KEY NOT NULL, policy TEXT NOT NULL); PRAGMA user_version=4;`);
}
it('rolls all earlier migration steps back when a later DDL step fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deckent-schema-')); const path = join(root, 'ledger.db');
  try {
    const setup = new DatabaseSync(path);
    setup.exec('CREATE TABLE execution_pools(marker TEXT); INSERT INTO execution_pools VALUES (\'preserve\');'); setup.close();
    await expect(openSqliteAttemptStore(path, options)).rejects.toThrow();
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      expect(db.prepare('PRAGMA user_version').get()!.user_version).toBe(0);
      expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(row => row.name)).toEqual(['execution_pools']);
      expect(db.prepare('SELECT marker FROM execution_pools').get()!.marker).toBe('preserve');
    } finally { db.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('advances an empty schema-four ledger to five', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deckent-schema-v5-')); const path = join(root, 'ledger.db');
  try {
    const setup = new DatabaseSync(path); createSchemaFour(setup); setup.close();
    const store = await openSqliteAttemptStore(path, options); store.close();
    const db = new DatabaseSync(path, { readOnly: true });
    try { expect(db.prepare('PRAGMA user_version').get()!.user_version).toBe(5); } finally { db.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('advances a populated current Run ledger after its version is marked four', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deckent-schema-v5-')); const path = join(root, 'ledger.db');
  try {
    const store = await openSqliteAttemptStore(path, options);
    await admitRunAttempts(store, [{ scopeId: 's', runId: 'r', taskId: 't', attemptId: 'a', layoutRevision: 'l', generation: 1 }]);
    store.close();
    const downgrade = new DatabaseSync(path); downgrade.exec('PRAGMA user_version=4'); downgrade.close();
    const migrated = await openSqliteAttemptStore(path, options); expect((await migrated.loadRun('s', 'r'))!.revision).toBe(1); migrated.close();
    const db = new DatabaseSync(path, { readOnly: true });
    try { expect(db.prepare('PRAGMA user_version').get()!.user_version).toBe(5); } finally { db.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('requires a reset instead of inventing profile or launch evidence for a schema-four dispatch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deckent-schema-v5-')); const path = join(root, 'ledger.db');
  try {
    const setup = new DatabaseSync(path); createSchemaFour(setup);
    const legacy = { schemaVersion: 1, request: { protocolVersion: 1, identity: { runId: 'r', taskId: 't', attemptId: 'a', scopeId: 's', layoutRevision: 'l', generation: 1 }, workspace: '/workspace', argv: ['task'] }, owner: 'owner', terminal: null };
    setup.prepare('INSERT INTO dispatches(scope_id,attempt_id,record) VALUES(?,?,?)').run('s', 'a', JSON.stringify(legacy)); setup.close();
    await expect(openSqliteAttemptStore(path, options)).rejects.toMatchObject({ code: 'LEDGER_RESET_REQUIRED' });
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      expect(db.prepare('PRAGMA user_version').get()!.user_version).toBe(4);
      expect(db.prepare('SELECT record FROM dispatches').get()!.record).toBe(JSON.stringify(legacy));
    } finally { db.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('requires a reset when criterion definitions exist but do not cover a receipt graph', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deckent-schema-v5-')); const path = join(root, 'ledger.db');
  try {
    const setup = new DatabaseSync(path); createSchemaFour(setup);
    const graph = { schemaVersion: 2, revision: 1, tasks: [{ id: 't', kind: 'custom', dependencies: [], acceptanceCriteria: ['verified'] }],
      criterionDefinitions: [{ id: 'declared', version: 1, description: 'Declared criterion', evaluator: { id: 'test-evaluator', version: 1 }, parameters: {} }] };
    const identity = { scopeId: 's', runId: 'r', layoutRevision: 'l' };
    const snapshot = { schemaVersion: 1, identity, revision: 0, graph, progress: [{ taskId: 't', phase: 'pending', unresolvedEffects: false, eligibleAt: 0 }], bindings: [], cancelRequested: false };
    setup.prepare('INSERT INTO runs(scope_id,run_id,revision,snapshot,policy) VALUES(?,?,?,?,?)').run('s', 'r', 0, JSON.stringify(snapshot), '{}');
    setup.prepare('INSERT INTO run_receipts(scope_id,command_id,command,snapshot) VALUES(?,?,?,?)')
      .run('s', 'create', JSON.stringify({ action: 'create-run', commandId: 'create', actor: { id: 'operator', issuer: 'test', subject: '1' }, identity, graph, now: 0,
        policy: { schemaVersion: 2, poolId: 'pool', capacity: { executionSlots: 1, inFlightSlots: 1 }, ordering: ['t'] } }), JSON.stringify(snapshot)); setup.close();
    await expect(openSqliteAttemptStore(path, options)).rejects.toMatchObject({ code: 'LEDGER_RESET_REQUIRED' });
    const db = new DatabaseSync(path, { readOnly: true });
    try { expect(db.prepare('PRAGMA user_version').get()!.user_version).toBe(4); } finally { db.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('requires a reset when a full Run snapshot violates its progress and binding invariants', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deckent-schema-v5-')); const path = join(root, 'ledger.db');
  try {
    const setup = new DatabaseSync(path); createSchemaFour(setup);
    const graph = { schemaVersion: 2, revision: 1, tasks: [{ id: 't', kind: 'custom', dependencies: [], acceptanceCriteria: ['verified'] }],
      criterionDefinitions: [{ id: 'verified', version: 1, description: 'Verified result', evaluator: { id: 'test-evaluator', version: 1 }, parameters: {} }] };
    const snapshot = { schemaVersion: 1, identity: { scopeId: 's', runId: 'r', layoutRevision: 'l' }, revision: 0, graph,
      progress: [{ taskId: 't', phase: 'active', unresolvedEffects: false, eligibleAt: 0 }], bindings: [], cancelRequested: false };
    setup.prepare('INSERT INTO runs(scope_id,run_id,revision,snapshot,policy) VALUES(?,?,?,?,?)').run('s', 'r', 0, JSON.stringify(snapshot), '{}'); setup.close();
    await expect(openSqliteAttemptStore(path, options)).rejects.toMatchObject({ code: 'LEDGER_RESET_REQUIRED' });
    const db = new DatabaseSync(path, { readOnly: true });
    try { expect(db.prepare('PRAGMA user_version').get()!.user_version).toBe(4); } finally { db.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('rolls back the v4-to-v5 migration when a Run row revision disagrees with its snapshot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deckent-schema-v5-')); const path = join(root, 'ledger.db');
  try {
    const store = await openSqliteAttemptStore(path, options);
    await admitRunAttempts(store, [{ scopeId: 's', runId: 'r', taskId: 't', attemptId: 'a', layoutRevision: 'l', generation: 1 }]);
    store.close();
    const corrupt = new DatabaseSync(path); corrupt.exec('UPDATE runs SET revision=99; PRAGMA user_version=4'); corrupt.close();
    await expect(openSqliteAttemptStore(path, options)).rejects.toMatchObject({ code: 'LEDGER_RESET_REQUIRED' });
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      expect(db.prepare('PRAGMA user_version').get()!.user_version).toBe(4);
      expect(db.prepare('SELECT revision FROM runs').get()!.revision).toBe(99);
    } finally { db.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});
