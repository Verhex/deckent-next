import { validateTaskGraph } from '#domain/index.js';
import { resolveExecutionRegistry } from '#engine/index.js';
/** Explicit test-only admission data. Production never invents missing profile or evaluator choices. */
/** `noWorkspaceDelivery`: every fixture kind declares `workspaceDelivery: 'none'` (EXEC-RELEASE C2, owner B). */
export function fixtureExecution(graphInput: unknown, options: { noWorkspaceDelivery?: boolean } = {}) {
  const graph = validateTaskGraph(graphInput);
  const evaluators = [...new Map(graph.criterionDefinitions.map(value => [JSON.stringify(value.evaluator),
    { ...value.evaluator, implementation: { id: 'test-evaluator', version: 1 } }])).values()];
  return resolveExecutionRegistry(graph, { schemaVersion: 1, revision: 'fixture-registry',
    profiles: [{ id: 'fixture-profile', version: 1, adapter: { id: 'test-supervisor', version: 1 }, parameters: { fixture: true } }],
    kinds: [...new Set(graph.tasks.map(task => task.kind))].map(kind => ({ kind, profile: { id: 'fixture-profile', version: 1 }, ...(options.noWorkspaceDelivery ? { workspaceDelivery: 'none' as const } : {}) })), evaluators,
  }, {
    profile(value) { if (value.adapter.id !== 'test-supervisor' || value.parameters.fixture !== true) throw new Error('FIXTURE_PROFILE_INVALID'); return undefined; },
    criterion(value) { if (value.implementation.id !== 'test-evaluator') throw new Error('FIXTURE_EVALUATOR_INVALID'); return undefined; },
  });
}

/** Plain configured registry for composition admission fixtures using installed validators. */
export function fixtureDockerRegistry(kinds: readonly string[]) {
  return { schemaVersion: 1 as const, revision: 'fixture-docker-registry', profiles: [{ id: 'fixture-docker', version: 1,
    adapter: { id: 'docker', version: 2 }, parameters: { argv: ['node', 'task.js'], imageId: 'sha256:' + 'a'.repeat(64),
      memoryBytes: 268435456, pids: 64, cpus: 1, logMaxSizeKiB: 64, logMaxFiles: 2, tmpBytes: 16777216,
      deadlineMs: 20000, controlTimeoutMs: 10000, outputBytes: 65536 } }],
    kinds: [...new Set(kinds)].map(kind => ({ kind, profile: { id: 'fixture-docker', version: 1 } })),
    evaluators: [{ id: 'process-exit', version: 1, implementation: { id: 'process-exit', version: 1 } }],
  };
}
