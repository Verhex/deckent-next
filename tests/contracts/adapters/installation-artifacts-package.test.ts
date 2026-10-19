import { chmod, link, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { measureInstalledPackage, type PackageMeasurementLimits } from '../../../src/adapters/core/installation-artifacts/index.js';

const roots: string[] = [];
const limits: PackageMeasurementLimits = { maxFiles: 20, maxFileBytes: 4096, maxTotalBytes: 16384, maxDepth: 5 };
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture(files: string[] = ['dist', 'native', 'assets', 'README.md', 'LICENSE']) {
  const root = await mkdtemp(join(tmpdir(), 'deckent-package-measure-')); roots.push(root);
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'deckent-test', version: '1.2.3', files }));
  await mkdir(join(root, 'dist/internal'), { recursive: true }); await writeFile(join(root, 'dist/index.js'), 'export {}\n');
  await writeFile(join(root, 'dist/internal/value.js'), 'export const value = 1\n');
  await mkdir(join(root, 'native')); await writeFile(join(root, 'native/addon.node'), 'native-bytes'); await chmod(join(root, 'native/addon.node'), 0o500);
  await writeFile(join(root, 'README.md'), 'read me'); await writeFile(join(root, 'host-secret.txt'), 'never measure me');
  return root;
}

it('measures only declared package bytes and reports absent declarations honestly', async () => {
  const root = await fixture(), before = (await readdir(root)).sort();
  const result = await measureInstalledPackage(root, limits);
  expect(result).toMatchObject({ schemaVersion: 1, packageName: 'deckent-test', packageVersion: '1.2.3',
    declaredMissing: ['LICENSE', 'assets'], dependencyCoverage: 'excluded', origin: 'installed-bytes' });
  expect(result.files.map(file => file.path)).toEqual(['README.md', 'dist/index.js', 'dist/internal/value.js', 'native/addon.node', 'package.json']);
  const mode = (await stat(join(root, 'native/addon.node'))).mode & 0o777;
  expect(result.files.find(file => file.path === 'native/addon.node')).toMatchObject({ mode, executable: (mode & 0o111) !== 0 });
  expect(JSON.stringify(result)).not.toContain('host-secret'); expect((await readdir(root)).sort()).toEqual(before);
});

it('is deterministic and changes when a declared file is replaced', async () => {
  const root = await fixture(), first = await measureInstalledPackage(root, limits), again = await measureInstalledPackage(root, limits);
  expect(again.measurementDigest).toBe(first.measurementDigest);
  await writeFile(join(root, 'dist/index.js'), 'export const changed = true\n');
  expect((await measureInstalledPackage(root, limits)).measurementDigest).not.toBe(first.measurementDigest);
});

it('rejects corrupt metadata, escape, glob, hidden and node_modules declarations', async () => {
  const root = await fixture(); await writeFile(join(root, 'package.json'), '{');
  await expect(measureInstalledPackage(root, limits)).rejects.toMatchObject({ code: 'INSTALLATION_ARTIFACT_INVALID' });
  for (const declaration of ['../secret', 'dist/*.js', '.agents', 'node_modules']) {
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'x', version: '1', files: [declaration] }));
    await expect(measureInstalledPackage(root, limits)).rejects.toMatchObject({ code: expect.stringMatching(/INVALID|UNSAFE/) });
  }
});

it('rejects symlinks and multiply linked distribution files', async () => {
  const root = await fixture(); const target = join(root, 'dist/index.js'); await rm(target); await symlink(join(root, 'host-secret.txt'), target);
  await expect(measureInstalledPackage(root, limits)).rejects.toMatchObject({ code: 'INSTALLATION_ARTIFACT_UNSAFE' });
  await rm(target); await link(join(root, 'host-secret.txt'), target);
  await expect(measureInstalledPackage(root, limits)).rejects.toMatchObject({ code: 'INSTALLATION_ARTIFACT_UNSAFE' });
});

it('enforces required file, byte, total and depth limits before returning evidence', async () => {
  const root = await fixture();
  await expect(measureInstalledPackage(root, { ...limits, maxFiles: 2 })).rejects.toMatchObject({ code: 'INSTALLATION_ARTIFACT_LIMIT' });
  await expect(measureInstalledPackage(root, { ...limits, maxFileBytes: 4 })).rejects.toMatchObject({ code: 'INSTALLATION_ARTIFACT_LIMIT' });
  await expect(measureInstalledPackage(root, { ...limits, maxTotalBytes: 20 })).rejects.toMatchObject({ code: 'INSTALLATION_ARTIFACT_LIMIT' });
  await expect(measureInstalledPackage(root, { ...limits, maxDepth: 1 })).rejects.toMatchObject({ code: 'INSTALLATION_ARTIFACT_LIMIT' });
});

it('does not follow a declared directory replaced by a symlink', async () => {
  const root = await fixture(), outside = join(root, 'outside'); await mkdir(outside); await writeFile(join(outside, 'secret'), 'private');
  await rm(join(root, 'dist'), { recursive: true }); await symlink(outside, join(root, 'dist'));
  await expect(measureInstalledPackage(root, limits)).rejects.toMatchObject({ code: 'INSTALLATION_ARTIFACT_UNSAFE' });
  expect(await readFile(join(outside, 'secret'), 'utf8')).toBe('private');
});

it('rejects a symlink in a nested declared path before reading its ordinary leaf', async () => {
  const root = await fixture(['public-link/secret.json']), outside = join(root, 'outside'); await mkdir(outside);
  await writeFile(join(outside, 'secret.json'), '{"private":true}'); await symlink(outside, join(root, 'public-link'));
  await expect(measureInstalledPackage(root, limits)).rejects.toMatchObject({ code: 'INSTALLATION_ARTIFACT_UNSAFE' });
});

it('bounds visited empty directories as well as returned files', async () => {
  const root = await fixture(['tree']);
  for (let index = 0; index < 10; index++) await mkdir(join(root, 'tree', `empty-${index}`), { recursive: true });
  await expect(measureInstalledPackage(root, { ...limits, maxFiles: 6 })).rejects.toMatchObject({ code: 'INSTALLATION_ARTIFACT_LIMIT' });
});

it.skipIf(process.platform === 'win32')('requires POSIX executable modes: measures a 0500 executable accurately', async () => {
  const root = await fixture(), result = await measureInstalledPackage(root, limits);
  expect(result.files.find(file => file.path === 'native/addon.node')).toMatchObject({ mode: 0o500, executable: true });
});

it('keeps path order and per-file hashes when more files than the read bound are measured', async () => {
  const root = await fixture(['dist']), wide = { ...limits, maxFiles: 200, maxTotalBytes: 1 << 20 }, expected = ['package.json', 'dist/index.js', 'dist/internal/value.js'];
  for (let index = 0; index < 40; index++) {
    const path = `dist/part-${index % 3}/file-${String(index).padStart(2, '0')}.js`; await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), `export const value = ${'x'.repeat(index * 37)};\n`); expected.push(path);
  }
  const first = await measureInstalledPackage(root, wide), again = await measureInstalledPackage(root, wide);
  expect(first.files.map(file => file.path)).toEqual(expected.sort());
  for (const file of first.files) expect(file.sha256).toBe(createHash('sha256').update(await readFile(join(root, file.path))).digest('hex'));
  expect(again.measurementDigest).toBe(first.measurementDigest);
});

it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('requires POSIX permissions: reports the earliest failing file of concurrent reads, as a serial read would', async () => {
  const root = await fixture(['dist']);
  for (const name of ['a', 'b', 'c', 'd', 'e']) { await mkdir(join(root, 'dist/part'), { recursive: true }); await writeFile(join(root, `dist/part/${name}.js`), `export const ${name} = 1;\n`); }
  const used = (await measureInstalledPackage(root, limits)).files.reduce((sum, file) => sum + file.size, 0);
  // The first file cannot be opened and the byte budget runs out at the last one; both reads are in flight together and the later
  // refusal settles first, but the reported refusal is the earlier file's.
  await chmod(join(root, 'dist/index.js'), 0o000);
  await expect(measureInstalledPackage(root, { ...limits, maxTotalBytes: used - 1 })).rejects.toMatchObject({ code: 'INSTALLATION_ARTIFACT_UNAVAILABLE' });
  await chmod(join(root, 'dist/index.js'), 0o600);
  await expect(measureInstalledPackage(root, { ...limits, maxTotalBytes: used - 1 })).rejects.toMatchObject({ code: 'INSTALLATION_ARTIFACT_LIMIT' });
});
