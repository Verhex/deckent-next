import { mkdtemp, mkdir, writeFile, readFile, rm, stat, chmod, symlink, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openConfiguredAttemptStore } from '../../../src/composition/core/storage/index.js';
import { clearConfigCache, resolveProductLayout, prepareProductFile } from '#platform/index.js';
import type { SqliteAttemptStore } from '#adapters/index.js';
const roots: string[] = []; const stores: SqliteAttemptStore[] = [];
afterEach(async () => { for (const store of stores.splice(0)) store.close(); clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'deckent-ledger-')); roots.push(root);
  const project = join(root, 'project'); await mkdir(join(project, '.deckent'), { recursive: true, mode: 0o700 });
  const configPath = join(project, '.deckent/config.json');
  const data = join(root, 'data');
  const env = { HOME: join(root, 'home') };
  return { root, project, configPath, data, env };
}
describe.skipIf(process.platform === 'win32')('layout-selected ledger preflight', () => {
  it('opens relocated configured ledger with private file permissions and inspectable pinned layout', async () => {
    const f = await fixture();
    await writeFile(f.configPath, JSON.stringify({ layout: { root: f.data, resources: { ledger: 'execution/state.db' } },
      storage: { driver: 'sqlite', sqlite: { busyTimeoutMs: 20, journalMode: 'wal', durability: 'extra' } } }));
    const opened = await openConfiguredAttemptStore(f.project, { env: f.env }); stores.push(opened.store);
    expect(opened.path).toBe(join(f.data, 'execution/state.db'));
    expect(opened.layout.bootstrapConfigPath).toBe(f.configPath);
    expect((await stat(opened.path)).mode & 0o777).toBe(0o600);
    expect((await stat(join(f.data, 'execution'))).mode & 0o777).toBe(0o700);
    expect((await readFile(opened.path)).subarray(0, 15).toString()).toBe('SQLite format 3');
    await writeFile(f.configPath, JSON.stringify({ layout: { root: join(f.root, 'other') } })); clearConfigCache();
    expect(opened.path).toBe(join(f.data, 'execution/state.db'));
    expect(Object.isFrozen(opened.layout)).toBe(true);
  });
  it('refuses symlink root and sidecars without writing through them', async () => {
    const f = await fixture(); const outside = join(f.root, 'outside'); await mkdir(outside);
    await symlink(outside, f.data);
    await expect(prepareProductFile(resolveProductLayout({ projectRoot: f.project, root: f.data }), 'ledger')).rejects.toThrow('MANAGED_FILE_UNSAFE');
    await rm(f.data); await mkdir(join(f.data, 'state'), { recursive: true, mode: 0o700 });
    const sentinel = join(outside, 'sentinel'); await writeFile(sentinel, 'unchanged');
    await symlink(sentinel, join(f.data, 'state/ledger.db-wal'));
    await expect(prepareProductFile(resolveProductLayout({ projectRoot: f.project, root: f.data }), 'ledger', ['-wal'])).rejects.toThrow('MANAGED_FILE_UNSAFE');
    expect(await readFile(sentinel, 'utf8')).toBe('unchanged');
  });
  it('rejects insecure permissions and multiply linked files without silently repairing them', async () => {
    const f = await fixture(); await mkdir(f.data, { mode: 0o700 }); await chmod(f.data, 0o777);
    const layout = resolveProductLayout({ projectRoot: f.project, root: f.data });
    await expect(prepareProductFile(layout, 'ledger')).rejects.toThrow('MANAGED_FILE_UNSAFE');
    expect((await stat(f.data)).mode & 0o777).toBe(0o777); await chmod(f.data, 0o700);
    const path = await prepareProductFile(layout, 'ledger'); await link(path, join(f.data, 'alias'));
    await expect(prepareProductFile(layout, 'ledger')).rejects.toThrow('MANAGED_FILE_UNSAFE');
  });
  it('fails unsupported drivers before creating the selected root', async () => {
    const f = await fixture(); await writeFile(f.configPath, JSON.stringify({ layout: { root: f.data }, storage: { driver: 'uninstalled' } }));
    await expect(openConfiguredAttemptStore(f.project, { env: f.env })).rejects.toThrow();
    await expect(stat(f.data)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
