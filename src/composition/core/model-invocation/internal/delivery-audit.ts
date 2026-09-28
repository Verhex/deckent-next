import { modelInvocationProfileSchema, type ModelInvocationProfile, type ModelReference } from '#domain/index.js';
import { assessModelInvocationProfileDelivery, ModelBindingApplication, ModelInvocationStoreError,
  runtimeServiceResultCapacity, type ModelInvocationDelivery, type ModelInvocationDeliveryFinding,
  type ModelInvocationDeliverySurface } from '#engine/index.js';
import { boundedToolDelivery } from '#surfaces/index.js';
import { loadConfig, type ConfigLoadOptions } from '#platform/index.js';

export type { ModelInvocationDeliveryFinding, ModelInvocationDeliverySurface } from '#engine/index.js';

/** Fixed, non-secret probe identities: this never reaches a live request table, only sizes a hypothetical envelope. */
const PROBE_REQUEST_ID = '00000000-0000-4000-8000-000000000001';
const PROBE_MCP_TOOL_CALL_ID = 'doctor-model-invocation-delivery-probe';

type LoadedConfig = Awaited<ReturnType<typeof loadConfig>>;

/** Every delivery-bounded surface a declared profile's worst-case result must fit, for this installation's current
 * config — shared by the doctor audit and the activation-time check so both size the same two surfaces the same way. */
export function configuredModelInvocationDeliverySurfaces(config: LoadedConfig):
  readonly (readonly [ModelInvocationDeliverySurface, ModelInvocationDelivery])[] {
  const runtimeServiceDelivery: ModelInvocationDelivery = {
    maxResultBytes: runtimeServiceResultCapacity(PROBE_REQUEST_ID, config.service.responseMaxBytes, undefined) };
  const mcpDelivery = boundedToolDelivery(PROBE_MCP_TOOL_CALL_ID, config.mcp.responseMaxBytes);
  return mcpDelivery ? [['runtime-service', runtimeServiceDelivery], ['mcp', mcpDelivery]] : [['runtime-service', runtimeServiceDelivery]];
}
/** Every profile declared for this exact scope + model reference (there may be more than one across scopes). */
export function configuredModelInvocationProfiles(config: LoadedConfig, scopeId: string,
  reference: ModelReference): readonly ModelInvocationProfile[] {
  const configured = config['provider_invocation_profiles'] as { profiles?: unknown[] } | undefined;
  return (configured?.profiles ?? []).map(value => modelInvocationProfileSchema.parse(value))
    .filter(profile => profile.scopeId === scopeId && profile.reference.providerId === reference.providerId
      && profile.reference.providerVersion === reference.providerVersion && profile.reference.modelId === reference.modelId
      && profile.reference.modelVersion === reference.modelVersion);
}
/** Findings for one already-resolved profile across every delivery surface; [] when it fits everywhere or its
 * binding is stale (a separate, pre-existing condition, not a delivery-fitness answer). */
export function assessModelInvocationProfileDeliverySurfaces(profile: ModelInvocationProfile, definition: Parameters<typeof assessModelInvocationProfileDelivery>[1],
  catalogRevision: string, surfaces: ReturnType<typeof configuredModelInvocationDeliverySurfaces>): readonly ModelInvocationDeliveryFinding[] {
  const findings: ModelInvocationDeliveryFinding[] = [];
  for (const [surface, delivery] of surfaces) {
    let assessment;
    try { assessment = assessModelInvocationProfileDelivery(profile, definition, catalogRevision, delivery); }
    catch (error) {
      if (error instanceof ModelInvocationStoreError && error.code === 'MODEL_INVOCATION_CORRUPT') continue; // stale binding, separate concern
      throw error;
    }
    if (!assessment.fits) findings.push({ scopeId: profile.scopeId, profileId: profile.id, reference: profile.reference,
      surface, requiredBytes: assessment.requiredBytes, availableBytes: assessment.availableBytes });
  }
  return findings;
}

/**
 * Typed, read-only, network-free audit (SESSION-RESULT-LIMIT-2026-09-28): for every declared invocation profile,
 * predicts whether the runtime-service (CLI/SDK line mode, `terminal session`) and MCP (`invoke_model`) surfaces
 * could ever deliver its worst-case result, reusing `assessModelInvocationProfileDelivery` (which itself reuses
 * `assertInvocationDeliveryFit`) — never a second copy of the size math. A profile whose model is not declared at
 * all is skipped (not this card's concern, a separate pre-existing gap).
 */
export async function assessConfiguredModelInvocationDelivery(projectRoot: string,
  options: ConfigLoadOptions = {}): Promise<readonly ModelInvocationDeliveryFinding[]> {
  const config = await loadConfig(projectRoot, options);
  const configured = config['provider_invocation_profiles'] as { profiles?: unknown[] } | undefined;
  const profiles = (configured?.profiles ?? []).map(value => modelInvocationProfileSchema.parse(value));
  if (profiles.length === 0) return [];
  const bindings = new ModelBindingApplication({ async read() { return config['provider_catalog']; } });
  const surfaces = configuredModelInvocationDeliverySurfaces(config);
  const findings: ModelInvocationDeliveryFinding[] = [];
  for (const profile of profiles) {
    const binding = await bindings.inspect(profile.reference);
    if (binding.status !== 'declared') continue; // not this card's concern: a separate, pre-existing gap
    findings.push(...assessModelInvocationProfileDeliverySurfaces(profile, binding.definition, binding.catalogRevision, surfaces));
  }
  return findings;
}
