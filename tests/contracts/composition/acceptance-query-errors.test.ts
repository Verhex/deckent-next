import { expect, it } from 'vitest';
import { WorkClassRegistryError, TaskEvaluationError, CORE_WORK_CLASSES } from '#domain/index.js';
import { DispatchError, resolveExecutionRegistry } from '#engine/index.js';
import { queryFailure } from '#composition/core/query-errors/index.js';
import { execution, graph } from '../domain/acceptance-fixture.js';
it.each([
  new WorkClassRegistryError('WORK_CLASS_OVERRIDE_DENIED'),
  new WorkClassRegistryError('WORK_CLASS_EVIDENCE_NOT_REGISTERED'),
  new TaskEvaluationError('TASK_EVALUATION_PROFILE_MISMATCH'),
  new DispatchError('DISPATCH_FENCED'),
])('keeps $code typed and localized, without inventory masking', error => {
  const mapped = queryFailure(error);
  expect(mapped.code).toBe(error.code); expect(mapped.code).not.toBe('INVENTORY_UNAVAILABLE');
  expect(mapped.localize?.('en').message).not.toBe(mapped.localize?.('tr').message);
});
it('a real invalid v2 overlay admission produces the registered WORK_CLASS_OVERRIDE_DENIED error', () => {
  const invalid = { schemaVersion: 2, revision: 'invalid', classes: [{ ...CORE_WORK_CLASSES.classes[0], acceptanceProfile: execution().workClassProfiles![0]!.profile }], bindings: [] };
  try { execution(graph, invalid); throw new Error('expected admission refusal'); }
  catch (error) { expect(queryFailure(error).code).toBe('WORK_CLASS_OVERRIDE_DENIED'); }
  expect(typeof resolveExecutionRegistry).toBe('function');
});
