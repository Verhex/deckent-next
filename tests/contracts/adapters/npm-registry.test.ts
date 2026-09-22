import { createServer, type Server } from 'node:http';
import { afterEach, expect, it } from 'vitest';
import { fetchNpmLatestVersion } from '#adapters/index.js';

const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve())))); });
async function registry(handler: Parameters<typeof createServer>[1]) {
  const server = createServer(handler); servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  return `http://127.0.0.1:${address.port}`;
}
const input = (endpoint: string, over: Partial<Parameters<typeof fetchNpmLatestVersion>[0]> = {}) => ({ endpoint, package: '@openai/codex', timeoutMs: 2000, responseMaxBytes: 4096, ...over });

it('reads the latest tag from <endpoint>/<encoded package>/latest with no credentials and bounded response', async () => {
  const seen: string[] = [];
  const endpoint = await registry((request, response) => {
    seen.push(`${request.method} ${request.url} auth=${request.headers.authorization ?? 'none'}`);
    response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ name: '@openai/codex', version: '0.156.0', dist: { tarball: 'x' } }));
  });
  const latest = await fetchNpmLatestVersion(input(endpoint));
  expect(latest).toMatchObject({ version: '0.156.0', source: `${endpoint}/%40openai%2Fcodex/latest` });
  expect(seen).toEqual([`GET /%40openai%2Fcodex/latest auth=none`]);
});
it('maps status, oversized, invalid and timed-out responses to bounded typed errors', async () => {
  const notFound = await registry((_request, response) => { response.statusCode = 404; response.end('{}'); });
  await expect(fetchNpmLatestVersion(input(notFound))).rejects.toMatchObject({ code: 'NPM_REGISTRY_STATUS', status: 404 });
  const huge = await registry((_request, response) => { response.end(JSON.stringify({ version: '1.0.0', padding: 'x'.repeat(8192) })); });
  await expect(fetchNpmLatestVersion(input(huge))).rejects.toMatchObject({ code: 'NPM_REGISTRY_RESPONSE_TOO_LARGE' });
  const invalid = await registry((_request, response) => { response.end(JSON.stringify({ version: 'latest' })); });
  await expect(fetchNpmLatestVersion(input(invalid))).rejects.toMatchObject({ code: 'NPM_REGISTRY_RESPONSE_INVALID' });
  const slow = await registry(() => { /* never answers */ });
  await expect(fetchNpmLatestVersion(input(slow, { timeoutMs: 200 }))).rejects.toMatchObject({ code: 'NPM_REGISTRY_TIMEOUT' });
  await expect(fetchNpmLatestVersion(input('http://127.0.0.1:1'))).rejects.toMatchObject({ code: 'NPM_REGISTRY_UNAVAILABLE' });
  expect(() => fetchNpmLatestVersion(input('ftp://registry.invalid'))).toThrow('NPM_REGISTRY_ENDPOINT_INVALID');
  expect(() => fetchNpmLatestVersion(input('http://127.0.0.1:1', { package: '../etc' }))).toThrow('NPM_REGISTRY_PACKAGE_INVALID');
});
