import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { releaseWorkerCustody } from '#domain/index.js';
import { openSqliteAttemptStore, openSqliteInventoryReader, readMonitorLedger } from '#adapters/index.js';
import { recordAcceptanceMetric } from '#adapters/core/sqlite-ledger/index.js';
import { identity } from '../domain/acceptance-fixture.js';
import { lostWorker } from '../domain/worker-custody-fixture.js';

it('old Run bytes read unchanged and held; persisted release survives reopen with no acceptance, metric or new Attempt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deckent-custody-read-')), path = join(root, 'ledger.db');
  const f = lostWorker(), oldBytes = JSON.stringify(f.run);
  const journal = await openSqliteAttemptStore(path, { busyTimeoutMs: 1000, journalMode: 'delete', durability: 'full' }, { now: () => 100, timeoutMs: 1000 });
  journal.close(); const db = new DatabaseSync(path);
  const read = async () => {
    const reader = await openSqliteInventoryReader(path, { busyTimeoutMs: 1000 });
    try { return { run: await reader.loadRun(identity.scopeId, identity.runId), evidence: await reader.loadRunPoolEvidence(identity.scopeId, identity.runId) }; }
    finally { reader.close(); }
  };
  const counts = () => Object.fromEntries(['attempts', 'run_receipts', 'task_evaluation_observations', 'acceptance_metrics']
    .map(table => [table, db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n]));
  try {
    db.prepare('INSERT INTO execution_pools VALUES(?,?)').run('pool', JSON.stringify({ schemaVersion: 1, poolId: 'pool', capacity: { executionSlots: 1, inFlightSlots: 1 } }));
    db.prepare('INSERT INTO runs VALUES(?,?,?,?,?)').run(identity.scopeId, identity.runId, f.run.revision, oldBytes,
      JSON.stringify({ schemaVersion: 2, poolId: 'pool', capacity: { executionSlots: 1, inFlightSlots: 1 }, ordering: f.run.graph.tasks.map(task => task.id) }));
    db.prepare('INSERT INTO attempts VALUES(?,?,?,?)').run(identity.scopeId, identity.attemptId, f.attempt.revision, JSON.stringify(f.attempt));
    const old = await read(); expect(JSON.stringify(old.run)).toBe(oldBytes);
    expect(old.evidence.pool?.occupancy).toEqual({ execution: 1, inFlight: 1 });
    expect(db.prepare('SELECT snapshot FROM runs').get()!.snapshot).toBe(oldBytes);
    const before = counts(), changes = db.prepare('SELECT total_changes() AS n').get()!.n;
    const released = releaseWorkerCustody(old.run, f.run.revision, f.record, f.fence, f.proof);
    expect(db.prepare('SELECT total_changes() AS n').get()!.n).toBe(changes);
    expect(counts()).toEqual(before);
    // Persist only the approved reducer snapshot as a fixture; the K10 audited release transaction is a separate lane.
    db.prepare('UPDATE runs SET revision=?,snapshot=?').run(released.revision, JSON.stringify(released));
    db.prepare('INSERT INTO run_receipts VALUES(?,?,?,?)').run(identity.scopeId, 'release-fixture', JSON.stringify({ action: 'release-worker-custody' }), JSON.stringify(released));
    recordAcceptanceMetric(db, 'release-fixture', released);
    const reopened = await read(); expect(reopened.run).toEqual(released);
    expect(reopened.evidence.pool?.occupancy).toEqual({ execution: 0, inFlight: 0 });
    expect(counts()).toEqual({ ...before, run_receipts: 1 });
    expect(db.prepare('SELECT snapshot FROM attempts').get()!.snapshot).toBe(JSON.stringify(f.attempt));
    const monitor = await readMonitorLedger(path, { busyTimeoutMs: 1000, maxRuns: 10 });
    expect(monitor.diagnostics).toEqual([]); expect(monitor.pools[0]).toMatchObject({ execution: 0, inFlight: 0 });
    expect(monitor.runs[0]!.snapshot.progress[0]).toMatchObject({ phase: 'reconciling', unresolvedEffects: true });
  } finally { db.close(); await rm(root, { recursive: true, force: true }); }
});
