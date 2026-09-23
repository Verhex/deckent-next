import { createServer, type Server } from 'node:http';
import { afterEach, expect, it } from 'vitest';
import { InferenceMetricsError, readInferenceMetrics } from '#adapters/index.js';

const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve())))); });

async function listen(handler: (requestUrl: string | undefined, reply: import('node:http').ServerResponse) => void) {
  const hits: string[] = [];
  const server = createServer((request, reply) => { hits.push(request.url ?? ''); handler(request.url, reply); });
  servers.push(server);
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve()); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('FIXTURE_ADDRESS');
  return { origin: `http://127.0.0.1:${address.port}`, hits };
}

it('reads a loopback 200 body and refuses a non-loopback host before connecting', async () => {
  const fixture = await listen((_url, reply) => { reply.writeHead(200, { 'content-type': 'text/plain' }); reply.end('metric_ok 1\n'); });
  await expect(readInferenceMetrics({ url: `${fixture.origin}/metrics`, timeoutMs: 1_000, responseMaxBytes: 1024 })).resolves.toEqual({ body: 'metric_ok 1\n' });
  const started = Date.now();
  expect(() => readInferenceMetrics({ url: 'http://203.0.113.5/metrics', timeoutMs: 5_000, responseMaxBytes: 1024 }))
    .toThrow(expect.objectContaining({ code: 'INFERENCE_METRICS_HOST_DENIED' }));
  expect(Date.now() - started).toBeLessThan(500);
  expect(() => readInferenceMetrics({ url: 'http://user:secret@127.0.0.1/metrics', timeoutMs: 1_000, responseMaxBytes: 1024 }))
    .toThrow(expect.objectContaining({ code: 'INFERENCE_METRICS_ENDPOINT_INVALID' }));
});

it('does not follow redirects and keeps status bodies out of the error', async () => {
  const stolen = await listen((_url, reply) => { reply.writeHead(200); reply.end('stolen'); });
  const fixture = await listen((_url, reply) => {
    reply.writeHead(302, { location: `${stolen.origin}/metrics` });
    reply.end('secret-location');
  });
  const error = await readInferenceMetrics({ url: `${fixture.origin}/metrics`, timeoutMs: 1_000, responseMaxBytes: 1024 }).catch(value => value);
  expect(error).toBeInstanceOf(InferenceMetricsError);
  expect(error).toMatchObject({ code: 'INFERENCE_METRICS_REDIRECT', status: 302 });
  expect(String(error.message)).not.toContain('secret-location');
  expect(String(error.message)).not.toContain(stolen.origin);
  expect(stolen.hits).toEqual([]);
  expect(fixture.hits).toEqual(['/metrics']);
});

it('reports non-200, size and timeout without the response body', async () => {
  const status = await listen((_url, reply) => { reply.writeHead(503); reply.end('secret-status'); });
  const statusError = await readInferenceMetrics({ url: `${status.origin}/metrics`, timeoutMs: 1_000, responseMaxBytes: 1024 }).catch(value => value);
  expect(statusError).toMatchObject({ code: 'INFERENCE_METRICS_STATUS', status: 503 });
  expect(String(statusError.message)).not.toContain('secret-status');
  const large = await listen((_url, reply) => { reply.writeHead(200); reply.end('0123456789'); });
  await expect(readInferenceMetrics({ url: `${large.origin}/metrics`, timeoutMs: 1_000, responseMaxBytes: 4 }))
    .rejects.toMatchObject({ code: 'INFERENCE_METRICS_RESPONSE_TOO_LARGE' });
  const hung = await listen(() => { /* never respond */ });
  await expect(readInferenceMetrics({ url: `${hung.origin}/metrics`, timeoutMs: 50, responseMaxBytes: 1024 }))
    .rejects.toMatchObject({ code: 'INFERENCE_METRICS_TIMEOUT' });
});
