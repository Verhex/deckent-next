import { ENVIRONMENT_NOT_READY_CODE, environmentRequirementsSchema, type EnvironmentRequirement } from '#domain/index.js';
import { ErrorRegistry } from '#platform/index.js';
/** One environment probe kind, registered by an adapter (an open registry: coding kinds in the native-coding adapter, business-process
 * kinds such as a connector or a credential reference in their own adapters, Law 10). It answers only met/unmet: it never calls a model,
 * never receives task text, and a credential kind may only ask the existing secret port whether a reference resolves, never read it out. */
export type EnvironmentProbe = (requirement: EnvironmentRequirement, signal?: AbortSignal) => Promise<'met' | 'unmet'>;
export type EnvironmentProbes = ReadonlyMap<string, EnvironmentProbe>;
/** PRE-7 ORTAM-HAZIR: Deckent's own check, before any worker starts, that the task's declared environment requirements hold, in declaration
 * order. The first unmet one refuses the launch typed (EXECUTION_ENVIRONMENT_NOT_READY naming it); a kind no adapter registered is unmet
 * (fail closed). A probe failure that is not an answer (daemon, timeout of the control call) propagates as the adapter's own error. */
export async function assertTaskEnvironment(declared: unknown, probes: EnvironmentProbes, signal?: AbortSignal): Promise<void> {
  if (declared === undefined) return;
  for (const requirement of environmentRequirementsSchema.parse(declared).requirements) {
    const probe = probes.get(requirement.kind);
    if (!probe || await probe(requirement, signal) !== 'met') throw ErrorRegistry.createError(ENVIRONMENT_NOT_READY_CODE,
      { params: { requirement: requirement.id, kind: requirement.kind, target: requirement.target, registered: probe ? 'yes' : 'no' } });
  }
}
