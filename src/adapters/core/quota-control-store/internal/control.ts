import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { releaseRunQuota, runSnapshotSchema } from '#domain/index.js';
import { AttemptStoreError, executionPoolSchema, runExecutionPolicySchema, quotaReleaseReceiptSchema, RunStoreError, type AuditStore, type QuotaReleaseWrite } from '#engine/index.js';
import { SqliteAuditStore } from '#adapters/core/audit-store/index.js';
import { sqliteFailure } from '#adapters/core/sqlite-ledger/index.js';

const recordSchema = z.object({ fingerprint: z.string(), receipt: quotaReleaseReceiptSchema }).strict();
type ReleaseInput = Omit<QuotaReleaseWrite, 'authorizedPoolIds'>;
function priorReceipt(db: DatabaseSync, write: ReleaseInput) {
  const prior = db.prepare('SELECT record FROM quota_release_receipts WHERE scope_id=? AND command_id=?').get(write.command.scopeId, write.command.commandId);
  if (!prior) return null;
  let raw; try { raw = JSON.parse(String(prior.record)); } catch { throw new RunStoreError('RUN_STORE_CORRUPT'); }
  // Historical receipts cannot prove which pools were authorized. Never infer their effect scope from today's waits.
  if (raw?.receipt?.poolIds === undefined) throw new RunStoreError('RUN_COMMAND_CONFLICT');
  let record; try { record = recordSchema.parse(raw); } catch { throw new RunStoreError('RUN_STORE_CORRUPT'); }
  if (record.fingerprint !== JSON.stringify({ command: write.command, actor: write.actor })) throw new RunStoreError('RUN_COMMAND_CONFLICT');
  return record.receipt;
}
function affectedRuns(db: DatabaseSync, write: ReleaseInput) {
  return db.prepare(`SELECT DISTINCT r.scope_id,r.run_id,r.snapshot,r.policy FROM run_quota_waits q
    JOIN runs r ON r.scope_id=q.scope_id AND r.run_id=q.run_id
    WHERE q.channel_id=? AND q.deadline_ms>? AND q.released_at_ms IS NULL`).all(write.command.channelId, write.atMs).map(row => {
    let run; try { run = runSnapshotSchema.parse(JSON.parse(String(row.snapshot))); } catch { throw new RunStoreError('RUN_STORE_CORRUPT'); }
    let policy; try { policy = runExecutionPolicySchema.parse(JSON.parse(String(row.policy))); } catch { throw new RunStoreError('RUN_STORE_CORRUPT'); }
    if (run.identity.scopeId !== row.scope_id || run.identity.runId !== row.run_id) throw new RunStoreError('RUN_STORE_CORRUPT');
    return { run, poolId: policy.poolId };
  });
}
/** Advisory authority scope; the writer re-reads it under BEGIN IMMEDIATE and refuses any unauthorized pool before its first write. */
export function loadQuotaReleasePools(db: DatabaseSync, write: ReleaseInput): readonly string[] {
  try { return priorReceipt(db, write)?.poolIds ?? [...new Set(affectedRuns(db, write).map(item => item.poolId))].sort(); }
  catch (error) { throw sqliteFailure(error); }
}
/** Indexed active waits, authoritative Run snapshots and sealed audit/receipt commit together; no synthetic reset signal. */
export function releaseQuota(db: DatabaseSync, write: QuotaReleaseWrite, audit: (store: AuditStore, released: number, poolIds: readonly string[]) => void) {
  let active = false;
  try {
    db.exec('BEGIN IMMEDIATE'); active = true;
    const { command, actor, atMs } = write, fingerprint = JSON.stringify({ command, actor });
    const prior = priorReceipt(db, write);
    if (prior) {
      if (prior.poolIds.some(id => !write.authorizedPoolIds.includes(id))) throw new RunStoreError('RUN_STORE_CONFLICT');
      db.exec('COMMIT'); active = false; return prior;
    }
    const pool = db.prepare('SELECT policy FROM execution_pools WHERE pool_id=?').get(command.poolId);
    if (!pool) throw new RunStoreError('RUN_POOL_REQUIRED');
    try { if (executionPoolSchema.parse(JSON.parse(String(pool.policy))).poolId !== command.poolId) throw new Error(); }
    catch { throw new RunStoreError('RUN_STORE_CORRUPT'); }
    const runs = affectedRuns(db, write), poolIds = [...new Set(runs.map(item => item.poolId))].sort();
    // CAS on the authorized resource set: waits added on a new pool during asynchronous policy checks require a new command attempt.
    if (poolIds.some(id => !write.authorizedPoolIds.includes(id))) throw new RunStoreError('RUN_STORE_CONFLICT');
    let released = 0;
    for (const { run } of runs) {
      const next = releaseRunQuota(run, command.channelId, atMs);
      if (!next) throw new RunStoreError('RUN_STORE_CORRUPT');
      released += next.quotaWaits!.filter(wait => wait.channelId === command.channelId && wait.releasedAtMs === atMs
        && run.quotaWaits!.some(old => old.identity.attemptId === wait.identity.attemptId && old.releasedAtMs === undefined)).length;
      const changed = db.prepare('UPDATE runs SET revision=?,snapshot=? WHERE scope_id=? AND run_id=? AND revision=?')
        .run(next.revision, JSON.stringify(next), run.identity.scopeId, run.identity.runId, run.revision);
      if (changed.changes !== 1) throw new RunStoreError('RUN_STORE_CONFLICT');
    }
    const receipt = quotaReleaseReceiptSchema.parse({ ...command, poolIds, released, atMs });
    db.prepare('INSERT INTO quota_release_receipts(scope_id,command_id,record) VALUES(?,?,?)')
      .run(command.scopeId, command.commandId, JSON.stringify({ fingerprint, receipt }));
    audit(new SqliteAuditStore(db), released, poolIds);
    db.exec('COMMIT'); active = false; return receipt;
  } catch (error) {
    if (active) { try { db.exec('ROLLBACK'); } catch { throw new AttemptStoreError('ATTEMPT_STORE_OUTCOME_UNKNOWN'); } }
    throw sqliteFailure(error);
  }
}
