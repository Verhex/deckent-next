import { realpath } from 'node:fs/promises';
import { nativeWorkerReadiness } from '#capabilities/index.js';
import { nativeAgentFlagSetDigest } from '#adapters/core/native-cli-headless/index.js';
import { nativeCliAgent } from '#adapters/core/native-cli-registry/index.js';
import type { NativeCliWorkerBinding } from './profile.js';
import type { NativeCliWorkerPorts, NativeCliWorkerReadiness } from './ports.js';

export async function inspectNativeCliWorker(binding: NativeCliWorkerBinding, ports: Pick<NativeCliWorkerPorts, 'readiness' | 'f08' | 'readinessPoint' | 'verification'>): Promise<NativeCliWorkerReadiness> {
  const entry = nativeCliAgent(binding.protocolFamily);
  return nativeWorkerReadiness(binding, entry ? nativeAgentFlagSetDigest(entry) : undefined, () => realpath(binding.definition.executable).catch(() => null), ports);
}
