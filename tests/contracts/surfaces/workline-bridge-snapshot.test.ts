import { describe, expect, it } from 'vitest';
import { buildWorklineBridgeSnapshot, newWorkerTaskIds } from '#surfaces/core/terminal/index.js';
import { buildInferenceServingPlan } from '#engine/index.js';
import type { InferenceServingProfile } from '#domain/index.js';

const profile: InferenceServingProfile = {
  schemaVersion: 1,
  id: 'host-qwen',
  scopeId: 'pilot',
  hardware: { gpus: 1, vramGbPerGpu: 32, arch: 'blackwell_consumer', topology: 'single' },
  model: {
    modelId: 'qwen-local',
    weightGb: 17.5,
    kvBytesPerTokenBf16: 65536,
    kvBytesPerTokenFp8: 32768,
    deltaNetStateGbPerSeq: 0.1,
  },
  serving: { backend: 'llama_cpp', weightQuant: 'q4', kvDtype: 'fp16', gpuMemUtil: 0.9, overheadGb: 2, port: 18080 },
  workload: { maxCtx: 32768, avgActiveCtx: 8192, roleMaxCtx: { brain: 32768, worker: 8192, auditor: 4096 } },
  calibration: { computeCap: 4 },
};

describe('workline bridge snapshot', () => {
  it('builds desktop-shaped snapshot with a work-only tail cap and no chat content', () => {
    const plan = buildInferenceServingPlan(profile);
    const entries = Array.from({ length: 5 }, (_, index) => [
      { schemaVersion: 1 as const, kind: 'chat' as const, id: `c-${index}`, role: 'user' as const, text: `secret prompt ${index}` },
      { schemaVersion: 1 as const, kind: 'notice' as const, id: `n-${index}`, level: 'info' as const, text: `notice ${index}` },
    ]).flat();
    const snapshot = buildWorklineBridgeSnapshot({
      profile,
      plan,
      tty: { columns: 120, rows: 40 },
      ledgerTail: entries,
      maxTail: 3,
      observedAtMs: 1000,
    });
    expect(snapshot.profileId).toBe('host-qwen');
    expect(snapshot.ledgerTail.map(entry => entry.id)).toEqual(['n-2', 'n-3', 'n-4']);
    expect(JSON.stringify(snapshot)).not.toContain('secret prompt');
    expect(snapshot.observedAtMs).toBe(1000);
  });

  it('dedupes worker watch keys', () => {
    const worker = {
      schemaVersion: 1 as const,
      kind: 'worker' as const,
      id: 'w1',
      scopeId: 'pilot',
      taskId: 't1',
      process: 'running',
      provider: 'docker',
      authority: 'next-ledger',
    };
    const first = newWorkerTaskIds(new Set(), [worker]);
    expect(first.fresh).toHaveLength(1);
    const second = newWorkerTaskIds(first.seen, [worker]);
    expect(second.fresh).toHaveLength(0);
  });
});
