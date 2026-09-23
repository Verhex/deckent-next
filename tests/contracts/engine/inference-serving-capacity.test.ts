import { describe, expect, it } from 'vitest';
import type { InferenceServingProfile } from '#domain/index.js';
import { buildInferenceServingPlan, estimateReplicaCapacity, InferenceTokenBudget, loopbackMetricsUrl, previewEmptyInferenceSlot, roleContextCeiling } from '#engine/index.js';

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

  it('rejects a request above its role ceiling instead of silently clamping it', () => {
    const budget = new InferenceTokenBudget(10_000_000, role => roleContextCeiling(profile, role));
    expect(budget.tryReserve({ id: 'big', role: 'auditor', estimatedTokens: 32769 })).toBe('rejected');
    expect(budget.tryReserve({ id: 'fit', role: 'auditor', estimatedTokens: 32768 })).toBe('admitted');
    expect(budget.snapshot().reserved).toBe(32768);
  });

  it('publishes launchers on loopback only', () => {
    const docker = buildInferenceServingPlan(profile, 18080).launcher.argv;
    expect(docker.slice(0, 5)).toEqual(['docker', 'run', '--rm', '-p', '127.0.0.1:18080:8000']);
    const process = buildInferenceServingPlan({ ...profile, serving: { ...profile.serving, imageRef: undefined } } as InferenceServingProfile, 18081).launcher.argv;
    expect(process[0]).toBe('vllm');
    expect(process.slice(process.indexOf('--host'), process.indexOf('--host') + 4)).toEqual(['--host', '127.0.0.1', '--port', '18081']);
  });

  it('reads metrics only from loopback and previews an empty slot without keeping the hold', () => {
    expect(loopbackMetricsUrl('http://127.0.0.1:18080/v1')).toEqual({ ok: true, url: 'http://127.0.0.1:18080/metrics' });
    expect(loopbackMetricsUrl('http://10.0.0.8:18080/v1')).toEqual({ ok: false, code: 'INFERENCE_METRICS_HOST_DENIED' });
    const request = { id: 'task-1', role: 'worker' as const, estimatedTokens: 100 };
    expect(previewEmptyInferenceSlot(profile, request)).toBe('admitted');
    const budget = new InferenceTokenBudget(estimateReplicaCapacity(profile).totalTokenBudget, role => roleContextCeiling(profile, role));
    expect(budget.snapshot().reserved).toBe(0);
  });
});
