import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { runProposalSchema, validateTaskGraph, TaskGraphError, TASK_GRAPH_SCHEMA_VERSION, WORK_INPUT_ASSIGNED_SCHEMA_VERSION, identitySchema, encodeCommandProjection, type EvaluatorDefinition, type BrainPlanCommand, type WorkClassPolicy } from '#domain/index.js';
import { installedEvaluatorParameters } from '#capabilities/core/evaluation-evidence/index.js';
import { ErrorRegistry, redactForRecord, sha256, type KnownSecretSnapshot } from '#platform/index.js';
import templates from './internal/templates.json' with { type: 'json' };
const selected = z.object({ id: identitySchema, version: z.number().int().positive().safe() }).strict();
/** `modelAssignment: 'system'` (ATAMA-1, owner ASS1): the plan names tasks and WorkClasses only; the worker comes from the WorkClass candidate
 * list at admission. Absent = the earlier contract, where the plan pinned a worker model (v1/v2 rows keep their bytes and digest). */
const template = selected.extend({ instruction: z.string().min(1).max(16_384), summaryChars: z.number().int().min(1).max(1024),
  modelAssignment: z.enum(['brain', 'system']).optional() }).strict();
type BrainReasoning = 'model-default' | 'off';
const reasoning = z.enum(templates.reasoningModes as [BrainReasoning, ...BrainReasoning[]]);
export const brainPlannerConfigSchema = z.object({ schemaVersion: z.literal(1).default(1),
  selected: selected.default(templates.selected), templates: z.array(template).min(1).max(256).default(z.array(template).parse(templates.templates)),
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
function brainDraftJsonSchema(turnLimit: boolean, systemAssignment: boolean) {
  const schema = zodToJsonSchema(brainDraftSchema, { $refStrategy: 'none' }) as { properties?: { graph?: { properties?: Record<string, unknown> } } };
  const graph = schema.properties?.graph?.properties;
  if (graph) graph['schemaVersion'] = { type: 'number', const: TASK_GRAPH_SCHEMA_VERSION };
  // ATAMA-1: the model is offered only the work input version that leaves the worker to the system, without model or effort fields.
  if (systemAssignment) systemWorkInputSchema(graph);
  // No supplied kind's worker can honour a turn limit: the model is not offered `workInput.maxTurns` at all (live /do 2026-10-16 planned
  // maxTurns for a Codex worker). The draft contract still accepts it, so a stored proposal keeps parsing; creation refuses it typed.
  if (!turnLimit) dropProperty(schema, 'maxTurns');
  return schema;
}
function dropProperty(node: unknown, name: string): void {
  if (Array.isArray(node)) { node.forEach(value => dropProperty(value, name)); return; }
  if (!node || typeof node !== 'object') return;
  const record = node as Record<string, unknown>, properties = record['properties'];
  if (properties && typeof properties === 'object' && !Array.isArray(properties)) delete (properties as Record<string, unknown>)[name];
  if (Array.isArray(record['required'])) record['required'] = (record['required'] as unknown[]).filter(value => value !== name);
  Object.values(record).forEach(value => dropProperty(value, name));
}
function systemWorkInputSchema(graph: Record<string, unknown> | undefined): void {
  const items = (graph?.['tasks'] as { items?: { properties?: Record<string, unknown> } } | undefined)?.items?.properties;
  const union = items?.['workInput'] as { anyOf?: { properties?: Record<string, { const?: unknown }>; required?: string[] }[] } | undefined;
  const branch = union?.anyOf?.find(row => row.properties?.['schemaVersion']?.const === WORK_INPUT_ASSIGNED_SCHEMA_VERSION);
  if (!items || !branch?.properties) throw ErrorRegistry.createError('BRAIN_TEMPLATE_UNAVAILABLE');
  for (const name of ['model', 'effort']) delete branch.properties[name];
  branch.required = (branch.required ?? []).filter(name => name !== 'model' && name !== 'effort');
  items['workInput'] = branch;
}
/** The configured template the next plan uses; a missing or ambiguous selection is refused, never a fallback. */
export function selectedBrainTemplate(configInput: unknown) {
  const config = brainPlannerConfigSchema.parse(configInput), chosen = config.templates.filter(row => row.id === config.selected.id && row.version === config.selected.version);
  if (chosen.length !== 1) throw ErrorRegistry.createError('BRAIN_TEMPLATE_UNAVAILABLE');
  return chosen[0]!;
}
/** A turn limit is offered only when at least one supplied kind's worker supports it; unknown context offers it (no new refusal). */
function supportsTurnLimit(context: unknown): boolean {
  const kinds = (context as { kinds?: readonly { turnLimit?: string }[] } | null)?.kinds;
  if (!Array.isArray(kinds) || !kinds.some(row => row.turnLimit !== undefined)) return true;
  return kinds.some(row => row.turnLimit === 'supported');
}
export function prepareBrainPrompt(command: BrainPlanCommand, policy: WorkClassPolicy, context: unknown, configInput: unknown, known?: KnownSecretSnapshot) {
  const config = brainPlannerConfigSchema.parse(configInput), chosenTemplate = selectedBrainTemplate(config), intent = redactForRecord(command.intent, known);
  const modelAssignment = chosenTemplate.modelAssignment ?? 'brain';
  const projected = JSON.stringify(redactJson({ scopeId: command.scopeId, workClasses: brainWorkClassView(policy), context }, known));
  const bytes = new TextEncoder().encode(projected).length;
  if (bytes > config.context.maxBytes) throw ErrorRegistry.createError('BRAIN_CONTEXT_TOO_LARGE', { params: { limit: config.context.maxBytes, observed: bytes, unit: 'bytes' } });
  return Object.freeze({ template: { id: chosenTemplate.id, version: chosenTemplate.version,
    digest: sha256(encodeCommandProjection('brain-template:1', chosenTemplate)) }, summaryChars: chosenTemplate.summaryChars, modelAssignment,
    inputDigest: brainInputDigest(command, known), contextDigest: sha256(projected), intent,
    messages: [{ role: 'system' as const, content: redactForRecord(chosenTemplate.instruction, known) },
      { role: 'user' as const, content: JSON.stringify({ intent, context: JSON.parse(projected) as unknown,
        schema: brainDraftJsonSchema(supportsTurnLimit(context), modelAssignment === 'system') }) }] });
}
/** A reply that is exactly one Markdown code fence around the object (```json … ``` or ``` … ```) is read as its body; anything else is
 * parsed as given. Models add the fence despite the instruction (live /do 2026-10-16, stage json); no other repair is attempted. */
const FENCED = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/u;
function unfence(text: string): string {
  const match = FENCED.exec(text.trim());
  return match ? match[1]! : text;
}
/** The WorkClass vocabulary the Brain plans with: class ids (and parent), the default effort a v1/v2 template may name, the criterion and
 * evidence types a declared criterion acceptance may use, the kind bindings, evidence extensions and advisory permission vocabulary. The
 * acceptance scoring (rubric weights, ceiling rules, thresholds), the proposal-admission risk/standing grant, the silence policy and the
 * worker candidate lists never enter the planning context: the plan is judged by them, so it must not be written against them. */
export function brainWorkClassView(policy: WorkClassPolicy) {
  return { revision: policy.revision,
    classes: policy.classes.map(row => ({ id: row.id, defaultEffort: row.defaultEffort, ...('parentClassId' in row && row.parentClassId !== undefined ? { parentClassId: row.parentClassId } : {}),
      ...('acceptanceProfile' in row ? { acceptance: { criterionTypes: row.acceptanceProfile.criterionTypes, evidenceTypes: row.acceptanceProfile.evidenceTypes } } : {}) })),
    bindings: policy.bindings.map(row => ({ kind: row.kind, classId: row.classId })),
    ...(policy.evidenceExtensions?.length ? { evidenceExtensions: policy.evidenceExtensions } : {}),
    ...(policy.proposalPermissions?.length ? { proposalPermissions: policy.proposalPermissions } : {}) };
}
/** Each failure stage is explicit and contains no provider text or secret-bearing parse diagnostics. */
/** `requireCurrentGraph` is for a NEW model reply only. Verifying a stored proposal's model contribution keeps reading every graph
 * version the contract accepts, so an upgrade never turns a pending, valid older proposal into a rejection (Astra 2524). */
export function parseBrainDraft(text: string, known?: KnownSecretSnapshot, options: { readonly requireCurrentGraph?: boolean } = {}): BrainDraft {
  let input: unknown;
  try { input = redactJson(JSON.parse(unfence(text)) as unknown, known); } catch { throw ErrorRegistry.createError('BRAIN_OUTPUT_INVALID', { params: { stage: 'json' } }); }
  const parsed = brainDraftSchema.safeParse(input);
  if (!parsed.success) throw ErrorRegistry.createError('BRAIN_OUTPUT_INVALID', { params: { stage: 'schema' } });
  if (options.requireCurrentGraph && parsed.data.graph.schemaVersion !== TASK_GRAPH_SCHEMA_VERSION) throw ErrorRegistry.createError('BRAIN_GRAPH_INVALID', { params: { rule: 'TASK_GRAPH_VERSION' } });
  try { validateTaskGraph(parsed.data.graph); } catch (error) {
    throw ErrorRegistry.createError('BRAIN_GRAPH_INVALID', { params: { rule: error instanceof TaskGraphError ? error.code : 'TASK_GRAPH_INVALID' } });
  }
  return parsed.data;
}
/** ATAMA-1 (owner ASS1, A1): under a system-assignment template a NEW reply that names a worker model or effort (or uses the work input
 * version that requires one) is refused, typed. Stored proposals are never re-judged by this rule (their source check reads them as recorded). */
export function assertBrainLeavesAssignment(draft: BrainDraft): void {
  if (draft.graph.tasks.some(task => task.workInput && (task.workInput.schemaVersion !== WORK_INPUT_ASSIGNED_SCHEMA_VERSION
    || task.workInput.model !== undefined || task.workInput.effort !== undefined))) throw ErrorRegistry.createError('BRAIN_ASSIGNMENT_REFUSED');
}
export const brainOutputDigest = (draft: BrainDraft) => sha256(encodeCommandProjection('brain-output:1', draft));
