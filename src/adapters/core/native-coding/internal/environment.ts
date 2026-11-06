import { nativeWorkerEnvironmentProbes, nativeWorkerTemplateEnvironment, nativeWorkerToolBounds, type NativeWorkerProbeRunner } from '#capabilities/index.js';
import { dockerNodeHeapCeilingBytes } from '#adapters/core/docker-supervisor/index.js';
import { nativeCliAgent } from '#adapters/core/native-cli-registry/index.js';
import registry from './environment-probes.json' with { type: 'json' };
const nativeCodingToolBounds = (family: string) => nativeWorkerToolBounds(nativeCliAgent(family)?.headless.isolation.limits);
/** Default requirements follow the enforcing realm; explicit declarations are preserved. */
export const nativeCodingTemplateEnvironment = (settings: Readonly<{ memoryBytes?: unknown; readOnlyMounts?: unknown }>, family?: string) =>
  nativeWorkerTemplateEnvironment(registry.templateDefaults, settings, family ? nativeCodingToolBounds(family).heapBytes : typeof settings.memoryBytes === 'number' ? dockerNodeHeapCeilingBytes(settings.memoryBytes) : null);
export type ContainerProbeRunner = NativeWorkerProbeRunner;
export const nativeCodingEnvironmentProbes = (run: ContainerProbeRunner) => nativeWorkerEnvironmentProbes(registry, run);
