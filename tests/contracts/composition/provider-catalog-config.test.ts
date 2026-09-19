import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { inspectDeclaredModels } from '../../../src/index.js';
import { clearConfigCache, ConfigValidationError, resolveGlobalConfigPaths, writeConfig } from '#platform/index.js';

const roots: string[] = [];

function provider(id: string, nativeId = `test-native/${id}`) {
  return { id, version: 1, models: [{ id: `${id}-model`, version: 1, nativeId,
    protocols: [{ family: 'test-native-http', version: 'v1', capabilities: [{ id: 'text', version: 1, state: 'supported' }] }],
  }] };
}
function catalog(revision: string, providers: readonly ReturnType<typeof provider>[]) {
  return { schemaVersion: 1, revision, providers };
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'deckent-provider-catalog-')); roots.push(root);
  const home = join(root, 'private-home'), project = join(root, 'project');
  const env = { HOME: home, USERPROFILE: home, APPDATA: join(home, 'roaming'), LOCALAPPDATA: join(home, 'local'), XDG_CONFIG_HOME: join(home, '.config') };
  const globalPath = resolveGlobalConfigPaths(env).platformPath;
  const projectPath = join(project, '.deckent', 'config.json');
  await Promise.all([mkdir(dirname(globalPath), { recursive: true }), mkdir(dirname(projectPath), { recursive: true })]);
  return { project, env, globalPath, projectPath };
}
async function expectCatalogError(loading: Promise<unknown>, expectedReason = 'PROVIDER_CATALOG_INVALID') {
  try { await loading; expect.fail('invalid catalog must reject'); }
  catch (error) {
    expect(error).toBeInstanceOf(ConfigValidationError);
    expect(error).toMatchObject({ issues: [{ path: 'provider_catalog', reason: expectedReason }] });
    return error as ConfigValidationError;
  }
}

afterEach(async () => {
  clearConfigCache();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('declared provider catalog configuration through the SDK', () => {
  it('returns the complete global declaration when the project has no catalog', async () => {
    const f = await fixture(); const declared = catalog('global-revision', [provider('test-provider-alpha'), provider('test-provider-beta')]);
    await writeFile(f.globalPath, JSON.stringify({ provider_catalog: declared }));
    await expect(inspectDeclaredModels(f.project, { env: f.env })).resolves.toEqual({
      schemaVersion: 1, status: 'declared', availability: 'not-observed', catalog: declared,
    });
  });

  it('uses a complete project snapshot in place of every global provider and revision', async () => {
    const f = await fixture();
    await writeFile(f.globalPath, JSON.stringify({ provider_catalog: catalog('global-revision', [provider('test-provider-alpha'), provider('test-provider-beta')]) }));
    const project = catalog('project-revision', [provider('test-provider-gamma')]);
    await writeFile(f.projectPath, JSON.stringify({ provider_catalog: project }));
    const result = await inspectDeclaredModels(f.project, { env: f.env });
    expect(result).toEqual({ schemaVersion: 1, status: 'declared', availability: 'not-observed', catalog: project });
    if (result.status === 'declared') expect(result.catalog.providers.map(value => value.id)).toEqual(['test-provider-gamma']);
  });

  it('rejects a partial project catalog and an invalid global catalog even when project data is valid', async () => {
    const partial = await fixture();
    await writeFile(partial.projectPath, JSON.stringify({ provider_catalog: { schemaVersion: 1, revision: 'partial-project', providers: [{ id: 'test-provider-partial', version: 1 }] } }));
    await expectCatalogError(inspectDeclaredModels(partial.project, { env: partial.env }));

    const masked = await fixture();
    await writeFile(masked.globalPath, JSON.stringify({ provider_catalog: catalog('invalid-global', [provider('test-provider-duplicate'), provider('test-provider-duplicate')]) }));
    await writeFile(masked.projectPath, JSON.stringify({ provider_catalog: catalog('valid-project', [provider('test-provider-clean')]) }));
    await expectCatalogError(inspectDeclaredModels(masked.project, { env: masked.env }));
  });

  it('rejects an exact catalog secret reference before resolving an earlier allowed config secret', async () => {
    const f = await fixture(); let resolverCalls = 0;
    await writeFile(f.projectPath, JSON.stringify({
      projectName: '$DECK:ALLOWED_EARLIER',
      provider_catalog: catalog('secret-catalog', [provider('test-provider-secret', '$DECK:SYNTHETIC_CATALOG')]),
    }));
    const error = await expectCatalogError(inspectDeclaredModels(f.project, { env: f.env, secretResolver: async () => { resolverCalls++; return 'not-used'; } }, ), 'SECRET_REFERENCE_FORBIDDEN');
    expect(resolverCalls).toBe(0);
    expect(JSON.stringify(error.issues)).not.toContain('SYNTHETIC_CATALOG');
    expect(JSON.stringify(error.issues)).not.toContain('$DECK:');
  });

  it('reports no catalog as not configured and creates no default declaration', async () => {
    const f = await fixture();
    await expect(inspectDeclaredModels(f.project, { env: f.env })).resolves.toEqual({
      schemaVersion: 1, status: 'not-configured', availability: 'not-observed', catalog: null,
    });
  });

  it('returns typed, non-echoing configuration errors for duplicate and future catalogs', async () => {
    const f = await fixture();
    for (const invalid of [
      catalog('duplicate-catalog', [provider('test-provider-duplicate'), provider('test-provider-duplicate')]),
      { schemaVersion: 2, revision: 'future-catalog', providers: [provider('test-provider-future')] },
    ]) {
      await writeFile(f.projectPath, JSON.stringify({ provider_catalog: invalid }));
      const error = await expectCatalogError(inspectDeclaredModels(f.project, { env: f.env, force: true }));
      expect(JSON.stringify(error.issues)).not.toContain('test-provider-future');
      expect(JSON.stringify(error.issues)).not.toContain('$DECK:');
    }
  });

  it('rejects duplicate catalog writes before a lock or bytes change, then writes a valid catalog the SDK reads', async () => {
    const f = await fixture(); const existing = '{"projectName":"preserved"}';
    await writeFile(f.projectPath, existing);
    const duplicate = { provider_catalog: catalog('duplicate-write', [provider('test-provider-write'), provider('test-provider-write')]) };
    await expect(writeConfig(f.projectPath, duplicate)).rejects.toMatchObject({ code: 'CONFIG_VALIDATION',
      issues: [{ path: 'provider_catalog', reason: 'PROVIDER_CATALOG_INVALID' }] });
    expect(await readFile(f.projectPath, 'utf8')).toBe(existing);
    expect(await readdir(dirname(f.projectPath))).toEqual(['config.json']);

    const valid = catalog('valid-write', [provider('test-provider-valid-write')]);
    await writeConfig(f.projectPath, { provider_catalog: valid });
    clearConfigCache();
    await expect(inspectDeclaredModels(f.project, { env: f.env })).resolves.toEqual({
      schemaVersion: 1, status: 'declared', availability: 'not-observed', catalog: valid,
    });
  });
});
