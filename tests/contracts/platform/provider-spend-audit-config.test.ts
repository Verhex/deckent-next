import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { registerProviderConfig, validateProviderSpendAuditLayers } from '#adapters/core/contract/index.js';
import { clearConfigCache, loadConfig, resolveGlobalConfigPaths } from '#platform/index.js';

registerProviderConfig();
const roots: string[] = [];
afterEach(async () => { clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const limits = { schemaVersion: 1, pageSize: 100, maxReservations: 10_000, timeoutMs: 5000 };
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'deckent-audit-config-')); roots.push(root);
  const project = join(root, 'project'), home = join(root, 'home'), env = { HOME: home, XDG_CONFIG_HOME: join(home, '.config') };
  const projectPath = join(project, '.deckent/config.json'), globalPath = resolveGlobalConfigPaths(env).platformPath;
  await Promise.all([mkdir(dirname(projectPath), { recursive: true }), mkdir(dirname(globalPath), { recursive: true })]);
  return { project, env, projectPath, globalPath };
}

it('has no implicit audit workload and loads explicitly authored bounded limits', async () => {
  const f = await fixture(); await writeFile(f.projectPath, '{}');
  expect((await loadConfig(f.project, { env: f.env })).provider_spend_audit).toBeUndefined();
  await writeFile(f.projectPath, JSON.stringify({ provider_spend_audit: limits })); clearConfigCache();
  expect((await loadConfig(f.project, { env: f.env })).provider_spend_audit).toEqual(limits);
});

it('allows narrower child bounds and rejects expanding any parent work ceiling', async () => {
  const f = await fixture(); await writeFile(f.globalPath, JSON.stringify({ provider_spend_audit: limits }));
  const child = { ...limits, pageSize: 50, maxReservations: 500, timeoutMs: 1000 };
  await writeFile(f.projectPath, JSON.stringify({ provider_spend_audit: child }));
  expect((await loadConfig(f.project, { env: f.env })).provider_spend_audit).toEqual(child);
  for (const key of ['pageSize', 'maxReservations', 'timeoutMs'] as const) {
    await writeFile(f.projectPath, JSON.stringify({ provider_spend_audit: { ...limits, [key]: limits[key] + 1 } })); clearConfigCache();
    await expect(loadConfig(f.project, { env: f.env })).rejects.toThrow();
  }
});

it('rejects unbounded, unknown and secret-derived work limits', async () => {
  for (const invalid of [{ ...limits, timeoutMs: 0 }, { ...limits, maxReservations: Infinity },
    { ...limits, pageSize: 1001 }, { ...limits, extra: true }]) {
    expect(() => validateProviderSpendAuditLayers(undefined, invalid)).toThrow();
  }
  const f = await fixture(); let resolutions = 0;
  await writeFile(f.projectPath, JSON.stringify({ provider_spend_audit: { ...limits, timeoutMs: '$DECK:AUDIT_LIMIT' } }));
  await expect(loadConfig(f.project, { env: f.env, secretResolver: async () => { resolutions++; return '1000'; } })).rejects.toThrow();
  expect(resolutions).toBe(0);
});
