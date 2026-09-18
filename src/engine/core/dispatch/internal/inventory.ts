import { z } from 'zod';
import { identitySchema, type AttemptIdentity, type VerifiedPrincipal } from '#domain/index.js';
import { authenticate, type PrincipalVerifier } from '#engine/core/authentication/index.js';
import type { DispatchRecord, DispatchTerminal } from './port.js';
export const dispatchInventoryQuerySchema = z.object({ schemaVersion: z.literal(1), scopeId: identitySchema,
  after: identitySchema.nullable(), limit: z.number().int().positive().max(2_147_483_646) }).strict().readonly();
export const dispatchInventoryInputSchema = dispatchInventoryQuerySchema.unwrap().extend({
  after: dispatchInventoryQuerySchema.unwrap().shape.after.default(null),
  limit: dispatchInventoryQuerySchema.unwrap().shape.limit.optional(),
}).readonly();
export type DispatchInventoryInput = z.input<typeof dispatchInventoryInputSchema>;
export type DispatchInventoryQuery = z.infer<typeof dispatchInventoryQuerySchema>;
export interface DispatchInventoryEntry {
  readonly identity: AttemptIdentity;
  readonly owner: string;
  readonly launch: DispatchRecord['launch'];
  readonly terminal: DispatchTerminal | null;
  readonly cancellationRequested: boolean;
  /** Retention reference only. This does not prove completeness, availability or permission to release. */
  readonly outputRecorded: boolean;
}
export interface DispatchInventoryPage { readonly entries: readonly DispatchInventoryEntry[]; readonly nextAfter: string | null }
export interface DispatchInventoryStore { listDispatches(query: DispatchInventoryQuery): Promise<DispatchInventoryPage> }
export interface DispatchInventoryAuthorization { authorize(scopeId: string, principal: VerifiedPrincipal): Promise<void> }
export class DispatchInventoryError extends Error { constructor() { super('DISPATCH_INVENTORY_LIMIT'); this.name = 'DispatchInventoryError'; } }
/** Moving keyset pagination, not a point-in-time snapshot. Refresh from null to discover earlier new keys. */
export class DispatchInventoryApplication {
  constructor(private readonly store: DispatchInventoryStore, private readonly verifier: PrincipalVerifier,
    private readonly authorization: DispatchInventoryAuthorization, private readonly maxPageSize: number) {
    if (!Number.isSafeInteger(maxPageSize) || maxPageSize < 1 || maxPageSize > 2_147_483_646) throw new DispatchInventoryError();
  }
  async inspect(input: unknown, credential?: unknown): Promise<DispatchInventoryPage> {
    const query = dispatchInventoryQuerySchema.parse(input);
    if (query.limit > this.maxPageSize) throw new DispatchInventoryError();
    const principal = await authenticate(this.verifier, credential, query.scopeId);
    await this.authorization.authorize(query.scopeId, principal);
    return this.store.listDispatches(query);
  }
}
