import { describe, expect, it } from 'vitest';
import type { InferenceServingProfile } from '#domain/index.js';
import { buildInferenceServingPlan, capExecutionSlots, estimateReplicaCapacity, InferenceTokenBudget, parseInferencePrometheus, pickServedModelId, roleContextCeiling } from '#engine/index.js';

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
  serving: {
    backend: 'vllm',
    weightQuant: 'nvfp4',
    kvDtype: 'fp8',
    gpuMemUtil: 0.92,
    overheadGb: 3,
    imageRef: 'vllm/vllm-openai:v0.10.2',
  },
  workload: {
    maxCtx: 163840,
    avgActiveCtx: 32768,
    roleMaxCtx: { brain: 163840, worker: 65536, auditor: 32768 },
  },
  calibration: { computeCap: 8 },
};

describe('inference serving capacity', () => {
  it('derives max-num-seqs from token budget and compute cap', () => {
    const capacity = estimateReplicaCapacity(profile);
    expect(capacity.maxNumSeqs).toBeLessThanOrEqual(profile.calibration.computeCap);
    expect(capacity.totalTokenBudget).toBeGreaterThan(0);
    expect(roleContextCeiling(profile, 'worker')).toBe(65536);
  });

  it('requires exact published model id', () => {
    expect(pickServedModelId('Qwen3.8-27B-Q4_K_M', ['Qwen3.8-27B-Q4_K_M'])).toBe('Qwen3.8-27B-Q4_K_M');
    expect(() => pickServedModelId('Qwen3.8-27B', ['Qwen3.8-27B-Q4_K_M'])).toThrow('INFERENCE_MODEL_ID_MISMATCH');
    expect(() => pickServedModelId('only', ['a', 'b'])).toThrow('INFERENCE_MODEL_ID_MISMATCH');
  });

  it('caps run execution slots to inference max-num-seqs', () => {
    const capacity = estimateReplicaCapacity(profile);
    expect(capExecutionSlots(profile, 64)).toBe(capacity.maxNumSeqs);
    expect(capExecutionSlots(profile, 1)).toBe(1);
  });

  it('builds docker launcher argv without latest tag drift', () => {
    const plan = buildInferenceServingPlan(profile);
    expect(plan.launcher.kind).toBe('docker');
    expect(plan.launcher.argv.join(' ')).toContain('--max-num-seqs');
    expect(plan.launcher.argv.join(' ')).toContain('vllm/vllm-openai:v0.10.2');
  });

  it('token budget waits when over capacity', () => {
    const budget = new InferenceTokenBudget(1000, role => roleContextCeiling(profile, role));
    const first = budget.tryReserve({ id: 'a', role: 'worker', estimatedTokens: 900 });
    const second = budget.tryReserve({ id: 'b', role: 'worker', estimatedTokens: 200 });
    expect(first).toBe('admitted');
    expect(second).toBe('wait');
  });

  it('parses prometheus metric aliases', () => {
    const body = 'vllm:kv_cache_usage_perc 42.5\nvllm:num_requests_running 3\nvllm:num_requests_waiting 1\n';
    const snapshot = parseInferencePrometheus(body);
    expect(snapshot.kvCacheUsageRatio).toBeCloseTo(0.425);
    expect(snapshot.running).toBe(3);
    expect(snapshot.waiting).toBe(1);
  });
});
