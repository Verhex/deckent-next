import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { fetchHttps, isPublicNativeAddress, NETWORK_FETCH_OPERATION, operationsConfigSchema, planFetchCall, readOperationsConfig, registerProviderConfig,
  resolveOperationCatalog, SYSTEM_FETCH_TRANSPORT, type HttpFetchTransport } from '#adapters/index.js';
import { startFetchFixture, type FetchFixture } from '../support/fetch-fixture.js';

// FETCH S6 (owner 2026-09-28): the governed HTTPS fetch adapter against a real local TLS server. The test transport only re-routes an
// address the adapter already checked as public; a private or local answer is refused by the adapter's own check before any dial.
const roots: string[] = [], fixtures: FetchFixture[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.close();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'deckent-fetch-')); roots.push(root);
  const started = await startFetchFixture(root); fixtures.push(started); return started;
}
const MiB = 1024 * 1024;
const settings = { egress: 'approval' as const, allowedHosts: ['docs.example'], maxBytes: 4 * MiB, timeoutMs: 5_000, maxRedirects: 3 };
const run = (f: { transport: HttpFetchTransport }, url: string, extra: Partial<Parameters<typeof fetchHttps>[0]> = {}) => fetchHttps({ url, maxBytes: settings.maxBytes,
  timeoutMs: settings.timeoutMs, maxRedirects: settings.maxRedirects, redirectAllowed: host => host === 'docs.example' || host === 'mirror.example',
  transport: f.transport, ...extra });

describe.skipIf(process.platform !== 'linux')('https fetch adapter (FETCH S6)', () => {
  it('sends one plain GET to the checked address with SNI and Host = host, no credentials, a fixed User-Agent, and returns the response', async () => {
    const f = await fixture();
    f.routes.set('/page', (_request, response) => response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end('<h1>hello</h1>'));
    const result = await run(f, 'https://docs.example/page#section');
    expect(result).toMatchObject({ outcome: 'response', httpStatus: 200, contentType: 'text/html; charset=utf-8', truncated: false,
      finalUrl: 'https://docs.example/page', redirects: 0 });
    expect(result.body.toString('utf8')).toBe('<h1>hello</h1>');
    expect(f.dialed).toEqual(['93.184.215.14']);
    expect(f.seen).toHaveLength(1);
    const [request] = f.seen;
    expect(request).toMatchObject({ host: 'docs.example', sni: 'docs.example', path: '/page' });
    expect(request!.headers['user-agent']).toBe('Deckent-Fetch/1');
    expect(request!.headers['authorization']).toBeUndefined(); expect(request!.headers['cookie']).toBeUndefined();
    expect(request!.headers['accept-encoding']).toBe('identity');
  }, 30_000);

  it('refuses a private, local or mixed DNS answer before any connection (the check is the adapter\'s, not the transport\'s)', async () => {
    const f = await fixture();
    for (const answer of [['127.0.0.1'], ['10.0.0.7'], ['93.184.215.14', '192.168.1.4'], ['::1'], ['fd00::1'], ['::ffff:127.0.0.1']]) {
      f.answers.set('docs.example', answer);
      expect(await run(f, 'https://docs.example/page')).toMatchObject({ outcome: 'refused', reason: 'address-not-public', httpStatus: null });
    }
    expect(f.dialed).toEqual([]); expect(f.connections()).toBe(0);
  }, 30_000);

  it('the product transport resolves localhost to a loopback address and refuses it; nothing is sent', async () => {
    expect(await fetchHttps({ url: 'https://localhost/', maxBytes: 1024, timeoutMs: 5_000, maxRedirects: 0, redirectAllowed: () => false,
      transport: SYSTEM_FETCH_TRANSPORT })).toMatchObject({ outcome: 'refused', reason: 'address-not-public' });
  }, 30_000);

  it('the shared public-address check covers IPv6 and keeps IPv4 as before', () => {
    for (const address of ['1.1.1.1', '93.184.215.14', '2606:4700:4700::1111', '2a00:1450:4001:80b::200e']) expect(isPublicNativeAddress(address)).toBe(true);
    for (const address of ['10.0.0.1', '127.0.0.1', '100.64.0.1', '169.254.1.1', '192.0.2.1', '::', '::1', 'fe80::1', 'fc00::1', 'fd12:3456::1',
      'ff02::1', '::ffff:127.0.0.1', '::ffff:10.1.2.3', '64:ff9b::a00:1', '2001:db8::1', '2001::1', '2002:c000:204::1', '3fff::1', 'not-an-ip']) {
      expect(isPublicNativeAddress(address)).toBe(false);
    }
  });

  it('cuts a 5 MiB body at 4 MiB and says so', async () => {
    const f = await fixture();
    f.routes.set('/big', (_request, response) => { response.writeHead(200, { 'content-type': 'application/octet-stream' }); response.end(Buffer.alloc(5 * MiB, 0x61)); });
    const result = await run(f, 'https://docs.example/big');
    expect(result).toMatchObject({ outcome: 'response', httpStatus: 200, truncated: true });
    expect(result.body.length).toBe(4 * MiB);
  }, 30_000);

  it('follows a redirect only inside the allowed hosts; outside it the fetch stops (fail closed), http: and loops are refused', async () => {
    const f = await fixture();
    f.routes.set('docs.example/to-mirror', (_request, response) => response.writeHead(302, { location: 'https://mirror.example/final' }).end());
    f.routes.set('mirror.example/final', (_request, response) => response.writeHead(200, { 'content-type': 'text/plain' }).end('mirrored'));
    f.routes.set('docs.example/to-other', (_request, response) => response.writeHead(301, { location: 'https://other.example/x' }).end());
    f.routes.set('docs.example/to-http', (_request, response) => response.writeHead(307, { location: 'http://docs.example/x' }).end());
    f.routes.set('docs.example/loop', (_request, response) => response.writeHead(302, { location: '/loop' }).end());
    const followed = await run(f, 'https://docs.example/to-mirror');
    expect(followed).toMatchObject({ outcome: 'response', httpStatus: 200, finalUrl: 'https://mirror.example/final', redirects: 1 });
    expect(followed.body.toString()).toBe('mirrored');
    expect(f.seen.map(row => row.sni)).toEqual(['docs.example', 'mirror.example']);

    expect(await run(f, 'https://docs.example/to-other')).toMatchObject({ outcome: 'stopped', reason: 'redirect-refused', httpStatus: 301 });
    expect(f.resolved).not.toContain('other.example');
    expect(await run(f, 'https://docs.example/to-http')).toMatchObject({ outcome: 'stopped', reason: 'redirect-refused' });
    expect(await run(f, 'https://docs.example/loop')).toMatchObject({ outcome: 'stopped', reason: 'too-many-redirects', redirects: 3 });
  }, 30_000);

  it('a timeout after the request was sent is unknown, and the adapter never sends it again', async () => {
    const f = await fixture();
    f.routes.set('/slow', (_request, response) => { response.writeHead(200, { 'content-type': 'text/plain' }); response.write('partial'); });
    const result = await run(f, 'https://docs.example/slow', { timeoutMs: 1_000 });
    expect(result).toMatchObject({ outcome: 'unknown', reason: 'timed-out' });
    expect(f.seen).toHaveLength(1); expect(f.connections()).toBe(1);
  }, 30_000);

  it('plans a call before anything is resolved: https only, no credentials, default port, no IP literal, allowlist verdict, byte limit', () => {
    expect(planFetchCall(settings, { url: 'https://docs.example/a?q=1#frag' })).toEqual({ ok: true, url: 'https://docs.example/a?q=1', host: 'docs.example',
      listed: true, maxBytes: 4 * MiB });
    expect(planFetchCall(settings, { url: 'https://Other.Example/x', maxBytes: 100 })).toEqual({ ok: true, url: 'https://other.example/x', host: 'other.example',
      listed: false, maxBytes: 100 });
    expect(planFetchCall(settings, { url: 'https://docs.example/', maxBytes: 64 * MiB })).toMatchObject({ ok: true, maxBytes: 4 * MiB });
    expect(planFetchCall(settings, { url: 'http://docs.example/' })).toEqual({ ok: false, error: 'not-https' });
    expect(planFetchCall(settings, { url: 'ftp://docs.example/' })).toEqual({ ok: false, error: 'not-https' });
    expect(planFetchCall(settings, { url: 'https://user:pw@docs.example/' })).toEqual({ ok: false, error: 'credentials-in-url' });
    expect(planFetchCall(settings, { url: 'https://docs.example:8443/' })).toEqual({ ok: false, error: 'port-not-allowed' });
    expect(planFetchCall(settings, { url: 'https://93.184.215.14/' })).toEqual({ ok: false, error: 'ip-literal-host' });
    expect(planFetchCall(settings, { url: 'https://[2606:4700::1111]/' })).toEqual({ ok: false, error: 'ip-literal-host' });
    expect(planFetchCall(settings, { url: 'not a url' })).toEqual({ ok: false, error: 'invalid-url' });
    expect(planFetchCall(settings, { url: `https://docs.example/${'a'.repeat(2048)}` })).toEqual({ ok: false, error: 'url-too-long' });
    expect(planFetchCall(settings, { url: 'https://docs.example/', maxBytes: 0 })).toEqual({ ok: false, error: 'invalid-arguments' });
    // `allowlist` egress: a host outside the list is refused before any card; `approval` egress asks for it.
    expect(planFetchCall({ ...settings, egress: 'allowlist' }, { url: 'https://other.example/' })).toEqual({ ok: false, error: 'host-not-allowed' });
    expect(planFetchCall({ ...settings, egress: 'none' }, { url: 'https://docs.example/' })).toEqual({ ok: false, error: 'network-disabled' });
  });
});

describe('network.fetch is a Core operation of the one catalog (FETCH S7)', () => {
  it('resolves as Core, and configuration can neither redefine its id at any version nor claim its target kind', () => {
    registerProviderConfig();
    const entry = resolveOperationCatalog(readOperationsConfig({})).entries().find(row => row.descriptor.operation.id === 'network.fetch');
    expect(entry).toEqual({ descriptor: NETWORK_FETCH_OPERATION, provenance: { source: 'core', module: 'core.network-fetch@1' } });
    const issues = (value: unknown) => operationsConfigSchema.safeParse(value).error?.issues.map(issue => issue.message) ?? [];
    for (const version of [1, 2]) {
      expect(issues({ catalog: [{ ...NETWORK_FETCH_OPERATION, operation: { id: 'network.fetch', version } }] })).toContain('OPERATION_CORE_REDEFINED');
    }
    const claim = { adapter: 'http-conditional', options: { kind: 'network-fetch', baseUrl: 'https://erp.example/api', timeoutMs: 1_000, responseMaxBytes: 1_024,
      idempotencyLookup: true } };
    expect(issues({ catalog: [], targets: [claim] })).toEqual(['OPERATION_TARGET_KIND_RESERVED']);
  });
});
