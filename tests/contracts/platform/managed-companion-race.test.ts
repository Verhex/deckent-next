import type { Stats } from 'node:fs';
import { chmod, link, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
const race = vi.hoisted(() => ({ path: '', remaining: 0, replace: undefined as (() => Promise<void>) | undefined }));
vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return { ...actual, lstat: async (...args: Parameters<typeof actual.lstat>) => {
    const observed = await actual.lstat(...args);
    if (String(args[0]) === race.path && race.remaining-- > 0 && race.replace) {
      await race.replace();
      // Reproduce the zero-link stat measured during real SQLite unlink in the bounded probe.
      (observed as Stats).nlink = 0;
    }
    return observed;
  } };
});
import { inspectProductFile, prepareProductFile, resolveProductLayout } from '#platform/index.js';
const roots: string[] = [];
afterEach(async () => { race.path = ''; race.replace = undefined; await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
for (const operation of [prepareProductFile, inspectProductFile]) {
  it.skipIf(process.platform === 'win32').each(['absent', 'private', 'unsafe', 'unstable', 'symlink', 'directory', 'hardlink'] as const)(`${operation.name} validates the current companion after an observed unlink: %s`, async state => {
    const root = await mkdtemp(join(tmpdir(), 'deckent-companion-race-')); roots.push(root);
    const layout = resolveProductLayout({ projectRoot: root, root: join(root, 'data') });
    const file = await prepareProductFile(layout, 'ledger'); await writeFile(file, 'primary');
    const companion = file + '-wal'; await writeFile(companion, 'old', { mode: 0o600 });
    race.path = companion; race.remaining = state === 'unstable' ? 2 : 1;
    race.replace = async () => {
      await unlink(companion);
      if (state === 'symlink') { await symlink(file, companion); return; }
      if (state === 'directory') { await mkdir(companion); return; }
      if (state === 'hardlink') { await link(file, companion); return; }
      if (state !== 'absent') {
        await writeFile(companion, 'replacement', { mode: 0o600 });
        if (state === 'unsafe') await chmod(companion, 0o644);
      }
    };
    if (state !== 'absent' && state !== 'private') {
      await expect(operation(layout, 'ledger', ['-wal'])).rejects.toMatchObject({ code: 'MANAGED_FILE_UNSAFE',
        diagnostic: { reason: state === 'unsafe' ? 'mode' : state === 'symlink' || state === 'directory' ? 'file-type' : 'link-count', companion: '-wal' } });
    } else expect(await operation(layout, 'ledger', ['-wal'])).toBe(file);
    expect(await readFile(file, 'utf8')).toBe('primary');
  });
}
