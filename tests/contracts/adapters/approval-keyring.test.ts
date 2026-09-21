import { it, expect } from 'vitest';
import { mkdtemp, rm, chmod, link, symlink, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openLocalIntegrityAuthority } from '../../../src/adapters/core/local-keyring/index.js';
import { resolveProductLayout, productResourcePath } from '../../../src/platform/core/host/index.js';
import { constantTimeDigestEqual, createHmacIntegrity } from '../../../src/platform/core/integrity/index.js';
import { encodeCommandProjection } from '../../../src/domain/core/command/index.js';

it('reopens private signing custody and rejects unsafe files without creating on read', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deckent-key-'));
  const layout = resolveProductLayout({ projectRoot: root });
  try {
    await expect(openLocalIntegrityAuthority(layout, 'key')).rejects.toMatchObject({ code: 'INTEGRITY_KEY_UNAVAILABLE' });
    await expect(lstat(productResourcePath(layout, 'approvals'))).rejects.toMatchObject({ code: 'ENOENT' });
    const first = await openLocalIntegrityAuthority(layout, 'key', true);
    const second = await openLocalIntegrityAuthority(layout, 'key');
    expect(second.verify('message', first.sign('message'), first.keyId)).toBe(true);
    const path = join(productResourcePath(layout, 'approvals'), 'key');
    await chmod(path, 0o640);
    await expect(openLocalIntegrityAuthority(layout, 'key')).rejects.toMatchObject({ code: 'INTEGRITY_KEY_UNAVAILABLE' });
    await chmod(path, 0o600);
    await link(path, path + '.hard');
    await expect(openLocalIntegrityAuthority(layout, 'key')).rejects.toMatchObject({ code: 'INTEGRITY_KEY_UNAVAILABLE' });
    await rm(path + '.hard'); await symlink(path, path + '.sym');
    await expect(openLocalIntegrityAuthority(layout, 'key.sym')).rejects.toMatchObject({ code: 'INTEGRITY_KEY_UNAVAILABLE' });
  } finally { await rm(root, { recursive: true, force: true }); }
});
it('canonicalizes object ordering without conflating text or accepting malformed MACs', () => {
  expect(encodeCommandProjection('v1', { a: 1, b: [2] })).toBe(encodeCommandProjection('v1', { b: [2], a: 1 }));
  expect(encodeCommandProjection('v1', '\u00e9')).not.toBe(encodeCommandProjection('v1', 'e\u0301'));
  expect(() => encodeCommandProjection('v1', [undefined])).toThrow('COMMAND_ENCODING_INVALID');
  expect(() => encodeCommandProjection('v1', NaN)).toThrow('COMMAND_ENCODING_INVALID');
  const material = new Uint8Array(32).fill(1); const authority = createHmacIntegrity('key', material);
  const mac = authority.sign('message'); material.fill(0);
  expect(authority.verify('message', mac, 'key')).toBe(true);
  expect(authority.verify('different', mac, 'key')).toBe(false);
  expect(authority.verify('message', mac, 'other-key')).toBe(false);
  for (const invalid of ['', mac.slice(2), mac + 'ff', 'z'.repeat(64)]) expect(constantTimeDigestEqual(mac, invalid)).toBe(false);
});
