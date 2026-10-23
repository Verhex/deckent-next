import { createRequire } from 'node:module';
import { identitySchema } from '#domain/index.js';
import { MemoryJournalError, memoryExtractionSourceOf } from '#engine/index.js';
import { readAcceptedTaskMetrics, readRunAcceptanceEvaluations, requireLedgerVersion, MEMORY_AUTOMATION_LEDGER_VERSION, type SqliteLedgerOptions } from '#adapters/core/sqlite-ledger/index.js';
import { openSqliteInventoryReader } from '#adapters/core/attempt-store/index.js';

type Describe = { workClass(classId: string | null): Parameters<typeof memoryExtractionSourceOf>[0]['workClass']; readonly workTargetId: string | null };
/**
 * S4B-1: the memory distiller's page, read-only — current accepted Task rows after the row position, each turned into a sealed source (its Run,
 * its canonical evaluation, whether its Attempt left a claimed or unknown effect). A row whose Run or evaluation is gone yields `null` (passed
 * over, never invented). Positions are the metric rows' own; nothing is written here.
 */
export async function readMemoryExtractionPage(path: string, options: Pick<SqliteLedgerOptions, 'busyTimeoutMs'>, scopeId: string, after: string | null, limit: number, describe: Describe) {
  const scope = identitySchema.parse(scopeId);
  if (after !== null && !/^\d+$/u.test(after)) throw new MemoryJournalError('MEMORY_CORRUPT');
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
  const db = new DatabaseSync(path, { readOnly: true, timeout: options.busyTimeoutMs }), runs = await openSqliteInventoryReader(path, { busyTimeoutMs: options.busyTimeoutMs });
  try {
    requireLedgerVersion(db, MEMORY_AUTOMATION_LEDGER_VERSION);
    const unsettled = db.prepare(`SELECT 1 FROM effect_intents WHERE scope_id=? AND json_extract(record,'$.intent.producer.identity.attemptId')=? AND state IN('claimed','unknown') LIMIT 1`);
    const out: { position: string; source: ReturnType<typeof memoryExtractionSourceOf> }[] = [];
    for (const row of readAcceptedTaskMetrics(db, scope, after === null ? 0 : Number(after), limit)) {
      const run = await runs.loadRun(scope, row.metric.identity.runId), attemptId = row.metric.identity.attemptId;
      out.push({ position: String(row.position), source: run && memoryExtractionSourceOf({ run, attemptId, evaluations: readRunAcceptanceEvaluations(db, run),
        unsettledEffects: unsettled.get(scope, attemptId) !== undefined, workClass: describe.workClass(row.metric.workClass), workTargetId: describe.workTargetId }) });
    }
    return out;
  } finally { db.close(); runs.close(); }
}
