import type { InferenceServingProfile } from '#domain/index.js';

export interface ReplicaCapacityEstimate {
  readonly kvPoolGb: number;
  readonly tokenCapacity: number;
  readonly maxNumSeqs: number;
  readonly kvBytesPerToken: number;
  readonly replicaCount: number;
  readonly totalTokenBudget: number;
}

function resolveKvBytesPerToken(profile: InferenceServingProfile): number {
  if (profile.serving.kvDtype === 'bf16') return profile.model.kvBytesPerTokenBf16;
  return profile.model.kvBytesPerTokenFp8;
}

function replicaCount(profile: InferenceServingProfile): number {
  if (profile.hardware.topology === 'dp') return profile.hardware.gpus;
  if (profile.hardware.topology === 'tp') return 1;
  return 1;
}

/** Pure estimate from profile; observed startup logs override via calibration.observedTokenCapacity. */
export function estimateReplicaCapacity(profile: InferenceServingProfile): ReplicaCapacityEstimate {
  const kvBytesPerToken = resolveKvBytesPerToken(profile);
  const replicas = replicaCount(profile);
  const vramGb = profile.hardware.vramGbPerGpu;
  const kvPoolGb = Math.max(0, vramGb * profile.serving.gpuMemUtil - profile.model.weightGb - profile.serving.overheadGb);
  const tokenCapacity = Math.floor((kvPoolGb * 1024 ** 3) / kvBytesPerToken);
  const calibrated = profile.calibration.observedTokenCapacity ?? tokenCapacity;
  const seqBudget = Math.floor(calibrated / profile.workload.avgActiveCtx);
  const maxNumSeqs = Math.max(1, Math.min(seqBudget, profile.calibration.computeCap));
  const totalTokenBudget = calibrated * replicas;
  return { kvPoolGb, tokenCapacity: calibrated, maxNumSeqs, kvBytesPerToken, replicaCount: replicas, totalTokenBudget };
}

export function roleContextCeiling(profile: InferenceServingProfile, role: 'brain' | 'worker' | 'auditor'): number {
  return profile.workload.roleMaxCtx[role];
}
