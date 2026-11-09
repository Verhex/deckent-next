import type { ModelReference } from '#domain/index.js';
import { nativeAgentExecutionSchema, nativeAgentReadinessSchema, type NativeAgentExecution, type NativeAgentReadiness,
  type NativeAgentReadinessReason } from '#capabilities/index.js';

export type SubscriptionReadinessSurface = 'chat' | 'worker' | 'brain' | 'agent' | 'skill';
/** Expected digests come from the selected current profile/registry, never from the observation being checked. */
export type SubscriptionReadinessQuery = Readonly<{
  surface: SubscriptionReadinessSurface;
  scopeId: string;
  reference: ModelReference;
  profileDigest: string;
  flagSetDigest: string;
}>;
/** True/false are observed facts; null/absent means unknown, including expired or otherwise unverified facts. */
export type SubscriptionReadinessObservations = Readonly<{
  cli?: boolean | null;
  login?: boolean | null;
  environment?: boolean | null;
  execution?: NativeAgentExecution | null;
  toolSurface?: boolean | null;
  plugins?: boolean | null;
  bridge?: boolean | null;
  /** NF-7: a display read's verification time (host clock, ms); presentation only, never part of readiness. */
  checkedAtMs?: number;
}>;
export interface SubscriptionReadinessReader {
  /** Read only existing observations for this exact surface/scope/reference. The caller owns inspection authorization.
   * Never refresh, preflight, spawn, sign in, read credentials or admit work here; omit stale/missing observations.
   * Execution owners must recheck principal/company/installation, delegation, lease, policy and capacity at admission. */
  read(query: SubscriptionReadinessQuery): Promise<SubscriptionReadinessObservations | null | undefined>;
}
type Check = readonly [boolean | null | undefined, NativeAgentReadinessReason];
const incomplete = (state: 'unknown' | 'unavailable', reason: NativeAgentReadinessReason): NativeAgentReadiness =>
  nativeAgentReadinessSchema.parse({ state, reason });

/** Prerequisite projection only: a ready seal is neither consent, a policy grant, a capacity reservation nor admission.
 * Brain uses its tool-less profile's observations; tool/plugin/bridge failures only block tool-bearing surfaces.
 * No cached result or fallback exists here. K0 requires an execution seal even for a ready Brain projection.
 * `unknownSurfaceFacts: 'allow'`: an unknown tool/plugin/bridge fact does not block (a guarded first run checks it); a false one still does. */
export async function inspectSubscriptionReadiness(input: SubscriptionReadinessQuery, reader: SubscriptionReadinessReader,
  options: Readonly<{ unknownSurfaceFacts?: 'allow' }> = {}): Promise<NativeAgentReadiness> {
  const query = Object.freeze({ ...input, reference: Object.freeze({ ...input.reference }) });
  let observed: SubscriptionReadinessObservations | null | undefined;
  try { observed = await reader.read(query); }
  catch { return incomplete('unknown', 'NATIVE_AGENT_ENVIRONMENT_REFUSED'); }
  const checks: Check[] = [[observed?.cli, 'NATIVE_AGENT_CLI_UNAVAILABLE'], [observed?.login, 'NATIVE_AGENT_LOGIN_REQUIRED'],
    [observed?.environment, 'NATIVE_AGENT_ENVIRONMENT_REFUSED']];
  const surface = (value: boolean | null | undefined) => options.unknownSurfaceFacts === 'allow' ? value !== false : value;
  if (query.surface !== 'brain') checks.push([surface(observed?.plugins), 'NATIVE_AGENT_PLUGIN_UNEXPECTED'],
    [surface(observed?.toolSurface), 'NATIVE_AGENT_TOOL_SURFACE_UNEXPECTED'], [surface(observed?.bridge), 'NATIVE_AGENT_BRIDGE_UNAVAILABLE']);
  const seal = nativeAgentExecutionSchema.safeParse(observed?.execution);
  checks.push([seal.success ? seal.data.profileDigest === query.profileDigest && seal.data.flagSetDigest === query.flagSetDigest : undefined,
    'NATIVE_AGENT_CAPABILITY_UNSEALED']);
  // A known blocker is more informative than an earlier missing observation; neither can produce ready.
  const refused = checks.find(([value]) => value === false);
  if (refused) return incomplete('unavailable', refused[1]);
  const missing = checks.find(([value]) => value !== true);
  if (missing) return incomplete('unknown', missing[1]);
  return nativeAgentReadinessSchema.parse({ state: 'ready', execution: seal.data });
}
