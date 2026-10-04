import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, rm, rename, readdir } from 'node:fs/promises';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

const race = vi.hoisted(() => ({ renameNoOp: false, renames: 0, path: '', calls: 0, at: 0, denied: '', openPath: '', directoryPath: '', directoryDenial: '', release: undefined as (() => Promise<void>) | undefined,
  rename: undefined as ((source: string, destination: string) => Promise<void>) | undefined,
  replace: undefined as (() => Promise<void>) | undefined }));
vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return { ...actual, rename: async (...args: Parameters<typeof actual.rename>) => {
    if (race.renameNoOp && String(args[0]) === race.path && String(args[1]).includes('.stale-')) { race.renames++; return; }
    if (race.rename && String(args[0]) === race.path) return race.rename(String(args[0]), String(args[1]));
    return actual.rename(...args);
  }, open: async (...args: Parameters<typeof actual.open>) => {
    if (String(args[0]) === race.openPath && race.denied) {
      const code = race.denied;
      if (race.release) { const release = race.release; race.release = undefined; race.denied = ''; await release(); }
      throw Object.assign(new Error(code), { code });
    }
    return actual.open(...args);
  }, readdir: async (...args: Parameters<typeof actual.readdir>) => {
    if (String(args[0]) === race.directoryPath && race.directoryDenial) throw Object.assign(new Error(race.directoryDenial), { code: race.directoryDenial });
    return actual.readdir(...args);
  }, lstat: async (...args: Parameters<typeof actual.lstat>) => {
    const observed = await actual.lstat(...args);
    if (String(args[0]) === race.path && ++race.calls === race.at && race.replace) {
      const replace = race.replace; race.replace = undefined; await replace();
    }
    return observed;
  } };
});
import { withConfigWriteLock } from '../../../src/platform/index.js';

const roots: string[] = [];
afterEach(async () => {
  race.renameNoOp = false; race.renames = 0;
  race.rename = undefined;
  race.directoryPath = ''; race.directoryDenial = '';
  race.replace = undefined; race.release = undefined; race.path = ''; race.openPath = ''; race.denied = '';
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
it.each(['EPERM', 'EACCES'])('holds an unreadable owner on %s until the bounded deadline without entering or reclaiming', async code => {
  const root = await mkdtemp(join(tmpdir(), 'deckent-config-lock-denied-')); roots.push(root);
  const path = join(root, 'config.json'), lock = `${path}.write-lock`, ownerPath = join(lock, 'owner.json');
  const dead = await promisify(execFile)(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']);
  const owner = JSON.stringify({ pid: Number(dead.stdout), hostname: hostname(), nonce: 'unreadable-owner' });
  await mkdir(lock); await writeFile(ownerPath, owner);
  race.openPath = ownerPath; race.denied = code;
  let entered = false; const warning = vi.fn();
  await expect(withConfigWriteLock(path, async () => { entered = true; }, 1, { onWarning: warning }))
    .rejects.toMatchObject({ code: 'CONFIG_WRITE_LOCKED' });
  expect(entered).toBe(false); expect(warning).not.toHaveBeenCalled();
  expect(await readFile(ownerPath, 'utf8')).toBe(owner);
});
it('retries a Windows delete-pending metadata open denial after the real owner releases custody', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deckent-config-lock-delete-')); roots.push(root);
  const path = join(root, 'config.json'), lock = `${path}.write-lock`, ownerPath = join(lock, 'owner.json');
  await mkdir(lock); await writeFile(ownerPath, JSON.stringify({ pid: process.pid, hostname: hostname() }));
  race.openPath = ownerPath; race.denied = 'EPERM'; race.release = () => rm(lock, { recursive: true });
  let entered = false;
  await withConfigWriteLock(path, async () => { entered = true; }, 1000);
  expect(entered).toBe(true); expect(race.release).toBeUndefined();
});
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

// Windows delete-pending directory enumeration is as uncertain as an unreadable owner.
it.each(['EPERM', 'EACCES'])('holds a directory unreadable on %s without entering or reclaiming', async code => {
  const root = await mkdtemp(join(tmpdir(), 'deckent-config-lock-scandir-')); roots.push(root);
  const path = join(root, 'config.json'), lock = `${path}.write-lock`, ownerPath = join(lock, 'owner.json');
  const owner = JSON.stringify({ pid: process.pid, hostname: hostname(), nonce: 'live-owner' });
  await mkdir(lock); await writeFile(ownerPath, owner);
  race.directoryPath = lock; race.directoryDenial = code;
  let entered = false; const warning = vi.fn();
  await expect(withConfigWriteLock(path, async () => { entered = true; }, 1, { onWarning: warning }))
    .rejects.toMatchObject({ code: 'CONFIG_WRITE_LOCKED' });
  expect(entered).toBe(false); expect(warning).not.toHaveBeenCalled();
  expect(await readFile(ownerPath, 'utf8')).toBe(owner);
  race.directoryDenial = '';
  await rm(lock, { recursive: true });
  await withConfigWriteLock(path, async () => { entered = true; }, 1000);
  expect(entered).toBe(true);
});
it('propagates directory IO failure instead of treating every error as contention', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deckent-config-lock-scandir-io-')); roots.push(root);
  const path = join(root, 'config.json'), lock = `${path}.write-lock`;
  await mkdir(lock); await writeFile(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid }));
  race.directoryPath = lock; race.directoryDenial = 'EIO';
  let entered = false;
  await expect(withConfigWriteLock(path, async () => { entered = true; }, 1)).rejects.toMatchObject({ code: 'EIO' });
  expect(entered).toBe(false);
});

it('reports no reclaim when Windows rename succeeds without moving a dead legacy file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deckent-config-lock-noop-')); roots.push(root);
  const path = join(root, 'config.json'), lock = `${path}.write-lock`;
  const dead = await promisify(execFile)(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']);
  const original = JSON.stringify({ pid: Number(dead.stdout) });
  await writeFile(lock, original);
  race.path = lock; race.renameNoOp = true;
  const warning = vi.fn(); let entered = false;
  await expect(withConfigWriteLock(path, async () => { entered = true; }, 50, { onWarning: warning }))
    .rejects.toMatchObject({ code: 'CONFIG_WRITE_LOCKED' });
  expect(race.renames).toBeGreaterThan(0);
  expect(entered).toBe(false); expect(warning).not.toHaveBeenCalled();
  expect(await readFile(lock, 'utf8')).toBe(original);
});

it('reports one reclaim when two concurrent Windows renames resolve for the same moved generation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deckent-config-lock-double-')); roots.push(root);
  const path = join(root, 'config.json'), lock = `${path}.write-lock`;
  const dead = await promisify(execFile)(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']);
  const original = JSON.stringify({ pid: Number(dead.stdout) });
  await writeFile(lock, original);
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  let secondEntered!: () => void, firstMoved!: () => void, renames = 0;
  const second = new Promise<void>(resolve => { secondEntered = resolve; });
  const moved = new Promise<void>(resolve => { firstMoved = resolve; });
  race.path = lock;
  race.rename = async (source, destination) => {
    if (++renames === 1) { await second; await actual.rename(source, destination); firstMoved(); }
    else { secondEntered(); await moved; } // A successful duplicate return, without another move.
  };
  const warning = vi.fn(); let active = 0, maximum = 0, entries = 0;
  const writer = async () => { maximum = Math.max(maximum, ++active); entries++; await new Promise(resolve => setTimeout(resolve, 30)); active--; };
  await Promise.all([withConfigWriteLock(path, writer, 1000, { onWarning: warning }), withConfigWriteLock(path, writer, 1000, { onWarning: warning })]);
  expect(renames).toBe(2); expect(entries).toBe(2); expect(maximum).toBe(1);
  expect(warning).toHaveBeenCalledTimes(1);
  expect(warning.mock.calls[0]![0]).toMatchObject({ code: 'CONFIG_LOCK_STALE_RECLAIMED' });
  const retained = (await readdir(root)).filter(name => name.includes('.stale-'));
  expect(retained).toHaveLength(2);
  expect(await readFile(join(root, retained.find(name => !name.endsWith('.reclaimed'))!), 'utf8')).toBe(original);
});

it('leaves a moved generation recoverable when its exclusive receipt cannot be written', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deckent-config-lock-receipt-')); roots.push(root);
  const path = join(root, 'config.json'), lock = `${path}.write-lock`;
  const dead = await promisify(execFile)(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']);
  const original = JSON.stringify({ pid: Number(dead.stdout) }); await writeFile(lock, original);
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  race.path = lock;
  race.rename = async (source, destination) => {
    await actual.rename(source, destination); race.openPath = `${destination}.reclaimed`; race.denied = 'EACCES';
  };
  const warning = vi.fn(); let entered = false;
  await expect(withConfigWriteLock(path, async () => { entered = true; }, 1000, { onWarning: warning })).rejects.toMatchObject({ code: 'EACCES' });
  expect(entered).toBe(false); expect(warning).not.toHaveBeenCalled();
  const tombstone = (await readdir(root)).find(name => name.includes('.stale-'))!;
  expect(await readFile(join(root, tombstone), 'utf8')).toBe(original);
  await withConfigWriteLock(path, async () => { entered = true; }, 1000, { onWarning: warning });
  expect(entered).toBe(true); expect(warning).not.toHaveBeenCalled();
});
