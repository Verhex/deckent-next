import { z } from 'zod';
import registry from '../../../../../assets/native-coding/commands.json' with { type: 'json' };

/** Pure provider vocabulary from the versioned registry asset; no adapter dependency or I/O. */
export function providerIdSchema<const Id extends string>(ids: readonly Id[]) {
  if (ids.length === 0 || new Set(ids).size !== ids.length) throw new Error('PROVIDER_ID_VOCABULARY_INVALID');
  return z.enum(ids as [Id, ...Id[]]);
}
/** The vocabulary checks the registry envelope before startup derives ids; stale assets get the same typed refusal as capability loading. */
export class NativeCliRegistryError extends Error {
  readonly code = 'NATIVE_CLI_REGISTRY_INVALID';
  constructor() { super('NATIVE_CLI_REGISTRY_INVALID'); this.name = 'NativeCliRegistryError'; }
}
const vocabularyEnvelope = z.object({ schemaVersion: z.literal(3), adapters: z.record(z.string().regex(/^[a-z][a-z0-9-]*$/), z.unknown())
  .refine(value => Object.keys(value).length > 0) }).strict();
export function nativeCliVocabulary(input: unknown): readonly string[] {
  const parsed = vocabularyEnvelope.safeParse(input);
  if (!parsed.success) throw new NativeCliRegistryError();
  return Object.freeze(Object.keys(parsed.data.adapters));
}
/** Registry-derived id (a string whose values come from the asset at load); the published declaration must not reference the JSON
 * module (consumers resolve our `.d.ts` with `resolveJsonModule: false`), so the type is the vocabulary's element type, not `keyof typeof`. */
export type NativeCliId = string;
export const nativeCliIds: readonly [NativeCliId, ...NativeCliId[]] = nativeCliVocabulary(registry) as readonly [NativeCliId, ...NativeCliId[]];
export const nativeCliIdSchema = providerIdSchema(nativeCliIds);
/** How a native CLI reports the model it ran: `session-events` = start model plus per-model usage (verifiable); `session-start-name` = only the
 * model's display name at session start, compared with the catalog's recorded reported names (never `verified`); `none` = no model evidence. */
export const modelUsageEvidenceSchema = z.enum(['session-events', 'session-start-name', 'none']);
export type ModelUsageEvidence = z.infer<typeof modelUsageEvidenceSchema>;
/** Capabilities that existed before capability stamping; unstamped records were written under one of these. */
const LEGACY_MODEL_USAGE_EVIDENCE: readonly ModelUsageEvidence[] = Object.freeze(['session-events', 'none']);

/** Read migration only: profiles/records written before capability stamping retain the shipped registry behavior of that time. A capability
 * added after stamping (e.g. `session-start-name`) never applies to such a record: it was produced without that evidence, so it reads as `none`. */
export function readLegacyModelUsageEvidence(provider: NativeCliId): ModelUsageEvidence {
  const adapters: Record<string, { readonly capabilities?: { readonly modelUsageEvidence?: unknown } } | undefined> = registry.adapters;
  const entry = adapters[provider];
  if (!entry) throw new NativeCliRegistryError();
  const current = modelUsageEvidenceSchema.parse(entry.capabilities?.modelUsageEvidence);
  return LEGACY_MODEL_USAGE_EVIDENCE.includes(current) ? current : 'none';
}
