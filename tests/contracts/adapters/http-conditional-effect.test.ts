import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, expect, it } from 'vitest';
import { HttpConditionalEffectTarget } from '#adapters/index.js';

const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }))); });

it('bounds the whole exchange: a slowly dripping target ends as an unknown outcome within the timeout, and reports its endpoint identity', async () => {
  const server = createServer((_request, response) => { response.writeHead(200); const timer = setInterval(() => response.write('x'), 20); response.on('close', () => clearInterval(timer)); });
  servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/erp/`;
  const target = new HttpConditionalEffectTarget({ kind: 'records', baseUrl, timeoutMs: 300, responseMaxBytes: 1_000_000, idempotencyLookup: true });
  expect(target.identity()).toBe(`records@http://127.0.0.1:${(server.address() as AddressInfo).port}/erp`);
  const started = Date.now();
  await expect(target.apply({ target: { kind: 'records', id: 'PO-1' }, operation: { id: 'post', version: 1 }, idempotencyKey: 'k'.repeat(64), expectedVersion: null, input: null }))
    .rejects.toMatchObject({ code: 'EFFECT_TARGET_UNKNOWN' });
  expect(Date.now() - started).toBeLessThan(2_000);
});

it('refuses a `.` or `..` target id before any request: a dot segment would leave {base}/records/ after URL normalisation (SEC F38)', async () => {
  const seen: string[] = [];
  const server = createServer((request, response) => { seen.push(request.url ?? ''); response.writeHead(200, { etag: 'v1' }); response.end('{}'); });
  servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/erp/`;
  const target = new HttpConditionalEffectTarget({ kind: 'records', baseUrl, timeoutMs: 2_000, responseMaxBytes: 1_000_000, idempotencyLookup: false });
  for (const id of ['..', '.']) {
    await expect(target.apply({ target: { kind: 'records', id }, operation: { id: 'post', version: 1 }, idempotencyKey: 'k'.repeat(64), expectedVersion: null, input: null }))
      .rejects.toMatchObject({ code: 'EFFECT_TARGET_REJECTED' });
    await expect(target.observe({ kind: 'records', id })).rejects.toMatchObject({ code: 'EFFECT_TARGET_REJECTED' });
  }
  expect(seen).toEqual([]);
  // A dotted id that is not a dot segment stays an ordinary record address.
  await target.observe({ kind: 'records', id: '...' });
  expect(seen).toEqual(['/erp/records/...']);
});
