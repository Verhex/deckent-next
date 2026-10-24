// f5: the realm gateway names its refusals by host (counts only, bounded by providers.json), never the request text.
import { mkdtemp, rm } from 'node:fs/promises';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { nativeEgressLimits, openNativeEgressGateway } from '#adapters/core/native-connection/index.js';
import { headlessEgressSchema } from '#domain/index.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
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
    expect(Object.keys(egress.hosts)).toHaveLength(max); expect(egress.hosts['h0.example']).toBe(2);
    expect(egress.hosts[`h${max}.example`]).toBeUndefined(); expect(egress.other).toBe(3);
    expect(JSON.stringify(egress)).not.toMatch(/secret|token|::1/u);
  } finally { await gateway.close(); }
});
