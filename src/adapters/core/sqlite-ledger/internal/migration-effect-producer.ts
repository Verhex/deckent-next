import type { DatabaseSync } from 'node:sqlite';
/**
 * S6R-1 effect-producer index. LEDGER NUMBER NOT ASSIGNED: s1 is this wave's migration writer; the lead assigns the version at landing and
 * wires this step into `migrateLedger` (code step + CURRENT_LEDGER_VERSION) then. Until then no ledger runs it and nothing depends on it:
 * the producer lives in the intent record (`$.intent.producer`), this index only serves the recovery gate's lookup by Attempt (S6R-4).
 * Older rows have no producer and index as NULL (the fail-closed window rule reads them). Additive: no row is rewritten. The caller owns
 * BEGIN IMMEDIATE; an existing index is refused, never adopted.
 */
export function migrateEffectProducerIndex(db: DatabaseSync): void {
  db.exec(`CREATE INDEX effect_intents_producer_attempt ON effect_intents(scope_id,json_extract(record,'$.intent.producer.identity.attemptId'))`);
}
/** The down step of the same migration (rollback to the previous ledger version drops only this index). */
export function revertEffectProducerIndex(db: DatabaseSync): void { db.exec('DROP INDEX effect_intents_producer_attempt'); }
