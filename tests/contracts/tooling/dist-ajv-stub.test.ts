import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { afterEach, describe, expect, it } from 'vitest';
// FASTURI-OUT (owner 2026-09-29): the stub and its guard against the INSTALLED MCP SDK, so an SDK upgrade that moves the ajv provider fails
// verify, not only a release-time build-dist. The entry imports exactly the SDK specifiers Deckent's src uses, plus Deckent's own validator
// (MCP-SCHEMA-VALIDATOR: the SDK's cf-worker provider is no longer used and the guard refuses it).
// @ts-expect-error JavaScript build tooling has no declaration file.
import { ajvGuard, ajvStubPlugin } from '../../../scripts/build-dist.mjs';
// @ts-expect-error JavaScript build tooling has no declaration file.
import { bundledPackages, embeddedInBundle } from '../../../scripts/dist-sbom.mjs';

const ROOT = join(import.meta.dirname, '../../../');
const ENTRY = [`export { Client } from '@modelcontextprotocol/client';`, `export { StdioClientTransport } from '@modelcontextprotocol/client/stdio';`,
  `export { Server } from '@modelcontextprotocol/server';`, `export { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio';`,
  `export { DeckentJsonSchemaValidator } from './src/platform/core/validate/internal/json-schema.ts';`].join('\n');
const CF_WORKER = `export { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/server/validators/cf-worker';`;
const outs: string[] = [];
afterEach(async () => { await Promise.all(outs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

async function bundle(stub: boolean, entry = ENTRY) {
  const outdir = await mkdtemp(join(tmpdir(), 'dist-ajv-stub-')); outs.push(outdir);
  const hits = new Map<string, number>();
  const result = await build({ absWorkingDir: ROOT, stdin: { contents: entry, resolveDir: ROOT, sourcefile: 'entry.mjs', loader: 'js' }, outdir, bundle: true,
    format: 'esm', platform: 'node', target: 'node24', metafile: true, logLevel: 'silent',
    banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" } /* as build-dist's require banner */, plugins: stub ? [ajvStubPlugin(hits)] : [] });
  const { shipped } = bundledPackages(ROOT, result.metafile);
  return { outdir, violations: ajvGuard({ metafile: result.metafile, shipped, embedded: embeddedInBundle(ROOT, shipped), hits }) as string[], hits };
}

describe('MCP SDK ajv stub against the installed SDK', () => {
  it('bundles no ajv/fast-uri/cfworker with the stub; the stubbed bundle runs with Deckent\'s validator and fails closed without one', async () => {
    const { outdir, violations, hits } = await bundle(true);
    expect(violations).toEqual([]);
    expect(Object.fromEntries(hits)).toMatchObject({ '@modelcontextprotocol/client/_shims': 1, '@modelcontextprotocol/server/_shims': expect.any(Number) });
    const sdk = await import(pathToFileURL(join(outdir, 'stdin.js')).href) as Record<string, new (...args: unknown[]) => unknown>;
    expect(() => new sdk.Client!({ name: 't', version: '1' }, { jsonSchemaValidator: new sdk.DeckentJsonSchemaValidator!() })).not.toThrow();
    expect(() => new sdk.Server!({ name: 't', version: '1' }, { capabilities: { tools: {} }, jsonSchemaValidator: new sdk.DeckentJsonSchemaValidator!() })).not.toThrow();
    expect(() => new sdk.Server!({ name: 't', version: '1' }, { capabilities: { tools: {} } }))
      .toThrow(expect.objectContaining({ name: 'DeckentRemovedValidatorError', code: 'MCP_DEFAULT_VALIDATOR_REMOVED' }));
  }, 60_000);

  it('the guard sees the real provider when the stub is not applied (positive control)', async () => {
    const { violations } = await bundle(false);
    expect(violations).toEqual(expect.arrayContaining(['@modelcontextprotocol/client/_shims was bundled without the ajv stub',
      '@modelcontextprotocol/server/_shims was bundled without the ajv stub', expect.stringMatching(/^embedded fast-uri@3\.1\.0 in @modelcontextprotocol\/client@/u),
      expect.stringMatching(/^bundle input node_modules\/@modelcontextprotocol\/server\/dist\/ajvProvider-/u)]));
  }, 60_000);

  it('the guard refuses the SDK\'s cf-worker provider if anything bundles it (installed SDK)', async () => {
    const { violations } = await bundle(true, `${ENTRY}\n${CF_WORKER}`);
    expect(violations).toEqual([expect.stringMatching(/^bundle input node_modules\/@modelcontextprotocol\/server\/dist\/cfWorkerProvider-/u),
      expect.stringMatching(/^embedded @cfworker\/json-schema@4\.1\.1 in @modelcontextprotocol\/server@2\.2\.0/u)]);
  }, 60_000);
});
