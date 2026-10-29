import { chmod, link, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { measureInstalledPackage, type PackageMeasurementLimits } from '../../../src/adapters/core/installation-artifacts/index.js';
import { verifyBeuserDistribution } from '#adapters/core/beuser-realm/index.js';

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

async function stage(root: string) {
  const measured = await measureInstalledPackage(root, limits);
  const manifest = JSON.stringify(Object.fromEntries(measured.files.map(file => [file.path, `${file.sha256}:${file.mode.toString(8)}`])));
  await writeFile(join(root, 'manifest.json'), manifest);
  await writeFile(join(root, 'release.json'), JSON.stringify({ schemaVersion: 1, packageVersion: '1.2.3',
    manifestSha256: createHash('sha256').update(manifest).digest('hex') }));
}

it('measures the dev-release inventory plus both metadata records and rejects foreign or missing distribution bytes', async () => {
  // An old npm inclusion list still mentions native; its complete unpacked inventory has the actual dist layout.
  const root = await fixture(['dist', 'native', 'README.md']);
  await rm(join(root, 'native'), { recursive: true }); await rm(join(root, 'host-secret.txt')); await stage(root);
  const result = await measureInstalledPackage(root, limits), files = result.files.map(({ path, sha256, size }) => ({ path, sha256, size }));
  const digest = createHash('sha256').update(JSON.stringify(files)).digest('hex');
  expect(result.declaredMissing).toEqual([]);
  expect(files.map(file => file.path)).toEqual(['README.md', 'dist/index.js', 'dist/internal/value.js', 'manifest.json', 'package.json', 'release.json']);
  expect(await verifyBeuserDistribution(root, files, limits, digest)).toBe(true);
  const release = await readFile(join(root, 'release.json'));
  await writeFile(join(root, 'release.json'), Buffer.concat([release, Buffer.from('\n')]));
  expect((await measureInstalledPackage(root, limits)).measurementDigest).not.toBe(result.measurementDigest);
  expect(await verifyBeuserDistribution(root, files, limits, digest)).toBe(false);
  await writeFile(join(root, 'release.json'), release);
  await writeFile(join(root, 'foreign.txt'), 'foreign');
  expect(await verifyBeuserDistribution(root, files, limits, digest)).toBe(false);
  await rm(join(root, 'foreign.txt')); await rm(join(root, 'README.md'));
  expect((await measureInstalledPackage(root, limits)).declaredMissing).toEqual(['README.md']);
  expect(await verifyBeuserDistribution(root, files, limits, digest)).toBe(false);
  await rm(join(root, 'dist/internal/value.js'));
  expect((await measureInstalledPackage(root, limits)).declaredMissing).toEqual(['README.md', 'dist/internal/value.js']);
});

it('refuses incomplete, corrupt, linked or changed dev-release inventory records instead of falling back to package.files', async () => {
  const root = await fixture(['dist']); await stage(root);
  const release = await readFile(join(root, 'release.json')), manifest = await readFile(join(root, 'manifest.json'));
  await rm(join(root, 'manifest.json'));
  await expect(measureInstalledPackage(root, limits)).rejects.toMatchObject({ code: 'INSTALLATION_ARTIFACT_INVALID' });
  await symlink(join(root, 'host-secret.txt'), join(root, 'manifest.json'));
  await expect(measureInstalledPackage(root, limits)).rejects.toMatchObject({ code: 'INSTALLATION_ARTIFACT_UNSAFE' });
  await rm(join(root, 'manifest.json')); await writeFile(join(root, 'manifest.json'), '{}');
  await expect(measureInstalledPackage(root, limits)).rejects.toMatchObject({ code: 'INSTALLATION_ARTIFACT_INVALID' });
  await writeFile(join(root, 'manifest.json'), manifest); await writeFile(join(root, 'release.json'), '{');
  await expect(measureInstalledPackage(root, limits)).rejects.toMatchObject({ code: 'INSTALLATION_ARTIFACT_INVALID' });
  await writeFile(join(root, 'release.json'), JSON.stringify({ ...JSON.parse(release.toString()), schemaVersion: 2 }));
  await expect(measureInstalledPackage(root, limits)).rejects.toMatchObject({ code: 'INSTALLATION_ARTIFACT_INVALID' });
  await writeFile(join(root, 'release.json'), release); await writeFile(join(root, 'dist/index.js'), 'changed');
  await expect(measureInstalledPackage(root, limits)).rejects.toMatchObject({ code: 'INSTALLATION_ARTIFACT_CHANGED' });
  const unsafe = JSON.stringify({ 'package.json': 'a'.repeat(64) + ':644', '../escape': 'b'.repeat(64) + ':644' });
  await writeFile(join(root, 'manifest.json'), unsafe);
  await writeFile(join(root, 'release.json'), JSON.stringify({ schemaVersion: 1, packageVersion: '1.2.3',
    manifestSha256: createHash('sha256').update(unsafe).digest('hex') }));
  await expect(measureInstalledPackage(root, limits)).rejects.toMatchObject({ code: 'INSTALLATION_ARTIFACT_UNSAFE' });
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
