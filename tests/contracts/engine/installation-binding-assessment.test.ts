import { expect, it } from 'vitest';
import { installationBindingSchema, installationBindingCaptureSchema } from '#domain/index.js';
import { assessInstallationBinding } from '#engine/index.js';

const at = { canonicalRoot: '/srv/installation/.deckent', device: '2049', inode: '131' };
const machine = (digest: string, source: 'platform' | 'configured' = 'platform') =>
  installationBindingCaptureSchema.parse({ schemaVersion: 2, strength: 'machine', source, machineDigest: digest.repeat(64), ...at });
const weak = (overrides: Partial<typeof at> = {}) => installationBindingCaptureSchema.parse({ schemaVersion: 2, strength: 'weak', source: 'location', ...at, ...overrides });
const v1 = (digest: string) => installationBindingSchema.parse({ schemaVersion: 1, machineDigest: digest.repeat(64), ...at });

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
] as const)('%s -> %s', (_case, recorded, captured, expected) => {
  expect(assessInstallationBinding(recorded, captured)).toBe(expected);
});

it('rejects a weak binding that carries a machine digest and a machine binding without one', () => {
  expect(installationBindingCaptureSchema.safeParse({ schemaVersion: 2, strength: 'weak', source: 'location', machineDigest: 'a'.repeat(64), ...at }).success).toBe(false);
  expect(installationBindingCaptureSchema.safeParse({ schemaVersion: 2, strength: 'machine', source: 'platform', ...at }).success).toBe(false);
  expect(installationBindingCaptureSchema.safeParse({ schemaVersion: 2, strength: 'machine', source: 'location', machineDigest: 'a'.repeat(64), ...at }).success).toBe(false);
  expect(installationBindingCaptureSchema.safeParse({ schemaVersion: 2, strength: 'weak', source: 'location', ...at, machineId: 'raw' }).success).toBe(false);
});
