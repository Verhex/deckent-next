import { createHash } from 'node:crypto';
import { chmod, link, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { inspectInstallationFile, publishInstallationFile } from '../../../src/adapters/core/installation-files/index.js';

const roots: string[] = [], maxBytes = 4096;
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() { const base = await mkdtemp(join(tmpdir(), 'deckent-install-file-')); roots.push(base);
  const root = join(base, 'private'); await mkdir(root, { mode: 0o700 }); return { root, path: join(root, 'nested/config.json') }; }
const request = (f: Awaited<ReturnType<typeof fixture>>, transactionId = 'transaction-1') => ({ ...f, maxBytes, transactionId });
const sha = (value: string) => createHash('sha256').update(value).digest('hex');

it('publishes once and replays exact immutable bytes', async () => {
  const f = await fixture(); expect(await inspectInstallationFile({ ...f, maxBytes })).toEqual({ digest: null });
  expect(await publishInstallationFile(request(f), '{"ok":true}\n')).toEqual({ digest: sha('{"ok":true}\n'), status: 'published' });
  expect(await publishInstallationFile(request(f), '{"ok":true}\n')).toEqual({ digest: sha('{"ok":true}\n'), status: 'replayed' });
  expect(await readFile(f.path, 'utf8')).toBe('{"ok":true}\n');
});
it('never replaces a foreign target, including an exclusive publication race', async () => {
  const f = await fixture(); await mkdir(join(f.root, 'nested'), { mode: 0o700 }); await writeFile(f.path, 'foreign', { mode: 0o600 });
  await expect(publishInstallationFile(request(f), 'wanted')).rejects.toMatchObject({ code: 'INSTALLATION_FILE_CONFLICT' });
  expect(await readFile(f.path, 'utf8')).toBe('foreign');
  const g = await fixture(); const settled = await Promise.allSettled([
    publishInstallationFile(request(g, 'one'), 'one'), publishInstallationFile(request(g, 'two'), 'two')]);
  expect(settled.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  expect(['one', 'two']).toContain(await readFile(g.path, 'utf8'));
});
it('recovers a target plus its reserved two-link stage', async () => {
  const f = await fixture(); await publishInstallationFile(request(f), 'same');
  const transaction = sha(`deckent.installation-file.v1\ntransaction-1\n${f.path}`), target = sha('same');
  const temp = join(f.root, 'nested', `.${basename(f.path)}.${transaction}.${target}.installing`);
  await link(f.path, temp); expect((await lstat(f.path)).nlink).toBe(2);
  await expect(publishInstallationFile(request(f), 'same')).resolves.toMatchObject({ status: 'replayed' });
  await expect(lstat(temp)).rejects.toMatchObject({ code: 'ENOENT' }); expect((await lstat(f.path)).nlink).toBe(1);
});
it('recovers complete and exact partial reserved stages before publishing', async () => {
  const f = await fixture(); await mkdir(join(f.root, 'nested'), { mode: 0o700 });
  const transaction = sha(`deckent.installation-file.v1\ntransaction-1\n${f.path}`), target = sha('complete');
  const temp = join(f.root, 'nested', `.${basename(f.path)}.${transaction}.${target}.installing`);
  await writeFile(temp, 'comp', { mode: 0o600 });
  await expect(publishInstallationFile(request(f), 'complete')).resolves.toMatchObject({ status: 'published' });
  expect(await readFile(f.path, 'utf8')).toBe('complete'); await expect(lstat(temp)).rejects.toMatchObject({ code: 'ENOENT' });
  const g = await fixture(); await mkdir(join(g.root, 'nested'), { mode: 0o700 });
  const completeTransaction = sha(`deckent.installation-file.v1\ntransaction-1\n${g.path}`), completeTarget = sha('ready');
  const completeTemp = join(g.root, 'nested', `.${basename(g.path)}.${completeTransaction}.${completeTarget}.installing`);
  await writeFile(completeTemp, 'ready', { mode: 0o600 });
  await expect(publishInstallationFile(request(g), 'ready')).resolves.toMatchObject({ status: 'published' });
  expect(await readFile(g.path, 'utf8')).toBe('ready');
});
it('rejects symlink and unrelated hard-link custody', async () => {
  const f = await fixture(); await mkdir(join(f.root, 'nested'), { mode: 0o700 }); const foreign = join(f.root, 'foreign');
  await writeFile(foreign, 'x', { mode: 0o600 }); await symlink(foreign, f.path);
  await expect(inspectInstallationFile({ ...f, maxBytes })).rejects.toMatchObject({ code: 'INSTALLATION_FILE_UNSAFE' }); await rm(f.path);
  await link(foreign, f.path); await expect(inspectInstallationFile({ ...f, maxBytes })).rejects.toMatchObject({ code: 'INSTALLATION_FILE_UNSAFE' });
});
it('rejects a symlink ancestor, accepts non-writable 0755 custody, and preserves an unrelated reserved stage', async () => {
  const base = await mkdtemp(join(tmpdir(), 'deckent-install-ancestor-')); roots.push(base);
  const real = join(base, 'real'); await mkdir(real, { mode: 0o700 }); const linked = join(base, 'linked'); await symlink(real, linked);
  await expect(publishInstallationFile({ root: join(linked, 'root'), path: join(linked, 'root/file'), maxBytes, transactionId: 'x' }, 'x'))
    .rejects.toMatchObject({ code: 'INSTALLATION_FILE_UNSAFE' });
  const f = await fixture(); await chmod(f.root, 0o755);
  await expect(publishInstallationFile(request(f), 'ok')).resolves.toMatchObject({ status: 'published' });
  const g = await fixture(); await mkdir(join(g.root, 'nested'), { mode: 0o700 });
  const transaction = sha(`deckent.installation-file.v1\ntransaction-1\n${g.path}`), target = sha('wanted');
  const temp = join(g.root, 'nested', `.${basename(g.path)}.${transaction}.${target}.installing`);
  await writeFile(temp, 'unrelated', { mode: 0o600 });
  await expect(publishInstallationFile(request(g), 'wanted')).rejects.toMatchObject({ code: 'INSTALLATION_FILE_CONFLICT' });
  expect(await readFile(temp, 'utf8')).toBe('unrelated');
});
it('rejects oversized content before creating directories', async () => {
  const f = await fixture(); await expect(publishInstallationFile({ ...request(f), maxBytes: 2 }, 'three')).rejects.toMatchObject({ code: 'INSTALLATION_FILE_INVALID' });
  await expect(lstat(join(f.root, 'nested'))).rejects.toMatchObject({ code: 'ENOENT' });
});
