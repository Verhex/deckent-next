import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main, layout } from './dev-release.mjs';

// The developer release kit requires Linux /proc and flock. This is a guard simulation,
// not proof that the service or its native custody works on macOS/Windows.
for (const platform of ['darwin', 'win32']) {
  test(`refuses developer release on ${platform} before reading or writing any installation`, async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'dev-release-platform-')));
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    try {
      Object.defineProperty(process, 'platform', { value: platform });
      await assert.rejects(main(['status', '--launcher', join(root, 'absent', 'next-entry.mjs')],
        { DECKENT_NEXT_INSTALL_ROOT: join(root, 'install') }), { code: 'DEV_RELEASE_PLATFORM_UNSUPPORTED' });
      assert.deepEqual(readdirSync(root), []);
    } finally {
      Object.defineProperty(process, 'platform', descriptor);
      rmSync(root, { recursive: true, force: true });
    }
  });
}
test('the portable release layout still refuses an install root inside the project', () => {
  const project = join(tmpdir(), 'release-project');
  assert.throws(() => layout({ env: { DECKENT_NEXT_INSTALL_ROOT: join(project, 'install') },
    launcher: join(project, '.agents', 'refactor', 'next-entry.mjs') }), { code: 'DEV_RELEASE_INSTALL_ROOT_INSIDE_PROJECT' });
});
