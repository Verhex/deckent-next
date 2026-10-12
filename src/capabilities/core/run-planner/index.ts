import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { runProposalSchema, validateTaskGraph, identitySchema, encodeCommandProjection, type BrainPlanCommand, type WorkClassPolicy } from '#domain/index.js';
import { ErrorRegistry, redactForRecord, sha256, type KnownSecretSnapshot } from '#platform/index.js';
import templates from './internal/templates.json' with { type: 'json' };
const selected = z.object({ id: identitySchema, version: z.number().int().positive().safe() }).strict();
const template = selected.extend({ instruction: z.string().min(1).max(16_384), summaryChars: z.number().int().min(1).max(1024) }).strict();
export const brainPlannerConfigSchema = z.object({ schemaVersion: z.literal(1).default(1),
  selected: selected.default(templates.selected), templates: z.array(template).min(1).max(256).default(templates.templates),
}).strict();
export type BrainPlannerConfig = z.infer<typeof brainPlannerConfigSchema>;
export const brainDraftSchema = runProposalSchema.unwrap().pick({ graph: true, budgetCeiling: true, requiredPermissions: true }).strict().readonly();
export type BrainDraft = z.infer<typeof brainDraftSchema>;
function redactJson(input: unknown, known?: KnownSecretSnapshot): unknown {
  if (typeof input === 'string') return redactForRecord(input, known);
  if (Array.isArray(input)) return input.map(value => redactJson(value, known));
  if (input && typeof input === 'object') return Object.fromEntries(Object.entries(input).map(([key, value]) => [redactForRecord(key, known), redactJson(value, known)]));
  return input;
}
export function brainInputDigest(command: BrainPlanCommand, known?: KnownSecretSnapshot): string {
  return sha256(encodeCommandProjection('brain-input:1', { ...command, intent: redactForRecord(command.intent, known) }));
}
export function prepareBrainPrompt(command: BrainPlanCommand, policy: WorkClassPolicy, context: unknown, configInput: unknown, known?: KnownSecretSnapshot) {
  const config = brainPlannerConfigSchema.parse(configInput), chosen = config.templates.filter(row => row.id === config.selected.id && row.version === config.selected.version);
  if (chosen.length !== 1) throw ErrorRegistry.createError('BRAIN_TEMPLATE_UNAVAILABLE');
  const chosenTemplate = chosen[0]!, intent = redactForRecord(command.intent, known);
  const projected = JSON.stringify(redactJson({ scopeId: command.scopeId, workClasses: policy, context }, known));
  return Object.freeze({ template: { id: chosenTemplate.id, version: chosenTemplate.version,
    digest: sha256(encodeCommandProjection('brain-template:1', chosenTemplate)) }, summaryChars: chosenTemplate.summaryChars,
    inputDigest: brainInputDigest(command, known), contextDigest: sha256(projected), intent,
    messages: [{ role: 'system' as const, content: redactForRecord(chosenTemplate.instruction, known) },
      { role: 'user' as const, content: JSON.stringify({ intent, context: JSON.parse(projected) as unknown,
        schema: zodToJsonSchema(brainDraftSchema, { $refStrategy: 'none' }) }) }] });
}
/** Each failure stage is explicit and contains no provider text or secret-bearing parse diagnostics. */
export function parseBrainDraft(text: string, known?: KnownSecretSnapshot): BrainDraft {
  let input: unknown;
  try { input = redactJson(JSON.parse(text) as unknown, known); } catch { throw ErrorRegistry.createError('BRAIN_OUTPUT_INVALID', { params: { stage: 'json' } }); }
  const parsed = brainDraftSchema.safeParse(input);
  if (!parsed.success) throw ErrorRegistry.createError('BRAIN_OUTPUT_INVALID', { params: { stage: 'schema' } });
  try { validateTaskGraph(parsed.data.graph); } catch { throw ErrorRegistry.createError('BRAIN_OUTPUT_INVALID', { params: { stage: 'graph' } }); }
  return parsed.data;
}
export const brainOutputDigest = (draft: BrainDraft) => sha256(encodeCommandProjection('brain-output:1', draft));
