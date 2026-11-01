import { persistedInteger, persistedUrl } from '#domain/index.js';
import { z } from 'zod';
import models from './models.json' with { type: 'json' };

const https = persistedUrl().startsWith('https://');
const level = z.string().min(1);
const capabilitySchema = z.strictObject({ get modelId() { return z.string().min(1).max(256); },
  get thinking() { return z.strictObject({ adaptive: z.boolean(), enabled: z.boolean(), off: z.enum(['disabled', 'between_tools']).nullable(), offMaxEffort: level.optional() }); },
  get effort() { return z.strictObject({ levels: z.array(level).min(1), default: level }).nullable(); },
  get maxOutputTokens() { return persistedInteger().positive().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER); }, source: https })
  .refine(row => row.effort === null || row.effort.levels.includes(row.effort.default))
  .refine(row => row.thinking.offMaxEffort === undefined || (row.thinking.off !== null && row.effort !== null));
type Capability = z.infer<typeof capabilitySchema>;
export type AnthropicModelCapability = Readonly<Omit<Capability, 'effort'> & {
  effort: Readonly<{ levels: readonly string[]; default: string }> | null }>;
const positiveInteger = persistedInteger().positive().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER);
const registrySchema = z.strictObject({ get schemaVersion() { return z.literal(2); }, get retrievedAt() { return z.string().regex(/^\d{4}-\d{2}-\d{2}$/); },
  get sources() { return z.record(z.string(), https); }, get note() { return z.string(); },
  get effort() { return z.strictObject({ levels: z.array(level).nonempty(), order: z.literal('ascending') }); },
  get metering() { return z.strictObject({ promptOverheadTokens: positiveInteger, thinkingBudgetMinTokens: positiveInteger }); },
  get models() { return z.array(capabilitySchema).min(1); } })
  .refine(registry => new Set(registry.models.map(row => row.modelId)).size === registry.models.length)
  .refine(registry => new Set(registry.effort.levels).size === registry.effort.levels.length)
  .refine(registry => registry.models.every(row => {
    const levels = registry.effort.levels;
    // The vocabulary declares ascending rank. Each model must be a strictly ascending subset of it.
    return (row.effort === null || row.effort.levels.every((value, index, subset) =>
      levels.includes(value) && (index === 0 || levels.indexOf(subset[index - 1]!) < levels.indexOf(value))))
      && (row.thinking.offMaxEffort === undefined || levels.includes(row.thinking.offMaxEffort));
  }));

/** Old/missing parameter shapes fail with ZodError at load; registry policy never has silent code defaults. */
const registry = registrySchema.parse(models);
/** `output_config.effort` vocabulary and ascending rank are adapter-owned versioned data. */
export const ANTHROPIC_EFFORT_LEVELS = Object.freeze(registry.effort.levels);
export type AnthropicEffort = (typeof ANTHROPIC_EFFORT_LEVELS)[number];
export const ANTHROPIC_METERING = Object.freeze(registry.metering);
/** New models are data rows, never model-name rules in code. */
export const ANTHROPIC_MODEL_CAPABILITIES: readonly AnthropicModelCapability[] = Object.freeze(registry.models.map(row =>
  Object.freeze({ ...row, thinking: Object.freeze(row.thinking), effort: row.effort === null ? null
    : Object.freeze({ ...row.effort, levels: Object.freeze(row.effort.levels) }) })));
export function anthropicModelCapability(modelId: string): AnthropicModelCapability | undefined {
  return ANTHROPIC_MODEL_CAPABILITIES.find(row => row.modelId === modelId);
}

type Controls = Readonly<{ maxOutputTokens: number; effort?: AnthropicEffort | undefined;
  thinking?: Readonly<{ mode: 'model-default' | 'adaptive' | 'enabled'; off?: 'disabled' | 'between_tools' | undefined }> | undefined }>;
const rank = (level: AnthropicEffort) => ANTHROPIC_EFFORT_LEVELS.indexOf(level);

/**
 * True when the model's documented request surface admits these controls. An unlisted model admits only the one shape every model
 * accepts: no thinking field (`model-default` without an off mode) and no effort; its output bound is left to the API.
 */
export function anthropicControlsAdmitted(modelId: string, controls: Controls): boolean {
  const row = anthropicModelCapability(modelId), thinking = controls.thinking;
  if (!row) return controls.effort === undefined && (thinking === undefined || (thinking.mode === 'model-default' && thinking.off === undefined));
  if (controls.maxOutputTokens > row.maxOutputTokens) return false;
  if (controls.effort !== undefined && !row.effort?.levels.includes(controls.effort)) return false;
  if (thinking?.mode === 'adaptive' && !row.thinking.adaptive) return false;
  if (thinking?.mode === 'enabled' && !row.thinking.enabled) return false;
  if (thinking?.off === undefined) return true;
  if (thinking.off !== row.thinking.off) return false;
  // An off mode limited to an effort ceiling is refused when the effort in effect (configured, else the model default) is above it.
  const ceiling = row.thinking.offMaxEffort, inEffect = controls.effort ?? row.effort?.default;
  return ceiling === undefined || inEffect === undefined || rank(inEffect) <= rank(ceiling);
}
