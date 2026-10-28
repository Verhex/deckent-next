import os from 'node:os';
import dns from 'node:dns/promises';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import { Duplex } from 'node:stream';
import { tunnelNativeConnect } from '#adapters/core/native-connection/index.js';
// f5: the realm gateway names its refusals by host (counts only, bounded by providers.json), never the request text.
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { nativeEgressLimits, openNativeEgressGateway } from '#adapters/core/native-connection/index.js';
import { headlessEgressSchema, headlessEgressReasons } from '#domain/index.js';

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); syncBuiltinESMExports(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const send = (socketPath: string, text: string) => new Promise<void>(resolve => {
  const socket = connect(socketPath, () => socket.write(text)); socket.on('data', () => socket.destroy()); socket.on('close', () => resolve()); socket.on('error', () => resolve());
});
it.skipIf(process.platform === 'win32')('counts refused CONNECT targets by valid host name up to the bound, the rest and non-CONNECT requests as other', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deckent-egress-')); roots.push(root);
  const gateway = await openNativeEgressGateway({ provider: 'claude', directory: root }), max = nativeEgressLimits().refusedHostsMax;
  try {
    for (let index = 0; index <= max; index++) await send(gateway.socketPath, `CONNECT h${index}.example:443 HTTP/1.1\r\nHost: h${index}.example:443\r\n\r\n`);
    await send(gateway.socketPath, 'CONNECT h0.example:443 HTTP/1.1\r\nHost: h0.example:443\r\n\r\n');
    await send(gateway.socketPath, 'CONNECT [::1]:443 HTTP/1.1\r\nHost: x\r\n\r\n');
    await send(gateway.socketPath, 'GET /secret-path?token=abc HTTP/1.1\r\nHost: api.anthropic.com\r\n\r\n');
    const egress = headlessEgressSchema.parse(gateway.egress());
    expect(egress.connected).toBe(0); expect(egress.refused).toBe(max + 4);
    expect(Object.keys(egress.hosts)).toHaveLength(max); expect(egress.hosts['h0.example']).toBe(2); expect(egress.reasons?.['h0.example']).toEqual({ allowlist: 2 });
    expect(egress.hosts[`h${max}.example`]).toBeUndefined(); expect(egress.other).toBe(3);
    expect(JSON.stringify(egress)).not.toMatch(/secret|token|::1/u);
  } finally { await gateway.close(); }
});

// BeUser M-01: an installation whose state path is too long for a Unix socket (sun_path, 104 bytes) still opens the gateway, in a private short
// directory under /tmp (0700) that is removed on close; before the fix this refused HEADLESS_ISOLATION_UNAVAILABLE (gateway).
it.skipIf(process.platform === 'win32')('NEGATIVE: a long state directory still opens a private gateway socket and removes it on close', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deckent-egress-')); roots.push(root);
  const deep = join(root, 'a'.repeat(60), 'b'.repeat(40)); await mkdir(deep, { recursive: true });
  const gateway = await openNativeEgressGateway({ provider: 'claude', directory: deep });
  try {
    expect(Buffer.byteLength(gateway.socketPath)).toBeLessThanOrEqual(103); expect(gateway.socketPath.startsWith(`/tmp/dk-ipc-${process.getuid?.()}/egress-`)).toBe(true);
    expect((await stat(dirname(gateway.socketPath))).mode & 0o777).toBe(0o700);
    await send(gateway.socketPath, 'GET / HTTP/1.1\r\nHost: x\r\n\r\n'); expect(gateway.egress().refused).toBe(1);
  } finally { await gateway.close(); }
  await expect(stat(dirname(gateway.socketPath))).rejects.toMatchObject({ code: 'ENOENT' });
});


// A minimal TLS routing header with an SNI extension (no handshake or real connection).
function hello(host: string) {
  const u16 = (n: number) => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; };
  const name = Buffer.from(host), names = Buffer.concat([Buffer.from([0]), u16(name.length), name]);
  const sni = Buffer.concat([u16(names.length), names]), extension = Buffer.concat([u16(0), u16(sni.length), sni]);
  const body = Buffer.concat([Buffer.from([3, 3]), Buffer.alloc(32), Buffer.from([0, 0, 2, 0x13, 1, 1, 0]), u16(extension.length), extension]);
  const header = Buffer.alloc(4); header[0] = 1; header.writeUIntBE(body.length, 1, 3);
  const handshake = Buffer.concat([header, body]); return Buffer.concat([Buffer.from([22, 3, 3]), u16(handshake.length), handshake]);
}
it('attributes allowlist, DNS, address, TLS, byte-budget, upstream and closed-gateway refusals without changing admission', async () => {
  for (const reason of ['allowlist', 'dns', 'non-public', 'client-hello', 'byte-budget', 'upstream', 'gateway-closed'] as const) {
    vi.restoreAllMocks();
    vi.spyOn(os, 'networkInterfaces').mockReturnValue({});
    vi.spyOn(dns, 'lookup').mockImplementation(async () => {
      if (reason === 'dns') throw new Error('private-canary');
      return [{ address: reason === 'non-public' ? '127.0.0.1' : '8.8.8.8', family: 4 }];
    });
    const remote = new Duplex({ read() {}, write(_chunk, _encoding, done) { done(); } }); Object.assign(remote, { setTimeout: () => remote });
    vi.spyOn(net, 'connect').mockImplementation(() => {
      queueMicrotask(() => remote.emit(reason === 'upstream' ? 'error' : 'connect', new Error('private-canary')));
      return remote as never;
    });
    syncBuiltinESMExports();
    const client = new Duplex({ read() {}, write(_chunk, _encoding, done) { done(); } }), host = reason === 'allowlist' ? 'outside.example' : 'allowed.example';
    const result = await new Promise(resolve => tunnelNativeConnect({ url: host + ':443' } as never, client as never, reason === 'client-hello' ? Buffer.from('invalid') : hello(host), {
      destinations: ['allowed.example'], closed: () => reason === 'gateway-closed', sockets: new Set(), count: () => false, connected: () => undefined,
      rejected: (target, cause) => resolve({ target, cause }),
    }));
    expect(result).toEqual({ target: host + ':443', cause: reason });
    client.destroy(); remote.destroy();
  }
  vi.restoreAllMocks(); syncBuiltinESMExports();
  const legacy = headlessEgressSchema.parse({ connected: 0, refused: 2, hosts: { 'api.example': 1 }, other: 1 });
  expect(headlessEgressReasons(legacy)).toEqual({ reasons: { 'api.example': { unknown: 1 } }, otherReasons: { unknown: 1 } });
  expect(headlessEgressSchema.safeParse({ ...legacy, reasons: { 'api.example': { allowlist: 2 } }, otherReasons: { unknown: 1 } }).success).toBe(false);
});
