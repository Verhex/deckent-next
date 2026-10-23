import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { catalogModelSchema, parseProviderCatalogDocument, readWorkerModelPin, WORK_CLASS_LIMITS, workerAssignmentSchema, type CatalogModel, type ExecutionProfileDefinition,
  type ModelCatalogActivationRecord, type ModelCatalogChannelRecord, type ModelCatalogModelRecord } from '#domain/index.js';
import { assertRunExecution, composeModelRolePolicy, renderRunCreateApprovalSummary, resolveWorkerEffortExecution, type ModelCatalogReader } from '#engine/index.js';
import { bindNativeWorkerEffort, compileNativeCodingWorkInput, isNativeCodingTemplate, nativeWorkerEffortCapability } from '#adapters/index.js';

// M3 (MODEL-INDEPENDENCE-AUDIT, owner 2026-10-23: a new model works through data only): WorkClass v5 candidate selectors expand through the
// tier/role registry (S2) ∩ the scope's catalog ∩ activation, then the unchanged worker admission; exact candidates must hold the worker role too.
const docker = { imageId: 'sha256:' + 'a'.repeat(64), memoryBytes: 268435456, pids: 64, cpus: 1, logMaxSizeKiB: 64, logMaxFiles: 2, tmpBytes: 16777216,
  deadlineMs: 20000, controlTimeoutMs: 10000, outputBytes: 65536 };
const claude = { provider: 'claude', cliVersion: '2.1.293 (Claude Code)', discovery: { schemaVersion: 1, mode: 'repository' }, permissionMode: 'unattended' };
const template = { id: 'claude-t', version: 1, adapter: { id: 'native-coding-template', version: 1 }, parameters: { schemaVersion: 1, docker, invocation: claude } };
const profile = { schemaVersion: 1, version: 1, criterionTypes: ['completion'], evidenceTypes: ['retained-artifact'],
  rubric: [{ criterionType: 'completion', evidenceTypes: ['retained-artifact'], weight: 1 }], ceilingRules: [], decisionThresholds: { rejectBelow: 0.5, acceptAt: 1 } };
const registry = (workClasses?: object) => ({ schemaVersion: 1, revision: 'r1', ...(workClasses ? { workClasses } : {}), profiles: [template],
  kinds: [{ kind: 'coding', profile: { id: 'claude-t', version: 1 } }],
  evaluators: [{ id: 'process-exit', version: 1, implementation: { id: 'process-exit', version: 1 } }] });
const input = { schemaVersion: 2, task: 'Append done to note.txt', scope: { paths: ['note.txt'] }, acceptance: 'note.txt ends with done' };
const graph = (workClass?: string) => ({ schemaVersion: 4, revision: 1,
  tasks: [{ id: 't', kind: 'coding', dependencies: [], acceptanceCriteria: ['exit'], ...(workClass ? { workClass } : {}), workInput: input }],
  criterionDefinitions: [{ id: 'exit', version: 1, description: 'Zero exit', evaluator: { id: 'process-exit', version: 1 }, parameters: { acceptedExitCodes: [0] } }] });
const validation = { profile() { return undefined; }, criterion() { return undefined; }, isTemplate: isNativeCodingTemplate };
const compiler = { capability: nativeWorkerEffortCapability, bind: bindNativeWorkerEffort,
  compile: (value: ExecutionProfileDefinition, work: unknown, effort?: Parameters<typeof compileNativeCodingWorkInput>[2], evidence?: Parameters<typeof compileNativeCodingWorkInput>[3]) =>
    compileNativeCodingWorkInput(value, work, effort, evidence) };
const CHANNEL = 'claude-cli-subscription';
const packaged = parseProviderCatalogDocument(JSON.parse(await readFile(new URL(`../../../assets/model-catalog/${CHANNEL}.json`, import.meta.url), 'utf8')));
const provider = packaged.providers[0]!;
/** A model that exists only as data: a catalog row cloned from a packaged one under a new, neutral exact id. */
const newModel = (id: string, extra: object = {}): CatalogModel => catalogModelSchema.parse({ ...provider.models.find(row => row.nativeId === 'claude-opus-5-5')!,
  id, nativeId: id, channelModelId: id, canonicalModelId: id, displayName: id, ...extra });
/** A catalog row without maker metadata (catalog v2 shape): its maker is unknown. */
const makerless = (id: string): CatalogModel => catalogModelSchema.parse({ id, version: 1, nativeId: id, protocols: [{ family: 'claude-code-stream-json', version: 'v1', capabilities: [] }],
  lifecycle: { state: 'active', deprecatedOn: null, retireNotBefore: null, retiredOn: null, source: null }, minCliVersion: null, aliases: [], efforts: ['low', 'medium', 'high'] });
function catalog(active: readonly string[], extra: readonly CatalogModel[] = []) {
  const channel: ModelCatalogChannelRecord = { schemaVersion: 1, channelId: CHANNEL, revision: 3, providerVersion: provider.version, channel: provider.channel, catalogRevision: packaged.revision };
  const models: ModelCatalogModelRecord[] = [...provider.models, ...extra].map(model => ({ schemaVersion: 1, channelId: CHANNEL, modelId: model.nativeId, revision: 7,
    providerVersion: provider.version, model, catalogRevision: packaged.revision }));
  const reader: ModelCatalogReader = {
    async channels() { return [channel]; },
    async channel(id) { return id === CHANNEL ? channel : null; },
    async models(id) { return id === CHANNEL ? models : []; },
    async activation(scopeId, channelId, modelId): Promise<ModelCatalogActivationRecord | null> {
      if (channelId !== CHANNEL) return null;
      return { schemaVersion: 1, scopeId, channelId, modelId, revision: 5, state: modelId === null || active.includes(modelId) ? 'active' : 'inactive' };
    },
    close() {},
  };
  return reader;
}
const roleRow = (modelId: string, tier: 'worker' | 'frontier', roles: readonly string[] = ['worker'], extra: object = {}) => ({ channelId: CHANNEL, modelId, version: 1, tier, roles, ...extra });
const roles = (models: readonly object[] = [], extraRoles: readonly object[] = []) => composeModelRolePolicy(models.length + extraRoles.length === 0 ? undefined
  : { schemaVersion: 1, overlays: [{ schemaVersion: 1, revision: 'acme-roles-1', roles: extraRoles, models, exceptions: [] }] });
const context = (policy = roles()) => ({ scopeId: 's', nowMs: Date.parse('2026-10-23T12:00:00Z'), roles: policy });
const v5 = (candidates: readonly object[]) => ({ schemaVersion: 5, revision: 'acme-v5', bindings: [], evidenceExtensions: [],
  classes: [{ id: 'acme', candidatePolicyId: 'acme-list', defaultEffort: 'high', acceptanceProfile: profile }],
  candidatePolicies: [{ id: 'acme-list', version: 1, candidates }] });
const assign = (reader: ModelCatalogReader, policy = roles(), workClass?: string, workClasses?: object) =>
  resolveWorkerEffortExecution(graph(workClass), registry(workClasses), reader, validation, compiler, context(policy));

it('PROOF: a new model added only as data (catalog row + role row + activation) joins the Core candidate list, with zero source edits', async () => {
  const id = 'acme-frontier-next', reader = catalog([id], [newModel(id)]), policy = roles([roleRow(id, 'frontier')]);
  // Core seed: kind `coding` → class `feature` → list `standard`, whose tail selector takes frontier-tier worker models in registry order.
  const execution = await assign(reader, policy), task = execution.tasks[0]!;
  expect(readWorkerModelPin(task.profile.parameters)!.pin).toEqual({ channelId: CHANNEL, modelId: id, auxiliaryModelIds: [] });
  const expansionDigest = createHash('sha256').update(JSON.stringify([{ role: 'worker', minTier: 'frontier' }, policy.revision, [[CHANNEL, id]]]), 'utf8').digest('hex');
  expect(task.assignment).toEqual({ schemaVersion: 2, workClass: 'feature', workClassRevision: 'atama-m3-2026-10-23', candidatePolicy: { id: 'standard', version: 2 },
    candidateIndex: 3, channelId: CHANNEL, modelId: id, catalogRevision: packaged.revision, modelRevision: 7, activationRevision: 5,
    effort: { level: null, source: 'cli-default' },
    selector: { roleRevision: JSON.stringify(['model-roles-2026-10-23', 'acme-roles-1']), expanded: 1, position: 0, expansionDigest },
    skipped: [{ index: 0, channelId: CHANNEL, modelId: 'claude-opus-5-5', reason: 'WORKER_MODEL_NOT_ACTIVE' },
      { index: 1, channelId: 'codex-cli-subscription', modelId: 'gpt-6.1-sol', reason: 'WORKER_CHANNEL_NOT_ACTIVE' },
      { index: 2, channelId: 'cursor-cli-subscription', modelId: 'claude-opus-5-thinking-high', reason: 'WORKER_CHANNEL_NOT_ACTIVE' }] });
  expect(assertRunExecution(graph(), execution).tasks[0]!.assignment).toEqual(task.assignment);
  // Replay of the same admission inputs seals byte-identical execution.
  expect(JSON.stringify(await assign(reader, policy))).toBe(JSON.stringify(execution));
  // Negative (fail-closed): the same catalog row and activation WITHOUT a role row never becomes a candidate.
  await expect(assign(reader, roles())).rejects.toMatchObject({ code: 'WORKER_ASSIGNMENT_NONE' });
  // A worker-tier role row joins the light list's tail instead, never a frontier list.
  const light = roles([roleRow(id, 'worker')]);
  await expect(assign(reader, light)).rejects.toMatchObject({ code: 'WORKER_ASSIGNMENT_NONE' });
  expect((await assign(reader, light, 'small')).tasks[0]!.assignment).toMatchObject({ schemaVersion: 2, candidatePolicy: { id: 'light', version: 2 }, candidateIndex: 3, modelId: id });
});

it('an exact candidate without the worker role is skipped typed (the bypass is closed); a choice that met no selector keeps the v1 seal', async () => {
  // An installation overlay withdraws the worker role from one Core row by compare-and-set.
  const policy = roles([roleRow('claude-opus-5-5', 'frontier', ['brain'], { version: 2, override: { previousVersion: 1 } })]);
  const reader = catalog(['claude-opus-5-5', 'claude-fable-5-1']);
  const execution = await assign(reader, policy), seal = execution.tasks[0]!.assignment!;
  expect(seal).toMatchObject({ schemaVersion: 2, candidateIndex: 3, modelId: 'claude-fable-5-1', selector: { expanded: 1, position: 0 } });
  expect(seal.skipped[0]).toEqual({ index: 0, channelId: CHANNEL, modelId: 'claude-opus-5-5', reason: 'WORKER_MODEL_ROLE_REFUSED' });
  // The design list names Fable second: no selector reached, so the seal is the alpha.54 v1 shape (rollback-readable).
  const deep = (await assign(reader, policy, 'design')).tasks[0]!.assignment!;
  expect(deep).toMatchObject({ schemaVersion: 1, candidatePolicy: { id: 'deep', version: 2 }, candidateIndex: 1, modelId: 'claude-fable-5-1', effort: { source: 'candidate' } });
  expect('selector' in deep).toBe(false);
});

it('selector filters: maxTier keeps frontier models out of the light tail; tiers, makers and channels narrow; an unknown maker never matches', async () => {
  // light: Sonnet (head) is inactive; Opus (frontier) and Haiku (worker) are active → the tail takes Haiku, never Opus.
  expect((await assign(catalog(['claude-opus-5-5', 'claude-haiku-5-5']), roles(), 'small')).tasks[0]!.assignment)
    .toMatchObject({ schemaVersion: 2, candidateIndex: 3, modelId: 'claude-haiku-5-5', selector: { expanded: 1, position: 0 } });
  const odd = 'acme-unknown-maker', reader = catalog([odd, 'claude-sonnet-5-5'], [makerless(odd)]), policy = roles([roleRow(odd, 'worker')]);
  const pick = async (selector: object) => (await assign(reader, policy, 'acme', v5([selector]))).tasks[0]!.assignment!.modelId;
  expect(await pick({ role: 'worker', makerIn: ['anthropic'] })).toBe('claude-sonnet-5-5');
  await expect(pick({ role: 'worker', makerNotIn: ['anthropic'] })).rejects.toMatchObject({ code: 'WORKER_ASSIGNMENT_NONE' });
  await expect(pick({ role: 'worker', makerIn: ['acme'] })).rejects.toMatchObject({ code: 'WORKER_ASSIGNMENT_NONE' });
  await expect(pick({ role: 'worker', channelIn: ['codex-cli-subscription'] })).rejects.toMatchObject({ code: 'WORKER_ASSIGNMENT_NONE' });
  await expect(pick({ role: 'worker', minTier: 'frontier' })).rejects.toMatchObject({ code: 'WORKER_ASSIGNMENT_NONE' });
  // The registry order decides within one expansion: Sonnet's Core row precedes the overlay row.
  expect(await pick({ role: 'worker' })).toBe('claude-sonnet-5-5');
  expect(await pick({ role: 'worker', channelIn: [CHANNEL], effort: 'low' })).toBe('claude-sonnet-5-5');
  // A model already tried is not tried twice: an exact entry after a selector that covered it adds no second skip. The choice after a
  // selector is a v2 seal without expansion facts (the chosen entry is exact).
  const late = 'acme-needs-newer-cli', tooNew = newModel(late, { minCliVersion: '9.9.9', minClientVersion: '9.9.9' });
  const twice = await assign(catalog([late, 'claude-sonnet-5-5'], [tooNew]), roles([roleRow(late, 'frontier')]), 'acme',
    v5([{ role: 'worker', minTier: 'frontier' }, { channelId: CHANNEL, modelId: late }, { channelId: CHANNEL, modelId: 'claude-sonnet-5-5' }]));
  expect(twice.tasks[0]!.assignment).toEqual(expect.objectContaining({ schemaVersion: 2, candidateIndex: 2, modelId: 'claude-sonnet-5-5',
    skipped: [{ index: 0, channelId: CHANNEL, modelId: late, reason: 'WORKER_MODEL_CLI_TOO_OLD' }] }));
  expect('selector' in twice.tasks[0]!.assignment!).toBe(false);
});

it('a selector naming an unregistered role, and expansions over the registry bound, are typed refusals: nothing is truncated', async () => {
  await expect(assign(catalog(['claude-sonnet-5-5']), roles(), 'acme', v5([{ role: 'auditor' }]))).rejects.toMatchObject({ code: 'MODEL_ROLE_NOT_REGISTERED' });
  const many = Array.from({ length: WORK_CLASS_LIMITS.expandedCandidatesPerPolicy + 1 }, (_, index) => `acme-many-${index}`);
  const reader = catalog(many, many.map(id => makerless(id))), policy = roles(many.map(id => roleRow(id, 'worker')));
  await expect(assign(reader, policy, 'acme', v5([{ role: 'worker', channelIn: [CHANNEL] }])))
    .rejects.toMatchObject({ code: 'WORKER_ASSIGNMENT_EXPANSION_LIMIT', detail: { taskId: 't', workClass: 'acme' } });
  // Within the bound the same data is a normal choice.
  const fits = many.slice(0, WORK_CLASS_LIMITS.expandedCandidatesPerPolicy);
  expect((await assign(catalog(fits, fits.map(id => makerless(id))), roles(fits.map(id => roleRow(id, 'worker'))), 'acme',
    v5([{ role: 'worker', channelIn: [CHANNEL] }]))).tasks[0]!.assignment).toMatchObject({ modelId: fits[0], selector: { expanded: fits.length } });
});

it('the v2 seal is exact: skips stay in order up to the chosen entry, and the count at the chosen entry is its expansion position', () => {
  const seal = { schemaVersion: 2, workClass: 'feature', workClassRevision: 'r', candidatePolicy: { id: 'standard', version: 2 }, candidateIndex: 1,
    channelId: 'c', modelId: 'm', catalogRevision: 'cat', modelRevision: 1, activationRevision: 1, effort: { level: null, source: 'cli-default' },
    selector: { roleRevision: 'roles', expanded: 3, position: 1, expansionDigest: 'a'.repeat(64) },
    skipped: [{ index: 0, channelId: 'c', modelId: 'n', reason: 'WORKER_MODEL_NOT_ACTIVE' }, { index: 1, channelId: 'c', modelId: 'o', reason: 'WORKER_CHANNEL_MISMATCH' }] };
  expect(workerAssignmentSchema.parse(seal)).toEqual(seal);
  for (const broken of [{ ...seal, skipped: [seal.skipped[1]!, seal.skipped[0]!] }, { ...seal, selector: { ...seal.selector, position: 0 } },
    { ...seal, selector: { ...seal.selector, position: 3 } }, { ...seal, selector: { ...seal.selector, expansionDigest: 'x' } },
    { ...seal, skipped: [...seal.skipped, { index: 2, channelId: 'c', modelId: 'p', reason: 'WORKER_MODEL_NOT_ACTIVE' }] }, { ...seal, extra: true }]) {
    expect(workerAssignmentSchema.safeParse(broken).success).toBe(false);
  }
  // A v1 seal (alpha.54) still parses unchanged.
  const rest = Object.fromEntries(Object.entries(seal).filter(([key]) => key !== 'selector'));
  expect(workerAssignmentSchema.parse({ ...rest, schemaVersion: 1, skipped: [seal.skipped[0]!] })).toMatchObject({ schemaVersion: 1 });
  expect(workerAssignmentSchema.safeParse({ ...seal, schemaVersion: 1 }).success).toBe(false);
});

it('the approval card says when the worker was chosen through a selector (seal v2) and says nothing for a v1 seal', async () => {
  const id = 'acme-frontier-next', policy = roles([roleRow(id, 'frontier')]);
  const card = async (reader: ModelCatalogReader, locale: 'en' | 'tr') => {
    const planned = graph(), execution = await assign(reader, policy);
    return renderRunCreateApprovalSummary({ schemaVersion: 1 as const, commandId: 'create', scopeId: 's', runId: 'run-a', graph: planned as never },
      { commandId: 'create', actor: { id: 'o', issuer: 'test', subject: 'o' }, graph: planned as never, identity: { scopeId: 's', runId: 'run-a', layoutRevision: 'l' }, now: 1,
        execution, policy: { schemaVersion: 2 as const, poolId: 'p', capacity: { executionSlots: 1, inFlightSlots: 1 }, ordering: ['t'] } },
      { decision: 'require-approval', revision: 'p1', reason: 'APPROVAL_REQUIRED' } as const, locale);
  };
  const viaSelector = await card(catalog([id], [newModel(id)]), 'en');
  expect(viaSelector).toContain('chosen through a selector: model 1 of 1 it matched');
  expect(await card(catalog([id], [newModel(id)]), 'tr')).toContain('seçiciyle seçildi: eşleşen 1 modelin 1. sırası');
  // v1 seal (an exact candidate taken before any selector): no selector line.
  expect(await card(catalog(['claude-opus-5-5'], [newModel(id)]), 'en')).not.toContain('chosen through a selector');
});
