import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { registerProviderConfig, validateProviderSpendingLayers } from '#adapters/core/contract/index.js';
import { clearConfigCache, loadConfig, resolveGlobalConfigPaths } from '#platform/index.js';

registerProviderConfig();
const roots: string[] = [];
afterEach(async () => { clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const budget = (scopeId = 'scope', overrides: Record<string, unknown> = {}) => ({ schemaVersion: 1, scopeId,
  budgetId: `budget-${scopeId}`, revision: 1, currency: 'USD', limitMinorUnits: 10_000, ...overrides });
const spending = (...budgets: unknown[]) => ({ schemaVersion: 1, budgets });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'deckent-provider-spending-')); roots.push(root);
  const project = join(root, 'project'), home = join(root, 'home'), env = { HOME: home, XDG_CONFIG_HOME: join(home, '.config') };
  const projectPath = join(project, '.deckent/config.json'), globalPath = resolveGlobalConfigPaths(env).platformPath;
  await Promise.all([mkdir(dirname(projectPath), { recursive: true }), mkdir(dirname(globalPath), { recursive: true })]);
  return { project, env, projectPath, globalPath };
}

it('loads no monetary default and accepts a project-owned budget when no parent authored the section', async () => {
  const f = await fixture(); await writeFile(f.projectPath, '{}');
  expect((await loadConfig(f.project, { env: f.env })).provider_spending).toBeUndefined();
  await writeFile(f.projectPath, JSON.stringify({ provider_spending: spending(budget()) })); clearConfigCache();
  expect((await loadConfig(f.project, { env: f.env })).provider_spending).toEqual(spending(budget()));
});

it('allows only an exact subset of parent-owned scope budgets', async () => {
  const f = await fixture(), first = budget(), second = budget('other');
  await writeFile(f.globalPath, JSON.stringify({ provider_spending: spending(first, second) }));
  await writeFile(f.projectPath, JSON.stringify({ provider_spending: spending(second) }));
  expect((await loadConfig(f.project, { env: f.env })).provider_spending).toEqual(spending(second));
  for (const changed of [budget('new'), budget('scope', { limitMinorUnits: 10_001 }), budget('scope', { limitMinorUnits: 9_999 }),
    budget('scope', { revision: 2 }), budget('scope', { revision: 1, limitMinorUnits: 0 })]) {
    await writeFile(f.projectPath, JSON.stringify({ provider_spending: spending(changed) })); clearConfigCache();
    await expect(loadConfig(f.project, { env: f.env })).rejects.toThrow();
  }
});

it('rejects duplicate scopes and secret references before resolution', async () => {
  expect(() => validateProviderSpendingLayers(undefined, spending(budget(), budget('scope', { budgetId: 'other' })))).toThrow();
  const f = await fixture(); await writeFile(f.projectPath, JSON.stringify({ provider_spending: spending(budget('$DECK:SCOPE')) }));
  let resolutions = 0;
  await expect(loadConfig(f.project, { env: f.env, secretResolver: async () => { resolutions++; return 'scope'; } })).rejects.toThrow();
  expect(resolutions).toBe(0);
});
