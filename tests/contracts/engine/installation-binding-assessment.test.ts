import { expect, it } from 'vitest';
import { installationBindingSchema, installationBindingCaptureSchema, retainedInstallationBinding, type WritableInstallationBinding } from '#domain/index.js';
import { assessInstallationBinding } from '#engine/index.js';

const at = { canonicalRoot: '/srv/installation/.deckent', device: '2049', inode: '131' };
const machine = (digest: string, source: 'platform' | 'configured' = 'platform') =>
  installationBindingCaptureSchema.parse({ schemaVersion: 2, strength: 'machine', source, machineDigest: digest.repeat(64), ...at });
const weak = (overrides: Partial<typeof at> = {}) => installationBindingCaptureSchema.parse({ schemaVersion: 2, strength: 'weak', source: 'location', ...at, ...overrides });
const v1 = (digest: string) => installationBindingSchema.parse({ schemaVersion: 1, machineDigest: digest.repeat(64), ...at });
const filesystemIdentity = { kind: 'linux.ext4.statfs-fsid.v1', value: '033b6aacc3f1ba86' };
const current = (extra: object = {}) => installationBindingCaptureSchema.parse({ ...machine('a'), filesystemIdentity, ...extra });
const v3 = installationBindingSchema.parse({ ...machine('a'), schemaVersion: 3, filesystemIdentity });

it.each([
  ['v1 machine record, same machine', v1('a'), machine('a'), 'match'],
  ['v1 machine record, other machine', v1('a'), machine('b'), 'relocated'],
  ['v1 machine record seen only weakly', v1('a'), weak(), 'relocated'],
  ['machine record, same digest from another source kind', machine('a'), machine('a', 'configured'), 'match'],
  ['machine record, other digest', machine('a'), machine('b'), 'relocated'],
  ['machine record seen only weakly (machine identity gone or copied into a container)', machine('a'), weak(), 'relocated'],
  ['weak record, same location', weak(), weak(), 'match'],
  ['weak record, new inode (copy or restore at the same path)', weak(), weak({ inode: '132' }), 'relocated'],
  ['weak record, new device', weak(), weak({ device: '2050' }), 'relocated'],
  ['weak record, moved root', weak(), weak({ canonicalRoot: '/srv/moved/.deckent' }), 'relocated'],
  ['weak record, machine capture at the same location', weak(), machine('a'), 'strengthen'],
  ['v3 same filesystem', v3, current(), 'match'],
  ['v3 same filesystem, renumbered device', v3, current({ device: '9999' }), 'match'],
  ['v3 filesystem unavailable', v3, machine('a'), 'relocated'],
  ['v3 different kind, same value', v3, current({ filesystemIdentity: { ...filesystemIdentity, kind: 'another.producer' } }), 'relocated'],
  ['v3 different filesystem value', v3, current({ filesystemIdentity: { ...filesystemIdentity, value: '133b6aacc3f1ba86' } }), 'relocated'],
  ['v3 different machine', v3, current({ machineDigest: 'b'.repeat(64) }), 'relocated'],
  ['v3 different root', v3, current({ canonicalRoot: '/srv/moved' }), 'relocated'],
  ['v3 different inode', v3, current({ inode: '132' }), 'relocated'],
  ['v3 weak capture with filesystem identity', v3, installationBindingCaptureSchema.parse({ ...weak(), filesystemIdentity }), 'relocated'],
  ['v2 machine with filesystem capture', machine('a'), current(), 'match'],
  ['v2 machine still refuses renumbered device', machine('a'), current({ device: '9999' }), 'relocated'],
  ['v1 still refuses renumbered device', v1('a'), current({ device: '9999' }), 'relocated'],
  ['weak still strengthens, not to v3', weak(), current(), 'strengthen'],
] as const)('%s -> %s', (_case, recorded, captured, expected) => {
  expect(assessInstallationBinding(recorded, captured)).toBe(expected);
});

it('rejects a weak binding that carries a machine digest and a machine binding without one', () => {
  expect(installationBindingCaptureSchema.safeParse({ schemaVersion: 2, strength: 'weak', source: 'location', machineDigest: 'a'.repeat(64), ...at }).success).toBe(false);
  expect(installationBindingCaptureSchema.safeParse({ schemaVersion: 2, strength: 'machine', source: 'platform', ...at }).success).toBe(false);
  expect(installationBindingCaptureSchema.safeParse({ schemaVersion: 2, strength: 'machine', source: 'location', machineDigest: 'a'.repeat(64), ...at }).success).toBe(false);
  expect(installationBindingCaptureSchema.safeParse({ schemaVersion: 2, strength: 'weak', source: 'location', ...at, machineId: 'raw' }).success).toBe(false);
  for (const override of [{ strength: 'weak' }, { filesystemIdentity: undefined }, { filesystemIdentity: { ...filesystemIdentity, extra: true } },
    { filesystemIdentity: { ...filesystemIdentity, kind: '' } }, { filesystemIdentity: { ...filesystemIdentity, kind: 'k'.repeat(129) } },
    { filesystemIdentity: { ...filesystemIdentity, value: 'v'.repeat(257) } }, { filesystemIdentity: { ...filesystemIdentity, value: '\n' } }]) {
    expect(installationBindingSchema.safeParse({ ...v3, ...override }).success).toBe(false);
  }
  // Writer result has no v3 arm at compile time, and strips the additive capture for every strength/source.
  const versions: readonly WritableInstallationBinding['schemaVersion'][] = [1, 2];
  for (const capture of [current(), current({ source: 'configured' }), installationBindingCaptureSchema.parse({ ...weak(), filesystemIdentity })]) {
    const written: WritableInstallationBinding & { readonly schemaVersion: 1 | 2 } = retainedInstallationBinding(capture);
    expect(versions).toContain(written.schemaVersion);
    expect(written).not.toHaveProperty('filesystemIdentity');
  }
  expect(() => retainedInstallationBinding(v3 as unknown as ReturnType<typeof current>)).toThrow();
});
