import type { DatabaseSync } from 'node:sqlite';
/**
 * Ledger v63 (S6R-1 effect producer; after s1's v62 on a55/integrate). Every intent claimed from v63 on names its producer in the record
 * (`$.intent.producer`); this index serves the recovery gate's lookup by Attempt (S6R-4). Older rows have no producer and index as NULL (the
 * fail-closed window rule reads them). Additive: no row is read or rewritten. The caller owns BEGIN IMMEDIATE; an existing index is refused,
 * never adopted. Downgrade = restore the pre-switch backup (an older build refuses v63); `revertEffectProducerIndex` is the exact down step.
 */
export function migrateEffectProducerIndex(db: DatabaseSync): void {
  db.exec(`CREATE INDEX effect_intents_producer_attempt ON effect_intents(scope_id,json_extract(record,'$.intent.producer.identity.attemptId'))`);
}
/** The down step of the same migration (rollback to the previous ledger version drops only this index). */
export function revertEffectProducerIndex(db: DatabaseSync): void { db.exec('DROP INDEX effect_intents_producer_attempt'); }
