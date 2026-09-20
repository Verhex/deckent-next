import { createImmutableJsonObjectSchema, MODEL_INVOCATION_RECEIPT_JSON_LIMITS } from '#domain/index.js';
import { AttemptStoreError, verifyModelInvocationReceipt, createModelInvocationResponseRecord,
  createModelInvocationEvidenceRecord, createModelInvocationUnknownRecord,
  type ModelInvocationRecord } from '#engine/index.js';

function invalid(): never { throw new AttemptStoreError('LEDGER_MIGRATION_EVIDENCE_REQUIRED'); }
function object(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return invalid();
  return input as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, keys: readonly string[]): void {
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) invalid();
}
/** Historical receipt2 exists only during migration; no runtime compatibility parser. */
export function migrateInvocationReceiptContent(input: unknown): ModelInvocationRecord {
  try {
    const old = object(createImmutableJsonObjectSchema(MODEL_INVOCATION_RECEIPT_JSON_LIMITS).parse(input));
    if (old.schemaVersion !== 2) return invalid();
    const base = verifyModelInvocationReceipt({ ...old, schemaVersion: 3, outcome: null });
    if (old.outcome === null) return Object.freeze({ receipt: base, content: null, purge: null });
    const outcome = object(old.outcome);
    if (outcome.schemaVersion !== 2 || !Number.isSafeInteger(outcome.observedAtMs) || Number(outcome.observedAtMs) < 0) return invalid();
    const observedAtMs = Number(outcome.observedAtMs);
    if (outcome.state === 'responded') {
      exact(outcome, ['schemaVersion', 'state', 'response', 'observedAtMs']);
      return createModelInvocationResponseRecord(base, outcome.response, observedAtMs);
    }
    if (outcome.state === 'unknown') {
      exact(outcome, ['schemaVersion', 'state', 'reason', 'evidence', 'observedAtMs']);
      if (outcome.reason !== 'transport-error') return invalid();
      if (outcome.evidence === null) return createModelInvocationUnknownRecord(base, observedAtMs);
    } else if (outcome.state === 'rejected') {
      exact(outcome, ['schemaVersion', 'state', 'evidence', 'observedAtMs']);
    } else return invalid();
    const converted = createModelInvocationEvidenceRecord(base, outcome.evidence, observedAtMs);
    if (converted.receipt.outcome?.state !== outcome.state) return invalid();
    return converted;
  } catch { return invalid(); }
}
