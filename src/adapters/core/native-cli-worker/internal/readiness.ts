import { isDeepStrictEqual } from 'node:util';
import { realpath } from 'node:fs/promises';
import { nativeAgentExecutionSchema, nativeAgentReadinessSchema } from '#capabilities/index.js';
import { nativeAgentFlagSetDigest } from '#adapters/core/native-cli-headless/index.js';
import { nativeCliAgent } from '#adapters/core/native-cli-registry/index.js';
import type { NativeCliWorkerBinding } from './profile.js';
import type { NativeCliWorkerPorts, NativeCliWorkerReadiness } from './ports.js';

/** A seal is prerequisite evidence, never a grant. Check the current registry and independently retained F08 binding. */
export async function inspectNativeCliWorker(binding: NativeCliWorkerBinding, ports: Pick<NativeCliWorkerPorts, 'readiness' | 'f08'>): Promise<NativeCliWorkerReadiness> {
  try {
    const readiness = nativeAgentReadinessSchema.parse(await ports.readiness(binding));
    if (readiness.state !== 'ready') return { state: 'waiting', reason: readiness.reason };
    const { execution } = readiness, entry = nativeCliAgent(binding.protocolFamily);
    if (!entry || execution.profileDigest !== binding.profileDigest || execution.flagSetDigest !== nativeAgentFlagSetDigest(entry)
      || execution.executable !== binding.definition.executable && execution.executable !== await realpath(binding.definition.executable).catch(() => null)
      || execution.ownerUid !== binding.definition.ownerUid)
      return { state: 'waiting', reason: 'NATIVE_AGENT_CAPABILITY_UNSEALED' };
    const proof = nativeAgentExecutionSchema.safeParse(await ports.f08(binding));
    if (!proof.success || !isDeepStrictEqual(proof.data, execution)) return { state: 'waiting', reason: 'NATIVE_WORKER_F08_REQUIRED' };
    return { state: 'ready', execution };
  } catch { return { state: 'waiting', reason: 'NATIVE_AGENT_ENVIRONMENT_REFUSED' }; }
}
