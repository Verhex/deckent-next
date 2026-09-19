import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { clearConfigCache, ConfigValidationError, loadConfig, registerConfigSection, resolveGlobalConfigPaths, validateConfig } from '../../../src/platform/index.js';

const roots: string[] = [];

const nestedValues = z.array(z.object({ value: z.string() }).strict()).default([]);
registerConfigSection('secret_policy_allowed_probe', z.object({ token: z.string() }).strict(), { optional: true });
registerConfigSection('secret_policy_forbid_probe', z.object({ token: z.string().default('clean'), nested: nestedValues }).strict(),
  { optional: true, secretReferences: 'forbid' });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'deckent-secret-policy-')); roots.push(root);
  const home = join(root, 'home'), project = join(root, 'project');
  const env = { HOME: home, USERPROFILE: home, APPDATA: join(home, 'roaming'), LOCALAPPDATA: join(home, 'local'), XDG_CONFIG_HOME: join(home, '.config') };
  const globalPath = resolveGlobalConfigPaths(env).platformPath;
  const projectPath = join(project, '.deckent', 'config.json');
  await Promise.all([mkdir(dirname(globalPath), { recursive: true }), mkdir(dirname(projectPath), { recursive: true })]);
  return { env, globalPath, project, projectPath };
}

async function expectForbidden(load: Promise<unknown>, calls: () => number) {
  try { await load; expect.fail('forbidden secret reference must reject'); }
  catch (error) {
    expect(error).toBeInstanceOf(ConfigValidationError);
    expect(error).toMatchObject({ issues: [{ path: 'secret_policy_forbid_probe', reason: 'SECRET_REFERENCE_FORBIDDEN' }] });
    const issues = (error as ConfigValidationError).issues;
    expect(issues).toHaveLength(1);
    expect(JSON.stringify(issues)).not.toContain('DECK:');
  }
  expect(calls()).toBe(0);
}

afterEach(async () => {
  clearConfigCache();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('registered config secret-reference policy', () => {
  it('rejects an exact project reference in a forbidden section before resolver access', async () => {
    const f = await fixture(); let resolverCalls = 0;
    await writeFile(f.projectPath, JSON.stringify({ secret_policy_forbid_probe: { token: '$DECK:PROJECT_SECRET', nested: [{ value: 'clean' }] } }));
    await expectForbidden(loadConfig(f.project, { env: f.env, heal: false, secretResolver: async () => { resolverCalls++; return 'not-used'; } }), () => resolverCalls);
  });

  it('rejects a forbidden global reference even when a clean project value overrides it', async () => {
    const f = await fixture(); let resolverCalls = 0;
    await writeFile(f.globalPath, JSON.stringify({ secret_policy_forbid_probe: { token: '$DECK:GLOBAL_SECRET' } }));
    await writeFile(f.projectPath, JSON.stringify({ secret_policy_forbid_probe: { token: 'clean', nested: [] } }));
    await expectForbidden(loadConfig(f.project, { env: f.env, heal: false, secretResolver: async () => { resolverCalls++; return 'not-used'; } }), () => resolverCalls);
  });

  it('does not resolve an earlier allowed-section reference when any forbidden section fails', async () => {
    const f = await fixture(); let resolverCalls = 0;
    await writeFile(f.projectPath, JSON.stringify({
      secret_policy_allowed_probe: { token: '$DECK:ALLOWED_FIRST' },
      secret_policy_forbid_probe: { token: '$DECK:FORBIDDEN_SECOND', nested: [] },
    }));
    await expectForbidden(loadConfig(f.project, { env: f.env, heal: false, secretResolver: async () => { resolverCalls++; return 'not-used'; } }), () => resolverCalls);
  });

  it('keeps default-allow interpolation behavior, including an unresolved reference', async () => {
    const f = await fixture();
    await writeFile(f.projectPath, JSON.stringify({ secret_policy_allowed_probe: { token: '$DECK:ALLOWED_TOKEN' } }));
    const resolved = await loadConfig(f.project, { env: f.env, heal: false, secretResolver: async name => name === 'ALLOWED_TOKEN' ? 'resolved-value' : undefined });
    expect(resolved['secret_policy_allowed_probe']).toEqual({ token: 'resolved-value' });
    const missing = await loadConfig(f.project, { env: f.env, force: true, heal: false, secretResolver: async () => undefined });
    expect(missing['secret_policy_allowed_probe']).toEqual({ token: '$DECK:ALLOWED_TOKEN' });
  });

  it('rejects default and transform-produced effective references before resolver access', async () => {
    registerConfigSection('secret_policy_effective_probe', z.object({
      source: z.string().default('source').transform(() => '$DECK:TRANSFORMED_REFERENCE'),
    }).strict(), { secretReferences: 'forbid' });
    for (const authored of [undefined, { secret_policy_effective_probe: { source: 'authored-clean' } }]) {
      const f = await fixture(); let resolverCalls = 0;
      if (authored !== undefined) await writeFile(f.projectPath, JSON.stringify(authored));
      try {
        await loadConfig(f.project, { env: f.env, heal: false, secretResolver: async () => { resolverCalls++; return 'not-used'; } });
        expect.fail('effective reference must reject');
      } catch (error) {
        expect(error).toBeInstanceOf(ConfigValidationError);
        expect(error).toMatchObject({ issues: [{ path: 'secret_policy_effective_probe', reason: 'SECRET_REFERENCE_FORBIDDEN' }] });
        expect(JSON.stringify((error as ConfigValidationError).issues)).not.toContain('TRANSFORMED_REFERENCE');
      }
      expect(resolverCalls).toBe(0);
    }
  });

  it('rejects malformed runtime metadata at registration', () => {
    for (const options of [{ secretReferences: 'invalid' as never }, { validateValue: 'invalid' as never }]) {
      try {
        registerConfigSection('secret_policy_bad_metadata_probe', z.object({}).strict(), options);
        expect.fail('invalid metadata must reject');
      } catch (error) { expect(error).toMatchObject({ code: 'CONFIG_SECTION_INVALID' }); }
    }
  });

  it('never invokes getters while inspecting a forbidden section', () => {
    let getterCalls = 0;
    const input: Record<string, unknown> = {};
    Object.defineProperty(input, 'secret_policy_forbid_probe', { enumerable: true, get() { getterCalls++; return { token: '$DECK:GETTER' }; } });
    try { validateConfig(input); expect.fail('accessor section must reject'); }
    catch (error) { expect(error).toMatchObject({ issues: [{ path: 'secret_policy_forbid_probe', reason: 'SECRET_SECTION_INVALID' }] }); }
    expect(getterCalls).toBe(0);
  });
});
