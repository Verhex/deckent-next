import { persistedInteger, identitySchema, type ModelInvocationControlRecord, type ModelInvocationReceipt } from '#domain/index.js';
import { z } from 'zod';


export const modelInvocationCancellationRecoveryCommandSchema = z.strictObject({ schemaVersion: z.literal(1),
  scopeId: identitySchema, afterInvocationId: identitySchema.nullable() }).readonly();
export const modelInvocationCancellationInventoryQuerySchema = modelInvocationCancellationRecoveryCommandSchema.unwrap()
  .extend({ limit: persistedInteger().positive().max(2_147_483_646) }).strict().readonly();
export type ModelInvocationCancellationRecoveryCommand = z.infer<typeof modelInvocationCancellationRecoveryCommandSchema>;
/** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ export type ModelInvocationCancellationInventoryQuery = z.infer<typeof modelInvocationCancellationInventoryQuerySchema>;
/** Metadata only: retained provider response content is never needed to deliver cancellation. */
export interface ModelInvocationCancellationInventoryEntry {
  readonly receipt: ModelInvocationReceipt;
  readonly control: ModelInvocationControlRecord;
}
export interface ModelInvocationCancellationInventoryPage {
  readonly entries: readonly ModelInvocationCancellationInventoryEntry[];
  readonly nextAfterInvocationId: string | null;
}
export interface ModelInvocationCancellationInventory {
  inspectCancellationInventory(query: ModelInvocationCancellationInventoryQuery): Promise<ModelInvocationCancellationInventoryPage>;
  close(): void;
}
