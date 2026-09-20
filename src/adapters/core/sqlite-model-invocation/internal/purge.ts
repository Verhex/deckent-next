import type { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import { ModelInvocationStoreError, verifyModelInvocationPurgeReceipt,
  type ModelInvocationPurgeAdmission, type ModelInvocationPurgeResult } from '#engine/index.js';
import { loadInvocationRecord } from './read.js';

function conflict(): never { throw new ModelInvocationStoreError('MODEL_INVOCATION_COMMAND_CONFLICT'); }
function corrupt(): never { throw new ModelInvocationStoreError('MODEL_INVOCATION_CORRUPT'); }
/** Caller owns BEGIN IMMEDIATE, commit and rollback, including audit failure. No receipt/counter writes. */
export function purgeInvocationContent(db: DatabaseSync, admission: ModelInvocationPurgeAdmission): ModelInvocationPurgeResult {
  const { command, actor } = admission;
  const prior = db.prepare(`SELECT scope_id,command_id,invocation_id,record FROM model_invocation_content_purges
    WHERE scope_id=? AND command_id=?`).get(command.scopeId, command.commandId);
  if (prior) {
    if (typeof prior.record !== 'string') return corrupt();
    let receipt;
    try { receipt = verifyModelInvocationPurgeReceipt(JSON.parse(prior.record)); } catch { return corrupt(); }
    if (prior.scope_id !== receipt.command.scopeId || prior.command_id !== receipt.command.commandId
      || prior.invocation_id !== receipt.command.invocationId) return corrupt();
    if (!isDeepStrictEqual(receipt.command, command) || !isDeepStrictEqual(receipt.actor, actor)) return conflict();
    const current = loadInvocationRecord(db, command.scopeId, command.invocationId);
    if (!current || !isDeepStrictEqual(current.purge, receipt)) return corrupt();
    return Object.freeze({ replayed: true, receipt });
  }
  const current = loadInvocationRecord(db, command.scopeId, command.invocationId);
  if (!current || current.purge || !current.content || !isDeepStrictEqual(current.receipt.request.reference, command.reference)
    || current.content.descriptor.digest !== command.expectedContentDigest) return conflict();
  const receipt = verifyModelInvocationPurgeReceipt({ schemaVersion: 1, ...admission });
  db.prepare(`INSERT INTO model_invocation_content_purges(scope_id,command_id,invocation_id,record) VALUES(?,?,?,?)`)
    .run(command.scopeId, command.commandId, command.invocationId, JSON.stringify(receipt));
  const changed = db.prepare(`UPDATE model_invocation_contents SET record=NULL,purge_command_id=?
    WHERE scope_id=? AND invocation_id=? AND record IS NOT NULL AND purge_command_id IS NULL`)
    .run(command.commandId, command.scopeId, command.invocationId);
  if (changed.changes !== 1) return corrupt();
  return Object.freeze({ replayed: false, receipt });
}
