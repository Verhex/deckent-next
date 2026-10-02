import { ErrorRegistry } from '#platform/index.js';
type DockerLimits = { readonly memoryBytes: number; readonly cpus: number; readonly pids: number };
/** Installation limits refuse an oversized immutable profile before admission; never clamp requested resources. */
export function assertDockerResourceCeiling(requested: DockerLimits, ceiling: DockerLimits): void {
  for (const resource of ['memoryBytes', 'cpus', 'pids'] as const) {
    if (requested[resource] > ceiling[resource]) throw ErrorRegistry.createError('EXECUTION_RESOURCE_CEILING', {
      params: { resource, requested: requested[resource], ceiling: ceiling[resource] } });
  }
}
