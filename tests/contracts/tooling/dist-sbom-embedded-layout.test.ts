import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error JavaScript build tooling has no declaration file.
import { scanEmbedded } from '../../../scripts/check-embedded-deps.mjs';
// @ts-expect-error JavaScript build tooling has no declaration file.
import { bundledPackages, cyclonedx, embeddedInBundle } from '../../../scripts/dist-sbom.mjs';

const NAME = '@scope/carrier', TOP = `node_modules/${NAME}`;
const LICENSES = new Map([['ajv@8.17.1', 'MIT'], ['fast-uri@3.1.0', 'BSD-3-Clause']]);
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function write(root: string, path: string, content: string) {
  await mkdir(join(root, path, '..'), { recursive: true });
  await writeFile(join(root, path), content);
}

async function install(root: string, dir: string, version = '2.2.0') {
  await write(root, `${dir}/package.json`, JSON.stringify({ name: NAME, version, license: 'MIT' }));
  await write(root, `${dir}/dist/provider.mjs`, 'export const provider = 1;');
  await write(root, `${dir}/dist/provider.mjs.map`, JSON.stringify({ sources: [
    '../../../node_modules/.pnpm/fast-uri@3.1.0/node_modules/fast-uri/index.js',
  ] }));
  await write(root, `${dir}/dist/types.d.mts.map`, JSON.stringify({ sources: [
    '../../../node_modules/.pnpm/ajv@8.17.1/node_modules/ajv/lib/types.ts',
  ] }));
  // Ordinary nested dependencies must not be mistaken for components embedded in the carrier.
  await write(root, `${dir}/node_modules/ordinary/hidden.map`, JSON.stringify({ sources: [
    'node_modules/.pnpm/not-embedded@1.0.0/node_modules/not-embedded/index.js',
  ] }));
}

function bundle(root: string, dirs: string[]) {
  const inputs = Object.fromEntries(dirs.flatMap(dir => [[`${dir}/dist/provider.mjs`, {}], [`${dir}/dist/types.d.mts`, {}]]));
  const output = Object.fromEntries(dirs.flatMap(dir => [
    [`${dir}/dist/provider.mjs`, { bytesInOutput: 7 }], [`${dir}/dist/types.d.mts`, { bytesInOutput: 0 }],
  ]));
  return bundledPackages(root, { inputs, outputs: { 'bundle.mjs': { inputs: output } } }).shipped;
}

async function fixture(dir = TOP) {
  const root = await mkdtemp(join(tmpdir(), 'dist-sbom-embedded-')); roots.push(root);
  await write(root, 'package.json', JSON.stringify({ dependencies: { [NAME]: '2.2.0' } }));
  await install(root, dir);
  return { root: await realpath(root), dir };
}

const expectedEmbedded = (version = '2.2.0') => [
  { name: 'ajv', version: '8.17.1', license: 'MIT', carrier: `${NAME}@${version}`, shipped: false, carrierFiles: [] },
  { name: 'fast-uri', version: '3.1.0', license: 'BSD-3-Clause', carrier: `${NAME}@${version}`, shipped: true, carrierFiles: ['dist/provider.mjs'] },
];
const expectedScan = (version = '2.2.0') => ({ package: NAME, installed: version, embedded: [
  { name: 'ajv', version: '8.17.1', installedTopLevel: null, sourceCount: 1, maps: ['dist/types.d.mts.map'] },
  { name: 'fast-uri', version: '3.1.0', installedTopLevel: null, sourceCount: 1, maps: ['dist/provider.mjs.map'] },
] });

async function cli(root: string) {
  await mkdir(join(root, 'scripts'), { recursive: true });
  await copyFile(new URL('../../../scripts/check-embedded-deps.mjs', import.meta.url), join(root, 'scripts/check-embedded-deps.mjs'));
  const result = spawnSync(process.execPath, ['scripts/check-embedded-deps.mjs'], { cwd: root, encoding: 'utf8', timeout: 10_000 });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(result.stderr).toBe('');
  return result.stdout;
}

describe('embedded components follow their carrier install directory', () => {
  it('preserves the pre-change top-level report and CycloneDX bytes, with no empty problems field', async () => {
    const { root, dir } = await fixture();
    const shipped = bundle(root, [dir]);
    const embedded = embeddedInBundle(root, shipped, LICENSES);
    expect(embedded).toEqual(expectedEmbedded());
    expect(scanEmbedded(root, [NAME])).toEqual([expectedScan()]);
    const bom = cyclonedx({ pkg: { name: 'fixture', version: '1.0.0', license: 'Apache-2.0' },
      identity: { sourceTreeSha256: 'abc', sourceCommit: null }, tools: [{ name: 'fixture', version: '1' }],
      shipped, embedded, timestamp: '2026-10-10T00:00:00.000Z' });
    // Fixed byte digest of this fixture's pre-change CycloneDX JSON, including its trailing newline.
    expect(createHash('sha256').update(`${JSON.stringify(bom, null, 2)}\n`).digest('hex'))
      .toBe('7b191b7e532765e31a4ef13bf14a57c7265a848198433c7be7321089fbd2075f');
    expect(await cli(root)).toBe(`${JSON.stringify({ schemaVersion: 1, root, packages: [expectedScan()], scanned: [`${NAME}@2.2.0`] }, null, 2)}\n`);
  });

  it.each([
    ['nested', `node_modules/a/node_modules/${NAME}`],
    ['pnpm', `node_modules/.pnpm/@scope+carrier@2.2.0/node_modules/${NAME}`],
  ])('reports shipped and unshipped embedded components for a %s carrier', async (_layout, dir) => {
    const { root } = await fixture(dir);
    expect(embeddedInBundle(root, bundle(root, [dir]), LICENSES)).toEqual(expectedEmbedded());
    expect(scanEmbedded(root, [{ name: NAME, dir }])).toEqual([expectedScan()]);
  });

  it('scans a symlinked carrier outside the top-level layout using its lexical installed directory', async () => {
    const target = `node_modules/.pnpm/@scope+carrier@2.2.0/node_modules/${NAME}`;
    const { root } = await fixture(target);
    const dir = `node_modules/a/node_modules/${NAME}`;
    await mkdir(join(root, dir, '..'), { recursive: true });
    await symlink(join(root, target), join(root, dir), process.platform === 'win32' ? 'junction' : 'dir');
    expect(scanEmbedded(root, [{ name: NAME, dir: join(root, dir) }])).toEqual([expectedScan()]);
    expect(embeddedInBundle(root, bundle(root, [dir]), LICENSES)).toEqual(expectedEmbedded());
  });

  it('keeps same-name hosts associated with their own version and shipped files', async () => {
    const { root } = await fixture();
    const nested = `node_modules/a/node_modules/${NAME}`;
    await install(root, nested, '3.0.0');
    const shipped = bundle(root, [TOP, nested]);
    // The top-level install shipped only the declaration carrier; the nested install shipped the provider.
    shipped.find((item: { dir: string }) => item.dir === TOP).shippedFiles = ['dist/types.d.mts'];
    expect(scanEmbedded(root, [NAME, { name: NAME, dir: nested }])).toEqual([expectedScan(), expectedScan('3.0.0')]);
    expect(embeddedInBundle(root, shipped, LICENSES)).toEqual([
      { ...expectedEmbedded()[0], shipped: true, carrierFiles: ['dist/types.d.mts'] },
      { ...expectedEmbedded()[1], shipped: false, carrierFiles: [] },
      ...expectedEmbedded('3.0.0'),
    ]);
  });

  it('accepts a relative root without corrupting carrier-relative sourcemap paths', async () => {
    const { root } = await fixture();
    const relativeRoot = relative(process.cwd(), root);
    expect(scanEmbedded(relativeRoot, [NAME])).toEqual([expectedScan()]);
  });

  it.each(['missing', 'not-directory', 'invalid-manifest', 'unreadable-map'])('reports an unscannable %s host without throwing; CLI exits 0', async failure => {
    const { root, dir } = await fixture();
    const shipped = bundle(root, [dir]);
    if (failure === 'missing' || failure === 'not-directory') {
      await rm(join(root, dir), { recursive: true });
      if (failure === 'not-directory') await write(root, dir, 'not a directory');
    } else if (failure === 'invalid-manifest') await write(root, `${dir}/package.json`, '{broken');
    else await symlink(join(root, dir, 'dist'), join(root, dir, 'dist/unreadable.map'), process.platform === 'win32' ? 'junction' : 'dir');

    let report: { package: string; problem?: string }[] = [];
    expect(() => { report = scanEmbedded(root, [NAME]); }).not.toThrow();
    expect(report).toHaveLength(1);
    expect(report[0]).toMatchObject({ package: NAME, problem: expect.any(String) });
    expect(report[0]!.problem).toContain(join(root, dir));
    let embedded: unknown[] = [];
    expect(() => { embedded = embeddedInBundle(root, shipped, LICENSES); }).not.toThrow();
    expect(embedded).toContainEqual({ carrier: `${NAME}@2.2.0`, problem: report[0]!.problem });

    const output = JSON.parse(await cli(root));
    expect(output.problems).toEqual(report);
    expect(output.scanned).toHaveLength(1);
  });
});
