import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
// DEPS-DIST: the bundled package's SBOM comes from the bundler's metafile (bytes actually shipped), not from package.json; OSV reads it back.
// @ts-expect-error JavaScript build tooling has no declaration file.
import { bundledPackages, cyclonedx, embeddedInBundle, npmPurl, packageDirOf, thirdPartyNotices } from '../../../scripts/dist-sbom.mjs';
// @ts-expect-error JavaScript build tooling has no declaration file.
import { ajvGuard, declarationImports, publishedManifest, stubAjvImport } from '../../../scripts/build-dist.mjs';
// @ts-expect-error JavaScript build tooling has no declaration file.
import { sbomComponents } from '../../../scripts/deps-watch.mjs';

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
    expect(packageDirOf('dist/index.js')).toBeNull();
    expect(npmPurl('@modelcontextprotocol/client', '2.2.0')).toBe('pkg:npm/%40modelcontextprotocol/client@2.2.0');
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
  const shims = 'import { n as AjvJsonSchemaValidator } from "./ajvProvider-97rDpkRx.mjs";\nimport process from "node:process";\n\nexport { AjvJsonSchemaValidator as DefaultJsonSchemaValidator, process };\n';
  it('replaces exactly the ajvProvider import, keeps every other line and throws a typed error when the default is built', async () => {
    const code = stubAjvImport(shims, 'server/_shims');
    expect(code).not.toContain('ajvProvider');
    expect(code).toContain('import process from "node:process";');
    expect(code).toContain('export { AjvJsonSchemaValidator as DefaultJsonSchemaValidator, process };');
    const subpath = stubAjvImport('import { n as AjvJsonSchemaValidator, r as addFormats, t as Ajv } from "../ajvProvider-97rDpkRx.mjs";\nexport { Ajv, AjvJsonSchemaValidator, addFormats };', 'client/validators/ajv');
    const root = await tree({ 'shims.mjs': code, 'ajv.mjs': subpath });
    const { DefaultJsonSchemaValidator } = await import(join(root, 'shims.mjs')) as { DefaultJsonSchemaValidator: new () => unknown };
    expect(() => new DefaultJsonSchemaValidator()).toThrow(expect.objectContaining({ name: 'DeckentRemovedValidatorError', code: 'MCP_DEFAULT_VALIDATOR_REMOVED' }));
    const ajv = await import(join(root, 'ajv.mjs')) as Record<string, (...args: unknown[]) => unknown>;
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
