import { createServer, type Server } from 'node:https';
import { connect } from 'node:net';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { TLSSocket } from 'node:tls';
import type { HttpFetchTransport } from '#adapters/index.js';
import { createLocalTls } from '../../fixtures/local-tls.js';

/**
 * FETCH (S6/S7) test fixture: a real local TLS server whose certificate names test hosts, and the test-only transport that routes a
 * *checked public* address to it. The adapter's public-address check runs before this transport is asked to connect, so a resolver
 * answer that is private or local is refused by the product code itself; the transport can only re-route an address that passed.
 */
export const TEST_HOSTS = ['docs.example', 'mirror.example', 'other.example'] as const;
/** Public (non-reserved) IPv4 addresses the test resolver answers with; nothing is ever sent to them (the dial goes to 127.0.0.1). */
export const PUBLIC_ANSWER: Readonly<Record<string, readonly string[]>> = { 'docs.example': ['93.184.215.14'], 'mirror.example': ['151.101.1.69'],
  'other.example': ['151.101.65.69'] };

export type Route = (request: IncomingMessage, response: ServerResponse) => void;
export async function startFetchFixture(root: string) {
  const tls = await createLocalTls(root, { dnsNames: [...TEST_HOSTS] });
  const seen: { host: string | undefined; sni: string | false; path: string | undefined; headers: IncomingMessage['headers'] }[] = [];
  const routes = new Map<string, Route>();
  let connections = 0;
  const server: Server = createServer({ key: tls.key, cert: tls.caPem }, (request, response) => {
    seen.push({ host: request.headers.host, sni: (request.socket as TLSSocket).servername, path: request.url, headers: request.headers });
    const route = routes.get(`${request.headers.host}${request.url}`) ?? routes.get(request.url ?? '');
    if (route) { route(request, response); return; }
    response.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
  });
  server.on('connection', () => { connections++; });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('FIXTURE_ADDRESS');
  const answers = new Map<string, readonly string[]>(Object.entries(PUBLIC_ANSWER));
  const dialed: string[] = [], resolved: string[] = [];
  const transport: HttpFetchTransport = Object.freeze({
    async resolve(host: string) {
      resolved.push(host);
      const found = answers.get(host);
      if (!found) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
      return found;
    },
    connect(checked: string) { dialed.push(checked); return connect({ host: '127.0.0.1', port: address.port }); },
    ca: Object.freeze([tls.caPem]),
  });
  return {
    server, seen, routes, dialed, resolved, answers, transport, connections: () => connections,
    async close() { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); },
  };
}
export type FetchFixture = Awaited<ReturnType<typeof startFetchFixture>>;
