import { Duplex } from 'node:stream';
import { HUB_LIMITS } from '#domain/index.js';
import { expect, it } from 'vitest';
import { startHubHttpListener, hubHttpRequest, HubHttpEffectTarget, HUB_NETWORK_OPERATION } from '#adapters/core/hub-http/index.js';

it('refuses a non-loopback cleartext listener before opening a socket (G18)', async () => {
  await expect(startHubHttpListener({ enabled: true, host: '0.0.0.0', port: 0, endpoint: 'http://hub.invalid/mcp',
    fetch: async () => new Response() })).rejects.toMatchObject({ code: 'HUB_TLS_REQUIRED' });
});

it('refuses private or mixed DNS answers before connect and never follows another origin (G31)', async () => {
  let connections = 0;
  const transport = { resolve: async () => ['93.184.216.34', '169.254.169.254'], connect: () => { connections++; throw new Error(); } };
  const response = await hubHttpRequest(new Request('https://hub.invalid/mcp', { method: 'POST', body: '{}' }), { local: false, transport });
  expect(response).toMatchObject({ outcome: 'refused', reason: 'address-not-public' });
  expect(connections).toBe(0);
});

it('stays off by default and refuses URL credentials/plain remote HTTP without resolving', async () => {
  expect(await startHubHttpListener({ port: 0, endpoint: 'http://127.0.0.1/mcp', fetch: async () => new Response() })).toBeNull();
  let dns = 0;
  const transport = { resolve: async () => { dns++; return ['93.184.216.34']; }, connect: () => { throw new Error(); } };
  expect(await hubHttpRequest(new Request('http://hub.invalid/mcp'), { local: false, transport })).toMatchObject({ outcome: 'refused' });
  expect(await hubHttpRequest(new Request('https://hub.invalid/mcp?access_token=synthetic'), { local: false, transport })).toMatchObject({ outcome: 'refused' });
  expect(dns).toBe(0);
});


/** In-memory HTTP peer: exercises the actual Node HTTP parser/writer without a socket permission or an external host. */
function wireFixture(answer: (path: string) => string) {
  const sent: string[] = [], resolved: string[] = [], pinned: string[] = [];
  const transport = { resolve: async (host: string) => { resolved.push(host); return ['10.0.0.8']; }, connect: (address: string) => {
    pinned.push(address); let bytes = '', answered = false;
    const socket = new Duplex({ read() {}, write(chunk, _encoding, callback) {
      bytes += String(chunk); callback();
      const end = bytes.indexOf('\r\n\r\n'), length = Number(/content-length: (\d+)/i.exec(bytes)?.[1] ?? 0);
      if (!answered && end >= 0 && Buffer.byteLength(bytes.slice(end + 4)) >= length) {
        answered = true; sent.push(bytes);
        queueMicrotask(() => { socket.push(answer(bytes.split(' ')[1]!)); socket.push(null); });
      }
    } });
    queueMicrotask(() => socket.emit('connect'));
    return socket;
  } };
  return { transport, sent, resolved, pinned };
}
it('pins each local hop, preserves POST bytes and Host, and blocks a redirect to another origin (G31)', async () => {
  const f = wireFixture(path => path === '/mcp' ? 'HTTP/1.1 307 Temporary Redirect\r\nLocation: /next\r\nContent-Length: 0\r\n\r\n'
    : 'HTTP/1.1 307 Temporary Redirect\r\nLocation: http://elsewhere.invalid/mcp\r\nContent-Length: 0\r\n\r\n');
  const result = await hubHttpRequest(new Request('http://local.invalid/mcp', { method: 'POST', headers: { host: 'spoof.invalid', cookie: 'synthetic-cookie' }, body: '{"test":1}' }), { local: true, transport: f.transport });
  expect(result).toMatchObject({ outcome: 'stopped', reason: 'url-refused' });
  expect(f.resolved).toEqual(['local.invalid', 'local.invalid']); expect(f.pinned).toEqual(['10.0.0.8', '10.0.0.8']);
  expect(f.sent).toHaveLength(2);
  expect(f.sent.every(request => request.includes('host: local.invalid') && request.endsWith('{"test":1}') && !request.includes('synthetic-cookie') && !request.includes('spoof.invalid'))).toBe(true);
});
it('bounds redirects and refuses ambiguous POST redirects without changing method or repeating a failed exchange', async () => {
  const f = wireFixture(() => 'HTTP/1.1 307 Temporary Redirect\r\nLocation: /mcp\r\nContent-Length: 0\r\n\r\n');
  expect(await hubHttpRequest(new Request('http://local.invalid/mcp'), { local: true, transport: f.transport })).toMatchObject({ outcome: 'stopped', reason: 'redirect-refused' });
  expect(f.sent).toHaveLength(4);
  const post = wireFixture(() => 'HTTP/1.1 302 Found\r\nLocation: /next\r\nContent-Length: 0\r\n\r\n');
  expect(await hubHttpRequest(new Request('http://local.invalid/mcp', { method: 'POST', body: '{}' }), { local: true, transport: post.transport })).toMatchObject({ outcome: 'stopped' });
  expect(post.sent).toHaveLength(1);
});
it('retains an interrupted sent response as unknown and makes no retry', async () => {
  const f = wireFixture(() => 'HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\npartial');
  expect(await hubHttpRequest(new Request('http://local.invalid/mcp'), { local: true, transport: f.transport })).toMatchObject({ outcome: 'unknown' });
  expect(f.sent).toHaveLength(1);
});

it('binds the outgoing request to the approved endpoint and refuses an oversized body before DNS', async () => {
  let dns = 0;
  const transport = { resolve: async () => { dns++; return ['127.0.0.1']; }, connect: () => { throw new Error(); } };
  const target = new HubHttpEffectTarget({ endpoint: 'https://approved.invalid/mcp', local: false, input: {},
    request: async () => new Request('https://other.invalid/mcp'), onResult: () => { throw new Error('must not exchange'); }, transport });
  await expect(target.apply({ target: { kind: target.kind, id: 'request' }, operation: HUB_NETWORK_OPERATION.operation, idempotencyKey: 'request', expectedVersion: null, input: {} })).rejects.toMatchObject({ code: 'EFFECT_TARGET_REJECTED' });
  expect(await hubHttpRequest(new Request('https://approved.invalid/mcp', { method: 'POST', body: Buffer.alloc(HUB_LIMITS.httpMaxBytes + 1) }), { local: false, transport })).toMatchObject({ outcome: 'refused', reason: 'request-invalid' });
  expect(dns).toBe(0);
});

it('verifies issuer-bound OIDC signatures, nonce and passkey-specific assurance before accepting an account', async () => {
  const { sign, createPublicKey, createPrivateKey } = await import('node:crypto');
  const { HubOidcPasskeyVerifier } = await import('#adapters/core/hub-http/index.js');
  const privateKey = createPrivateKey({ key: Buffer.from(`302e020100300506032b657004220420${'09'.repeat(32)}`, 'hex'), format: 'der', type: 'pkcs8' });
  const jwk = createPublicKey(privateKey).export({ format: 'jwk' });
  const verifier = new HubOidcPasskeyVerifier([{ issuer: 'https://idp.example', audience: 'hub', algorithms: ['EdDSA'],
    passkeyAcr: ['urn:fixture:webauthn-second-factor'], passkeyAmr: ['fixture:passkey'] }], async (issuer, kid) => {
    expect(issuer).toBe('https://idp.example'); expect(kid).toBe('fixture'); return jwk;
  }, () => 100000);
  const encode = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
  const token = (changes: object = {}) => {
    const message = `${encode({ alg: 'EdDSA', kid: 'fixture' })}.${encode({ iss: 'https://idp.example', sub: 'account', aud: 'hub', nonce: 'challenge',
      exp: 200, iat: 1, email: 'test@example.com', email_verified: true, name: 'Fixture', acr: 'urn:fixture:webauthn-second-factor', amr: ['fixture:passkey'], ...changes })}`;
    return { idToken: `${message}.${sign(null, Buffer.from(message), privateKey).toString('base64url')}` };
  };
  const expected = { issuer: 'https://idp.example', audience: 'hub', challenge: 'challenge', nowMs: 100000 };
  expect(await verifier.verify(token(), expected)).toMatchObject({ subject: 'account', emailVerified: true, passkeyVerified: true });
  await expect(verifier.verify(token({ nonce: 'replay' }), expected)).rejects.toMatchObject({ code: 'HUB_ACCOUNT_REFUSED' });
  await expect(verifier.verify(token({ amr: ['mfa'] }), expected)).rejects.toMatchObject({ code: 'HUB_ACCOUNT_REFUSED' });
  await expect(verifier.verify(token({ exp: 99 }), expected)).rejects.toMatchObject({ code: 'HUB_ACCOUNT_REFUSED' });
  await expect(verifier.verify(token({ aud: 'other' }), expected)).rejects.toMatchObject({ code: 'HUB_ACCOUNT_REFUSED' });
  const tampered = token(); tampered.idToken = tampered.idToken.replace(/.$/, value => value === 'A' ? 'B' : 'A');
  await expect(verifier.verify(tampered, expected)).rejects.toMatchObject({ code: 'HUB_ACCOUNT_REFUSED' });
});
