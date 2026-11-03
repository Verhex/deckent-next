import { isDeepStrictEqual } from 'node:util';
import { nativeAgentExecutionSchema, nativeAgentReadinessSchema, type NativeAgentReadinessReason, type NativeAgentExecution } from './contract.js';
import type { NativeCliWorkerBinding } from './worker-profile.js';
export async function nativeWorkerReadiness(binding: NativeCliWorkerBinding, flagDigest: string | undefined, executable: () => Promise<string | null>,
  ports: { readiness(binding: NativeCliWorkerBinding): Promise<unknown>; f08(binding: NativeCliWorkerBinding): Promise<unknown>; verification?: unknown }): Promise<{ state: 'ready'; execution: NativeAgentExecution; verification?: true } | { state: 'waiting';
    reason: NativeAgentReadinessReason | 'NATIVE_WORKER_F08_REQUIRED' | 'NATIVE_WORKER_F08_INVALID' | 'NATIVE_WORKER_TOOL_SURFACE_UNEXPECTED' | 'NATIVE_WORKER_PLUGIN_UNEXPECTED' }> {
  try {
    const readiness = nativeAgentReadinessSchema.parse(await ports.readiness(binding));
    if (readiness.state !== 'ready') return { state: 'waiting' as const, reason: readiness.reason };
    const { execution } = readiness;
    if (execution.profileDigest !== binding.profileDigest || execution.flagSetDigest !== flagDigest
      || execution.executable !== binding.definition.executable && execution.executable !== await executable() || execution.ownerUid !== binding.definition.ownerUid)
      return { state: 'waiting' as const, reason: 'NATIVE_AGENT_CAPABILITY_UNSEALED' as const };
    const value = await ports.f08(binding);
    if (value === null && ports.verification) return { state: 'ready' as const, execution, verification: true as const };
    const proof = nativeAgentExecutionSchema.safeParse(value);
    return !proof.success || !isDeepStrictEqual(proof.data, execution) ? { state: 'waiting' as const, reason: 'NATIVE_WORKER_F08_REQUIRED' as const } : { state: 'ready' as const, execution };
  } catch (error) {
    const code = (error as { code?: string }).code;
    return { state: 'waiting' as const, reason: code === 'NATIVE_WORKER_TOOL_SURFACE_UNEXPECTED' || code === 'NATIVE_WORKER_PLUGIN_UNEXPECTED' || code === 'NATIVE_WORKER_F08_INVALID'
      ? code : 'NATIVE_AGENT_ENVIRONMENT_REFUSED' as const };
  }
}
