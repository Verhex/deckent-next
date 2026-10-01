import { modelInvocationProfileSchema } from '#domain/index.js';
import { assessModelInvocationProfileDeliveries, ModelBindingApplication, runtimeServiceResultCapacity,
  type ModelInvocationDelivery, type ModelInvocationDeliveryFinding, type ModelInvocationDeliverySurface,
  type ModelInvocationDeliveryProfileTarget } from '#engine/index.js';
import { mcpToolDeliveryCapacityForProbe } from '#adapters/index.js';
import { loadConfig, type ConfigLoadOptions } from '#platform/index.js';
export type { ModelInvocationDeliveryFinding, ModelInvocationDeliverySurface } from '#engine/index.js';
/** Fixed, non-secret probe identities: this never reaches a live request table, only sizes a hypothetical envelope. */
const PROBE_REQUEST_ID = '00000000-0000-4000-8000-000000000001';
const PROBE_MCP_TOOL_CALL_ID = 'doctor-model-invocation-delivery-probe';
type LoadedConfig = Awaited<ReturnType<typeof loadConfig>>;
/**
 * Every delivery-bounded surface a declared profile's worst-case result must fit, for this installation's
 * current config — the one piece of adapter selection/wiring this card needs (SESSION-RESULT-LIMIT-2026-09-28
 * review): which capacity function serves which surface. The audit decision itself (profile list → finding,
 * activation accept/reject) lives in engine (`assessModelInvocationProfileDeliveries`,
 * `ModelActivationApplication.admit`), not here.
 */
export function configuredModelInvocationDeliverySurfaces(config: LoadedConfig):
  readonly (readonly [ModelInvocationDeliverySurface, ModelInvocationDelivery])[] {
  const runtimeServiceDelivery: ModelInvocationDelivery = {
    maxResultBytes: runtimeServiceResultCapacity(PROBE_REQUEST_ID, config.service.responseMaxBytes, undefined) };
  const mcpDelivery = mcpToolDeliveryCapacityForProbe(PROBE_MCP_TOOL_CALL_ID, config.mcp.responseMaxBytes);
  return mcpDelivery ? [['runtime-service', runtimeServiceDelivery], ['mcp', mcpDelivery]] : [['runtime-service', runtimeServiceDelivery]];
}
/**
 * Typed, read-only, network-free audit (SESSION-RESULT-LIMIT-2026-09-28): for every declared invocation profile,
 * predicts whether the runtime-service (CLI/SDK line mode, `terminal session`) and MCP (`invoke_model`) surfaces
 * could ever deliver its worst-case result. Resolves each profile's binding (adapter selection: which catalog
 * definition it pairs with) and hands the resolved targets to the engine's audit decision
 * (`assessModelInvocationProfileDeliveries`) — this function does no size math of its own. A profile whose
 * model is not declared at all is skipped (not this card's concern, a separate pre-existing gap).
 */
export async function assessConfiguredModelInvocationDelivery(projectRoot: string,
  options: ConfigLoadOptions = {}): Promise<readonly ModelInvocationDeliveryFinding[]> {
  const config = await loadConfig(projectRoot, options);
  const configured = config['provider_invocation_profiles'] as { profiles?: unknown[] } | undefined;
  const profiles = (configured?.profiles ?? []).map(value => modelInvocationProfileSchema.parse(value));
  if (profiles.length === 0) return [];
  const bindings = new ModelBindingApplication({ async read() { return config['provider_catalog']; } });
  const targets: ModelInvocationDeliveryProfileTarget[] = [];
  for (const profile of profiles) {
    const binding = await bindings.inspect(profile.reference);
    if (binding.status !== 'declared') continue; // not this card's concern: a separate, pre-existing gap
    targets.push({ profile, definition: binding.definition, catalogRevision: binding.catalogRevision });
  }
  return assessModelInvocationProfileDeliveries(targets, configuredModelInvocationDeliverySurfaces(config));
}
