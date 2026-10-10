import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { registerProviderConfig } from '#adapters/core/contract/index.js';
import { auditCheckpointPolicySchema } from '#engine/index.js';
import { clearConfigCache, loadConfig, resolveGlobalConfigPaths } from '#platform/index.js';
registerProviderConfig();
const roots: string[] = [];
afterEach(async () => { clearConfigCache(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'deckent-checkpoint-config-')); roots.push(root);
  const project = join(root, 'project'), home = join(root, 'home');
  const env = { HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, '.config') };
  const projectPath = join(project, '.deckent/config.json'), globalPath = resolveGlobalConfigPaths(env).platformPath;
  await Promise.all([mkdir(dirname(projectPath), { recursive: true }), mkdir(dirname(globalPath), { recursive: true })]);
  return { project, env, projectPath, globalPath };
}
it('loads registry defaults and a project-selected cadence through the actual config registry', async () => {
  const f = await fixture(); await writeFile(f.projectPath, '{}');
  expect((await loadConfig(f.project, { env: f.env })).audit_checkpoints).toBeUndefined();
  expect(auditCheckpointPolicySchema.parse({})).toMatchObject({ everyRecords: 1000, pageSize: 1000, maxRecords: 100000 });
  await writeFile(f.projectPath, JSON.stringify({ audit_checkpoints: { schemaVersion: 1, everyRecords: 3 } })); clearConfigCache();
  expect((await loadConfig(f.project, { env: f.env })).audit_checkpoints).toMatchObject({ everyRecords: 3, schemaVersion: 1 });
});
it('prevents a project weakening parent cadence or expanding verification work bounds', async () => {
  const f = await fixture(), parent = { schemaVersion: 1, everyRecords: 10, pageSize: 100, maxRecords: 10000 };
  await writeFile(f.globalPath, JSON.stringify({ audit_checkpoints: parent }));
  await writeFile(f.projectPath, JSON.stringify({ audit_checkpoints: { ...parent, everyRecords: 5 } }));
  expect((await loadConfig(f.project, { env: f.env })).audit_checkpoints).toMatchObject({ everyRecords: 5 });
  for (const key of ['everyRecords', 'pageSize', 'maxRecords'] as const) {
    await writeFile(f.projectPath, JSON.stringify({ audit_checkpoints: { ...parent, [key]: parent[key] + 1 } })); clearConfigCache();
    await expect(loadConfig(f.project, { env: f.env })).rejects.toThrow();
  }
});
it('rejects invalid and secret-derived cadence before resolving any secret', async () => {
  const f = await fixture(); let resolutions = 0;
  await writeFile(f.projectPath, JSON.stringify({ audit_checkpoints: { everyRecords: '$DECK:CADENCE' } }));
  await expect(loadConfig(f.project, { env: f.env, secretResolver: async () => { resolutions++; return '2'; } })).rejects.toThrow();
  expect(resolutions).toBe(0);
  for (const invalid of [{ everyRecords: 0 }, { everyRecords: 1.5 }, { everyRecords: 1001 }, { extra: true }, { schemaVersion: 2 }]) {
    expect(auditCheckpointPolicySchema.safeParse(invalid).success).toBe(false);
  }
});
