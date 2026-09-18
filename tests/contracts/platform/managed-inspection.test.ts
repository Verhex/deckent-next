import { chmod, link, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { inspectProductFile, prepareProductFile, prepareProductSocket, resolveProductLayout } from '#platform/index.js';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'deckent-inspect-')); roots.push(root);
  return { root, layout: resolveProductLayout({ projectRoot: root, root: join(root, 'data') }) };
}
describe.skipIf(process.platform === 'win32')('existing managed file inspection', () => {
  it('does not create missing roots, parents or files', async () => {
    const { root, layout } = await fixture();
    await expect(inspectProductFile(layout, 'ledger')).rejects.toThrow('MANAGED_FILE_MISSING');
    await expect(stat(join(root, 'data'))).rejects.toMatchObject({ code: 'ENOENT' });
    await mkdir(join(root, 'data/state'), { recursive: true, mode: 0o700 });
    await expect(inspectProductFile(layout, 'ledger')).rejects.toThrow('MANAGED_FILE_MISSING');
    await expect(stat(join(root, 'data/state/ledger.db'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('accepts existing private files without changing contents and rejects unsafe permissions or links', async () => {
    const { root, layout } = await fixture(); const file = await prepareProductFile(layout, 'ledger');
    await writeFile(file, 'unchanged'); expect(await inspectProductFile(layout, 'ledger')).toBe(file);
    expect(await readFile(file, 'utf8')).toBe('unchanged');
    await chmod(file, 0o644); await expect(inspectProductFile(layout, 'ledger')).rejects.toThrow('MANAGED_FILE_UNSAFE');
    expect((await stat(file)).mode & 0o777).toBe(0o644); await chmod(file, 0o600);
    await link(file, join(root, 'alias')); await expect(inspectProductFile(layout, 'ledger')).rejects.toThrow('MANAGED_FILE_UNSAFE');
    await rm(join(root, 'alias')); await symlink(file, file + '-wal');
    await expect(inspectProductFile(layout, 'ledger', ['-wal'])).rejects.toThrow('MANAGED_FILE_UNSAFE');
    await rm(file + '-wal'); await rm(file); await symlink(join(root, 'absent'), file);
    await expect(inspectProductFile(layout, 'ledger')).rejects.toThrow('MANAGED_FILE_UNSAFE');
  });
});

it.skipIf(process.platform === 'win32')('prepares a configured socket location without creating or replacing its endpoint', async () => {
  const { root } = await fixture();
  const layout = resolveProductLayout({ projectRoot: root, root: join(root, 'data'), resources: { runtimeSocket: 'custom/service.sock' } });
  await expect(prepareProductSocket(layout, 'runtimeSocket', false)).rejects.toThrow('MANAGED_FILE_MISSING');
  const endpoint = await prepareProductSocket(layout, 'runtimeSocket');
  expect(endpoint).toBe(join(root, 'data/custom/service.sock'));
  await expect(stat(endpoint)).rejects.toMatchObject({ code: 'ENOENT' });
  await writeFile(endpoint, 'owner-data', { mode: 0o600 });
  await expect(prepareProductSocket(layout, 'runtimeSocket')).rejects.toThrow('MANAGED_FILE_UNSAFE');
  expect(await readFile(endpoint, 'utf8')).toBe('owner-data');
});
