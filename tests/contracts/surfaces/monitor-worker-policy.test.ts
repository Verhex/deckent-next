import { expect, it } from 'vitest';
import type { WorkerModelView } from '#domain/index.js';
import { WorkClassRegistryError } from '#domain/index.js';
import { ErrorRegistry } from '#platform/index.js';
import { renderWorkerModelLine } from '#surfaces/core/monitor/index.js';

const policyRevision = '["core-r1","company-r2"]';
const view: WorkerModelView = { provider: 'codex', evidenceCapability: 'none',
  requested: { channelId: 'channel', modelId: 'model', auxiliaryModelIds: [] },
  init: null, usage: null, verdict: 'unverified', unexpected: [], evidence: 'none',
  reasoningEffort: { schemaVersion: 1, level: 'high', source: 'policy-default', status: 'selected',
    workClass: 'business-work', policyRevision, target: 'high' } };

it.each(['en', 'tr'] as const)('prints the exact frozen composite policy revision in the shared worker line (%s)', locale => {
  const before = JSON.stringify(view);
  const text = renderWorkerModelLine(view, locale);
  expect(text).toContain(policyRevision);
  expect(text).toContain(locale === 'en' ? 'Work class policy revision:' : 'İş sınıfı politika revizyonu:');
  expect(JSON.stringify(view)).toBe(before);
});

it.each(['en', 'tr'] as const)('does not invent a policy revision for historical worker evidence (%s)', locale => {
  const { policyRevision: omitted, ...legacy } = view.reasoningEffort!;
  expect(omitted).toBe(policyRevision);
  const text = renderWorkerModelLine({ ...view, reasoningEffort: legacy }, locale);
  expect(text).not.toContain(policyRevision);
  expect(text).not.toContain(locale === 'en' ? 'policy revision:' : 'politika revizyonu:');
  expect(renderWorkerModelLine({ ...view, reasoningEffort: undefined }, locale)).not.toContain(policyRevision);
});

it.each(['WORK_CLASS_OVERRIDE_DENIED', 'WORK_CLASS_PARENT_INVALID', 'WORK_CLASS_REGISTRY_LIMIT', 'WORK_CLASS_REVISION_INVALID'] as const)(
  'registers the existing domain failure in both language catalogs: %s', code => {
    const failure = new WorkClassRegistryError(code);
    for (const locale of ['en', 'tr'] as const) {
      const mapped = ErrorRegistry.createError(failure.code, { locale });
      expect(mapped.code).toBe(code);
      expect(mapped.message).toBe(ErrorRegistry.get(code, locale)!.message);
      expect(mapped.message).not.toContain('Unknown');
      expect(mapped.message).not.toContain('Bilinmeyen');
    }
    expect(ErrorRegistry.get(code, 'en')!.message).not.toBe(ErrorRegistry.get(code, 'tr')!.message);
  });
