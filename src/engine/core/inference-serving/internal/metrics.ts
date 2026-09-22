export interface InferencePrometheusSnapshot {
  readonly kvCacheUsageRatio: number | null;
  readonly running: number | null;
  readonly waiting: number | null;
}

const KV_KEYS = ['vllm:gpu_cache_usage_perc', 'vllm:kv_cache_usage_perc'];
const RUNNING_KEYS = ['vllm:num_requests_running'];
const WAITING_KEYS = ['vllm:num_requests_waiting'];

function parseGauge(body: string, names: readonly string[]): number | null {
  for (const line of body.split('\n')) {
    if (line.startsWith('#')) continue;
    for (const name of names) {
      if (line.startsWith(`${name} `)) {
        const value = Number(line.slice(name.length + 1).trim());
        return Number.isFinite(value) ? value : null;
      }
    }
  }
  return null;
}

export function parseInferencePrometheus(body: string): InferencePrometheusSnapshot {
  const kv = parseGauge(body, KV_KEYS);
  return {
    kvCacheUsageRatio: kv === null ? null : kv / (kv > 1 ? 100 : 1),
    running: parseGauge(body, RUNNING_KEYS),
    waiting: parseGauge(body, WAITING_KEYS),
  };
}
