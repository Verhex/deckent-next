import type { DatabaseSync } from 'node:sqlite';
import { integrationAdoptionIntentSchema } from '#engine/index.js';

type Json = Record<string, unknown>;
const object = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);
/** The exact v1 adopt record the v41 build wrote (B06-1): these keys only, the command at schema 1 without verification fields. */
const V1_ADOPT_KEYS = 'schemaVersion,kind,command,targetRef,fromCommit,toCommit,deliveryRef,basis,acceptance,actor';
const V1_COMMAND_KEYS = 'schemaVersion,commandId,identity,deliveryCommandId,targetRef';

/** v1 adopt record → its lossless v2 form (a v1 adoption is a v2 adoption without verification), or null when it is not an exact v1 record. */
function upgradedAdoption(text: string): string | null {
  let record: unknown;
  try { record = JSON.parse(text); } catch { return null; }
  if (!object(record) || record.schemaVersion !== 1 || record.kind !== 'adopt' || Object.keys(record).join(',') !== V1_ADOPT_KEYS) return null;
  const command = record.command;
  if (!object(command) || command.schemaVersion !== 1 || Object.keys(command).join(',') !== V1_COMMAND_KEYS) return null;
  const parsed = integrationAdoptionIntentSchema.safeParse({ ...record, schemaVersion: 2, command: { ...command, schemaVersion: 2 }, verification: null });
  return parsed.success ? JSON.stringify(parsed.data) : null;
}

/** B06-2b (owner: ledger v42). Adoption intents gain the verification binding (intent v2); the table is unchanged. Every exact v1 adopt
 * record whose columns agree with it is rewritten in the canonical v2 text the journal claims and finishes with, so a pre-upgrade
 * adoption replays, settles and rolls back with today's command. Rollback records are unchanged (schema 1). A record that is not an
 * exact v1 adoption is left byte for byte: it stays unreadable (ADOPTION_CORRUPT) as before, and one bad record never blocks the
 * upgrade. The service-start upgrade has already written the versioned backup; this runs in the single migration transaction. */
export function migrateAdoptionVerification(db: DatabaseSync): void {
  const rows = db.prepare("SELECT scope_id,command_id,target_ref,intent FROM workspace_adoptions WHERE kind='adopt'").all();
  const update = db.prepare('UPDATE workspace_adoptions SET intent=? WHERE scope_id=? AND command_id=? AND intent=?');
  for (const row of rows) {
    const text = upgradedAdoption(String(row.intent));
    if (text === null) continue;
    const intent = JSON.parse(text) as { command: { commandId: string; identity: { scopeId: string } }; targetRef: string };
    if (intent.command.identity.scopeId !== row.scope_id || intent.command.commandId !== row.command_id || intent.targetRef !== row.target_ref) continue;
    update.run(text, String(row.scope_id), String(row.command_id), String(row.intent));
  }
}
