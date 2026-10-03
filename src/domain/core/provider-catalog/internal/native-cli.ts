import { z } from 'zod';
import registry from '../../../../../assets/native-coding/commands.json' with { type: 'json' };

/** Pure provider vocabulary from the versioned registry asset; no adapter dependency or I/O. */
export function providerIdSchema<const Id extends string>(ids: readonly Id[]) {
  if (ids.length === 0 || new Set(ids).size !== ids.length) throw new Error('PROVIDER_ID_VOCABULARY_INVALID');
  return z.enum(ids as [Id, ...Id[]]);
}
export type NativeCliId = keyof typeof registry.adapters;
export const nativeCliIds = Object.freeze(Object.keys(registry.adapters) as [NativeCliId, ...NativeCliId[]]);
export const nativeCliIdSchema = providerIdSchema(nativeCliIds);
export const modelUsageEvidenceSchema = z.enum(['session-events', 'none']);
export type ModelUsageEvidence = z.infer<typeof modelUsageEvidenceSchema>;

/** Read migration only: profiles/records written before capability stamping retain the shipped registry behavior. */
export function readLegacyModelUsageEvidence(provider: NativeCliId): ModelUsageEvidence {
  return modelUsageEvidenceSchema.parse(registry.adapters[provider].capabilities.modelUsageEvidence);
}
