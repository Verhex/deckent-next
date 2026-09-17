import { z } from 'zod';
import { identitySchema } from '#domain/index.js';
import { sandboxRequestSchema } from '#engine/core/supervisor/index.js';
const claimObject = z.object({ request: sandboxRequestSchema, owner: identitySchema }).strict();
export const dispatchClaimSchema = claimObject.readonly();
export const dispatchTerminalSchema = z.object({ handle: identitySchema, exitCode: z.number().int().safe(), interrupted: z.boolean().nullable() }).strict().readonly();
export const dispatchRecordSchema = claimObject.extend({ schemaVersion: z.literal(1), terminal: dispatchTerminalSchema.nullable() }).strict().readonly();
export type DispatchClaim = z.infer<typeof dispatchClaimSchema>;
export type DispatchTerminal = z.infer<typeof dispatchTerminalSchema>;
export type DispatchRecord = z.infer<typeof dispatchRecordSchema>;
/** Internal execution custody. Only a fresh atomic claim permits launch; replay never grants launch,
 * even to the same owner. An unresolved claim requires reconciliation, never expiry-based stealing.
 */
export interface DispatchStore {
  readDispatch(request: DispatchClaim['request']): Promise<DispatchRecord | null>;
  claimDispatch(claim: DispatchClaim): Promise<Readonly<{ acquired: boolean; record: DispatchRecord }>>;
  finishDispatch(claim: DispatchClaim, terminal: DispatchTerminal): Promise<DispatchRecord>;
}
export class DispatchError extends Error {
  constructor(readonly code: 'DISPATCH_CONFLICT' | 'DISPATCH_NOT_ADMITTED' | 'DISPATCH_CORRUPT') { super(code); this.name = 'DispatchError'; }
}
