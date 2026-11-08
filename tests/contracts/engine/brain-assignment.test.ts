import { expect, it } from 'vitest';
import { CORE_WORK_CLASSES, type RunProposal } from '#domain/index.js';
import { assertBrainLeavesAssignment, brainPlannerConfigSchema, parseBrainDraft, prepareBrainPrompt, selectedBrainTemplate } from '#capabilities/index.js';
import { BrainPlanApplication, brainAssignsWorkers, modelInvocationRequestDigest, prepareBrainRegistryPrompt, type BrainPlanPorts } from '#engine/index.js';
import { sha256 } from '#platform/index.js';
import { proposalFixture } from '../support/run-proposal.js';

// ATAMA-1 (owner ASS1, A1): Brain template v3 plans tasks and WorkClasses only. The offered schema has no model or effort, the context offers
// no worker models, and a NEW reply that names either is a typed refusal before any proposal exists. v1/v2 templates and stored proposals keep working.
const command = { schemaVersion: 1 as const, scopeId: 's', commandId: 'brain', intent: 'Append done to note.txt' };
const model = { channelId: 'claude-cli-subscription', modelId: 'claude-opus-5-5', auxiliaryModelIds: [] };
const work = (extra: object = {}) => ({ schemaVersion: 2, task: 'Append done', scope: { paths: ['note.txt'] }, acceptance: 'note.txt ends with done', ...extra });
const draft = (workInput?: object) => { const { graph, budgetCeiling, requiredPermissions } = proposalFixture('feature');
  return { graph: { ...graph, tasks: [{ ...graph.tasks[0]!, kind: 'coding', ...(workInput ? { workInput } : {}) }] }, budgetCeiling, requiredPermissions }; };

it('selects template v6 (F2-11 class descriptions over v5: person language, system assignment, context v3) by default; v1–v5 stay available with their exact bytes', () => {
  expect(selectedBrainTemplate({})).toMatchObject({ id: 'run-proposal', version: 6, modelAssignment: 'system', contextVersion: 3, personLanguage: true });
  const config = brainPlannerConfigSchema.parse({});
  expect(config.templates.map(row => [row.version, row.modelAssignment ?? null])).toEqual([[1, null], [2, null], [3, 'system'], [4, 'system'], [5, 'system'], [6, 'system']]);
  const [v5, v6] = [5, 6].map(version => config.templates.find(row => row.version === version)!.instruction);
  expect(v6).toBe(v5!.replace('acceptance criteria.', "acceptance criteria. Choose each task's WorkClass from the supplied class descriptions: the narrowest class whose description fits that task; a kind's binding is only the default when no narrower class fits."));
  expect(prepareBrainPrompt(command, CORE_WORK_CLASSES, {}, { selected: { id: 'run-proposal', version: 2 } }).modelAssignment).toBe('brain');
  expect(brainAssignsWorkers({})).toBe(false); expect(brainAssignsWorkers({ selected: { id: 'run-proposal', version: 2 } })).toBe(true);
});

it('the v3 schema offers only work input v2 without model or effort; v2 still offers the pinned contract', () => {
  const schemaOf = (config: object) => JSON.parse(prepareBrainPrompt(command, CORE_WORK_CLASSES, {}, config).messages[1]!.content).schema;
  const v3 = schemaOf({}).properties.graph.properties.tasks.items.properties.workInput;
  expect(v3.properties.schemaVersion).toMatchObject({ const: 2 });
  expect(v3.properties).not.toHaveProperty('model'); expect(v3.properties).not.toHaveProperty('effort');
  expect(v3.required ?? []).not.toContain('model');
  expect(JSON.stringify(schemaOf({ selected: { id: 'run-proposal', version: 2 } }).properties.graph.properties.tasks.items.properties.workInput)).toContain('"model"');
});

it('the v3 context offers no worker models even when the caller read some; v2 keeps offering them', () => {
  const registry = { schemaVersion: 1 as const, revision: 'r', profiles: [{ id: 'p', version: 1, adapter: { id: 'test', version: 1 }, parameters: {} }],
    kinds: [{ kind: 'coding', profile: { id: 'p', version: 1 } }], evaluators: [{ id: 'process-exit', version: 1, implementation: { id: 'process-exit', version: 1 } }] };
  const workerModels = [{ profile: { id: 'p', version: 1 }, ...model, availableAuxiliaryModelIds: [], billing: 'subscription', efforts: [] }];
  const contextOf = (config: object) => JSON.parse(prepareBrainRegistryPrompt(command, registry, null, config, undefined, { kinds: [], workerModels: workerModels as never }).messages[1]!.content).context.context;
  expect(contextOf({}).workerModels).toEqual([]);
  expect(contextOf({ selected: { id: 'run-proposal', version: 2 } }).workerModels).toHaveLength(1);
});

it('a reply naming a model, an effort or the pinned work input version is refused; a v2 reply without them is accepted', () => {
  for (const workInput of [work({ model }), work({ model, effort: 'high' }), { ...work(), schemaVersion: 1, model }])
    expect(() => assertBrainLeavesAssignment(parseBrainDraft(JSON.stringify(draft(workInput))))).toThrow(expect.objectContaining({ code: 'BRAIN_ASSIGNMENT_REFUSED' }));
  expect(() => assertBrainLeavesAssignment(parseBrainDraft(JSON.stringify(draft(work()))))).not.toThrow();
  expect(() => assertBrainLeavesAssignment(parseBrainDraft(JSON.stringify(draft())))).not.toThrow();
  // A stored proposal's source check parses as recorded: a pinned v1 reply from a v2-template plan still reads (no rejection after upgrade).
  expect(parseBrainDraft(JSON.stringify(draft({ ...work(), schemaVersion: 1, model }))).graph.tasks[0]!.workInput?.model).toEqual(model);
});

const principal = { id: 'owner', issuer: 'test', subject: 'owner', assurance: 'os-user' as const, scopeIds: ['s'] };
const reference = { providerId: 'p', providerVersion: 1, modelId: 'm', modelVersion: 1 };
const invocation = { schemaVersion: 1 as const, commandId: 'x', scopeId: 's', reference, catalogRevision: 'c', expectedBinding: { encodingVersion: 1 as const, algorithm: 'sha256' as const, digest: 'b'.repeat(64) }, nativeRequest: {} };
async function plan(reply: object, config: object = {}) {
  const proposals: RunProposal[] = [];
  const prompt = prepareBrainPrompt(command, CORE_WORK_CLASSES, {}, config);
  const ports: BrainPlanPorts = {
    inspect: async () => null, prepare: async () => ({ invocation, prompt }),
    invoke: async value => ({ receipt: { request: { requestDigest: modelInvocationRequestDigest(value), commandId: value.commandId, reference, expectedBinding: value.expectedBinding, scopeId: 's' },
      actor: principal, claim: { invocationId: 'inv' }, activationRevision: 1, profile: { schemaVersion: 1, adapter: { definition: {} } },
      outcome: { state: 'responded', content: { digest: sha256('reply') } } } } as never),
    text: () => JSON.stringify(reply), stoppedAtLength: () => false,
    propose: async proposal => { proposals.push(proposal); return {} as never; },
  };
  await new BrainPlanApplication({ verify: async () => principal }, ports).plan(command);
  return proposals;
}
it('the Brain step refuses a v3 reply that picks the worker before any proposal is written; under v2 the same reply still proposes', async () => {
  await expect(plan(draft(work({ model })))).rejects.toMatchObject({ code: 'BRAIN_ASSIGNMENT_REFUSED' });
  await expect(plan(draft({ ...work(), schemaVersion: 1, model }))).rejects.toMatchObject({ code: 'BRAIN_ASSIGNMENT_REFUSED' });
  expect(await plan(draft(work()))).toHaveLength(1);
  expect(await plan(draft({ ...work(), schemaVersion: 1, model }), { selected: { id: 'run-proposal', version: 2 } })).toHaveLength(1);
  // F2-11 (owner walk 2026-11-08): "append one line to notlar.txt" was planned as `feature`, the `coding` kind's binding. A fake Brain answer naming
  // `small` is proposed as `small` (the system binds the class's agent and worker at admission: agent-selection.test.ts), never the kind binding.
  const reply = draft(work({ workClass: 'small' })), [proposal] = await plan({ ...reply, graph: { ...reply.graph, tasks: [{ ...reply.graph.tasks[0]!, workClass: 'small' }] } });
  expect(CORE_WORK_CLASSES.bindings.find(row => row.kind === 'coding')!.classId).toBe('feature');
  expect(proposal!.graph.tasks[0]).toMatchObject({ kind: 'coding', workClass: 'small', workInput: { workClass: 'small' } });
});

it('the planning context carries each WorkClass and its description but none of its worker candidate lists', () => {
  const registry = { schemaVersion: 1 as const, revision: 'r', profiles: [{ id: 'p', version: 1, adapter: { id: 'test', version: 1 }, parameters: {} }],
    kinds: [{ kind: 'coding', profile: { id: 'p', version: 1 } }], evaluators: [{ id: 'process-exit', version: 1, implementation: { id: 'process-exit', version: 1 } }] };
  const content = prepareBrainRegistryPrompt(command, registry, null, {}).messages[1]!.content;
  const classes = JSON.parse(content).context.workClasses.classes as { id: string; description?: string }[];
  expect(classes.map(row => row.id)).toContain('feature');
  // F2-11: each Core class reaches the Brain with its registry planning description (the Brain previously saw class ids only).
  expect(classes.every(row => typeof row.description === 'string' && row.description.length > 0)).toBe(true);
  expect(classes.find(row => row.id === 'small')!.description).toMatch(/append, insert or replace a line/u);
  for (const text of ['candidatePolic', 'claude-opus-5-5', 'gpt-6.1-sol']) expect(content).not.toContain(text);
});

