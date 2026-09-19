import { chmod, link, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
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
  expect(result.files.find(file => file.path === 'native/addon.node')).toMatchObject({ mode: 0o500, executable: true });
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
