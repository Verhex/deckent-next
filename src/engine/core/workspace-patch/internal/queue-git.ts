import { createHash } from 'node:crypto';
import { z } from 'zod';
import { TargetQueueError, identitySchema, type TargetQueueRecord } from '#domain/index.js';
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const queueGenerationRef = (target: string) => `refs/deckent/queue-generations/${digest(target)}`;
export const queueGenerationSchema = z.object({ schemaVersion: z.literal(1), key: z.string().regex(/^[a-f0-9]{64}$/),
  owner: identitySchema, epoch: z.number().int().positive().safe() }).strict();
export interface GitQueueFence { readonly ref: string; readonly value: string }
/** Versioned names, derived from durable ticket identity. No clock/random input on replay. */
export function queueCommandIds(record: Pick<TargetQueueRecord, 'request'>) { return queueTicketCommandIds(record.request.identity.scopeId, record.request.commandId); }
/** The same names from a ticket's scope and command id alone (a read-only caller holding only the queue view, e.g. its verification Run). */
export function queueTicketCommandIds(scopeId: string, commandId: string) {
  const key = digest({ scopeId, commandId });
  return { candidate: `queue-candidate-${key}`, delivery: `queue-delivery-${key}`, adoption: `queue-adopt-${key}`,
    verificationRun: `queue-verify-${key}`, verificationCreate: `queue-create-${key}` };
}
export function assertQueueGitTarget(ref: string, registered: string | undefined, allowed: readonly string[], protectedRefs: readonly string[], checkedOut: boolean): void {
  if (registered !== ref || !allowed.includes(ref) || protectedRefs.includes(ref) || checkedOut || !/^refs\/heads\/[A-Za-z0-9._/-]{1,200}$/.test(ref))
    throw new TargetQueueError('QUEUE_AUTHORITY_REQUIRED');
}
