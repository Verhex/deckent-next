import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { registerProviderConfig } from '#adapters/index.js';
import { readConfiguredInferenceMetrics } from '#composition/core/inference-metrics/index.js';
import { clearConfigCache } from '#platform/index.js';

registerProviderConfig();
const roots: string[] = [], servers: Server[] = [];
afterEach(async () => {
  clearConfigCache();
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

const profile = {
  schemaVersion: 1, id: 'dev-5090', scopeId: 'pilot',
  hardware: { gpus: 1, vramGbPerGpu: 32, arch: 'blackwell_consumer', topology: 'single' },
  model: { modelId: 'Qwen/Qwen3-Next-27B', weightGb: 17.5, kvBytesPerTokenBf16: 65536, kvBytesPerTokenFp8: 32768, deltaNetStateGbPerSeq: 0.1 },
  serving: { backend: 'vllm', openaiBaseUrl: 'http://127.0.0.1:9/v1', weightQuant: 'nvfp4', kvDtype: 'fp8', gpuMemUtil: 0.92, overheadGb: 3 },
  workload: { maxCtx: 163840, avgActiveCtx: 32768, roleMaxCtx: { brain: 163840, worker: 65536, auditor: 32768 } },
  calibration: { computeCap: 8 },
};

async function project(serving: Record<string, unknown>) {
  const root = await mkdtemp(join(tmpdir(), 'deckent-inference-metrics-'));
  roots.push(root);
  const projectRoot = join(root, 'project');
  await mkdir(join(projectRoot, '.deckent'), { recursive: true });
  await writeFile(join(projectRoot, '.deckent/config.json'), JSON.stringify({ inference_serving: serving }));
  return { projectRoot, env: { HOME: join(root, 'home'), PATH: process.env.PATH ?? '' } };
}

it('reads loopback metrics with the profile limits and refuses a missing limit or a non-loopback base URL', async () => {
  const hits: string[] = [];
  const server = createServer((request, reply) => { hits.push(request.url ?? ''); reply.writeHead(200); reply.end('live_metric 1\n'); });
  servers.push(server);
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve()); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('FIXTURE_ADDRESS');
  const local = { ...profile, serving: { ...profile.serving, openaiBaseUrl: `http://127.0.0.1:${address.port}/v1` },
    metrics: { timeoutMs: 1_000, responseMaxBytes: 256 } };
  const ready = await project({ schemaVersion: 1, activeProfileId: 'dev-5090', profiles: [local] });
  await expect(readConfiguredInferenceMetrics(ready.projectRoot, {}, { env: ready.env })).resolves.toEqual({
    ok: true, url: `http://127.0.0.1:${address.port}/metrics`, body: 'live_metric 1\n' });
  expect(hits).toEqual(['/metrics']);
  const unlimited = await project({ schemaVersion: 1, activeProfileId: 'dev-5090', profiles: [profile] });
  await expect(readConfiguredInferenceMetrics(unlimited.projectRoot, {}, { env: unlimited.env })).resolves.toEqual({
    ok: false, code: 'INFERENCE_METRICS_LIMITS_MISSING', url: null });
  const remote = { ...local, serving: { ...local.serving, openaiBaseUrl: 'http://203.0.113.5/v1' } };
  const denied = await project({ schemaVersion: 1, activeProfileId: 'dev-5090', profiles: [remote] });
  await expect(readConfiguredInferenceMetrics(denied.projectRoot, {}, { env: denied.env })).resolves.toEqual({
    ok: false, code: 'INFERENCE_METRICS_HOST_DENIED', url: null });
  expect(hits).toEqual(['/metrics']);
});
