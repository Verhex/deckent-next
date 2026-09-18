import { expect, it } from 'vitest';
import { resolveExecutionRegistry, type ExecutionRegistryValidation } from '#engine/index.js';
const graph = { schemaVersion: 2, revision: 1, tasks: [{ id: 't', kind: 'routine', dependencies: [], acceptanceCriteria: ['exit'] }],
  criterionDefinitions: [{ id: 'exit', version: 1, description: 'Configured exit criterion', evaluator: { id: 'exit', version: 1 }, parameters: { acceptedExitCodes: [0] } }] };
const registry = () => ({ schemaVersion: 1, revision: 'registry-1', profiles: [{ id: 'batch', version: 2,
  adapter: { id: 'installed-process', version: 1 }, parameters: { argv: ['task', '--bounded'] } }],
  kinds: [{ kind: 'routine', profile: { id: 'batch', version: 2 } }],
  evaluators: [{ id: 'exit', version: 1, implementation: { id: 'process-exit', version: 1 } }] });
const validation: ExecutionRegistryValidation = {
  profile(value) { if (value.adapter.id !== 'installed-process' || !Array.isArray(value.parameters.argv)) throw new Error('PROFILE_INVALID'); return undefined; },
  criterion(value, criterion) { if (value.implementation.id !== 'process-exit' || !Array.isArray(criterion.parameters.acceptedExitCodes)) throw new Error('CRITERION_INVALID'); return undefined; },
};
it('selects exact registered versions and copies immutable data instead of holding mutable registry references', () => {
  const source = registry(); const resolved = resolveExecutionRegistry(graph, source, validation);
  source.profiles[0]!.parameters.argv[0] = 'changed'; source.revision = 'registry-2';
  expect(resolved.registryRevision).toBe('registry-1'); expect(resolved.tasks[0]?.profile.parameters.argv).toEqual(['task', '--bounded']);
  expect(Object.isFrozen(resolved.tasks[0]?.profile.parameters.argv)).toBe(true);
  expect(resolved.criteria[0]).toMatchObject({ criterionId: 'exit', evaluator: { implementation: { id: 'process-exit', version: 1 } } });
});
it('rejects missing kinds, evaluator versions, duplicate mappings and dangling profile references without fallback', () => {
  const unknownKind = { ...graph, tasks: [{ ...graph.tasks[0], kind: 'unknown' }] };
  expect(() => resolveExecutionRegistry(unknownKind, registry(), validation)).toThrow('TASK_KIND_NOT_REGISTERED');
  const missing = registry(); missing.evaluators[0]!.version = 2;
  expect(() => resolveExecutionRegistry(graph, missing, validation)).toThrow('TASK_EVALUATOR_NOT_REGISTERED');
  const duplicate = registry(); duplicate.kinds.push(duplicate.kinds[0]!);
  expect(() => resolveExecutionRegistry(graph, duplicate, validation)).toThrow();
  const dangling = registry(); dangling.kinds[0]!.profile.version = 3;
  expect(() => resolveExecutionRegistry(graph, dangling, validation)).toThrow();
});
it('requires installed parameter validators and rejects asynchronous validation that could escape admission', () => {
  const source = registry(); source.profiles[0]!.adapter.id = 'uninstalled';
  expect(() => resolveExecutionRegistry(graph, source, validation)).toThrow('PROFILE_INVALID');
  const asyncValidator = { ...validation, async profile() {} } as unknown as ExecutionRegistryValidation;
  expect(() => resolveExecutionRegistry(graph, registry(), asyncValidator)).toThrow('EXECUTION_REGISTRY_VALIDATOR_INVALID');
});
