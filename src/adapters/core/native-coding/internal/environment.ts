import type { EnvironmentRequirement } from '#domain/index.js';
import registry from './environment-probes.json' with { type: 'json' };
export type ContainerProbeRunner = (argv: readonly string[], timeoutMs: number, signal?: AbortSignal) => Promise<'met' | 'unmet'>;
/** PRE-7: this adapter's probe kinds (environment-probes.json) over a container probe runner. Commands come only from the registry; the
 * declared requirement supplies whole argv elements, never a command. A kind whose placeholder the requirement leaves empty is unmet. */
export function nativeCodingEnvironmentProbes(run: ContainerProbeRunner): ReadonlyMap<string, (requirement: EnvironmentRequirement, signal?: AbortSignal) => Promise<'met' | 'unmet'>> {
  return new Map(Object.entries(registry.kinds).map(([kind, { argv }]) => [kind, async (requirement, signal) => {
    const values: Readonly<Record<string, string | undefined>> = { '{target}': requirement.target, '{expect}': requirement.expect };
    const resolved = argv.map(part => Object.hasOwn(values, part) ? values[part] : part);
    return resolved.every((part): part is string => part !== undefined) ? run(resolved, registry.timeoutMs, signal) : 'unmet';
  }]));
}
