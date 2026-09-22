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

/** Containers listen on all container interfaces behind a loopback-only publish; host processes bind loopback. */
function buildVllmArgs(profile: InferenceServingProfile, capacity: ReturnType<typeof estimateReplicaCapacity>, host: string, port: number): string[] {
  const model = profile.serving.modelPath ?? profile.model.modelId;
  const args = [
    '--model', model,
    '--host', host,
    '--port', String(port),
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
  if (profile.serving.backend === 'vllm' && profile.serving.imageRef) {
    const vllmArgs = buildVllmArgs(profile, capacity, '0.0.0.0', 8000);
    const gpuFlag = profile.hardware.gpus > 0 ? ['--gpus', `device=${profile.hardware.gpus === 1 ? '0' : 'all'}`] : [];
    return {
      profileId: profile.id,
      backend: profile.serving.backend,
      capacity,
      openaiBaseUrl,
      launcher: {
        kind: 'docker',
        argv: ['docker', 'run', '--rm', '-p', `127.0.0.1:${port}:8000`, ...gpuFlag, profile.serving.imageRef, ...vllmArgs],
        env: {},
      },
    };
  }
  return {
    profileId: profile.id,
    backend: profile.serving.backend,
    capacity,
    openaiBaseUrl,
    launcher: { kind: 'process', argv: ['vllm', ...buildVllmArgs(profile, capacity, '127.0.0.1', port)], env: {} },
  };
}
