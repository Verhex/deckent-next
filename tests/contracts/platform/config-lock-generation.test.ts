import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, rm, rename } from 'node:fs/promises';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

const race = vi.hoisted(() => ({ path: '', calls: 0, at: 0, replace: undefined as (() => Promise<void>) | undefined }));
vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return { ...actual, lstat: async (...args: Parameters<typeof actual.lstat>) => {
    const observed = await actual.lstat(...args);
    if (String(args[0]) === race.path && ++race.calls === race.at && race.replace) {
      const replace = race.replace; race.replace = undefined; await replace();
    }
    return observed;
  } };
});
import { withConfigWriteLock } from '../../../src/platform/index.js';

const roots: string[] = [];
afterEach(async () => { race.replace = undefined; race.path = ''; await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
it.each([1, 4])('recognizes file-to-directory generation replacement at observation %i without disturbing the live owner', async at => {
  const root = await mkdtemp(join(tmpdir(), 'deckent-config-lock-generation-')); roots.push(root);
  const path = join(root, 'config.json'), lock = `${path}.write-lock`;
  const dead = await promisify(execFile)(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']);
  await writeFile(lock, JSON.stringify({ pid: Number(dead.stdout) }));
  const owner = { pid: process.pid, hostname: hostname(), createdAt: new Date().toISOString(), nonce: 'replacement-owner' };
  race.path = lock; race.calls = 0; race.at = at;
  // Real filesystem replacement exactly between the first lstat and metadata validation.
  // At 4 the first stale observation already succeeded and reclaim is re-observing it.
  race.replace = async () => {
    await rename(lock, `${lock}.old`); await mkdir(lock, { mode: 0o700 });
    await writeFile(join(lock, 'owner.json'), JSON.stringify(owner), { mode: 0o600 });
  };
  let entered = false;
  await expect(withConfigWriteLock(path, async () => { entered = true; }, 1, { onWarning() {} }))
    .rejects.toMatchObject({ code: 'CONFIG_WRITE_LOCKED' });
  expect(race.replace).toBeUndefined(); expect(entered).toBe(false);
  expect(JSON.parse(await readFile(join(lock, 'owner.json'), 'utf8'))).toEqual(owner);
});
