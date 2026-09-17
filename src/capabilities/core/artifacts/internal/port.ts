import { z } from 'zod';
import { identitySchema } from '#domain/index.js';
export const artifactReceiptSchema = z.object({ schemaVersion: z.literal(1), scopeId: identitySchema,
  digest: z.string().regex(/^[a-f0-9]{64}$/), byteLength: z.number().int().nonnegative().safe() }).strict().readonly();
export type ArtifactReceipt = z.infer<typeof artifactReceiptSchema>;
/** Byte storage does not grant access: authenticated application policy must admit every operation.
 * Receipts identify immutable scoped content, never a caller-selected filesystem path.
 */
export interface ArtifactStore {
  put(scopeId: string, bytes: Uint8Array): Promise<ArtifactReceipt>;
  read(scopeId: string, receipt: ArtifactReceipt): Promise<Uint8Array>;
}
export class ArtifactError extends Error {
  constructor(readonly code: 'ARTIFACT_INVALID' | 'ARTIFACT_TOO_LARGE' | 'ARTIFACT_SCOPE_DENIED' | 'ARTIFACT_UNSAFE' | 'ARTIFACT_CORRUPT' | 'ARTIFACT_UNSUPPORTED') { super(code); this.name = 'ArtifactError'; }
}
