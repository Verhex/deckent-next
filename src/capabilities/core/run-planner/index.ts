import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { runProposalSchema, validateTaskGraph, TaskGraphError, TASK_GRAPH_SCHEMA_VERSION, identitySchema, encodeCommandProjection, type EvaluatorDefinition, type BrainPlanCommand, type WorkClassPolicy } from '#domain/index.js';
import { installedEvaluatorParameters } from '#capabilities/core/evaluation-evidence/index.js';
import { ErrorRegistry, redactForRecord, sha256, type KnownSecretSnapshot } from '#platform/index.js';
import templates from './internal/templates.json' with { type: 'json' };
const selected = z.object({ id: identitySchema, version: z.number().int().positive().safe() }).strict();
const template = selected.extend({ instruction: z.string().min(1).max(16_384), summaryChars: z.number().int().min(1).max(1024) }).strict();
type BrainReasoning = 'model-default' | 'off';
const reasoning = z.enum(templates.reasoningModes as [BrainReasoning, ...BrainReasoning[]]);
export const brainPlannerConfigSchema = z.object({ schemaVersion: z.literal(1).default(1),
  selected: selected.default(templates.selected), templates: z.array(template).min(1).max(256).default(templates.templates),
  maxCompletionTokens: z.number().int().positive().safe().nullable().default(templates.maxCompletionTokens),
  reasoning: reasoning.default(reasoning.parse(templates.reasoning)),
  context: z.object({ maxKinds: z.number().int().positive().safe(), maxModels: z.number().int().positive().safe(),
    maxEvaluators: z.number().int().positive().safe(), maxBytes: z.number().int().positive().safe(),
    requestMaxBytes: z.number().int().positive().safe(), tokenFramingAllowance: z.number().int().nonnegative().safe(),
  }).strict().default(templates.context),
}).strict();
export type BrainPlannerConfig = z.infer<typeof brainPlannerConfigSchema>;
export const brainDraftSchema = runProposalSchema.unwrap().pick({ graph: true, budgetCeiling: true, requiredPermissions: true }).strict().readonly();
export { boundBrainContext } from './internal/context.js';
export type { BrainRegistryContext } from './internal/context.js';
export type BrainDraft = z.infer<typeof brainDraftSchema>;
export const prepareBrainEvaluatorParameters = (evaluator: EvaluatorDefinition) => zodToJsonSchema(installedEvaluatorParameters(evaluator), { $refStrategy: 'none' });
function redactJson(input: unknown, known?: KnownSecretSnapshot): unknown {
  if (typeof input === 'string') return redactForRecord(input, known);
  if (Array.isArray(input)) return input.map(value => redactJson(value, known));
  if (input && typeof input === 'object') return Object.fromEntries(Object.entries(input).map(([key, value]) => [redactForRecord(key, known), redactJson(value, known)]));
  return input;
}
export function brainInputDigest(command: BrainPlanCommand, known?: KnownSecretSnapshot): string {
  return sha256(encodeCommandProjection('brain-input:1', { ...command, intent: redactForRecord(command.intent, known) }));
}
/** The draft schema shown to the model. The graph contract still reads older versions (stored proposals), but a NEW plan must use the
 * current graph version: an older one cannot carry typed work input (live /do 2026-10-13: a v2 plan with workInput was refused). */
function brainDraftJsonSchema() {
  const schema = zodToJsonSchema(brainDraftSchema, { $refStrategy: 'none' }) as { properties?: { graph?: { properties?: Record<string, unknown> } } };
  const graph = schema.properties?.graph?.properties;
  if (graph) graph['schemaVersion'] = { type: 'number', const: TASK_GRAPH_SCHEMA_VERSION };
  return schema;
}
export function prepareBrainPrompt(command: BrainPlanCommand, policy: WorkClassPolicy, context: unknown, configInput: unknown, known?: KnownSecretSnapshot) {
  const config = brainPlannerConfigSchema.parse(configInput), chosen = config.templates.filter(row => row.id === config.selected.id && row.version === config.selected.version);
  if (chosen.length !== 1) throw ErrorRegistry.createError('BRAIN_TEMPLATE_UNAVAILABLE');
  const chosenTemplate = chosen[0]!, intent = redactForRecord(command.intent, known);
  const projected = JSON.stringify(redactJson({ scopeId: command.scopeId, workClasses: policy, context }, known));
  const bytes = new TextEncoder().encode(projected).length;
  if (bytes > config.context.maxBytes) throw ErrorRegistry.createError('BRAIN_CONTEXT_TOO_LARGE', { params: { limit: config.context.maxBytes, observed: bytes, unit: 'bytes' } });
  return Object.freeze({ template: { id: chosenTemplate.id, version: chosenTemplate.version,
    digest: sha256(encodeCommandProjection('brain-template:1', chosenTemplate)) }, summaryChars: chosenTemplate.summaryChars,
    inputDigest: brainInputDigest(command, known), contextDigest: sha256(projected), intent,
    messages: [{ role: 'system' as const, content: redactForRecord(chosenTemplate.instruction, known) },
      { role: 'user' as const, content: JSON.stringify({ intent, context: JSON.parse(projected) as unknown,
        schema: brainDraftJsonSchema() }) }] });
}
/** Each failure stage is explicit and contains no provider text or secret-bearing parse diagnostics. */
/** `requireCurrentGraph` is for a NEW model reply only. Verifying a stored proposal's model contribution keeps reading every graph
 * version the contract accepts, so an upgrade never turns a pending, valid older proposal into a rejection (Astra 2524). */
export function parseBrainDraft(text: string, known?: KnownSecretSnapshot, options: { readonly requireCurrentGraph?: boolean } = {}): BrainDraft {
  let input: unknown;
  try { input = redactJson(JSON.parse(text) as unknown, known); } catch { throw ErrorRegistry.createError('BRAIN_OUTPUT_INVALID', { params: { stage: 'json' } }); }
  const parsed = brainDraftSchema.safeParse(input);
  if (!parsed.success) throw ErrorRegistry.createError('BRAIN_OUTPUT_INVALID', { params: { stage: 'schema' } });
  if (options.requireCurrentGraph && parsed.data.graph.schemaVersion !== TASK_GRAPH_SCHEMA_VERSION) throw ErrorRegistry.createError('BRAIN_GRAPH_INVALID', { params: { rule: 'TASK_GRAPH_VERSION' } });
  try { validateTaskGraph(parsed.data.graph); } catch (error) {
    throw ErrorRegistry.createError('BRAIN_GRAPH_INVALID', { params: { rule: error instanceof TaskGraphError ? error.code : 'TASK_GRAPH_INVALID' } });
  }
  return parsed.data;
}
export const brainOutputDigest = (draft: BrainDraft) => sha256(encodeCommandProjection('brain-output:1', draft));
