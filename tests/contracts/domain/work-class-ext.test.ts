import { expect, it } from 'vitest';
import { mergeWorkClassRegistries, CORE_WORK_CLASSES, resolveTaskWorkClass, workClassRegistrySchema } from '#domain/index.js';
import { assertRunExecution } from '#engine/index.js';
import { execution, profile, graph, overlay } from './acceptance-fixture.js';
const extension = { id: 'ext:posting-document', version: 1, mapsTo: 'operation-settlement', label: { en: 'adapter.posting.en', tr: 'adapter.posting.tr' } };
const extended = () => workClassRegistrySchema.parse({ ...overlay, schemaVersion: 3, evidenceExtensions: [extension],
  classes: [{ ...overlay.classes[0], acceptanceProfile: { ...profile, evidenceTypes: [extension.id], rubric: [{ criterionType: 'completion', evidenceTypes: [extension.id], weight: 1 }] } }] });
it('v3 extensions are declared, merged and frozen into the Run with the policy used by effort selection', () => {
  const configured = extended(), resolved = resolveTaskWorkClass('business', undefined, configured);
  expect(resolved.policy.revision).toBe(mergeWorkClassRegistries(CORE_WORK_CLASSES, [configured]).revision);
  const frozen = execution(graph, configured);
  expect(frozen.workClassProfiles?.[0]?.evidenceExtensions).toEqual([extension]);
  expect(frozen.tasks[0]!.acceptance?.policyRevision).toBe(resolved.policy.revision);
  expect(assertRunExecution(graph, JSON.parse(JSON.stringify(frozen)))).toEqual(frozen);
});
it('unknown extension profiles fail closed, and a v2 overlay cannot smuggle an ext type', () => {
  expect(() => mergeWorkClassRegistries(CORE_WORK_CLASSES, [{ ...extended(), evidenceExtensions: [] } as never])).toThrow('WORK_CLASS_EVIDENCE_NOT_REGISTERED');
  const row: Record<string, unknown> = { ...extended() }; delete row['evidenceExtensions'];
  expect(workClassRegistrySchema.safeParse({ ...row, schemaVersion: 2 }).success).toBe(false);
});
it.each(['unknown', 'ext:illegal space', 'verification-result'])('extension id %s is refused', id => {
  expect(workClassRegistrySchema.safeParse({ ...extended(), evidenceExtensions: [{ ...extension, id }] }).success).toBe(false);
});
it('duplicate extension ids and unknown core ceiling mapping are refused', () => {
  expect(workClassRegistrySchema.safeParse({ ...extended(), evidenceExtensions: [extension, extension] }).success).toBe(false);
  expect(workClassRegistrySchema.safeParse({ ...extended(), evidenceExtensions: [{ ...extension, mapsTo: 'free-text' }] }).success).toBe(false);
});
