import { afterEach, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { createConfigFileDocuments } from '#adapters/core/config-file/index.js';
import { ConfigApplication } from '#engine/core/config/index.js';
import { withConfigWriteLock, writeConfig } from '#platform/index.js';

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, unlink: vi.fn(actual.unlink) };
});
const roots: string[] = [];
const principal = { id: 'test', issuer: 'local-os', subject: 'test', assurance: 'os-user', scopeIds: ['test'] } as const;
const command = { keyPath: 'max_workers', principal, scopeId: 'test', commandId: 'retention-test' };
afterEach(async () => {
  vi.mocked(unlink).mockReset();
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  vi.mocked(unlink).mockImplementation(actual.unlink);
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function fixture(settings?: { backupKeep?: number; writeLockTimeoutMs?: number }) {
  const root = await mkdtemp(join(tmpdir(), 'config-retention-')); roots.push(root);
  const path = join(root, '.deckent/config.json'), global = join(root, 'global/config.json');
  await mkdir(dirname(path), { recursive: true }); await mkdir(dirname(global), { recursive: true });
  if (settings) await writeFile(global, JSON.stringify({ configFile: settings }));
  const documents = createConfigFileDocuments(root, { env: { DECKENT_GLOBAL_HOME: dirname(global) } });
  const app = new ConfigApplication(documents, { async authorize() { return 'test-policy'; }, async audit() {} });
  return { root, path, app };
}
for (const keep of [3, 2]) it(`keeps exactly ${keep} newest backups through governed writes using ${keep === 3 ? 'registry defaults' : 'configured retention'}`, async () => {
  const f = await fixture(keep === 3 ? undefined : { backupKeep: keep });
  const receipts: string[] = [];
  for (let value = 1; value <= 7; value++) {
    const result = await f.app.set({ ...command, value });
    if (result.backupPath) receipts.push(result.backupPath);
    const names = (await readdir(dirname(f.path))).filter(name => name.includes('.bak.'));
    expect(names).toHaveLength(Math.min(value - 1, keep));
    if (result.backupPath) expect(names).toContain(basename(result.backupPath));
    await sleep(2); // Distinct timestamps make prior filename ordering deterministic.
  }
  const values = await Promise.all(receipts.slice(-keep).map(async path => JSON.parse(await readFile(path, 'utf8')).max_workers));
  expect(values).toEqual(Array.from({ length: keep }, (_, index) => 7 - keep + index));
  for (const path of receipts.slice(0, -keep)) await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
});
it('reports a typed pruning failure after publication, preserves the saved document and releases its lock', async () => {
  const f = await fixture();
  for (let value = 1; value <= 4; value++) await f.app.set({ ...command, value });
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  const failure = Object.assign(new Error('backup deletion unavailable'), { code: 'EACCES' });
  vi.mocked(unlink).mockImplementation(async path => {
    if (!String(path).includes('.bak.')) return actual.unlink(path);
    expect(JSON.parse(await readFile(`${f.path}.write-lock/owner.json`, 'utf8')).pid).toBe(process.pid);
    expect(JSON.parse(await readFile(f.path, 'utf8')).max_workers).toBe(5);
    throw failure;
  });
  await expect(f.app.set({ ...command, value: 5 })).rejects.toMatchObject({ code: 'CONFIG_BACKUP_PRUNE_FAILED', cause: failure });
  expect(JSON.parse(await readFile(f.path, 'utf8')).max_workers).toBe(5);
  await expect(readFile(`${f.path}.write-lock/owner.json`)).rejects.toMatchObject({ code: 'ENOENT' });
  expect((await readdir(dirname(f.path))).filter(name => name.includes('.bak.'))).toHaveLength(4);
});
it('uses configured lock waiting for governed publication and compatibility writeConfig', async () => {
  const f = await fixture({ writeLockTimeoutMs: 25 });
  let release!: () => void, acquired!: () => void;
  const ready = new Promise<void>(resolve => { acquired = resolve; });
  const held = withConfigWriteLock(f.path, () => new Promise<void>(resolve => { release = resolve; acquired(); }));
  await ready;
  const pending: Promise<unknown>[] = [];
  try {
    // The guard makes a literal 2s timeout fail promptly while releasing the owner in finally.
    for (const write of [() => f.app.set({ ...command, value: 2 }), () => writeConfig(f.path, { configFile: { writeLockTimeoutMs: 25 }, max_workers: 2 })]) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const operation = write(); pending.push(operation);
      try {
        await expect(Promise.race([operation, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('configured lock deadline ignored')), 500); })]))
          .rejects.toMatchObject({ code: 'CONFIG_WRITE_LOCKED' });
      } finally { clearTimeout(timer); }
    }
  } finally { release(); await held; await Promise.allSettled(pending); }
  await expect(readFile(f.path)).rejects.toMatchObject({ code: 'ENOENT' });
});
