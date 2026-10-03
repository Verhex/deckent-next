import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readBuildIdentity } from '../../../src/platform/core/host/index.js';

vi.mock('node:fs', async importOriginal => ({ ...await importOriginal<typeof import('node:fs')>(), readFileSync: vi.fn() }));
const identity = { schemaVersion: 1, sourceTreeSha256: 'a'.repeat(64), sourceCommit: 'b'.repeat(40), sourceDirty: false };
beforeEach(() => { vi.mocked(readFileSync).mockReset(); });

describe('build identity optional source repository provenance', () => {
  it.each([undefined, 'declared', 'derived'])('returns sourceCommonDir with optional provenance origin %s', sourceCommonDirOrigin => {
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ ...identity, sourceCommonDir: '/source/repo/.git', sourceCommonDirOrigin }));
    expect(readBuildIdentity()).toEqual({ sourceTreeSha256: identity.sourceTreeSha256, sourceCommit: identity.sourceCommit,
      sourceDirty: false, sourceCommonDir: '/source/repo/.git' });
  });
  it.each([undefined, null, '', 42, {}])('keeps old identities valid without a usable sourceCommonDir (%j)', sourceCommonDir => {
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ ...identity, sourceCommonDir }));
    expect(readBuildIdentity()).toEqual({ sourceTreeSha256: identity.sourceTreeSha256, sourceCommit: identity.sourceCommit, sourceDirty: false });
  });
  it.each(['{bad json', JSON.stringify({ ...identity, schemaVersion: 2 })])('rejects malformed identities without throwing', content => {
    vi.mocked(readFileSync).mockReturnValue(content);
    expect(readBuildIdentity()).toBeNull();
  });
  it('returns null when identity cannot be read', () => {
    vi.mocked(readFileSync).mockImplementation(() => { throw new Error('EACCES'); });
    expect(readBuildIdentity()).toBeNull();
  });
});
