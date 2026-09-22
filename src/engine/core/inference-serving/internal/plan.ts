import type { InferenceServingProfile } from '#domain/index.js';
import { estimateReplicaCapacity } from './capacity.js';

export interface InferenceServingPlan {
  readonly profileId: string;
  readonly backend: InferenceServingProfile['serving']['backend'];
  readonly capacity: ReturnType<typeof estimateReplicaCapacity>;
  readonly launcher: {
    readonly kind: 'docker' | 'process';
    readonly argv: readonly string[];
    readonly env: Readonly<Record<string, string>>;
  };
  readonly openaiBaseUrl: string | null;
}

function defaultOpenAiBase(port: number): string {
  return `http://127.0.0.1:${port}/v1`;
}

function buildVllmArgs(profile: InferenceServingProfile, capacity: ReturnType<typeof estimateReplicaCapacity>): string[] {
  const model = profile.serving.modelPath ?? profile.model.modelId;
  const args = [
    '--model', model,
    '--host', '0.0.0.0',
    '--port', '8000',
    '--max-model-len', String(profile.workload.maxCtx),
    '--max-num-seqs', String(capacity.maxNumSeqs),
    '--gpu-memory-utilization', String(profile.serving.gpuMemUtil),
  ];
  if (profile.serving.kvDtype === 'fp8') args.push('--kv-cache-dtype', 'fp8');
  if (profile.hardware.topology === 'tp' && profile.hardware.gpus > 1) {
    args.push('--tensor-parallel-size', String(profile.hardware.gpus));
  }
  return args;
}

export function buildInferenceServingPlan(profile: InferenceServingProfile, port = 8000): InferenceServingPlan {
  const capacity = estimateReplicaCapacity(profile);
  const openaiBaseUrl = profile.serving.openaiBaseUrl ?? defaultOpenAiBase(port);
  if (profile.serving.backend === 'openai-compatible') {
    return {
      profileId: profile.id,
      backend: profile.serving.backend,
      capacity,
      openaiBaseUrl: profile.serving.openaiBaseUrl ?? null,
      launcher: { kind: 'process', argv: [], env: {} },
    };
  }
  const vllmArgs = buildVllmArgs(profile, capacity);
  if (profile.serving.backend === 'vllm' && profile.serving.imageRef) {
    const gpuFlag = profile.hardware.gpus > 0 ? ['--gpus', `device=${profile.hardware.gpus === 1 ? '0' : 'all'}`] : [];
    return {
      profileId: profile.id,
      backend: profile.serving.backend,
      capacity,
      openaiBaseUrl,
      launcher: {
        kind: 'docker',
        argv: ['docker', 'run', '--rm', '-p', `${port}:8000`, ...gpuFlag, profile.serving.imageRef, ...vllmArgs],
        env: {},
      },
    };
  }
  return {
    profileId: profile.id,
    backend: profile.serving.backend,
    capacity,
    openaiBaseUrl,
    launcher: { kind: 'process', argv: ['vllm', ...vllmArgs], env: {} },
  };
}
