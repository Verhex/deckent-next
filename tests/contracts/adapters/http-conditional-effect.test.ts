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
