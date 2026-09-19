import type { DatabaseSync } from 'node:sqlite';
import { runSnapshotSchema } from '#domain/index.js';
import { runCreateSchema } from '#engine/index.js';

/** Builds a genuine pre-v12 fixture. Runtime code never accepts this historical shape. */
export function legacyRunEligibility(snapshotInput: unknown, creationInput: unknown) {
  const snapshot = runSnapshotSchema.parse(snapshotInput), creation = runCreateSchema.parse(creationInput);
  if (snapshot.identity.scopeId !== creation.identity.scopeId || snapshot.identity.runId !== creation.identity.runId
    || JSON.stringify(snapshot.graph) !== JSON.stringify(creation.graph)
    || JSON.stringify(snapshot.execution) !== JSON.stringify(creation.execution)
    || snapshot.progress.some(progress => progress.eligibility.kind !== 'immediate')) throw new Error('INVALID_LEGACY_RUN_FIXTURE');
  return { ...snapshot, schemaVersion: 2 as const, progress: snapshot.progress.map(progress => ({
    taskId: progress.taskId, phase: progress.phase, unresolvedEffects: progress.unresolvedEffects, eligibleAt: creation.now,
  })) };
}

/** Converts test-created current rows and receipt snapshots while preserving command bytes. */
export function downgradeRunEligibilityFixtures(db: DatabaseSync): void {
  for (const row of db.prepare('SELECT scope_id,run_id,snapshot FROM runs').all()) {
    const receipts = db.prepare(`SELECT command FROM run_receipts WHERE scope_id=?
      AND json_extract(command,'$.action')='create-run' AND json_extract(command,'$.identity.runId')=?`)
      .all(String(row.scope_id), String(row.run_id));
    if (receipts.length !== 1) throw new Error('INVALID_LEGACY_RUN_FIXTURE');
    const { action, ...creation } = JSON.parse(String(receipts[0]!.command)) as Record<string, unknown>;
    if (action !== 'create-run') throw new Error('INVALID_LEGACY_RUN_FIXTURE');
    const parsed = runCreateSchema.parse(creation);
    db.prepare('UPDATE runs SET snapshot=? WHERE scope_id=? AND run_id=?')
      .run(JSON.stringify(legacyRunEligibility(JSON.parse(String(row.snapshot)), parsed)), String(row.scope_id), String(row.run_id));
    for (const receipt of db.prepare(`SELECT command_id,snapshot FROM run_receipts WHERE scope_id=?
      AND json_extract(snapshot,'$.identity.runId')=?`).all(String(row.scope_id), String(row.run_id))) {
      db.prepare('UPDATE run_receipts SET snapshot=? WHERE scope_id=? AND command_id=?')
        .run(JSON.stringify(legacyRunEligibility(JSON.parse(String(receipt.snapshot)), parsed)), String(row.scope_id), String(receipt.command_id));
    }
  }
}
