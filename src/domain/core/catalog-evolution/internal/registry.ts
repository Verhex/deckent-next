import { z } from 'zod';
import { identitySchema } from '#domain/core/primitives/index.js';
import seed from '../../../../../assets/catalog-evolution/registry.json' with { type: 'json' };

/**
 * S8-2 registry `catalog-evolution` v1 (S8-DESIGN §6, §10): the statistics bounds, the aggregator pass bounds and the suggestion rules as versioned
 * Core seed data (`assets/catalog-evolution`). Every value is `provisional` until measured on a real installation (K-F S8); only a person's governed
 * overlay write (protected config `catalogEvolution.overlay`, no AI writes it) may replace a rule row (next version) or mark it `calibrated`, and
 * it may only lower a resource bound. Rates and thresholds are integer micro-units (1 = 1 000 000), so every statistic is byte-reproducible.
 */
const positive = z.number().int().positive().safe();
const micro = z.number().int().nonnegative().safe();
const statsSchema = z.object({ zMicro: positive, windowTasks: positive, durationPercentileMicro: positive, windowMaxDays: positive, periodDays: positive, modelMixMax: positive,
  excludeUnknownEvidence: z.boolean(), readRowsMax: positive }).strict();
const passSchema = z.object({ passPageRows: positive, maxKeysPerPass: positive }).strict();
const suggestionsSchema = z.object({ maxOpenSuggestions: positive, suggestionTtlDays: positive, cooldownTasks: positive }).strict();
const rule = <K extends string, P extends z.ZodRawShape>(kind: K, params: P) => z.object({ id: identitySchema, version: positive, kind: z.literal(kind),
  status: z.enum(['provisional', 'calibrated']), params: z.object(params).strict().readonly() }).strict().readonly();
/** The five rule kinds (§6); S8-3 evaluates them, S8-2 only carries and validates them. */
const ruleSchema = z.union([
  rule('promote-agent', { minSamples: positive, lowerBoundMicro: micro, minModels: positive, minPeriods: positive, maxNonAttributableShareMicro: micro }),
  rule('redesign-agent', { minSamples: positive, upperBoundMicro: micro }),
  rule('revise-agent', { minSamples: positive, effortRatioMicro: positive, windows: positive }),
  rule('propose-agent', { minTasks: positive }), rule('propose-skill', { minLessons: positive })]);
const registrySchema = z.object({ schemaVersion: z.literal(1), revision: identitySchema, status: z.enum(['provisional', 'calibrated']),
  stats: statsSchema.readonly(), pass: passSchema.readonly(),
  suggestions: suggestionsSchema.readonly(),
  inherit: z.object({ recheckMinSamples: positive }).strict().readonly(),
  rollout: z.object({ minSuggestions: positive, minAgreementMicro: micro, maxReversalRateMicro: micro, minShadowNarrowings: positive }).strict().readonly(),
  rules: z.array(ruleSchema).min(1).readonly() }).strict().refine(value => new Set(value.rules.map(row => row.id)).size === value.rules.length).readonly();
export const catalogEvolutionOverlaySchema = z.object({ revision: identitySchema, stats: statsSchema.partial().optional(), pass: passSchema.partial().optional(), suggestions: suggestionsSchema.partial().optional(),
  rules: z.array(ruleSchema).optional() }).strict().readonly();
export type CatalogEvolutionRegistry = z.infer<typeof registrySchema>;
export type CatalogEvolutionRule = CatalogEvolutionRegistry['rules'][number];
export class CatalogEvolutionError extends Error {
  constructor(readonly code: 'CATALOG_EVOLUTION_REGISTRY_UNAVAILABLE' | 'CATALOG_EVOLUTION_CORRUPT' | 'CATALOG_EVOLUTION_POSITION_CONFLICT') { super(code); this.name = 'CatalogEvolutionError'; }
}
/** Resource bounds an overlay may only lower (it can never make a pass or a read bigger than the Core seed allows). */
const NARROW_ONLY = new Set(['windowTasks', 'modelMixMax', 'readRowsMax', 'passPageRows', 'maxKeysPerPass', 'maxOpenSuggestions']);
/** The Core seed with the installation overlay applied. A malformed seed or overlay, a widened resource bound, a rule row without a newer version
 * or of another kind is `CATALOG_EVOLUTION_REGISTRY_UNAVAILABLE` (never a default): no statistic, no pass record. `seedInput` is for tests only. */
export function composeCatalogEvolutionRegistry(overlay?: unknown, seedInput: unknown = seed): CatalogEvolutionRegistry {
  const base = registrySchema.safeParse(seedInput), extra = overlay === undefined ? null : catalogEvolutionOverlaySchema.safeParse(overlay);
  if (!base.success || (extra && !extra.success)) throw new CatalogEvolutionError('CATALOG_EVOLUTION_REGISTRY_UNAVAILABLE');
  if (!extra) return base.data;
  const lowered = <T extends Readonly<Record<string, unknown>>>(from: T, patch: Readonly<Record<string, unknown>> | undefined): T => {
    for (const [key, value] of Object.entries(patch ?? {})) if (value !== undefined && NARROW_ONLY.has(key) && (value as number) > (from[key] as number)) throw new CatalogEvolutionError('CATALOG_EVOLUTION_REGISTRY_UNAVAILABLE');
    return Object.freeze({ ...from, ...Object.fromEntries(Object.entries(patch ?? {}).filter(([, value]) => value !== undefined)) });
  };
  const rules = new Map(base.data.rules.map(row => [row.id, row] as const));
  for (const row of extra.data.rules ?? []) {
    const prior = rules.get(row.id);
    if (!prior || prior.kind !== row.kind || row.version <= prior.version) throw new CatalogEvolutionError('CATALOG_EVOLUTION_REGISTRY_UNAVAILABLE');
    rules.set(row.id, row);
  }
  return Object.freeze({ ...base.data, revision: extra.data.revision, stats: lowered(base.data.stats, extra.data.stats), pass: lowered(base.data.pass, extra.data.pass),
    suggestions: lowered(base.data.suggestions, extra.data.suggestions),
    rules: Object.freeze([...rules.values()]) });
}
