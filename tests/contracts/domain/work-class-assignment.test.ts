import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { catalogModelSchema, CORE_WORK_CLASSES, mergeWorkClassRegistries, parseProviderCatalogDocument, resolveWorkClassCandidates, selectWorkerEffort, workClassRegistrySchema,
  workerAssignmentSchema, workInputSchema } from '#domain/index.js';

// ATAMA-1 (owner ASS1, A1, A5, K10): the Core seed declares an ordered worker candidate list per WorkClass (registry v4); an overlay replaces a
// list only by compare-and-set; work input v2 leaves the model to the system; the assignment seal is exact and bounded.
const profile = { schemaVersion: 1, version: 1, criterionTypes: ['completion'], evidenceTypes: ['retained-artifact'],
  rubric: [{ criterionType: 'completion', evidenceTypes: ['retained-artifact'], weight: 1 }], ceilingRules: [], decisionThresholds: { rejectBelow: 0.5, acceptAt: 1 } };
const overlay = (extra: object) => workClassRegistrySchema.parse({ schemaVersion: 4, revision: 'acme-1', classes: [{ id: 'acme', defaultEffort: 'high', acceptanceProfile: profile }],
  bindings: [], evidenceExtensions: [], candidatePolicies: [], ...extra });

it('the Core seed is registry v4: every class names a declared candidate list of catalog channels and exact models, in owner order', async () => {
  expect(CORE_WORK_CLASSES.schemaVersion).toBe(4); expect(CORE_WORK_CLASSES.revision).toBe('atama-1-2026-10-23');
  const policy = mergeWorkClassRegistries(CORE_WORK_CLASSES, []);
  const lists = Object.fromEntries(policy.classes.map(row => [row.id, resolveWorkClassCandidates(policy, row)?.id]));
  expect(lists).toEqual({ small: 'light', test: 'light', feature: 'standard', design: 'deep', architecture: 'deep', 'security-critical': 'deep' });
  const known = new Map<string, Set<string>>();
  for (const name of ['claude-cli-subscription', 'codex-cli-subscription', 'cursor-cli-subscription']) {
    const document = parseProviderCatalogDocument(JSON.parse(await readFile(new URL(`../../../assets/model-catalog/${name}.json`, import.meta.url), 'utf8')));
    for (const provider of document.providers) known.set(provider.id, new Set(provider.models.filter(model => model.lifecycle.state === 'active').map(model => model.nativeId)));
  }
  // Every seed candidate is a current model of a packaged native CLI catalog (exact id, never an alias); activation stays the scope's decision.
  for (const list of policy.candidatePolicies ?? []) for (const row of list.candidates) expect(known.get(row.channelId)?.has(row.modelId), `${row.channelId}/${row.modelId}`).toBe(true);
  expect(policy.candidatePolicies?.find(row => row.id === 'standard')?.candidates.map(row => [row.modelId, row.effort ?? null]))
    .toEqual([['claude-opus-5-5', null], ['gpt-6.1-sol', 'medium'], ['claude-opus-5-thinking-high', null]]);
  // The pinned-model path keeps the class targets unchanged (a person's explicit pin; A1 retuning applies to the system assignment).
  expect(Object.fromEntries(CORE_WORK_CLASSES.classes.map(row => [row.id, row.defaultEffort]))).toEqual({ small: 'high', test: 'high', feature: 'xhigh',
    design: 'max', architecture: 'max', 'security-critical': 'max' });
});

it('v1, v2 and v3 registries keep parsing; v4 refuses duplicate lists, duplicate candidates, an empty list and a non-increasing override', () => {
  expect(workClassRegistrySchema.parse({ schemaVersion: 1, revision: 'r', classes: [{ id: 'a', defaultEffort: 'high' }], bindings: [] }).schemaVersion).toBe(1);
  expect(workClassRegistrySchema.parse({ schemaVersion: 2, revision: 'r', classes: [{ id: 'a', defaultEffort: 'high', acceptanceProfile: profile }], bindings: [] }).schemaVersion).toBe(2);
  expect(workClassRegistrySchema.parse({ schemaVersion: 3, revision: 'r', classes: [{ id: 'a', defaultEffort: 'high', acceptanceProfile: profile }], bindings: [], evidenceExtensions: [] }).schemaVersion).toBe(3);
  // A v3 class cannot name a candidate list (that field is v4).
  expect(workClassRegistrySchema.safeParse({ schemaVersion: 3, revision: 'r', classes: [{ id: 'a', candidatePolicyId: 'x', defaultEffort: 'high', acceptanceProfile: profile }],
    bindings: [], evidenceExtensions: [] }).success).toBe(false);
  const row = { channelId: 'c', modelId: 'm' };
  for (const candidatePolicies of [[{ id: 'x', version: 1, candidates: [row] }, { id: 'x', version: 1, candidates: [row] }], [{ id: 'x', version: 1, candidates: [row, row] }],
    [{ id: 'x', version: 1, candidates: [] }], [{ id: 'x', version: 2, override: { previousVersion: 2 }, candidates: [row] }],
    [{ id: 'x', version: 1, candidates: Array.from({ length: 17 }, (_, index) => ({ channelId: 'c', modelId: `m${index}` })) }]]) {
    expect(workClassRegistrySchema.safeParse({ schemaVersion: 4, revision: 'r', classes: [{ id: 'a', defaultEffort: 'high', acceptanceProfile: profile }], bindings: [],
      evidenceExtensions: [], candidatePolicies }).success).toBe(false);
  }
});

it('an overlay adds its own list, replaces a Core list only against its exact version, and never names a list nobody declared', () => {
  const own = overlay({ classes: [{ id: 'acme', candidatePolicyId: 'acme-list', defaultEffort: 'high', acceptanceProfile: profile }],
    candidatePolicies: [{ id: 'acme-list', version: 1, candidates: [{ channelId: 'erp-cli', modelId: 'erp-model' }] }] });
  const merged = mergeWorkClassRegistries(CORE_WORK_CLASSES, [own]);
  expect(resolveWorkClassCandidates(merged, merged.classes.find(row => row.id === 'acme'))?.candidates).toEqual([{ channelId: 'erp-cli', modelId: 'erp-model' }]);
  const replace = (override?: object, version = 2) => overlay({ candidatePolicies: [{ id: 'standard', version, ...(override ? { override } : {}), candidates: [{ channelId: 'c', modelId: 'm' }] }] });
  expect(() => mergeWorkClassRegistries(CORE_WORK_CLASSES, [replace()])).toThrow('WORK_CLASS_OVERRIDE_DENIED');
  expect(() => mergeWorkClassRegistries(CORE_WORK_CLASSES, [replace({ previousVersion: 2 }, 3)])).toThrow('WORK_CLASS_OVERRIDE_DENIED');
  const replaced = mergeWorkClassRegistries(CORE_WORK_CLASSES, [replace({ previousVersion: 1 })]);
  expect(replaced.candidatePolicies?.find(row => row.id === 'standard')).toMatchObject({ version: 2, candidates: [{ channelId: 'c', modelId: 'm' }] });
  expect(() => mergeWorkClassRegistries(CORE_WORK_CLASSES, [overlay({ candidatePolicies: [{ id: 'fresh', version: 2, override: { previousVersion: 1 }, candidates: [{ channelId: 'c', modelId: 'm' }] }] })]))
    .toThrow('WORK_CLASS_OVERRIDE_DENIED');
  expect(() => mergeWorkClassRegistries(CORE_WORK_CLASSES, [overlay({ classes: [{ id: 'acme', candidatePolicyId: 'nobody', defaultEffort: 'high', acceptanceProfile: profile }] })]))
    .toThrow('WORK_CLASS_CANDIDATES_NOT_REGISTERED');
  // A Core registry cannot claim an override of nothing.
  expect(() => mergeWorkClassRegistries(replace({ previousVersion: 1 }), [])).toThrow('WORK_CLASS_OVERRIDE_DENIED');
});

it('work input v2 may leave the model open; an effort without a model and a v1 input without one are refused', () => {
  const base = { task: 'Edit note.txt', scope: { paths: ['note.txt'] }, acceptance: 'note.txt changed' };
  const model = { channelId: 'claude-cli-subscription', modelId: 'claude-sonnet-5-5', auxiliaryModelIds: [] };
  expect(workInputSchema.parse({ schemaVersion: 2, ...base }).model).toBeUndefined();
  expect(workInputSchema.parse({ schemaVersion: 2, ...base, model, effort: 'high' }).model).toEqual(model);
  expect(workInputSchema.safeParse({ schemaVersion: 2, ...base, effort: 'high' }).success).toBe(false);
  expect(workInputSchema.safeParse({ schemaVersion: 1, ...base }).success).toBe(false);
  expect(workInputSchema.parse({ schemaVersion: 1, ...base, model }).schemaVersion).toBe(1);
  expect(workInputSchema.safeParse({ schemaVersion: 3, ...base }).success).toBe(false);
});

it('an assigned effort target is the candidate deviation or the vendor default; none keeps the CLI default and never escalates to Ultra', () => {
  const model = (efforts: string[], extra: object = {}) => catalogModelSchema.parse({ id: 'exact', version: 1, nativeId: 'exact', protocols: [{ family: 'fixture', version: 'v1', capabilities: [] }],
    lifecycle: { state: 'active', deprecatedOn: null, retireNotBefore: null, retiredOn: null, source: null }, minCliVersion: null, aliases: [], efforts, ...extra });
  const capability = { mode: 'arguments' as const, levels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] };
  const all = model(capability.levels);
  expect(selectWorkerEffort({ model: all, capability, kind: 'feature', assigned: { target: 'medium' } })).toMatchObject({ level: 'medium', source: 'policy-default', workClass: 'feature', target: 'medium' });
  expect(selectWorkerEffort({ model: all, capability, kind: 'feature', assigned: { target: null } })).toEqual({ schemaVersion: 1, level: null, source: 'cli-default', status: 'cli-default' });
  expect(selectWorkerEffort({ model: model(['ultra']), capability, kind: 'feature', assigned: { target: 'high' } })).toMatchObject({ level: null, status: 'ultra-opt-in-required' });
  expect(selectWorkerEffort({ model: model(['low', 'high']), capability, kind: 'feature', assigned: { target: 'medium' } })).toMatchObject({ level: 'low', target: 'medium' });
});

it('the assignment seal is exact: skipped rows are exactly the earlier candidates, in order, and reasons are typed identifiers', () => {
  const seal = { schemaVersion: 1, workClass: 'feature', workClassRevision: 'r', candidatePolicy: { id: 'standard', version: 1 }, candidateIndex: 1,
    channelId: 'c', modelId: 'm', catalogRevision: 'cat', modelRevision: 1, activationRevision: 1, effort: { level: null, source: 'cli-default' },
    skipped: [{ index: 0, channelId: 'c', modelId: 'n', reason: 'WORKER_MODEL_NOT_ACTIVE' }] };
  expect(workerAssignmentSchema.parse(seal)).toEqual(seal);
  for (const broken of [{ ...seal, skipped: [] }, { ...seal, skipped: [{ ...seal.skipped[0]!, index: 1 }] }, { ...seal, skipped: [{ ...seal.skipped[0]!, reason: 'free text' }] },
    { ...seal, effort: { level: null, source: 'brain' } }, { ...seal, extra: true }]) expect(workerAssignmentSchema.safeParse(broken).success).toBe(false);
});
