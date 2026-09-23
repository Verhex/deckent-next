import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { registerProviderConfig } from '#adapters/index.js';
import { main, type InferenceMetricsReading } from '#surfaces/core/cli/index.js';
import { clearConfigCache } from '#platform/index.js';

registerProviderConfig();
const roots: string[] = [];
afterEach(async () => { clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

const profile = {
  schemaVersion: 1, id: 'dev-5090', scopeId: 'pilot',
  hardware: { gpus: 1, vramGbPerGpu: 32, arch: 'blackwell_consumer', topology: 'single' },
  model: { modelId: 'Qwen/Qwen3-Next-27B', weightGb: 17.5, kvBytesPerTokenBf16: 65536, kvBytesPerTokenFp8: 32768, deltaNetStateGbPerSeq: 0.1 },
  serving: { backend: 'vllm', openaiBaseUrl: 'http://127.0.0.1:9/v1', weightQuant: 'nvfp4', kvDtype: 'fp8', gpuMemUtil: 0.92, overheadGb: 3 },
  workload: { maxCtx: 163840, avgActiveCtx: 32768, roleMaxCtx: { brain: 163840, worker: 65536, auditor: 32768 } },
  calibration: { computeCap: 8 },
  metrics: { timeoutMs: 1_000, responseMaxBytes: 256 },
};

async function project() {
  const root = await mkdtemp(join(tmpdir(), 'deckent-inference-metrics-cli-'));
  roots.push(root);
  const projectRoot = join(root, 'project');
  await mkdir(join(projectRoot, '.deckent'), { recursive: true });
  await writeFile(join(projectRoot, '.deckent/config.json'), JSON.stringify({
    inference_serving: { schemaVersion: 1, activeProfileId: 'dev-5090', profiles: [profile] } }));
  return { projectRoot, env: { HOME: join(root, 'home'), PATH: process.env.PATH ?? '' } };
}

it('inference metrics only calls the composition handler', async () => {
  const f = await project();
  const stdout: string[] = [], stderr: string[] = [];
  const sinks = { stdout: { write: (text: string) => { stdout.push(text); return true; } }, stderr: { write: (text: string) => { stderr.push(text); return true; } } };
  const help = await main(['inference', 'metrics', '--help'], { root: f.projectRoot, env: f.env, ...sinks, initialize: registerProviderConfig });
  expect(help).toBe(0);
  expect(stdout.join('')).toContain('inference metrics');
  stdout.length = 0;
  let calls = 0;
  const read = async (): Promise<InferenceMetricsReading> => { calls += 1; return { ok: true, url: 'http://127.0.0.1:9/metrics', body: 'metric_ok 1\n' }; };
  const shown = await main(['inference', 'metrics'], { root: f.projectRoot, env: f.env, ...sinks, initialize: registerProviderConfig, readInferenceMetrics: read });
  expect(shown).toBe(0);
  expect(calls).toBe(1);
  expect(stdout.join('')).toContain('metric_ok 1');
  expect(stderr.join('')).not.toContain('metric_ok');
  stdout.length = 0;
  const denied = await main(['inference', 'metrics', '--json'], { root: f.projectRoot, env: f.env, ...sinks, initialize: registerProviderConfig,
    readInferenceMetrics: async () => ({ ok: false, code: 'INFERENCE_METRICS_HOST_DENIED', url: null }) });
  expect(denied).toBe(1);
  expect(stdout.join('')).toBe('');
  expect(stderr.join('')).toContain('INFERENCE_METRICS_HOST_DENIED');
  expect(stderr.join('')).not.toContain('secret-body');
  const missing = await main(['inference', 'metrics'], { root: f.projectRoot, env: f.env, ...sinks, initialize: registerProviderConfig });
  expect(missing).toBe(2);
  expect(calls).toBe(1);
});
