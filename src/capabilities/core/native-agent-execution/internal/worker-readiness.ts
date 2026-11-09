import { isDeepStrictEqual } from 'node:util';
import { nativeAgentExecutionSchema, nativeAgentReadinessSchema, type NativeAgentReadinessReason, type NativeAgentExecution } from './contract.js';
import type { NativeCliWorkerBinding } from './worker-profile.js';
/** Worker refusals a readiness point reports as themselves; every other failure stays NATIVE_AGENT_ENVIRONMENT_REFUSED (fail-closed). */
const WORKER_REFUSALS = ['NATIVE_WORKER_TOOL_SURFACE_UNEXPECTED', 'NATIVE_WORKER_PLUGIN_UNEXPECTED', 'NATIVE_WORKER_F08_INVALID'] as const;
/** The seal was made for this definition's CLI and owner: its resolved executable, or (`recorded`, the worker binding) the recorded path itself. */
export async function sealMatchesDefinition(execution: NativeAgentExecution, definition: Readonly<{ executable: string; ownerUid: number }>,
  resolved: () => Promise<string | null>, recorded = false): Promise<boolean> {
  return execution.ownerUid === definition.ownerUid && (recorded && execution.executable === definition.executable || execution.executable === await resolved());
}
type ReadinessPoint = Readonly<{ readiness: unknown; f08(execution: NativeAgentExecution): Promise<unknown> }>;
/** `readinessPoint`: readiness and its F08 on one snapshot; without it the separate `readiness` and `f08` ports each read their own. */
export async function nativeWorkerReadiness(binding: NativeCliWorkerBinding, flagDigest: string | undefined, executable: () => Promise<string | null>,
  ports: { readiness(binding: NativeCliWorkerBinding): Promise<unknown>; f08(binding: NativeCliWorkerBinding): Promise<unknown>; readinessPoint?(binding: NativeCliWorkerBinding): Promise<ReadinessPoint>;
    verification?: unknown }): Promise<{ state: 'ready'; execution: NativeAgentExecution; verification?: true } | { state: 'waiting';
    reason: NativeAgentReadinessReason | 'NATIVE_WORKER_F08_REQUIRED' | typeof WORKER_REFUSALS[number] }> {
  try {
    const point = ports.readinessPoint ? await ports.readinessPoint(binding) : { readiness: await ports.readiness(binding), f08: () => ports.f08(binding) };
    const readiness = nativeAgentReadinessSchema.parse(point.readiness);
    if (readiness.state !== 'ready') return { state: 'waiting' as const, reason: readiness.reason };
    const { execution } = readiness;
    if (execution.profileDigest !== binding.profileDigest || execution.flagSetDigest !== flagDigest || !await sealMatchesDefinition(execution, binding.definition, executable, true))
      return { state: 'waiting' as const, reason: 'NATIVE_AGENT_CAPABILITY_UNSEALED' as const };
    const value = await point.f08(execution);
    if (value === null && ports.verification) return { state: 'ready' as const, execution, verification: true as const };
    const proof = nativeAgentExecutionSchema.safeParse(value);
    return !proof.success || !isDeepStrictEqual(proof.data, execution) ? { state: 'waiting' as const, reason: 'NATIVE_WORKER_F08_REQUIRED' as const } : { state: 'ready' as const, execution };
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    return { state: 'waiting' as const, reason: WORKER_REFUSALS.find(refusal => refusal === code) ?? 'NATIVE_AGENT_ENVIRONMENT_REFUSED' as const };
  }
}
