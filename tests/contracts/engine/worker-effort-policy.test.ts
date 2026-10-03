import { expect, it } from 'vitest';
import { catalogModelSchema, parseProviderCatalogDocument, selectWorkerEffort, workClassRegistrySchema } from '#domain/index.js';
const model = (efforts: string[], extra: object = {}) => catalogModelSchema.parse({ id: 'exact', version: 1, nativeId: 'exact', protocols: [{ family: 'fixture', version: 'v1', capabilities: [] }],
  lifecycle: { state: 'active', deprecatedOn: null, retireNotBefore: null, retiredOn: null, source: null }, minCliVersion: null, aliases: [], efforts, ...extra });
const capability = { mode: 'arguments' as const, levels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] };
it.each([['test', 'high'], ['small', 'high'], ['feature', 'xhigh'], ['design', 'max'], ['architecture', 'max'], ['security-critical', 'max']])('selects %s class in data', (kind, level) => {
  expect(selectWorkerEffort({ model: model(capability.levels), capability, kind })).toMatchObject({ level, source: 'policy-default', workClass: kind });
});
it('explicit wins over the class default and even an irrelevant class override', () => {
  expect(selectWorkerEffort({ model: model(capability.levels), capability, kind: 'design', explicit: 'low', workClass: 'unknown' })).toMatchObject({ level: 'low', source: 'explicit' });
});
it('clamps missing levels down by canonical rank regardless of catalog order; no downward level uses the lowest supported', () => {
  expect(selectWorkerEffort({ model: model(['ultra', 'high', 'low']), capability, kind: 'design' })).toMatchObject({ level: 'high', target: 'max' });
  expect(selectWorkerEffort({ model: model(['max']), capability, kind: 'small' })).toMatchObject({ level: 'max', target: 'high' });
});
it.each(['small', 'design'])('only-Ultra never escalates the %s policy target', kind => {
  expect(selectWorkerEffort({ model: model(['ultra']), capability, kind })).toMatchObject({ level: null, source: 'cli-default',
    status: 'ultra-opt-in-required', workClass: kind, target: kind === 'small' ? 'high' : 'max' });
  expect(selectWorkerEffort({ model: model(['ultra']), capability, kind, explicit: 'ultra' })).toMatchObject({ level: 'ultra', source: 'explicit', status: 'selected' });
});
it('Ultra remains available via a deliberate registry target, including an exact fixed-model binding', () => {
  const policy = workClassRegistrySchema.parse({ schemaVersion: 1, revision: 'opt-in', classes: [{ id: 'deep', defaultEffort: 'ultra' }], bindings: [{ kind: 'design', classId: 'deep' }] });
  const fixed = model(['ultra'], { effortBinding: { mode: 'fixed-model', level: 'ultra' } });
  for (const mode of ['arguments', 'model-id'] as const) {
    expect(selectWorkerEffort({ model: fixed, capability: { ...capability, mode }, kind: 'design' })).toMatchObject({ level: null, source: 'cli-default', status: 'ultra-opt-in-required' });
    expect(selectWorkerEffort({ model: fixed, capability: { ...capability, mode }, kind: 'design', policy })).toMatchObject({ level: 'ultra', source: 'policy-default', target: 'ultra' });
  }
});
it('never clamps explicit effort; unsupported model/CLI refuses, while absent effort records unsupported', () => {
  for (const request of [{ model: model([]), capability }, { model: model(['high']), capability: null }]) {
    expect(() => selectWorkerEffort({ ...request, kind: 'feature', explicit: 'high' })).toThrow('WORKER_EFFORT_UNSUPPORTED');
    expect(selectWorkerEffort({ ...request, kind: 'feature' })).toMatchObject({ level: null, source: 'cli-default', status: 'unsupported' });
  }
  expect(() => selectWorkerEffort({ model: model(['high']), capability, kind: 'feature', explicit: 'max' })).toThrow('WORKER_EFFORT_UNSUPPORTED');
});
it('unknown kinds keep visible CLI defaults; declared task class and configured overlay drive selection without changing kind', () => {
  expect(selectWorkerEffort({ model: model(['high']), capability, kind: 'custom' })).toMatchObject({ level: null, source: 'cli-default', status: 'cli-default' });
  const policy = workClassRegistrySchema.parse({ schemaVersion: 1, revision: 'enterprise-v1', classes: [{ id: 'erp-review', defaultEffort: 'medium' }], bindings: [{ kind: 'erp', classId: 'erp-review' }] });
  expect(selectWorkerEffort({ model: model(capability.levels), capability, kind: 'erp', policy })).toMatchObject({ level: 'medium', workClass: 'erp-review', policyRevision: 'enterprise-v1' });
  expect(selectWorkerEffort({ model: model(capability.levels), capability, kind: 'custom', workClass: 'small' })).toMatchObject({ level: 'high', workClass: 'small' });
  expect(() => selectWorkerEffort({ model: model(['high']), capability, kind: 'custom', workClass: 'missing' })).toThrow('WORK_CLASS_NOT_REGISTERED');
});
it('Cursor fixed model binds only its declared single effort; no inferred variant or bracket mapping', () => {
  const fixed = model(['high'], { effortBinding: { mode: 'fixed-model', level: 'high' } });
  const cursor = { mode: 'model-id' as const, levels: capability.levels };
  expect(selectWorkerEffort({ model: fixed, capability: cursor, kind: 'design' })).toMatchObject({ level: 'high', source: 'policy-default' });
  expect(() => selectWorkerEffort({ model: fixed, capability: cursor, kind: 'design', explicit: 'max' })).toThrow('WORKER_EFFORT_UNSUPPORTED');
  expect(selectWorkerEffort({ model: model(['high']), capability: cursor, kind: 'design' })).toMatchObject({ status: 'unsupported' });
  expect(() => selectWorkerEffort({ model: model(['high']), capability: cursor, kind: 'design', explicit: 'high' })).toThrow('WORKER_EFFORT_UNSUPPORTED');
});
it('refuses ambiguous fixed-model catalog declarations and malformed work-class mappings', () => {
  for (const efforts of [[], ['high', 'max'], ['low']]) expect(() => parseProviderCatalogDocument({ schemaVersion: 2, revision: 'r', providers: [{ id: 'cursor', version: 1,
    channel: { kind: 'native-cli', cli: 'cursor', aliases: [] }, models: [model(efforts, { effortBinding: { mode: 'fixed-model', level: 'high' } })] }] })).toThrow();
  expect(() => workClassRegistrySchema.parse({ schemaVersion: 1, revision: 'r', classes: [{ id: 'a', defaultEffort: 'high' }], bindings: [{ kind: 'coding', classId: 'missing' }] })).toThrow();
});
