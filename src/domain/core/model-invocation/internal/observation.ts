import { z } from 'zod';
import { counterSchema } from '#domain/core/primitives/index.js';

export const rateLimitFactSchema = z.strictObject({ kind: z.enum(['allowed', 'overage', 'quota', 'credits-required', 'unknown']),
  status: z.string().regex(/^(\?|[A-Za-z0-9_.:-]{1,16})$/u), window: z.string().regex(/^(\?|[A-Za-z0-9_.:-]{1,24})$/u),
  resetsAtMs: counterSchema.nullable() }).readonly();
export type RateLimitFact = z.infer<typeof rateLimitFactSchema>;
export const pluginNamesSchema = z.strictObject({ names: z.array(z.string().min(1).max(256).refine(value => [...value].every(char => char.charCodeAt(0) > 31 && char.charCodeAt(0) !== 127))).max(32).readonly(),
  omitted: counterSchema }).refine(value => new Set(value.names).size === value.names.length
    && value.names.length + value.omitted >= 1 && value.omitted <= Number.MAX_SAFE_INTEGER - value.names.length).readonly();
export type PluginNames = z.infer<typeof pluginNamesSchema>;
export const nativeCallObservationSchema = z.strictObject({ schemaVersion: z.literal(1), cliVersion: z.string().min(1).max(64).nullable(),
  builtinPlugins: pluginNamesSchema.nullable(), paidExtraUsage: rateLimitFactSchema.nullable(),
}).refine(value => value.builtinPlugins !== null || value.paidExtraUsage !== null).readonly();
export type NativeCallObservation = z.infer<typeof nativeCallObservationSchema>;
