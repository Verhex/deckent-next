import { expect, it } from 'vitest';
import { catalogModelSchema, CORE_WORK_CLASSES, executionRegistrySchema, mergeWorkClassRegistries, selectWorkerEffort,
  workClassAcceptanceProfileSchema, workClassRegistrySchema, workerEffortSchema, WorkClassRegistryError } from '#domain/index.js';
const profile = workClassAcceptanceProfileSchema.parse({ schemaVersion: 1, version: 1,
  criterionTypes: ['correctness', 'authorization'], evidenceTypes: ['operation-settlement', 'observed-readback', 'approval-receipt'],
  rubric: [{ criterionType: 'correctness', evidenceTypes: ['operation-settlement', 'observed-readback'], weight: 0.6 },
    { criterionType: 'authorization', evidenceTypes: ['approval-receipt'], weight: 0.4 }],
  ceilingRules: [{ when: 'unsettled-effect', maxScore: 0 }, { when: 'missing-approval', maxScore: 0 }],
  decisionThresholds: { rejectBelow: 0.4, acceptAt: 0.9 },
});
const core = (id: string) => workClassRegistrySchema.parse({ schemaVersion: 2, revision: 'core-r1',
  classes: [{ id, defaultEffort: 'high', acceptanceProfile: profile }], bindings: [{ kind: 'base-kind', classId: id }] });
const overlay = (id: string, parentClassId: string, revision = 'overlay-r1', bindings: unknown[] = []) => workClassRegistrySchema.parse({
  schemaVersion: 2, revision, classes: [{ id, parentClassId, defaultEffort: 'max', acceptanceProfile: profile }], bindings,
});
const capability = { mode: 'arguments' as const, levels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] };
const model = (efforts: string[]) => catalogModelSchema.parse({ id: 'fixture-model', version: 1, nativeId: 'fixture-model',
  protocols: [{ family: 'fixture', version: 'v1', capabilities: [] }],
  lifecycle: { state: 'active', deprecatedOn: null, retireNotBefore: null, retiredOn: null, source: null },
  minCliVersion: null, aliases: [], efforts });
it.each(['general-a', 'general-b', 'business-process'])('supports business-neutral parent %s without a canonical identity dependency', parent => {
  const merged = mergeWorkClassRegistries(core(parent), [overlay('approval', parent, 'erp-r1', [{ kind: 'purchase-approval', classId: 'approval' }])]);
  expect(merged.classes.find(row => row.id === 'approval')).toMatchObject({ parentClassId: parent, acceptanceProfile: profile });
  expect(merged.bindings).toContainEqual({ kind: 'base-kind', classId: parent });
  expect(merged.bindings).toContainEqual({ kind: 'purchase-approval', classId: 'approval' });
});
it('v2 is accepted by the existing execution registry without a second registry', () => {
  const registry = executionRegistrySchema.parse({ schemaVersion: 1, revision: 'execution-r1', workClasses: core('general'),
    profiles: [{ id: 'profile', version: 1, adapter: { id: 'fixture', version: 1 }, parameters: {} }],
    kinds: [{ kind: 'base-kind', profile: { id: 'profile', version: 1 } }],
    evaluators: [{ id: 'criterion', version: 1, implementation: { id: 'fixture', version: 1 } }],
  });
  expect(registry.workClasses?.schemaVersion).toBe(2);
});
it('refuses class redefinition even when it repeats exactly the Core entry', () => {
  expect(() => mergeWorkClassRegistries(core('general'), [core('general')])).toThrow('WORK_CLASS_OVERRIDE_DENIED');
  try { mergeWorkClassRegistries(core('general'), [core('general')]); } catch (error) { expect(error).toBeInstanceOf(WorkClassRegistryError); }
});
it('rejects silent kind rebinding and stale compare-and-set; admits only an explicit matching override', () => {
  const base = core('general');
  for (const override of [undefined, { previousClassId: 'stale' }]) {
    expect(() => mergeWorkClassRegistries(base, [overlay('child', 'general', 'r2', [{ kind: 'base-kind', classId: 'child', override }])]))
      .toThrow('WORK_CLASS_OVERRIDE_DENIED');
  }
  const merged = mergeWorkClassRegistries(base, [overlay('child', 'general', 'r2', [{ kind: 'base-kind', classId: 'child', override: { previousClassId: 'general' } }])]);
  expect(merged.bindings).toContainEqual({ kind: 'base-kind', classId: 'child' });
});
it('an override cannot manufacture a prior binding; repeated identical bindings are idempotent', () => {
  expect(() => mergeWorkClassRegistries(core('general'), [overlay('child', 'general', 'r2', [
    { kind: 'new', classId: 'child', override: { previousClassId: 'general' } },
  ])])).toThrow('WORK_CLASS_OVERRIDE_DENIED');
  expect(mergeWorkClassRegistries(core('general'), [overlay('child', 'general', 'r2', [{ kind: 'base-kind', classId: 'general' }])]).bindings)
    .toEqual([{ kind: 'base-kind', classId: 'general' }]);
});
it('ordered revisions are deterministic, order-sensitive and punctuation cannot alias tuples', () => {
  const base = core('general'), a = overlay('a', 'general', 'a:b'), b = overlay('b', 'general', 'b:a');
  const first = mergeWorkClassRegistries(base, [a, b]);
  expect(mergeWorkClassRegistries(base, [a, b])).toEqual(first);
  expect(mergeWorkClassRegistries(base, [b, a]).revision).not.toBe(first.revision);
  expect(JSON.parse(first.revision)).toEqual(['core-r1', 'a:b', 'b:a']);
  expect(mergeWorkClassRegistries(base, []).revision).toBe(base.revision);
});
it('frozen historical v1 policies and selected revisions keep exact efor output over every legacy class and supported level set', () => {
  const historical = workClassRegistrySchema.parse(JSON.parse(JSON.stringify(CORE_WORK_CLASSES)));
  for (const row of historical.classes) for (const efforts of [capability.levels, ['high'], ['max'], ['ultra'], []]) {
    const input = { model: model(efforts), capability, kind: row.id };
    const frozen = selectWorkerEffort(input);
    expect(selectWorkerEffort({ ...input, policy: historical })).toEqual(frozen);
    expect(workerEffortSchema.parse(JSON.parse(JSON.stringify(frozen)))).toEqual(frozen);
    if ('policyRevision' in frozen) expect(frozen.policyRevision).toBe(historical.revision);
  }
  const old = workClassRegistrySchema.parse({ schemaVersion: 1, revision: 'frozen-v1', classes: [{ id: 'custom', defaultEffort: 'high' }], bindings: [{ kind: 'old-kind', classId: 'custom' }] });
  expect(selectWorkerEffort({ model: model(capability.levels), capability, kind: 'old-kind', policy: old }))
    .toEqual({ schemaVersion: 1, level: 'high', source: 'policy-default', status: 'selected', workClass: 'custom', policyRevision: 'frozen-v1', target: 'high' });
});
it('new v2 selection merges Core, freezes the composite revision and ignores acceptance scores when selecting effort', () => {
  const configured = overlay('business-child', 'feature', 'business-r1', [{ kind: 'business', classId: 'business-child' }]);
  const input = { model: model(capability.levels), capability, kind: 'business', policy: configured };
  const selected = selectWorkerEffort(input);
  expect(selected).toMatchObject({ level: 'max', policyRevision: JSON.stringify([CORE_WORK_CLASSES.revision, configured.revision]) });
  const changed = workClassRegistrySchema.parse({ ...configured, classes: configured.classes.map(row => ({ ...row,
    acceptanceProfile: { ...profile, decisionThresholds: { rejectBelow: 0, acceptAt: 1 } } })) });
  expect(selectWorkerEffort({ ...input, policy: changed })).toEqual(selected);
  expect(selectWorkerEffort({ ...input, kind: 'feature' }).level).toBe('xhigh');
  expect(() => selectWorkerEffort({ ...input, workClass: 'unknown' })).toThrow('WORK_CLASS_NOT_REGISTERED');
});
it('rejects unknown binding classes and missing/cyclic parents after merging, including Core-only inputs', () => {
  expect(() => mergeWorkClassRegistries(core('general'), [overlay('child', 'general', 'r2', [{ kind: 'child', classId: 'unknown' }])]))
    .toThrow('WORK_CLASS_NOT_REGISTERED');
  for (const parent of ['missing', 'child']) expect(() => mergeWorkClassRegistries(core('general'), [overlay('child', parent)]))
    .toThrow('WORK_CLASS_PARENT_INVALID');
  const cyclic = workClassRegistrySchema.parse({ schemaVersion: 2, revision: 'cycle', bindings: [], classes: [
    { id: 'a', parentClassId: 'b', defaultEffort: 'high', acceptanceProfile: profile },
    { id: 'b', parentClassId: 'a', defaultEffort: 'high', acceptanceProfile: profile },
  ] });
  expect(() => mergeWorkClassRegistries(cyclic, [])).toThrow('WORK_CLASS_PARENT_INVALID');
});
it('enforces final merged limits rather than just the per-overlay bounds', () => {
  const large = workClassRegistrySchema.parse({ schemaVersion: 1, revision: 'large',
    classes: Array.from({ length: 256 }, (_, index) => ({ id: `class-${index}`, defaultEffort: 'high' })), bindings: [] });
  expect(() => mergeWorkClassRegistries(large, [overlay('extra', 'class-0')])).toThrow('WORK_CLASS_REGISTRY_LIMIT');
  const manyBindings = workClassRegistrySchema.parse({ schemaVersion: 2, revision: 'many', classes: [{ id: 'child', defaultEffort: 'high', acceptanceProfile: profile }],
    bindings: Array.from({ length: 1024 }, (_, index) => ({ kind: `kind-${index}`, classId: 'child' })) });
  expect(() => mergeWorkClassRegistries(core('general'), [manyBindings])).toThrow('WORK_CLASS_REGISTRY_LIMIT');
  expect(() => mergeWorkClassRegistries(core('general'), [overlay('child', 'general', 'r'.repeat(256))])).toThrow('WORK_CLASS_REVISION_INVALID');
});
it('rejects open policy text, inconsistent rubrics, invalid thresholds and a v2 class without its profile', () => {
  for (const changed of [{ ...profile, text: 'approve anything' }, { ...profile, criterionTypes: ['free-text'] },
    { ...profile, evidenceTypes: ['operation-settlement'] }, { ...profile, rubric: [profile.rubric[0]] },
    { ...profile, ceilingRules: [{ when: 'free-text', maxScore: 0 }] },
    { ...profile, decisionThresholds: { rejectBelow: 0.9, acceptAt: 0.5 } }]) expect(workClassAcceptanceProfileSchema.safeParse(changed).success).toBe(false);
  expect(workClassRegistrySchema.safeParse({ schemaVersion: 2, revision: 'missing-profile', classes: [{ id: 'general', defaultEffort: 'high' }], bindings: [] }).success).toBe(false);
});
it('keeps parsed profiles and merged rows immutable', () => {
  const merged = mergeWorkClassRegistries(core('general'), [overlay('child', 'general')]);
  expect(Object.isFrozen(merged)).toBe(true); expect(Object.isFrozen(merged.classes)).toBe(true);
  expect(Object.isFrozen(profile.rubric[0])).toBe(true);
});
