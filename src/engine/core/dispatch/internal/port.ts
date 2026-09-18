import { artifactReceiptSchema, type ArtifactReceipt } from '#capabilities/index.js';
import { z } from 'zod';
import { identitySchema, processExitCauseShape, isValidExitCause, type AttemptIdentity, type VerifiedPrincipal } from '#domain/index.js';
import { sandboxRequestSchema } from '#engine/core/supervisor/index.js';
const claimObject = z.object({ request: sandboxRequestSchema, owner: identitySchema }).strict();
export const dispatchClaimSchema = claimObject.readonly();
export const dispatchTerminalSchema = z.object({ handle: identitySchema, ...processExitCauseShape, interrupted: z.boolean().nullable() }).strict().refine(isValidExitCause, 'ATTEMPT_EXIT_CAUSE_INVALID').readonly();
export const dispatchRecordSchema = claimObject.extend({ schemaVersion: z.literal(1), terminal: dispatchTerminalSchema.nullable(), output: artifactReceiptSchema.optional(), cancellation: z.object({ id: identitySchema, issuer: identitySchema, subject: identitySchema }).strict().readonly().optional() }).strict().readonly();
export type DispatchClaim = z.infer<typeof dispatchClaimSchema>;
export type DispatchTerminal = z.infer<typeof dispatchTerminalSchema>;
export type DispatchRecord = z.infer<typeof dispatchRecordSchema>;
/** Internal execution custody. Only a fresh atomic claim permits launch; replay never grants launch,
 * even to the same owner. An unresolved claim requires reconciliation, never expiry-based stealing.
 */
/** Trusted lookup after authorization; full identity must match the Run binding. */
export interface RunBoundDispatchStore { loadBoundDispatch(identity: AttemptIdentity): Promise<DispatchRecord | null> }
export interface DispatchStore {
  requestDispatchCancellation(request: DispatchClaim['request'], principal: VerifiedPrincipal): Promise<DispatchRecord>;
  retainDispatchOutput(claim: DispatchClaim, receipt: ArtifactReceipt): Promise<DispatchRecord>;
  readDispatch(request: DispatchClaim['request']): Promise<DispatchRecord | null>;
  claimDispatch(claim: DispatchClaim): Promise<Readonly<{ acquired: boolean; record: DispatchRecord }>>;
  finishDispatch(claim: DispatchClaim, terminal: DispatchTerminal): Promise<DispatchRecord>;
}
export class DispatchError extends Error {
  constructor(readonly code: 'DISPATCH_ARTIFACT_REQUIRED' | 'DISPATCH_CONFLICT' | 'DISPATCH_NOT_ADMITTED' | 'DISPATCH_CORRUPT') { super(code); this.name = 'DispatchError'; }
}
