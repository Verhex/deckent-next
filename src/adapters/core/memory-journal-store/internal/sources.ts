import { createRequire } from 'node:module';
import { identitySchema } from '#domain/index.js';
import { MemoryJournalError, memoryEvaluationSourceOf, memoryExtractionSourceOf, type MemoryEvaluationSources } from '#engine/index.js';
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
/**
 * S4B-3 §6.3: the evaluator's sealed sources, read-only, one connection for a pass: the Run snapshot, its canonical evaluations and whether the
 * Attempt left a claimed or unknown effect. `mayRead` is the evaluator's own `run`/`inspect` decision (V4); refused or gone: null (fail closed).
 */
export async function openMemoryEvaluationSourceReader(path: string, options: Pick<SqliteLedgerOptions, 'busyTimeoutMs'>, makerOf: (channelId: string, modelId: string) => string | null,
  mayRead: (runId: string) => boolean): Promise<MemoryEvaluationSources & { close(): void }> {
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
  const db = new DatabaseSync(path, { readOnly: true, timeout: options.busyTimeoutMs });
  try { requireLedgerVersion(db, MEMORY_AUTOMATION_LEDGER_VERSION); } catch (error) { db.close(); throw error; }
  const runs = await openSqliteInventoryReader(path, { busyTimeoutMs: options.busyTimeoutMs }).catch(error => { db.close(); throw error; });
  const unsettled = db.prepare(`SELECT 1 FROM effect_intents WHERE scope_id=? AND json_extract(record,'$.intent.producer.identity.attemptId')=? AND state IN('claimed','unknown') LIMIT 1`);
  return Object.freeze({ async source(scopeId: string, attempt: { readonly runId: string; readonly attemptId: string }) {
    const run = mayRead(attempt.runId) ? await runs.loadRun(scopeId, attempt.runId) : null;
    return run && memoryEvaluationSourceOf({ run, attemptId: attempt.attemptId, evaluations: readRunAcceptanceEvaluations(db, run),
      unsettledEffects: unsettled.get(scopeId, attempt.attemptId) !== undefined, makerOf });
  }, close() { db.close(); runs.close(); } });
}
