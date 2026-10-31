import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { parseProviderCatalogDocument, readWorkerModelPin, type CatalogModel, type ExecutionProfileDefinition, type ModelCatalogActivationRecord, type ModelCatalogChannelRecord,
  type ModelCatalogModelRecord, type ModelRolePolicy } from '#domain/index.js';
import { assertRunExecution, assignTaskWorker, composeModelRolePolicy, renderRunCreateApprovalSummary, resolveWorkerEffortExecution, type ModelCatalogReader } from '#engine/index.js';
import { bindNativeWorkerEffort, compileNativeCodingWorkInput, isNativeCodingTemplate, nativeWorkerEffortCapability } from '#adapters/index.js';

// ATAMA-1 (owner ASS1, A1, A5): a work input without a model gets its worker from the task's WorkClass candidate list, through the same
// admission check a pinned model gets; the choice is sealed with the Run. Nothing outside the list is chosen; no admissible candidate is a refusal.
const docker = { imageId: 'sha256:' + 'a'.repeat(64), memoryBytes: 268435456, pids: 64, cpus: 1, logMaxSizeKiB: 64, logMaxFiles: 2, tmpBytes: 16777216,
  deadlineMs: 20000, controlTimeoutMs: 10000, outputBytes: 65536 };
const claude = { provider: 'claude', cliVersion: '2.1.293 (Claude Code)', discovery: { schemaVersion: 1, mode: 'repository' }, permissionMode: 'unattended' };
const codex = { provider: 'codex', cliVersion: 'codex-cli 0.159.2', discovery: { schemaVersion: 1, mode: 'repository' }, permissionMode: 'unattended' };
const template = (id: string, invocation: object) => ({ id, version: 1, adapter: { id: 'native-coding-template', version: 1 }, parameters: { schemaVersion: 1, docker, invocation } });
const registry = (workClasses?: object) => ({ schemaVersion: 1, revision: 'r1', ...(workClasses ? { workClasses } : {}),
  profiles: [template('claude-t', claude), template('codex-t', codex)],
  kinds: [{ kind: 'coding', profile: { id: 'claude-t', version: 1 } }, { kind: 'codex-coding', profile: { id: 'codex-t', version: 1 } }],
  evaluators: [{ id: 'process-exit', version: 1, implementation: { id: 'process-exit', version: 1 } }] });
const input = (extra: object = {}) => ({ schemaVersion: 2, task: 'Append done to note.txt', scope: { paths: ['note.txt'] }, acceptance: 'note.txt ends with done', ...extra });
const graph = (kind: string, workInput: object = input(), workClass?: string) => ({ schemaVersion: 4, revision: 1,
  tasks: [{ id: 't', kind, dependencies: [], acceptanceCriteria: ['exit'], ...(workClass ? { workClass } : {}), workInput }],
  criterionDefinitions: [{ id: 'exit', version: 1, description: 'Zero exit', evaluator: { id: 'process-exit', version: 1 }, parameters: { acceptedExitCodes: [0] } }] });
const validation = { profile() { return undefined; }, criterion() { return undefined; }, isTemplate: isNativeCodingTemplate };
const compiler = { capability: nativeWorkerEffortCapability, bind: bindNativeWorkerEffort,
  compile: (value: ExecutionProfileDefinition, work: unknown, effort?: Parameters<typeof compileNativeCodingWorkInput>[2], evidence?: Parameters<typeof compileNativeCodingWorkInput>[3]) =>
    compileNativeCodingWorkInput(value, work, effort, evidence) };

/** The packaged Claude and Codex catalog documents as ledger rows; activation rows per scope are the test's own. `extra`: catalog rows a test
 * adds as data only (M3 proof), appended to a packaged channel. */
async function catalog(active: Readonly<Record<string, readonly string[]>>, extra: Readonly<Record<string, readonly CatalogModel[]>> = {}) {
  const channels: ModelCatalogChannelRecord[] = [], models = new Map<string, ModelCatalogModelRecord[]>();
  for (const name of ['claude-cli-subscription', 'codex-cli-subscription']) {
    const document = parseProviderCatalogDocument(JSON.parse(await readFile(new URL(`../../../assets/model-catalog/${name}.json`, import.meta.url), 'utf8')));
    for (const provider of document.providers) {
      channels.push({ schemaVersion: 1, channelId: provider.id, revision: 3, providerVersion: provider.version, channel: provider.channel, catalogRevision: document.revision });
      models.set(provider.id, [...provider.models, ...extra[provider.id] ?? []].map(model => ({ schemaVersion: 1, channelId: provider.id, modelId: model.nativeId, revision: 7,
        providerVersion: provider.version, model, catalogRevision: document.revision })));
    }
  }
  const reads: string[] = [];
  const reader: ModelCatalogReader = {
    async channels() { return channels; },
    async channel(id) { return channels.find(row => row.channelId === id) ?? null; },
    async models(id) { return models.get(id) ?? []; },
    async activation(scopeId, channelId, modelId): Promise<ModelCatalogActivationRecord | null> {
      reads.push(`${scopeId}/${channelId}/${modelId ?? '*'}`);
      const ids = active[`${scopeId}/${channelId}`];
      if (!ids) return null;
      return { schemaVersion: 1, scopeId, channelId, modelId, revision: 5, state: modelId === null || ids.includes(modelId) ? 'active' : 'inactive' };
    },
    close() {},
  };
  return { reader, reads };
}
const context = (scopeId = 's', roles: ModelRolePolicy = composeModelRolePolicy(undefined)) => ({ scopeId, nowMs: Date.parse('2026-10-23T12:00:00Z'), roles });
const standard = { channel: 'claude-cli-subscription', model: 'claude-opus-5-5' };

it('takes the first admissible candidate of the WorkClass list and seals it; earlier candidates are kept with their typed refusal', async () => {
  // Core seed: kind `coding` → class `feature` → list `standard` (Opus on Claude, then gpt-6.1-sol on Codex, then a Cursor model).
  const { reader } = await catalog({ 's/claude-cli-subscription': ['claude-opus-5-5'] });
  const execution = await resolveWorkerEffortExecution(graph('coding'), registry(), reader, validation, compiler, context());
  const task = execution.tasks[0]!, pin = readWorkerModelPin(task.profile.parameters)!;
  expect(pin.pin).toEqual({ channelId: standard.channel, modelId: standard.model, auxiliaryModelIds: [] });
  expect(task.assignment).toEqual({ schemaVersion: 1, workClass: 'feature', workClassRevision: 'atama-m3-2026-10-23', candidatePolicy: { id: 'standard', version: 2 },
    candidateIndex: 0, channelId: standard.channel, modelId: standard.model, catalogRevision: 'claude-cli-subscription-2026-10-31', modelRevision: 7, activationRevision: 5,
    // A1: the Claude catalog declares no vendor default and the list names no deviation, so the CLI's own default stays in place.
    effort: { level: null, source: 'cli-default' }, skipped: [] });
  expect(pin.reasoningEffort).toMatchObject({ level: null, source: 'cli-default' });
  // The Brain never named the model: the request carried none, and the Run's integrity check accepts exactly this seal.
  expect(assertRunExecution(graph('coding'), execution).tasks[0]!.assignment).toEqual(task.assignment);
});

it('skips an inactive, an unknown-channel and a CLI-mismatched candidate with their reasons; nothing outside the list is chosen', async () => {
  // A Codex template: the Claude candidate is the wrong CLI, gpt-6.1-sol is not active in the scope, Cursor is not in the catalog at all.
  const { reader } = await catalog({ 's/codex-cli-subscription': ['gpt-6-luna'] });
  await expect(resolveWorkerEffortExecution(graph('codex-coding', input(), 'feature'), registry(), reader, validation, compiler, context()))
    .rejects.toMatchObject({ code: 'WORKER_ASSIGNMENT_NONE', detail: { taskId: 't', workClass: 'feature', channelId: null, modelId: null,
      skipped: 'claude-cli-subscription/claude-opus-5-5: WORKER_CHANNEL_MISMATCH; codex-cli-subscription/gpt-6.1-sol: WORKER_MODEL_NOT_ACTIVE; '
        + 'cursor-cli-subscription/claude-opus-5-thinking-high: WORKER_CHANNEL_NOT_ACTIVE' } });
  // The light list names gpt-6-luna second: it is chosen, its catalog vendor default (medium) is the effort, and the skip is sealed.
  const execution = await resolveWorkerEffortExecution(graph('codex-coding', input(), 'small'), registry(), reader, validation, compiler, context());
  expect(execution.tasks[0]!.assignment).toMatchObject({ workClass: 'small', candidatePolicy: { id: 'light', version: 2 }, candidateIndex: 1, modelId: 'gpt-6-luna',
    catalogRevision: 'codex-cli-subscription-2026-10-23', effort: { level: 'medium', source: 'catalog' },
    skipped: [{ index: 0, channelId: 'claude-cli-subscription', modelId: 'claude-sonnet-5-5', reason: 'WORKER_CHANNEL_MISMATCH' }] });
  expect(readWorkerModelPin(execution.tasks[0]!.profile.parameters)!.reasoningEffort).toMatchObject({ level: 'medium', source: 'policy-default', workClass: 'small', target: 'medium' });
});

it('a candidate deviation is the effort target (A1), clamped to what the model supports, and recorded as the candidate\'s', async () => {
  const { reader } = await catalog({ 's/codex-cli-subscription': ['gpt-6.1-sol'] });
  const execution = await resolveWorkerEffortExecution(graph('codex-coding', input(), 'architecture'), registry(), reader, validation, compiler, context());
  expect(execution.tasks[0]!.assignment).toMatchObject({ candidatePolicy: { id: 'deep', version: 2 }, candidateIndex: 2, modelId: 'gpt-6.1-sol', effort: { level: 'high', source: 'candidate' } });
});

it('activation is per scope: the same plan is assigned in the scope that activated the model and refused in one that did not', async () => {
  const { reader, reads } = await catalog({ 'a/claude-cli-subscription': ['claude-opus-5-5'], 'b/claude-cli-subscription': [] });
  expect((await resolveWorkerEffortExecution(graph('coding'), registry(), reader, validation, compiler, context('a'))).tasks[0]!.assignment?.modelId).toBe('claude-opus-5-5');
  await expect(resolveWorkerEffortExecution(graph('coding'), registry(), reader, validation, compiler, context('b')))
    .rejects.toMatchObject({ code: 'WORKER_ASSIGNMENT_NONE', detail: { skipped: expect.stringContaining('claude-opus-5-5: WORKER_MODEL_NOT_ACTIVE') } });
  // Scope b's admission read only scope b's activation rows.
  expect(reads.filter(row => !row.startsWith('a/') && !row.startsWith('b/'))).toEqual([]);
});

it('replaying the same admission inputs seals byte-identical execution; a different catalog fact is a different seal, never a silent reuse', async () => {
  const { reader } = await catalog({ 's/claude-cli-subscription': ['claude-opus-5-5'] });
  const first = JSON.stringify(await resolveWorkerEffortExecution(graph('coding'), registry(), reader, validation, compiler, context()));
  expect(JSON.stringify(await resolveWorkerEffortExecution(graph('coding'), registry(), reader, validation, compiler, context()))).toBe(first);
});

it('the Run integrity check refuses a seal that disagrees with the frozen pin, a missing seal and a seal on a pinned input', async () => {
  const { reader } = await catalog({ 's/claude-cli-subscription': ['claude-opus-5-5', 'claude-sonnet-5-5'] });
  const execution = await resolveWorkerEffortExecution(graph('coding'), registry(), reader, validation, compiler, context());
  const task = execution.tasks[0]!, { assignment, ...unsealed } = task;
  const tampered = (value: object) => ({ ...execution, tasks: [value] });
  expect(() => assertRunExecution(graph('coding'), tampered({ ...task, assignment: { ...assignment!, modelId: 'claude-sonnet-5-5' } }))).toThrow('RUN_EXECUTION_INTEGRITY');
  expect(() => assertRunExecution(graph('coding'), tampered({ ...task, assignment: { ...assignment!, effort: { level: 'high', source: 'candidate' } } }))).toThrow('RUN_EXECUTION_INTEGRITY');
  expect(() => assertRunExecution(graph('coding'), tampered(unsealed))).toThrow('RUN_EXECUTION_INTEGRITY');
  const pinned = graph('coding', input({ model: { channelId: standard.channel, modelId: standard.model, auxiliaryModelIds: [] } }));
  expect(() => assertRunExecution(pinned, execution)).toThrow('RUN_EXECUTION_INTEGRITY');
});

it('an explicit pin (work input v1, or v2 naming its model) keeps today\'s path: no assignment, the pinned model even when the list would differ', async () => {
  const { reader } = await catalog({ 's/claude-cli-subscription': ['claude-opus-5-5', 'claude-sonnet-5-5'] });
  for (const work of [{ ...input(), schemaVersion: 1, model: { channelId: standard.channel, modelId: 'claude-sonnet-5-5', auxiliaryModelIds: [] } },
    input({ model: { channelId: standard.channel, modelId: 'claude-sonnet-5-5', auxiliaryModelIds: [] } })]) {
    const execution = await resolveWorkerEffortExecution(graph('coding', work), registry(), reader, validation, compiler, context());
    expect(execution.tasks[0]!.assignment).toBeUndefined();
    expect(readWorkerModelPin(execution.tasks[0]!.profile.parameters)!.pin.modelId).toBe('claude-sonnet-5-5');
    // The pinned path keeps the class default target (feature = xhigh, clamped to what the model supports).
    expect(readWorkerModelPin(execution.tasks[0]!.profile.parameters)!.reasoningEffort).toMatchObject({ source: 'policy-default', workClass: 'feature', target: 'xhigh' });
  }
});

it('a class without a candidate list, an unknown class and a missing admission context are typed refusals, never a default model', async () => {
  const { reader } = await catalog({ 's/claude-cli-subscription': ['claude-opus-5-5'] });
  const overlay = { schemaVersion: 2, revision: 'erp-1', classes: [{ id: 'erp', defaultEffort: 'medium', acceptanceProfile: { schemaVersion: 1, version: 1, criterionTypes: ['completion'],
    evidenceTypes: ['retained-artifact'], rubric: [{ criterionType: 'completion', evidenceTypes: ['retained-artifact'], weight: 1 }], ceilingRules: [], decisionThresholds: { rejectBelow: 0.5, acceptAt: 1 } } }],
    bindings: [] };
  await expect(resolveWorkerEffortExecution(graph('coding', input(), 'erp'), registry(overlay), reader, validation, compiler, context()))
    .rejects.toMatchObject({ code: 'WORKER_ASSIGNMENT_NO_CANDIDATES', detail: { taskId: 't', workClass: 'erp' } });
  await expect(resolveWorkerEffortExecution(graph('coding', input(), 'missing'), registry(), reader, validation, compiler, context()))
    .rejects.toMatchObject({ code: 'WORK_CLASS_NOT_REGISTERED' });
  await expect(resolveWorkerEffortExecution(graph('coding'), registry(), reader, validation, compiler))
    .rejects.toMatchObject({ code: 'WORKER_ASSIGNMENT_NO_CANDIDATES' });
  // The adapter compiler never receives a model-less input on its own: it refuses it typed.
  expect(() => compileNativeCodingWorkInput(template('claude-t', claude), input())).toThrow(expect.objectContaining({ code: 'WORKER_MODEL_UNASSIGNED' }));
});

it('an Enterprise overlay replaces a Core list only by compare-and-set and the assignment then reads the replacement', async () => {
  const { reader } = await catalog({ 's/claude-cli-subscription': ['claude-sonnet-5-5'] });
  const replaced = { schemaVersion: 4, revision: 'acme-1', classes: [{ id: 'acme-feature', candidatePolicyId: 'standard', defaultEffort: 'high', acceptanceProfile: {
    schemaVersion: 1, version: 1, criterionTypes: ['completion'], evidenceTypes: ['retained-artifact'], rubric: [{ criterionType: 'completion', evidenceTypes: ['retained-artifact'], weight: 1 }],
    ceilingRules: [], decisionThresholds: { rejectBelow: 0.5, acceptAt: 1 } } }], bindings: [], evidenceExtensions: [],
    candidatePolicies: [{ id: 'standard', version: 3, override: { previousVersion: 2 }, candidates: [{ channelId: standard.channel, modelId: 'claude-sonnet-5-5', effort: 'medium' }] }] };
  const execution = await resolveWorkerEffortExecution(graph('coding'), registry(replaced), reader, validation, compiler, context());
  expect(execution.tasks[0]!.assignment).toMatchObject({ workClass: 'feature', workClassRevision: JSON.stringify(['atama-m3-2026-10-23', 'acme-1']),
    candidatePolicy: { id: 'standard', version: 3 }, candidateIndex: 0, modelId: 'claude-sonnet-5-5', effort: { level: 'medium', source: 'candidate' } });
  const stale = { ...replaced, candidatePolicies: [{ ...replaced.candidatePolicies[0]!, override: undefined }] };
  await expect(resolveWorkerEffortExecution(graph('coding'), registry(JSON.parse(JSON.stringify(stale))), reader, validation, compiler, context()))
    .rejects.toThrow('WORK_CLASS_OVERRIDE_DENIED');
});

it('assignTaskWorker reads only: it compiles candidates onto the template and returns the chosen input without writing anything', async () => {
  const { reader } = await catalog({ 's/claude-cli-subscription': ['claude-opus-5-5'] });
  const compiled: string[] = [];
  const result = await assignTaskWorker({ id: 't', kind: 'coding' }, input() as never, template('claude-t', claude) as never, undefined, reader,
    (value, work) => { compiled.push(work.model!.modelId); return compileNativeCodingWorkInput(value, work); }, context());
  expect(result.input.model).toEqual({ channelId: standard.channel, modelId: standard.model, auxiliaryModelIds: [] });
  expect(compiled).toEqual([standard.model]);
});

it('the approval card shows the assigned worker, its effort and the list position, and names each skipped candidate (EN/TR)', async () => {
  const { reader } = await catalog({ 's/claude-cli-subscription': ['claude-fable-5-1'] });
  const planned = graph('coding', input(), 'design'), execution = await resolveWorkerEffortExecution(planned, registry(), reader, validation, compiler, context());
  const command = { schemaVersion: 1 as const, commandId: 'create', scopeId: 's', runId: 'run-a', graph: planned as never };
  const create = { commandId: 'create', actor: { id: 'o', issuer: 'test', subject: 'o' }, graph: planned as never, identity: { scopeId: 's', runId: 'run-a', layoutRevision: 'l' }, now: 1,
    execution, policy: { schemaVersion: 2 as const, poolId: 'p', capacity: { executionSlots: 1, inFlightSlots: 1 }, ordering: ['t'] } };
  const verdict = { decision: 'require-approval', revision: 'p1', reason: 'APPROVAL_REQUIRED' } as const;
  const en = renderRunCreateApprovalSummary(command, create, verdict, 'en'), tr = renderRunCreateApprovalSummary(command, create, verdict, 'tr');
  expect(en).toContain('worker: claude-fable-5-1 (claude-cli-subscription) · effort: high · from the design list deep@2, choice 2');
  expect(en).toContain('skipped before it: claude-opus-5-5 (WORKER_MODEL_NOT_ACTIVE)');
  expect(tr).toContain('çalışan: claude-fable-5-1 (claude-cli-subscription) · effort: high · design listesinden (deep@2), 2. seçenek');
  expect(tr).toContain('ondan önce atlananlar: claude-opus-5-5 (WORKER_MODEL_NOT_ACTIVE)');
  // A pinned task's card is byte-identical to before: no worker line.
  const pinned = graph('coding', input({ model: { channelId: standard.channel, modelId: 'claude-fable-5-1', auxiliaryModelIds: [] } }));
  const pinnedExecution = await resolveWorkerEffortExecution(pinned, registry(), reader, validation, compiler, context());
  expect(renderRunCreateApprovalSummary({ ...command, graph: pinned as never }, { ...create, graph: pinned as never, execution: pinnedExecution }, verdict, 'en')).not.toContain('worker:');
});
