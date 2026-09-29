import { z } from 'zod';
import models from './models.json' with { type: 'json' };

/** `output_config.effort` levels in ascending order (GA, no beta header; 2026-09-29). */
export const ANTHROPIC_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type AnthropicEffort = (typeof ANTHROPIC_EFFORT_LEVELS)[number];
const effort = z.enum(ANTHROPIC_EFFORT_LEVELS);
const https = z.string().url().startsWith('https://');

const capabilitySchema = z.object({ modelId: z.string().min(1).max(256),
  thinking: z.object({ adaptive: z.boolean(), enabled: z.boolean(), off: z.enum(['disabled', 'between_tools']).nullable(), offMaxEffort: effort.optional() }).strict(),
  effort: z.object({ levels: z.array(effort).min(1), default: effort }).strict().nullable(),
  maxOutputTokens: z.number().int().positive().safe(), source: https }).strict()
  .refine(row => row.effort === null || row.effort.levels.includes(row.effort.default))
  .refine(row => row.thinking.offMaxEffort === undefined || (row.thinking.off !== null && row.effort !== null));
export type AnthropicModelCapability = Readonly<z.infer<typeof capabilitySchema>>;
const registrySchema = z.object({ schemaVersion: z.literal(1), retrievedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  sources: z.record(z.string(), https), note: z.string(), models: z.array(capabilitySchema).min(1) }).strict()
  .refine(registry => new Set(registry.models.map(row => row.modelId)).size === registry.models.length);

/**
 * Adapter-owned, dated and sourced data (`models.json`): what the Messages API accepts per model. A profile is checked against its row at
 * load, so a configuration the API would refuse with a 400 never reaches a call. New models are a data row, never a model-name rule in code.
 */
export const ANTHROPIC_MODEL_CAPABILITIES: readonly AnthropicModelCapability[] = Object.freeze(registrySchema.parse(models).models
  .map(row => Object.freeze(row)));
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
