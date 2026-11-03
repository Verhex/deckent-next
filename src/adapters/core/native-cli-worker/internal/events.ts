import { readLegacyModelUsageEvidence, type WorkerEvent } from '#domain/index.js';
import { createWorkerEventCollector } from '#engine/index.js';
import { nativeWorkerEventRetentionBytes } from '#adapters/core/native-connection/index.js';
import type { resolveNativeCliWorkerProfile } from './profile.js';

export const createNativeWorkerEvents = (binding: NonNullable<ReturnType<typeof resolveNativeCliWorkerProfile>['nativeSubscription']>, accept: (events: readonly WorkerEvent[]) => void) =>
  createWorkerEventCollector({ provider: binding.provider, admitted: binding.model ?? null, evidenceCapability: binding.modelUsageEvidence ?? readLegacyModelUsageEvidence(binding.provider) }, nativeWorkerEventRetentionBytes(), accept);
