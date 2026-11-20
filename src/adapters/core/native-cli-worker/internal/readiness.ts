import { nativeWorkerReadiness } from '#capabilities/index.js';
import { nativeAgentFlagSetDigest, resolveHeadlessExecutable } from '#adapters/core/native-cli-headless/index.js';
import { nativeCliAgent } from '#adapters/core/native-cli-registry/index.js';
import type { NativeCliWorkerBinding } from './profile.js';
import type { NativeCliWorkerPorts, NativeCliWorkerReadiness } from './ports.js';

export async function inspectNativeCliWorker(binding: NativeCliWorkerBinding, ports: Pick<NativeCliWorkerPorts, 'readiness' | 'f08' | 'readinessPoint' | 'verification'>): Promise<NativeCliWorkerReadiness> {
  const entry = nativeCliAgent(binding.protocolFamily);
  const { executable, ownerUid } = binding.definition;
  return nativeWorkerReadiness(binding, entry ? nativeAgentFlagSetDigest(entry) : undefined,
    () => entry ? resolveHeadlessExecutable(entry, executable, ownerUid).then(program => program.executable, () => null) : Promise.resolve(null), ports);
}
