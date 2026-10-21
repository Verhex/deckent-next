import { ENVIRONMENT_NOT_READY_CODE, ENVIRONMENT_UNCERTAIN_CODE, RegistryError, environmentRequirementsSchema, identitySchema, type EnvironmentRequirement } from '#domain/index.js';
import { ErrorRegistry } from '#platform/index.js';
/** One environment probe kind, registered by an adapter (an open registry: coding kinds in the native-coding adapter, business-process
 * kinds such as a connector or a credential reference in their own adapters, Law 10). It answers only met/unmet: it never calls a model,
 * never receives task text, and a credential kind may only ask the existing secret port whether a reference resolves, never read it out. */
export type EnvironmentProbe = (requirement: EnvironmentRequirement, signal?: AbortSignal) => Promise<'met' | 'unmet' | Readonly<{ uncertain: string }>>;
export type EnvironmentProbes = ReadonlyMap<string, EnvironmentProbe>;
/** Add-only probe kinds of other packages (Enterprise, ERP, custom), registered through `deckent/extensions` before composeCore seals.
 * Their kinds are dotted (own namespace); Core adapters' kinds are undotted, so a registration never replaces a Core kind. Grants nothing. */
export class EnvironmentProbeRegistry {
  private readonly kinds = new Map<string, EnvironmentProbe>(); private sealed = false;
  register(kind: string, probe: EnvironmentProbe): void {
    if (this.sealed) throw new RegistryError('REGISTRY_SEALED');
    if (!identitySchema.safeParse(kind).success || typeof probe !== 'function') throw new RegistryError('REGISTRY_MANIFEST_INVALID');
    if (!kind.includes('.')) throw new RegistryError('REGISTRY_NAMESPACE_RESERVED');
    if (this.kinds.has(kind)) throw new RegistryError('REGISTRY_ADAPTER_DUPLICATE');
    this.kinds.set(kind, probe);
  }
  seal(): void { this.sealed = true; }
  /** Core adapters' kinds plus the registered ones. */
  with(core: EnvironmentProbes): EnvironmentProbes { return new Map([...core, ...this.kinds]); }
}
export const environmentProbeRegistry = new EnvironmentProbeRegistry();
export function registerEnvironmentProbeKind(kind: string, probe: EnvironmentProbe): void { environmentProbeRegistry.register(kind, probe); }
/** PRE-7 ORTAM-HAZIR: Deckent's own check, before any worker starts, that the task's declared environment requirements hold, in declaration
 * order. The first unmet one refuses the launch typed (EXECUTION_ENVIRONMENT_NOT_READY naming it); a kind no adapter registered is unmet
 * (fail closed). A probe failure that is not an answer (daemon, timeout of the control call) propagates as the adapter's own error. */
export async function assertTaskEnvironment(declared: unknown, probes: EnvironmentProbes, signal?: AbortSignal): Promise<void> {
  if (declared === undefined) return;
  for (const requirement of environmentRequirementsSchema.parse(declared).requirements) {
    const probe = probes.get(requirement.kind), answer = probe ? await probe(requirement, signal) : 'unmet';
    // REVISE 2691: a probe whose end could not be proven is neither met nor unmet; it names its probe and nothing launches.
    if (typeof answer === 'object') throw ErrorRegistry.createError(ENVIRONMENT_UNCERTAIN_CODE, { params: { requirement: requirement.id, kind: requirement.kind, probe: answer.uncertain } });
    if (answer !== 'met') throw ErrorRegistry.createError(ENVIRONMENT_NOT_READY_CODE,
      { params: { requirement: requirement.id, kind: requirement.kind, target: requirement.target, registered: probe ? 'yes' : 'no' } });
  }
}
