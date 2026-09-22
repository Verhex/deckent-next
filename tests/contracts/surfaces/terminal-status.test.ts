import { describe, expect, it } from 'vitest';
import { estimateReplicaCapacity } from '#engine/index.js';
import type { InferenceServingProfile } from '#domain/index.js';

const profile: InferenceServingProfile = {
  schemaVersion: 1,
  id: 'dev-5090',
  scopeId: 'pilot',
  hardware: { gpus: 1, vramGbPerGpu: 32, arch: 'blackwell_consumer', topology: 'single' },
  model: {
    modelId: 'Qwen/Qwen3-Next-27B',
    weightGb: 17.5,
    kvBytesPerTokenBf16: 65536,
    kvBytesPerTokenFp8: 32768,
    deltaNetStateGbPerSeq: 0.1,
  },
  serving: { backend: 'vllm', weightQuant: 'nvfp4', kvDtype: 'fp8', gpuMemUtil: 0.92, overheadGb: 3 },
  workload: {
    maxCtx: 163840,
    avgActiveCtx: 32768,
    roleMaxCtx: { brain: 163840, worker: 65536, auditor: 32768 },
  },
  calibration: { computeCap: 8 },
};

describe('terminal operator projections', () => {
  it('derives positive token budget for status rendering', () => {
    const capacity = estimateReplicaCapacity(profile);
    expect(capacity.maxNumSeqs).toBeGreaterThan(0);
    expect(capacity.totalTokenBudget).toBeGreaterThan(100_000);
  });
});
