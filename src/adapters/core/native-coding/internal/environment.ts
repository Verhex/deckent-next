import type { EnvironmentRequirement } from '#domain/index.js';
import { dockerNodeHeapCeilingBytes } from '#adapters/core/docker-supervisor/index.js';
import registry from './environment-probes.json' with { type: 'json' };
/** PRE-7 phase 2: the declaration a coding template gets when its operator declared none (registry `templateDefaults`). */
export function nativeCodingTemplateEnvironment(docker: Readonly<{ memoryBytes?: unknown; readOnlyMounts?: unknown }>) {
  const { requirements, whenMounted, nodeHeap } = registry.templateDefaults, heap = typeof docker.memoryBytes === 'number' ? dockerNodeHeapCeilingBytes(docker.memoryBytes) : null;
  const mounted = new Set((Array.isArray(docker.readOnlyMounts) ? docker.readOnlyMounts : []).map(mount => (mount as { target?: unknown })?.target));
  return { schemaVersion: 1, requirements: [...requirements, ...whenMounted.filter(row => mounted.has(row.target)).map(row => row.requirement), ...(heap ? [{ ...nodeHeap, expect: String(heap) }] : [])] };
}
export type ContainerProbeRunner = (argv: readonly string[], timeoutMs: number, signal?: AbortSignal) => Promise<'met' | 'unmet' | Readonly<{ uncertain: string }>>;
/** PRE-7: this adapter's probe kinds (environment-probes.json) over a container probe runner. Commands come only from the registry; the
 * declared requirement supplies whole argv elements, never a command. A kind whose placeholder the requirement leaves empty is unmet. */
export function nativeCodingEnvironmentProbes(run: ContainerProbeRunner): ReadonlyMap<string, (requirement: EnvironmentRequirement, signal?: AbortSignal) => Promise<'met' | 'unmet' | Readonly<{ uncertain: string }>>> {
  return new Map(Object.entries(registry.kinds).map(([kind, { argv }]) => [kind, async (requirement, signal) => {
    const values: Readonly<Record<string, string | undefined>> = { '{target}': requirement.target, '{expect}': requirement.expect };
    const resolved = argv.map(part => Object.hasOwn(values, part) ? values[part] : part);
    return resolved.every((part): part is string => part !== undefined) ? run(resolved, registry.timeoutMs, signal) : 'unmet';
  }]));
}
