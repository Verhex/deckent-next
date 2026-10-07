import { it, expect } from 'vitest';
import { mkdtemp, rm, chmod, link, symlink, lstat, writeFile, readFile } from 'node:fs/promises';
import { withConfigWriteLock } from '../../../src/platform/core/config/index.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { derivePrefixCacheSalt, ensureLocalPrefixCacheSaltKey, localPrefixCacheSalt, openLocalIntegrityAuthority, PREFIX_CACHE_SALT_KEY_FILE } from '../../../src/adapters/core/local-keyring/index.js';
import { resolveProductLayout, productResourcePath } from '../../../src/platform/core/host/index.js';
import { constantTimeDigestEqual, createHmacIntegrity } from '../../../src/platform/core/integrity/index.js';
import { encodeCommandProjection } from '../../../src/domain/core/command/index.js';

it.skipIf(process.platform === 'win32')('requires POSIX private keyring; INTEGRITY_KEY_UNAVAILABLE — reopens private signing custody and rejects unsafe files without creating on read', async () => {
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

it.skipIf(process.platform === 'win32')('read-only signing custody stays available under a held writer lock without changing key bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'key-read-only-'));
  const layout = resolveProductLayout({ projectRoot: root });
  try {
    const authority = await openLocalIntegrityAuthority(layout, 'key', true);
    const path = join(productResourcePath(layout, 'approvals'), 'key');
    const before = await readFile(path);
    await withConfigWriteLock(path, async () => {
      const readOnly = await openLocalIntegrityAuthority(layout, 'key');
      expect(readOnly.verify('read-only', authority.sign('read-only'), authority.keyId)).toBe(true);
      expect(await readFile(path)).toEqual(before);
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});
it.skipIf(process.platform === 'win32')('a failed first publication remains unavailable: create mode never repairs or truncates an existing partial key', async () => {
  const root = await mkdtemp(join(tmpdir(), 'key-partial-'));
  const layout = resolveProductLayout({ projectRoot: root });
  try {
    await openLocalIntegrityAuthority(layout, 'good', true);
    const path = join(productResourcePath(layout, 'approvals'), 'partial');
    await writeFile(path, Buffer.alloc(0), { mode: 0o600 });
    await expect(openLocalIntegrityAuthority(layout, 'partial', true)).rejects.toMatchObject({ code: 'INTEGRITY_KEY_UNAVAILABLE' });
    expect((await readFile(path)).length).toBe(0);
    expect((await lstat(path)).mode & 0o777).toBe(0o600);
  } finally { await rm(root, { recursive: true, force: true }); }
});

// VLLM-CACHE-SALT (owner 2026-10-07): cache_salt = HMAC-SHA256(installation salt secret, scopeId) from a separate 256-bit file, never the
// integrity key and never a public formula of the scope id; an unsafe or unreadable secret fails closed with a typed code.
it('derives a secret per-scope salt: same secret and scope stay stable, two secrets differ, no plain digest of the scope', async () => {
  const { createHash } = await import('node:crypto');
  const one = new Uint8Array(32).fill(1), two = new Uint8Array(32).fill(2);
  const salt = derivePrefixCacheSalt(one, 'scope-a');
  expect(salt).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  expect(derivePrefixCacheSalt(one, 'scope-a')).toBe(salt);
  expect(derivePrefixCacheSalt(two, 'scope-a')).not.toBe(salt);
  expect(derivePrefixCacheSalt(one, 'scope-b')).not.toBe(salt);
  for (const plain of [createHash('sha256').update('scope-a').digest('base64url'), createHash('sha256').update('deckent.prefix-cache-salt.v1\0scope-a').digest('base64url')]) expect(salt).not.toBe(plain);
  expect(() => derivePrefixCacheSalt(new Uint8Array(31), 'scope-a')).toThrow(expect.objectContaining({ code: 'PREFIX_CACHE_SALT_UNAVAILABLE' }));
});
it.skipIf(process.platform === 'win32')('requires POSIX private keyring; keeps the salt secret in its own 0600 file, separate from the integrity key, and fails closed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deckent-salt-')), other = await mkdtemp(join(tmpdir(), 'deckent-salt-'));
  const layout = resolveProductLayout({ projectRoot: root });
  try {
    await expect(localPrefixCacheSalt(layout, 'scope-a', 'authority.key', false)).rejects.toMatchObject({ code: 'PREFIX_CACHE_SALT_UNAVAILABLE' });
    await expect(lstat(productResourcePath(layout, 'approvals'))).rejects.toMatchObject({ code: 'ENOENT' }); // read mode creates nothing
    const first = await localPrefixCacheSalt(layout, 'scope-a', 'authority.key'); // first use creates the secret (older installation)
    const path = join(productResourcePath(layout, 'approvals'), PREFIX_CACHE_SALT_KEY_FILE), info = await lstat(path);
    expect(info.mode & 0o777).toBe(0o600); expect(info.size).toBe(32);
    expect(first).toBe(derivePrefixCacheSalt(await readFile(path), 'scope-a'));
    expect(await localPrefixCacheSalt(layout, 'scope-a', 'authority.key')).toBe(first); // stable: the scope keeps its prefix cache
    expect(await localPrefixCacheSalt(resolveProductLayout({ projectRoot: other }), 'scope-a', 'authority.key')).not.toBe(first); // another installation secret
    // Separate from the integrity key: creating the salt secret did not create authority material, and vice versa nothing is derived from it.
    await expect(lstat(join(productResourcePath(layout, 'approvals'), 'authority.key'))).rejects.toMatchObject({ code: 'ENOENT' });
    await ensureLocalPrefixCacheSaltKey(layout); expect(await localPrefixCacheSalt(layout, 'scope-a', 'authority.key')).toBe(first); // init never replaces it
    // One key, one use: a configuration naming the salt file as the integrity key is refused.
    await expect(localPrefixCacheSalt(layout, 'scope-a', PREFIX_CACHE_SALT_KEY_FILE)).rejects.toMatchObject({ code: 'PREFIX_CACHE_SALT_UNAVAILABLE' });
    await chmod(path, 0o644);
    await expect(localPrefixCacheSalt(layout, 'scope-a', 'authority.key')).rejects.toMatchObject({ code: 'PREFIX_CACHE_SALT_UNAVAILABLE' });
    await chmod(path, 0o600); await writeFile(path, Buffer.alloc(31), { mode: 0o600 });
    await expect(localPrefixCacheSalt(layout, 'scope-a', 'authority.key')).rejects.toMatchObject({ code: 'PREFIX_CACHE_SALT_UNAVAILABLE' });
    // Rotation: removing the secret makes the next use create a new one; every scope gets a new salt.
    await rm(path); const rotated = await localPrefixCacheSalt(layout, 'scope-a', 'authority.key');
    expect(rotated).not.toBe(first); expect(rotated).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  } finally { await rm(root, { recursive: true, force: true }); await rm(other, { recursive: true, force: true }); }
});
