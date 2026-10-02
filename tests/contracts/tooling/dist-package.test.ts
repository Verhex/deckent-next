import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
// DEPS-DIST: the bundled package's SBOM comes from the bundler's metafile (bytes actually shipped), not from package.json; OSV reads it back.
// @ts-expect-error JavaScript build tooling has no declaration file.
import { bundledNativeComponents, bundledPackages, cyclonedx, embeddedInBundle, lockedLicenseTexts, npmPurl, packageDirOf, thirdPartyNotices } from '../../../scripts/dist-sbom.mjs';
// @ts-expect-error JavaScript build tooling has no declaration file.
import { ajvGuard, declarationImports, publishedManifest, STANDALONE_ENTRIES, standaloneImportProblems, stubAjvImport } from '../../../scripts/build-dist.mjs';
// @ts-expect-error JavaScript build tooling has no declaration file.
import { sbomComponents } from '../../../scripts/deps-watch.mjs';
// @ts-expect-error JavaScript build tooling has no declaration file.
import { vendorDeclarations } from '../../../scripts/dist-types.mjs';

type Component = { name: string; group?: string; purl: string; 'bom-ref': string; licenses: unknown[]; hashes?: { alg: string; content: string }[];
  properties: { name: string; value: string }[]; components?: Component[] };
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function tree(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), 'dist-package-')); roots.push(root);
  for (const [path, content] of Object.entries(files)) { await mkdir(join(root, path, '..'), { recursive: true }); await writeFile(join(root, path), content); }
  return root;
}
const integrity = `sha512-${Buffer.alloc(64, 1).toString('base64')}`;
const fixture = () => tree({
  'package-lock.json': JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/@scope/carrier': { version: '2.2.0', integrity },
    'node_modules/@scope/carrier/node_modules/zod': { version: '4.6.5' } } }),
  'node_modules/@scope/carrier/package.json': JSON.stringify({ name: '@scope/carrier', version: '2.2.0', license: 'MIT' }),
  'node_modules/@scope/carrier/LICENSE': 'carrier license text',
  // The carrier embeds fast-uri in the shipped provider and json-schema-typed only in a declaration file (never shipped).
  'node_modules/@scope/carrier/dist/provider.mjs.map': JSON.stringify({ sources: ['../../../node_modules/.pnpm/fast-uri@3.1.0/node_modules/fast-uri/index.js'] }),
  'node_modules/@scope/carrier/dist/types.d.mts.map': JSON.stringify({ sources: ['../../../node_modules/.pnpm/json-schema-typed@8.0.2/node_modules/json-schema-typed/index.ts'] }),
  'node_modules/@scope/carrier/node_modules/zod/package.json': JSON.stringify({ name: 'zod', version: '4.6.5', license: 'MIT' }),
  'node_modules/@scope/carrier/node_modules/zod/LICENSE': 'zod license text',
  'node_modules/unlicensed/package.json': JSON.stringify({ name: 'unlicensed', version: '1.0.0', license: '(MIT OR CC0-1.0)' }),
  'node_modules/shaken/package.json': JSON.stringify({ name: 'shaken', version: '0.1.0', license: 'MIT' }),
});
const metafile = { inputs: { 'dist/index.js': {}, 'node_modules/@scope/carrier/dist/provider.mjs': {}, 'node_modules/@scope/carrier/node_modules/zod/index.js': {},
  'node_modules/unlicensed/index.js': {}, 'node_modules/shaken/index.js': {} },
outputs: { 'out/dist/index.js': { inputs: { 'dist/index.js': { bytesInOutput: 10 } } },
  'out/dist/vendor/chunk-A.js': { inputs: { 'node_modules/@scope/carrier/dist/provider.mjs': { bytesInOutput: 300 }, 'node_modules/@scope/carrier/node_modules/zod/index.js': { bytesInOutput: 50 },
    'node_modules/unlicensed/index.js': { bytesInOutput: 5 }, 'node_modules/shaken/index.js': { bytesInOutput: 0 } } } } };

describe('dist SBOM', () => {
  it('maps metafile inputs to the innermost installed package and encodes scoped purls', () => {
    expect(packageDirOf('node_modules/a/node_modules/@s/b/lib/x.js')).toBe('node_modules/a/node_modules/@s/b');
    expect(packageDirOf(String.raw`node_modules\a\node_modules\@s\b\lib\x.js`)).toBe('node_modules/a/node_modules/@s/b');
    expect(packageDirOf('dist/index.js')).toBeNull();
    expect(npmPurl('@modelcontextprotocol/client', '2.2.0')).toBe('pkg:npm/%40modelcontextprotocol/client@2.2.0');
  });

  it('preserves shipped bytes and nested package identity for Windows metafile separators', async () => {
    const root = await fixture();
    const windowsKeys = (entries: Record<string, unknown>) => Object.fromEntries(Object.entries(entries).map(([key, value]) => [key.replaceAll('/', '\\'), value]));
    const windows = { inputs: windowsKeys(metafile.inputs), outputs: Object.fromEntries(Object.entries(metafile.outputs)
      .map(([key, output]) => [key.replaceAll('/', '\\'), { ...output, inputs: windowsKeys(output.inputs) }])) };
    expect(bundledPackages(root, windows)).toEqual(bundledPackages(root, metafile));
  });

  it('lists shipped packages by bytes in the bundle, keeps nested versions apart and reports tree-shaken ones separately', async () => {
    const root = await fixture();
    const { shipped, treeShaken } = bundledPackages(root, metafile);
    expect(shipped.map((item: { name: string; version: string }) => `${item.name}@${item.version}`)).toEqual(['@scope/carrier@2.2.0', 'zod@4.6.5', 'unlicensed@1.0.0']);
    expect(treeShaken.map((item: { name: string }) => item.name)).toEqual(['shaken']);
    const embedded = embeddedInBundle(root, shipped, new Map([['fast-uri@3.1.0', 'BSD-3-Clause']]));
    expect(embedded.map((item: { name: string; shipped: boolean; license: string | null }) => [item.name, item.shipped, item.license]))
      .toEqual([['fast-uri', true, 'BSD-3-Clause'], ['json-schema-typed', false, null]]);

    const bom = cyclonedx({ pkg: { name: 'deckent', version: '1.0.0', license: 'Apache-2.0' }, identity: { sourceTreeSha256: 'abc', sourceCommit: null },
      tools: [{ name: 'esbuild', version: '0.28.2' }], shipped, embedded, timestamp: '2026-09-29T00:00:00.000Z' });
    expect(bom).toMatchObject({ bomFormat: 'CycloneDX', specVersion: '1.6', metadata: { component: { purl: 'pkg:npm/deckent@1.0.0' } } });
    const [carrier, zod, unlicensed] = bom.components as Component[];
    expect(carrier).toMatchObject({ group: '@scope', name: 'carrier', purl: 'pkg:npm/%40scope/carrier@2.2.0', hashes: [{ alg: 'SHA-512', content: '01'.repeat(64) }] });
    expect(carrier!.properties).toContainEqual({ name: 'cdx:npm:package:bundled', value: 'true' });
    // Only the embedded component whose carrier file is shipped is listed, nested under its carrier with a carrier-qualified bom-ref.
    expect(carrier!.components!.map(item => [item.purl, item['bom-ref']])).toEqual([['pkg:npm/fast-uri@3.1.0', 'pkg:npm/fast-uri@3.1.0?carrier=%40scope%2Fcarrier%402.2.0']]);
    expect(zod!.properties).toContainEqual({ name: 'deckent:bundle:installPath', value: 'node_modules/@scope/carrier/node_modules/zod' });
    expect(unlicensed!.licenses).toEqual([{ expression: '(MIT OR CC0-1.0)' }]);
    // Same content → same serial number, whatever the timestamp.
    expect(cyclonedx({ pkg: { name: 'deckent', version: '1.0.0', license: 'Apache-2.0' }, identity: { sourceTreeSha256: 'abc', sourceCommit: null },
      tools: [{ name: 'esbuild', version: '0.28.2' }], shipped, embedded, timestamp: 'later' }).serialNumber).toBe(bom.serialNumber);

    // OSV input: deps-watch reads the same document back, with the carrier string acceptedRisks use.
    expect(sbomComponents(bom)).toEqual([{ name: '@scope/carrier', version: '2.2.0', via: null }, { name: 'fast-uri', version: '3.1.0', via: '@scope/carrier@2.2.0' },
      { name: 'zod', version: '4.6.5', via: null }, { name: 'unlicensed', version: '1.0.0', via: null }]);
    expect(() => sbomComponents({ bomFormat: 'SPDX' })).toThrow('not a CycloneDX JSON SBOM');

    const notices = thirdPartyNotices(root, { pkg: { name: 'deckent', version: '1.0.0' }, shipped, embedded });
    expect(notices.text).toContain('carrier license text');
    expect(notices.text).toContain('- fast-uri@3.1.0 (in @scope/carrier@2.2.0): BSD-3-Clause');
    expect(notices.gaps).toEqual(['unlicensed@1.0.0: no license file in the installed package',
      'fast-uri@3.1.0 (in @scope/carrier@2.2.0): license text not shipped by the carrier']);
  });
});

// FASTURI-OUT (owner 2026-09-29): the published package carries no ajv/fast-uri. The SDK's default-validator modules are loaded with their one
// ajvProvider import replaced by a throwing stub, and the guard fails the build on any of three independent signals.
describe('MCP SDK ajv provider stub and guard', () => {
  it('refuses unstubbed and forbidden providers with Windows metafile separators', () => {
    const input = { metafile: { inputs: { [String.raw`node_modules\@modelcontextprotocol\client\dist\ajvProvider-x.mjs`]: {},
      [String.raw`node_modules\fast-uri\index.js`]: {} } }, shipped: [], embedded: [], hits: new Map() };
    expect(ajvGuard(input)).toEqual(['@modelcontextprotocol/client/_shims was bundled without the ajv stub',
      'bundle input node_modules/@modelcontextprotocol/client/dist/ajvProvider-x.mjs', 'bundle input node_modules/fast-uri/index.js']);
  });
  const shims = 'import { n as AjvJsonSchemaValidator } from "./ajvProvider-97rDpkRx.mjs";\nimport process from "node:process";\n\nexport { AjvJsonSchemaValidator as DefaultJsonSchemaValidator, process };\n';
  it('replaces exactly the ajvProvider import, keeps every other line and throws a typed error when the default is built', async () => {
    const code = stubAjvImport(shims, 'server/_shims');
    expect(code).not.toContain('ajvProvider');
    expect(code).toContain('import process from "node:process";');
    expect(code).toContain('export { AjvJsonSchemaValidator as DefaultJsonSchemaValidator, process };');
    const subpath = stubAjvImport('import { n as AjvJsonSchemaValidator, r as addFormats, t as Ajv } from "../ajvProvider-97rDpkRx.mjs";\nexport { Ajv, AjvJsonSchemaValidator, addFormats };', 'client/validators/ajv');
    const root = await tree({ 'shims.mjs': code, 'ajv.mjs': subpath });
    const { DefaultJsonSchemaValidator } = await import(pathToFileURL(join(root, 'shims.mjs')).href) as { DefaultJsonSchemaValidator: new () => unknown };
    expect(() => new DefaultJsonSchemaValidator()).toThrow(expect.objectContaining({ name: 'DeckentRemovedValidatorError', code: 'MCP_DEFAULT_VALIDATOR_REMOVED' }));
    const ajv = await import(pathToFileURL(join(root, 'ajv.mjs')).href) as Record<string, (...args: unknown[]) => unknown>;
    for (const name of ['Ajv', 'AjvJsonSchemaValidator', 'addFormats']) expect(() => ajv[name]!()).toThrow(`${name} (the MCP SDK default ajv validator) is not part of this package`);
    // A layout the stub does not recognise fails the build instead of silently shipping the real provider.
    expect(() => stubAjvImport('export const CORS_IS_POSSIBLE = false;', 'client/_shims')).toThrow('client/_shims: expected exactly one ajvProvider import');
    expect(() => stubAjvImport(`${shims}import { t as Ajv } from "./ajvProvider-x.mjs";\n`, 'server/_shims')).toThrow('expected exactly one ajvProvider import');
  });

  it('reports every signal: unstubbed _shims, forbidden inputs, shipped packages and shipped embedded components', () => {
    const clean = { metafile: { inputs: { 'node_modules/@modelcontextprotocol/client/dist/shimsNode.mjs': {}, 'src/platform/core/validate/internal/json-schema.ts': {} } },
      shipped: [{ name: '@modelcontextprotocol/client', version: '2.2.0' }], embedded: [{ name: 'fast-uri', version: '3.1.0', carrier: '@modelcontextprotocol/client@2.2.0', shipped: false, carrierFiles: [] }],
      hits: new Map([['@modelcontextprotocol/client/_shims', 1]]) };
    expect(ajvGuard(clean)).toEqual([]);
    expect(ajvGuard({ ...clean, hits: new Map(),
      metafile: { inputs: { ...clean.metafile.inputs, 'node_modules/@modelcontextprotocol/client/dist/ajvProvider-97rDpkRx.mjs': {}, 'node_modules/@modelcontextprotocol/server/dist/index.mjs': {},
        'node_modules/fast-uri/index.js': {}, 'node_modules/@modelcontextprotocol/server/dist/cfWorkerProvider-p3WaZPqB.mjs': {} } },
      shipped: [...clean.shipped, { name: 'fast-uri', version: '3.1.8' }],
      embedded: [{ ...clean.embedded[0], shipped: true, carrierFiles: ['dist/ajvProvider-97rDpkRx.mjs'] },
        { name: '@cfworker/json-schema', version: '4.1.1', carrier: '@modelcontextprotocol/server@2.2.0', shipped: true, carrierFiles: ['dist/cfWorkerProvider-p3WaZPqB.mjs'] }] })).toEqual([
      '@modelcontextprotocol/client/_shims was bundled without the ajv stub', '@modelcontextprotocol/server/_shims was bundled without the ajv stub',
      'bundle input node_modules/@modelcontextprotocol/client/dist/ajvProvider-97rDpkRx.mjs', 'bundle input node_modules/fast-uri/index.js',
      'bundle input node_modules/@modelcontextprotocol/server/dist/cfWorkerProvider-p3WaZPqB.mjs',
      'shipped package fast-uri@3.1.8', 'embedded fast-uri@3.1.0 in @modelcontextprotocol/client@2.2.0 (dist/ajvProvider-97rDpkRx.mjs)',
      'embedded @cfworker/json-schema@4.1.1 in @modelcontextprotocol/server@2.2.0 (dist/cfWorkerProvider-p3WaZPqB.mjs)']);
  });
});

describe('bundled native executables in the SBOM and notices (BWRAP-SELECT)', () => {
  it('lists the shipped bubblewrap per architecture with its binary hash, corresponding source and linked Alpine packages; deps-watch skips it', () => {
    const lock = JSON.parse(readFileSync(new URL('../../../packaging/bwrap/bwrap.lock.json', import.meta.url), 'utf8'));
    const native = bundledNativeComponents(lock);
    expect(native).toHaveLength(1);
    const [bwrap] = native as Component[] & { externalReferences?: unknown[] }[];
    expect(bwrap).toMatchObject({ type: 'application', name: 'bubblewrap', version: '0.13.0', licenses: [{ license: { id: 'LGPL-2.1-or-later' } }],
      purl: `pkg:generic/bubblewrap@0.13.0?download_url=${encodeURIComponent(lock.source.url)}&checksum=sha256:${lock.source.sha256}`,
      hashes: [{ alg: 'SHA-256', content: lock.outputs.x86_64.sha256 }],
      externalReferences: [{ type: 'source-distribution', url: lock.source.url, hashes: [{ alg: 'SHA-256', content: lock.source.sha256 }] }, { type: 'vcs', url: 'https://github.com/containers/bubblewrap' }] });
    expect(bwrap!.properties).toContainEqual({ name: 'deckent:bundle:path', value: 'dist/adapters/core/shell-sandbox-bwrap/bundled/linux-x64/bwrap' });
    expect(bwrap!.components!.map(item => [item.purl, item.licenses])).toEqual([
      ['pkg:apk/alpine/musl@1.2.6-r2?arch=x86_64&distro=alpine-3.24.2', [{ license: { id: 'MIT' } }]],
      ['pkg:apk/alpine/libcap@2.78-r0?arch=x86_64&distro=alpine-3.24.2', [{ license: { id: 'BSD-3-Clause' } }]],
      ['pkg:apk/alpine/gcc@15.2.0-r5?arch=x86_64&distro=alpine-3.24.2', [{ expression: 'GPL-3.0-or-later WITH GCC-exception-3.1' }]]]);
    const bom = cyclonedx({ pkg: { name: 'deckent', version: '1.0.0', license: 'Apache-2.0' }, identity: { sourceTreeSha256: 'abc', sourceCommit: null }, tools: [],
      shipped: [], embedded: [], native, timestamp: 't' });
    expect(bom.components).toEqual(native);
    expect(bom.dependencies[0].dependsOn).toEqual([bwrap!['bom-ref']]);
    expect(sbomComponents(bom)).toEqual([]); // not an npm component: OSV is not asked, the GitHub advisory watch is
    const notices = thirdPartyNotices('/', { pkg: { name: 'deckent', version: '1.0.0' }, shipped: [], embedded: [],
      native: [{ name: 'bubblewrap', version: '0.13.0', notice: 'bubblewrap 0.13.0 (LGPL-2.1-or-later) notice', dir: 'dist/adapters/core/shell-sandbox-bwrap/bundled' }] });
    expect(notices.text).toContain('## bubblewrap 0.13.0 (separate executable)');
    expect(notices.text).toContain('bubblewrap 0.13.0 (LGPL-2.1-or-later) notice');
    expect(notices.gaps).toEqual([]);
  });
});

describe('standalone mounted entries (PACKAGED-WORKER-BOOTSTRAP)', () => {
  it('names the native worker bootstrap the docker supervisor mounts alone', () => {
    expect(STANDALONE_ENTRIES).toEqual(['adapters/core/native-connection/internal/worker.js']);
  });

  it('accepts only external node: builtins and refuses a shared chunk, a kept relative import and a bare package', () => {
    expect(standaloneImportProblems({ imports: [{ path: 'node:http', kind: 'import-statement', external: true }] }, 'w.js')).toEqual([]);
    expect(standaloneImportProblems({ imports: [
      { path: '.pack/package/dist/vendor/chunk-OXXOQBJJ.js', kind: 'import-statement' },
      { path: './credential.js', kind: 'import-statement', external: true },
      { path: 'react-devtools-core', kind: 'dynamic-import', external: true },
      { path: 'node:net', kind: 'import-statement', external: true }] }, 'w.js')).toEqual([
      'w.js imports .pack/package/dist/vendor/chunk-OXXOQBJJ.js (import-statement)', 'w.js imports ./credential.js (import-statement)',
      'w.js imports react-devtools-core (dynamic-import)']);
  });
});

describe('published manifest', () => {
  it('drops dependencies and scripts, keeps the public entry points and lists the notice files', () => {
    const manifest = publishedManifest({ name: 'deckent', version: '1.0.0', type: 'module', bin: { deckent: './dist/cli.js' }, exports: { '.': './dist/index.js' },
      imports: { '#platform/*': './dist/platform/*' }, dependencies: { zod: '3.25.76' }, devDependencies: { esbuild: '0.28.2' }, scripts: { build: 'x' },
      files: ['dist', 'README.md'] }, ['THIRD-PARTY-NOTICES.md', 'sbom.cdx.json']);
    expect(manifest).toEqual({ name: 'deckent', version: '1.0.0', type: 'module', bin: { deckent: './dist/cli.js' }, exports: { '.': './dist/index.js' },
      imports: { '#platform/*': './dist/platform/*' }, files: ['dist', 'README.md', 'THIRD-PARTY-NOTICES.md', 'sbom.cdx.json'] });
  });

  it('reports third-party packages the shipped declarations still import', async () => {
    const root = await tree({ 'a.d.ts': "import { z } from 'zod';\nexport type A = import('react').ReactNode;\nimport type { X } from '#platform/index.js';",
      'sub/b.d.ts': "import { DatabaseSync } from 'node:sqlite';\nexport * from './a.js';\nimport { Server } from '@modelcontextprotocol/server/stdio';", 'c.js': "import 'zod';" });
    expect(declarationImports(root)).toEqual({ '@modelcontextprotocol/server': 1, react: 1, zod: 1 });
  });
});

describe('published declarations (DEPS-TYPES)', () => {
  const pkg = (name: string, version: string, extra: Record<string, unknown> = {}) => JSON.stringify({ name, version, type: 'module', license: 'MIT', ...extra });
  const files = (root: string, dir = ''): Promise<string[]> => readdir(join(root, dir), { withFileTypes: true }).then(entries => Promise.all(entries.map(entry =>
    entry.isDirectory() ? files(root, join(dir, entry.name)) : [join(dir, entry.name)]))).then(list => list.flat().sort());

  it('ships the consumer-reachable closure with third-party declarations vendored per name@version and bare specifiers rewritten', async () => {
    const root = await tree({
      'package.json': pkg('app', '1.0.0'),
      'dist/index.d.ts': "import { z } from 'zod';\nexport * from './own.js';\nexport type A = import('lib').B;\nexport declare const schema: typeof z;\n",
      'dist/own.d.ts': 'export type Own = 1;\n',
      'dist/unreachable.d.ts': "import type { ReactNode } from 'react';\nexport type R = ReactNode;\n",
      // zod-like: CJS-flavoured types first in its exports; the file keeps its .d.cts format in the vendored copy.
      'node_modules/zod/package.json': pkg('zod', '3.0.0', { exports: { '.': { types: './index.d.cts', import: './index.js' } } }),
      'node_modules/zod/index.d.cts': "export * from './inner.cjs';\n", 'node_modules/zod/inner.d.cts': 'export declare const z: { readonly kind: 3 };\n',
      'node_modules/zod/LICENSE': 'zod license',
      // lib depends on its own nested dep@2 while the top level has dep@1: resolution, not the package name, decides.
      'node_modules/lib/package.json': pkg('lib', '1.0.0', { exports: { '.': { import: { types: './dist/index.d.mts', default: './dist/index.mjs' } } } }),
      'node_modules/lib/dist/index.d.mts': "import type { Y } from 'dep';\nexport type B = Y | import('dep').Y;\n",
      'node_modules/lib/node_modules/dep/package.json': pkg('dep', '2.0.0', { types: './index.d.ts' }),
      'node_modules/lib/node_modules/dep/index.d.ts': 'export type Y = 2;\n',
      'node_modules/dep/package.json': pkg('dep', '1.0.0', { types: './index.d.ts' }), 'node_modules/dep/index.d.ts': 'export type Y = 1;\n',
    });
    const stage = join(root, 'stage');
    const result = vendorDeclarations({ root, stage });
    expect(result.problems).toEqual([]);
    expect(await files(stage)).toEqual(['dist/index.d.ts', 'dist/own.d.ts', 'dist/vendor/types/dep@2.0.0/index.d.ts', 'dist/vendor/types/dep@2.0.0/package.json',
      'dist/vendor/types/lib@1.0.0/dist/index.d.mts', 'dist/vendor/types/lib@1.0.0/package.json', 'dist/vendor/types/zod@3.0.0/index.d.cts',
      'dist/vendor/types/zod@3.0.0/inner.d.cts', 'dist/vendor/types/zod@3.0.0/package.json']);
    expect(await readFile(join(stage, 'dist/index.d.ts'), 'utf8')).toBe("import { z } from './vendor/types/zod@3.0.0/index.cjs';\nexport * from './own.js';\n" +
      "export type A = import('./vendor/types/lib@1.0.0/dist/index.mjs').B;\nexport declare const schema: typeof z;\n");
    expect(await readFile(join(stage, 'dist/vendor/types/lib@1.0.0/dist/index.d.mts'), 'utf8'))
      .toBe("import type { Y } from '../../dep@2.0.0/index.js';\nexport type B = Y | import('../../dep@2.0.0/index.js').Y;\n");
    expect(await readFile(join(stage, 'dist/vendor/types/zod@3.0.0/index.d.cts'), 'utf8')).toBe("export * from './inner.cjs';\n");
    expect(JSON.parse(await readFile(join(stage, 'dist/vendor/types/zod@3.0.0/package.json'), 'utf8'))).toEqual({ type: 'module' });
    expect(result.vendored.map((item: { name: string; version: string; files: string[]; licenseFiles: string[] }) => [`${item.name}@${item.version}`, item.files, item.licenseFiles]))
      .toEqual([['lib@1.0.0', ['dist/index.d.mts'], []], ['dep@2.0.0', ['index.d.ts'], []], ['zod@3.0.0', ['index.d.cts', 'inner.d.cts'], ['LICENSE']]]);
    expect(result).toMatchObject({ own: 2, rewrittenOwn: 1 });
    // Declarations-only packages get their own license section; a missing license text is a gap.
    const notices = thirdPartyNotices(root, { pkg: { name: 'app', version: '1.0.0' }, shipped: [], embedded: [], declarations: result.vendored });
    expect(notices.text).toContain('## zod@3.0.0 (type declarations only)');
    expect(notices.text).toContain('zod license');
    expect(notices.gaps).toEqual(['lib@1.0.0 (declarations): no license file in the installed package', 'dep@2.0.0 (declarations): no license file in the installed package']);
  });

  it('refuses declarations a consumer could not resolve the same way in NodeNext and Bundler, or that a copy cannot relocate', async () => {
    const root = await tree({
      'package.json': pkg('app', '1.0.0'),
      // Extensionless relative import: Bundler finds it, NodeNext does not.
      'dist/index.d.ts': "export * from './own';\nexport type { X } from 'aug';\nexport type { M } from 'missing';\n", 'dist/own.d.ts': 'export type Own = 1;\n',
      'node_modules/aug/package.json': pkg('aug', '1.0.0', { types: './index.d.ts' }),
      'node_modules/aug/index.d.ts': "export type X = 1;\ndeclare module 'other' { interface Extra { x: 1 } }\n",
    });
    const { problems } = vendorDeclarations({ root, stage: join(root, 'stage') });
    expect(problems).toEqual([
      "dist/index.d.ts: './own' does not resolve (nodenext)",
      "dist/index.d.ts: './own' resolves to null (nodenext) and " + join(root, 'dist/own.d.ts') + ' (bundler)',
      "dist/index.d.ts: 'missing' does not resolve (bundler)",
      "dist/index.d.ts: 'missing' does not resolve (nodenext)",
      "node_modules/aug/index.d.ts: declare module 'other' cannot be relocated",
    ]);
  });
});

// PACK-SMOKE (2026-09-30): a component whose installed copy ships no license text takes the locked upstream text for exactly its name@version
// and SPDX id; a missing, moved or altered text is a blocker, never a silent fallback.
describe('locked upstream license texts', () => {
  const digest = (text: string) => createHash('sha256').update(text).digest('hex');
  const lockTree = (texts: unknown[], files: Record<string, string>) => tree({ 'packaging/licenses/licenses.lock.json': JSON.stringify({ schemaVersion: 1, texts }),
    ...Object.fromEntries(Object.entries(files).map(([path, text]) => [`packaging/licenses/${path}`, text])) });
  const entry = (name: string, version: string, text: string, extra: Record<string, unknown> = {}) =>
    ({ name, version, license: 'MIT', file: `${name}@${version}/LICENSE`, sha256: digest(text), source: { url: `https://example.test/${name}`, commit: 'abc' }, ...extra });

  it('fills a shipped package and an embedded component once per name@version, and reports which entries were used', async () => {
    const root = await lockTree([entry('yoga', '3.2.1', 'yoga text'), entry('ctype', '1.0.5', 'ctype text'), entry('stale', '0.0.1', 'old')],
      { 'yoga@3.2.1/LICENSE': 'yoga text', 'ctype@1.0.5/LICENSE': 'ctype text', 'stale@0.0.1/LICENSE': 'old' });
    const locked = lockedLicenseTexts(root);
    expect(locked.problems).toEqual([]);
    const shipped = [{ name: 'yoga', version: '3.2.1', license: 'MIT', licenseFiles: [], dir: 'node_modules/yoga' }];
    const embedded = ['client', 'server'].map(carrier => ({ name: 'ctype', version: '1.0.5', license: 'MIT', carrier: `@mcp/${carrier}@2.2.0`, shipped: true, carrierFiles: ['dist/x.mjs'] }));
    const notices = thirdPartyNotices(root, { pkg: { name: 'deckent', version: '1.0.0' }, shipped, embedded, locked: locked.texts });
    expect(notices.gaps).toEqual([]);
    expect(notices.lockedUsed).toEqual(['ctype@1.0.5', 'yoga@3.2.1']);
    expect(notices.text).toContain(`upstream text from https://example.test/yoga at commit abc, sha256 ${digest('yoga text')}`);
    expect(notices.text.split('ctype text').length - 1).toBe(1);
    // Without the lock the same inputs are gaps, as before.
    expect(thirdPartyNotices(root, { pkg: { name: 'deckent', version: '1.0.0' }, shipped, embedded }).gaps).toEqual(['yoga@3.2.1: no license file in the installed package',
      'ctype@1.0.5 (in @mcp/client@2.2.0): license text not shipped by the carrier', 'ctype@1.0.5 (in @mcp/server@2.2.0): license text not shipped by the carrier']);
  });

  it('keeps the gap when the version or SPDX id differs, and refuses altered, missing or escaping texts', async () => {
    const root = await lockTree([entry('yoga', '3.2.1', 'yoga text', { license: 'BSD-3-Clause' }), entry('ctype', '1.0.5', 'ctype text'),
      entry('altered', '1.0.0', 'original'), entry('gone', '1.0.0', 'x'), entry('escape', '1.0.0', 'x', { file: '../../escape' })],
    { 'yoga@3.2.1/LICENSE': 'yoga text', 'ctype@1.0.5/LICENSE': 'ctype text', 'altered@1.0.0/LICENSE': 'edited by hand' });
    const locked = lockedLicenseTexts(root);
    expect(locked.problems).toEqual([`altered@1.0.0: locked license text sha256 ${digest('edited by hand')} does not match the lock (${digest('original')})`,
      'gone@1.0.0: locked license text gone@1.0.0/LICENSE missing or outside packaging/licenses', 'escape@1.0.0: locked license text ../../escape missing or outside packaging/licenses']);
    const notices = thirdPartyNotices(root, { pkg: { name: 'deckent', version: '1.0.0' }, locked: locked.texts,
      shipped: [{ name: 'yoga', version: '3.2.1', license: 'MIT', licenseFiles: [], dir: 'node_modules/yoga' }],
      embedded: [{ name: 'ctype', version: '1.0.6', license: 'MIT', carrier: '@mcp/client@2.2.0', shipped: true, carrierFiles: ['dist/x.mjs'] }] });
    expect(notices.gaps).toEqual(['yoga@3.2.1: no license file in the installed package; the locked text is BSD-3-Clause, the package declares MIT',
      'ctype@1.0.6 (in @mcp/client@2.2.0): license text not shipped by the carrier']);
    expect(notices.lockedUsed).toEqual([]);
  });

  it('the repository lock: every text present and byte-identical to its recorded upstream sha256', () => {
    const root = fileURLToPath(new URL('../../..', import.meta.url));
    const locked = lockedLicenseTexts(root);
    expect(locked.problems).toEqual([]);
    expect([...locked.texts.keys()].sort()).toEqual(['content-type@1.0.5', 'yoga-layout@3.2.1']);
  });
});
