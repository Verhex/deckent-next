import { createLocalTls } from '../../fixtures/local-tls.js';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { NativeJsonHttpError, sendNativeJsonHttp } from '#adapters/core/provider-http-json/index.js';

const servers: Server[] = [];
const limits = { requestMaxBytes: 4096, responseMaxBytes: 4096, timeoutMs: 5000 };
let directory = '', certificate = '', privateKey = '';
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'deckent-provider-http-json-'));
  ({ key: privateKey, caPem: certificate } = await createLocalTls(directory));
});
afterEach(async () => Promise.all(servers.splice(0).map(async server => {
  server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
})).then(async () => rm(directory, { recursive: true, force: true })));
async function fixture(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const server = createServer(handler); servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('FIXTURE_ADDRESS');
  return `http://127.0.0.1:${address.port}/`;
}
async function secureFixture(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const server = createHttpsServer({ key: privateKey, cert: certificate }, handler); servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('FIXTURE_ADDRESS');
  return `https://127.0.0.1:${address.port}/`;
}
const response = Object.freeze({ schemaVersion: 1 as const, native: Object.freeze({ answer: 'stable' }), usage: null });

it('snapshots body, parser, endpoint, and resolver before asynchronous credential resolution', async () => {
  const seen: string[] = []; let secondRequests = 0;
  const first = await secureFixture((request, reply) => { const chunks: Buffer[] = []; request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => { seen.push(Buffer.concat(chunks).toString('utf8')); reply.end('{"source":"first"}'); }); });
  const second = await secureFixture((_request, reply) => { secondRequests++; reply.end('{}'); });
  const definition = { endpoint: first, authentication: { type: 'bearer' as const, credentialRef: 'TOKEN' }, tls: { caPem: certificate } };
  const request = { definition, limits: { ...limits }, body: '{"before":true}', adapter: { id: 'adapter-one', version: 1 } };
  let parsed = '';
  const options = { async resolveCredential() {
    request.body = '{"after":true}'; definition.endpoint = second; definition.tls.caPem = 'invalid';
    options.parseResponse = () => { throw new Error('mutated parser'); };
    options.resolveCredential = async () => { throw new Error('mutated resolver'); };
    await Promise.resolve(); return 'secret';
  }, parseResponse: (body: Buffer) => { parsed = body.toString('utf8'); return { response }; } };
  await expect(sendNativeJsonHttp(request, options)).resolves.toEqual(response);
  expect(seen).toEqual(['{"before":true}']); expect(parsed).toBe('{"source":"first"}'); expect(secondRequests).toBe(0);
});

it('does not execute accessor properties in request wrappers or nested security definitions', async () => {
  let reads = 0;
  const accessorRequest = Object.defineProperty({ limits, body: '{}', adapter: { id: 'adapter-one', version: 1 } }, 'definition', {
    enumerable: true, get() { reads++; return {}; },
  });
  await expect(sendNativeJsonHttp(accessorRequest as never, { parseResponse: () => ({ response }) }))
    .rejects.toMatchObject({ code: 'NATIVE_JSON_HTTP_REQUEST_INVALID' } satisfies Partial<NativeJsonHttpError>);
  const nested = Object.defineProperty({ authentication: { type: 'none' } }, 'endpoint', {
    enumerable: true, get() { reads++; return 'http://127.0.0.1:1/'; },
  });
  await expect(sendNativeJsonHttp({ definition: nested, limits, body: '{}', adapter: { id: 'adapter-one', version: 1 } } as never,
    { parseResponse: () => ({ response }) })).rejects.toMatchObject({ code: 'NATIVE_JSON_HTTP_DEFINITION_INVALID' });
  const adapter = Object.defineProperty({ version: 1 }, 'id', { enumerable: true, get() { reads++; return 'adapter-one'; } });
  await expect(sendNativeJsonHttp({ definition: { endpoint: 'http://127.0.0.1:1/', authentication: { type: 'none' } },
    limits, body: '{}', adapter } as never, { parseResponse: () => ({ response }) }))
    .rejects.toMatchObject({ code: 'NATIVE_JSON_HTTP_REQUEST_INVALID' });
  expect(reads).toBe(0);
});

it('records the exact generic adapter identity in rejected response evidence', async () => {
  const body = Buffer.from('{"error":"limited"}');
  const endpoint = await fixture((_request, response) => { response.statusCode = 429; response.end(body); });
  const result = await sendNativeJsonHttp({ definition: { endpoint, authentication: { type: 'none' } }, limits, body: '{}',
    adapter: { id: 'custom-native-adapter', version: 7 } }, { parseResponse: () => ({ response }) });
  expect(result).toMatchObject({ kind: 'rejected', evidence: { adapter: { id: 'custom-native-adapter', version: 7 },
    reason: 'http-status', httpStatus: 429, body: { complete: true, byteLength: body.byteLength, observedBytes: body.byteLength } } });
});
