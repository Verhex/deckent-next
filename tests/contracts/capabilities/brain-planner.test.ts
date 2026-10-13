import { expect, it } from 'vitest';
import { CORE_WORK_CLASSES } from '#domain/index.js';
import { prepareBrainPrompt, parseBrainDraft, brainOutputDigest, brainPlannerConfigSchema } from '#capabilities/index.js';
import { snapshotKnownSecrets } from '#platform/index.js';
import { proposalFixture } from '../support/run-proposal.js';
const command = { schemaVersion: 1 as const, scopeId: 's', commandId: 'brain', intent: 'Plan a durable customer process' };
const { graph, budgetCeiling, requiredPermissions } = proposalFixture();
const draft = { graph, budgetCeiling, requiredPermissions };
it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '64'])('refuses invalid planner completion budget %j', maxCompletionTokens => {
  expect(brainPlannerConfigSchema.safeParse({ maxCompletionTokens }).success).toBe(false);
});
it('defaults to model behavior and inherited chat budget, with explicit validated choices', () => {
  expect(brainPlannerConfigSchema.parse({})).toMatchObject({ maxCompletionTokens: null, reasoning: 'model-default' });
  expect(brainPlannerConfigSchema.parse({ maxCompletionTokens: 64, reasoning: 'off' })).toMatchObject({ maxCompletionTokens: 64, reasoning: 'off' });
  expect(brainPlannerConfigSchema.safeParse({ reasoning: 'on' }).success).toBe(false);
});
it('uses a configured versioned template, actual catalogs and the same proposal JSON schema without model or authority literals', () => {
  const prompt = prepareBrainPrompt(command, CORE_WORK_CLASSES, { permissions: ['inspect'] }, { selected: { id: 'customer', version: 7 },
    templates: [{ id: 'customer', version: 7, instruction: 'Propose only', summaryChars: 200 }] });
  expect(prompt.template).toMatchObject({ id: 'customer', version: 7 }); expect(prompt.messages[0]!.content).toBe('Propose only');
  const user = JSON.parse(prompt.messages[1]!.content);
  expect(user.context.scopeId).toBe('s'); expect(user.context.context.permissions).toEqual(['inspect']);
  expect(user.schema.properties).toHaveProperty('graph'); expect(user.schema.properties).not.toHaveProperty('proposer');
  expect(brainOutputDigest(parseBrainDraft(JSON.stringify(draft)))).toHaveLength(64);
});
it.each(['missing', 'duplicate'])('refuses %s selected template instead of fallback', kind => {
  const row = { id: 'missing', version: 1, instruction: 'Propose', summaryChars: 200 };
  expect(() => prepareBrainPrompt(command, CORE_WORK_CLASSES, {}, { selected: { id: 'missing', version: 1 }, templates: kind === 'missing' ? [{ ...row, version: 2 }] : [row, row] }))
    .toThrow(expect.objectContaining({ code: 'BRAIN_TEMPLATE_UNAVAILABLE' }));
});
it.each([['not-json', 'json'], [JSON.stringify({ ...draft, approved: true }), 'schema']] as const)('stages %s failures without provider diagnostics', (input, stage) => {
  expect(() => parseBrainDraft(input)).toThrow(expect.objectContaining({ code: 'BRAIN_OUTPUT_INVALID', params: { stage } }));
});
it.each([
  ['TASK_GRAPH_CYCLE', { ...graph.tasks[0]!, dependencies: ['task'] }],
  ['TASK_CRITERION_DEFINITION_MISSING', { ...graph.tasks[0]!, acceptanceCriteria: ['invented'] }],
  ['TASK_DEPENDENCY_MISSING', { ...graph.tasks[0]!, dependencies: ['invented'] }],
] as const)('keeps safe graph rule %s without provider text', (rule, task) => {
  expect(() => parseBrainDraft(JSON.stringify({ ...draft, graph: { ...graph, tasks: [task] } })))
    .toThrow(expect.objectContaining({ code: 'BRAIN_GRAPH_INVALID', params: { rule } }));
});
it('supplies criterion-id annotation and selects v2 while keeping v1 available', () => {
  const current = prepareBrainPrompt(command, CORE_WORK_CLASSES, {}, {});
  expect(current.template.version).toBe(2);
  const schema = JSON.parse(current.messages[1]!.content).schema;
  expect(schema.properties.graph.properties.tasks.items.properties.acceptanceCriteria.description).toContain('criterionDefinitions ids');
  const old = prepareBrainPrompt(command, CORE_WORK_CLASSES, {}, { selected: { id: 'run-proposal', version: 1 } });
  expect(old.template.version).toBe(1);
});
it('masks both credential-shaped and known escaped secrets before model context, output graph or summary can retain them', () => {
  const secret = 'opaque"and\\quoted', known = snapshotKnownSecrets([{ name: 'FIXTURE', value: secret }]);
  const prompt = prepareBrainPrompt({ ...command, intent: 'api_key=sk-fixture ' + secret }, CORE_WORK_CLASSES, { notes: secret }, {}, known);
  expect(JSON.stringify(prompt.messages)).not.toContain('sk-fixture'); expect(prompt.messages[1]!.content).not.toContain(JSON.stringify(secret).slice(1, -1));
  expect(JSON.parse(prompt.messages[1]!.content).intent).toContain('[REDACTED]');
  const parsed = parseBrainDraft(JSON.stringify({ ...draft, graph: { ...graph,
    criterionDefinitions: [{ ...graph.criterionDefinitions[0]!, description: secret }] } }), known);
  expect(parsed.graph.criterionDefinitions[0]!.description).toBe('‹secret:FIXTURE›');
});
