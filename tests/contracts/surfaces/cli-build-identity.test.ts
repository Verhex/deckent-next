import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readBuildIdentity } from '../../../src/platform/core/host/index.js';
import { dispatch } from '../../../src/surfaces/core/cli/index.js';

vi.mock('../../../src/platform/core/host/internal/build-identity.js', () => ({ readBuildIdentity: vi.fn() }));
const identity = { sourceTreeSha256: 'a'.repeat(64), sourceCommit: 'b'.repeat(40), sourceDirty: false };
beforeEach(() => { vi.mocked(readBuildIdentity).mockReset(); });

describe('CLI existing build identity surface', () => {
  it('--version prints sourceCommonDir when present', () => {
    vi.mocked(readBuildIdentity).mockReturnValue({ ...identity, sourceCommonDir: '/source/repo/.git' });
    const result = dispatch(['--version']);
    expect(result.code).toBe(0);
    expect(result.output).toContain('sourceCommonDir /source/repo/.git');
  });
  it('old identities keep their existing version line byte for byte', () => {
    vi.mocked(readBuildIdentity).mockReturnValue(identity);
    expect(dispatch(['--version']).output.split('\n')[1]).toBe('build aaaaaaaaaaaa · commit bbbbbbbbbbbb');
  });
  it('source mode has no invented build or source repository identity', () => {
    vi.mocked(readBuildIdentity).mockReturnValue(null);
    expect(dispatch(['--version']).output).not.toContain('sourceCommonDir');
    expect(dispatch(['--version']).output).not.toContain('\n');
  });
});
