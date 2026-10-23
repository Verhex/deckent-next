import { z } from 'zod';
import { identitySchema } from '#domain/core/primitives/index.js';
import asset from '../../../../../assets/model-makers/makers.json' with { type: 'json' };

/**
 * Canonical model maker (S4B-1, MODEL-INDEPENDENCE-AUDIT M1 item 1, lead 2026-10-23). A catalog `vendorId` names a maker as one channel spells
 * it; this versioned registry maps vendor aliases to one canonical maker, so two channels that serve one maker's models count as the same maker.
 * It holds no tier or role (S2 `model_roles` stays their only owner); a new maker or alias is a data update, never code.
 */
const registrySchema = z.object({ schemaVersion: z.literal(1), revision: identitySchema,
  aliases: z.record(identitySchema, identitySchema).refine(aliases => Object.values(aliases).every(target => !Object.hasOwn(aliases, target))) }).strict();
export const MODEL_MAKERS = Object.freeze(registrySchema.parse(asset));
/** The canonical maker of one catalog model entry; `null` (maker unknown) for an entry without metadata or one whose model the provider chooses. */
export function canonicalModelMaker(model: unknown): string | null {
  if (typeof model !== 'object' || model === null) return null;
  const entry = model as { readonly vendorId?: unknown; readonly selection?: unknown };
  if (entry.selection !== undefined || !identitySchema.safeParse(entry.vendorId).success) return null;
  const vendor = entry.vendorId as string;
  return Object.hasOwn(MODEL_MAKERS.aliases, vendor) ? MODEL_MAKERS.aliases[vendor]! : vendor;
}
/** Independence of an evaluator from every source model: all makers known, at least one source, and the evaluator's maker differs from each. */
export function makersIndependent(evaluator: string | null, sources: readonly (string | null)[]): boolean {
  return evaluator !== null && sources.length > 0 && sources.every(source => source !== null && source !== evaluator);
}
