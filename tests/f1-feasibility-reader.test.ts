import { expect, it, vi } from 'vitest';
import { decidePersonalContinuity } from '../src/adapters/core/secret-store/internal/f1-feasibility-reader.js';

function fixture(separateFilesystems = false) {
  const owner = { installationId: 'fixture-installation', companyId: 'fixture-company', scopeId: 'fixture-project',
    principal: { issuer: 'fixture-host', subject: '1000' } };
  const bindingId = 'a1000000-0000-4000-8000-000000000001';
  const kind = 'linux.ext4.statfs-fsid.v1';
  const installation = { canonicalRoot: '/fixture/installation', inode: '101', machineDigest: 'a'.repeat(64),
    filesystemIdentity: { kind, value: '123456789abcdef0' } };
  const store = { canonicalRoot: '/fixture/person', inode: '102', uid: 1000, keyInode: '103',
    filesystemIdentity: separateFilesystems ? { kind, value: 'fedcba9876543210' } : installation.filesystemIdentity };
  return {
    owner,
    binding: { schemaVersion: 2, owner, bindingId, generation: 7, cleanup: { state: 'complete', revision: 1 } },
    baseline: { status: 'verified' as const, record: { schemaVersion: 1, owner, bindingId, expectedGeneration: 7, installation, store } },
    before: { installation: { ...installation, device: '2049', local: true }, store: { ...store, device: separateFilesystems ? '2065' : '2049', local: true } },
    observation: { installation: { ...installation, device: '2050', local: true }, store: { ...store, device: separateFilesystems ? '2066' : '2050', local: true } },
  };
}

function demonstrate(input: Parameters<typeof decidePersonalContinuity>[0], expected: ReturnType<typeof decidePersonalContinuity>) {
  const readValue = vi.fn(() => 'made-up stored value'), events: string[] = [];
  const decision = decidePersonalContinuity(input);
  expect(readValue).not.toHaveBeenCalled();
  events.push(decision);
  if (decision === 'continue') { readValue(); events.push('read'); }
  expect(events).toEqual(expected === 'continue' ? ['continue', 'read'] : [expected]);
  expect(readValue).toHaveBeenCalledTimes(expected === 'continue' ? 1 : 0);
}

it('continues before the value read after device-only renumbering, with one or two modeled filesystems', () => {
  for (const separateFilesystems of [false, true]) {
    const f = fixture(separateFilesystems);
    expect(f.observation).toEqual({ installation: { ...f.before.installation, device: '2050' },
      store: { ...f.before.store, device: separateFilesystems ? '2066' : '2050' } });
    demonstrate(f, 'continue');
  }
});

it('refuses each root mismatch independently and refuses changed key identity before the value read', () => {
  const f = fixture(true), { installation, store } = f.observation;
  demonstrate({ ...f, observation: { installation: { ...installation, inode: '201' }, store } }, 'installation-mismatch');
  demonstrate({ ...f, observation: { installation, store: { ...store, filesystemIdentity: installation.filesystemIdentity } } }, 'store-mismatch');
  demonstrate({ ...f, observation: { installation, store: { ...store, keyInode: '203' } } }, 'store-mismatch');
});

it('refuses a generation mismatch and an expectation for a different binding before the value read', () => {
  const f = fixture();
  demonstrate({ ...f, binding: { ...f.binding, generation: 6 } }, 'generation-mismatch');
  demonstrate({ ...f, binding: { ...f.binding, bindingId: 'a1000000-0000-4000-8000-000000000002' } }, 'binding-mismatch');
});

it('holds legacy or missing starting records before the value read', () => {
  const f = fixture();
  const legacy = { schemaVersion: 1, bindingId: f.binding.bindingId, generation: 7, uid: 1000,
    installationId: f.owner.installationId, principal: f.owner.principal, locationDigest: 'a'.repeat(64),
    installationLocationDigest: 'b'.repeat(64), keyIdentityDigest: 'c'.repeat(64), cleanup: f.binding.cleanup };
  demonstrate({ ...f, binding: legacy, baseline: { status: 'missing' } }, 'missing-start');
  demonstrate({ ...f, baseline: { status: 'missing' } }, 'missing-start');
});

it('holds unavailable starting evidence or a missing live locality proof before the value read', () => {
  const f = fixture();
  demonstrate({ ...f, baseline: { status: 'unavailable' } }, 'evidence-unavailable');
  demonstrate({ ...f, observation: { ...f.observation, store: undefined } }, 'evidence-unavailable');
  demonstrate({ ...f, observation: { ...f.observation, installation: { ...f.observation.installation, local: false } } }, 'evidence-unavailable');
});
