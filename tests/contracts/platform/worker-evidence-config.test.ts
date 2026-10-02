import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { loadConfig, ConfigValidationError } from '#platform/index.js';
import { registerProviderConfig } from '#adapters/index.js';

registerProviderConfig();
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const minimum = 4194304 + 32768;
async function fixture(maxBytes: number) {
  const root = await mkdtemp(join(tmpdir(), 'deckent-evidence-config-')); roots.push(root);
  const project = join(root, 'project'); await mkdir(join(project, '.deckent'), { recursive: true });
  await writeFile(join(project, '.deckent', 'config.json'), JSON.stringify({ artifacts: { maxBytes } }));
  return { project, env: { HOME: join(root, 'home'), DECKENT_GLOBAL_HOME: join(root, 'global') } };
}
it('rejects an artifact ceiling below the registry event budget plus reserved host evidence at config load', async () => {
  for (const maxBytes of [1024, 1048576, minimum - 1]) {
    const f = await fixture(maxBytes);
    await expect(loadConfig(f.project, { env: f.env })).rejects.toBeInstanceOf(ConfigValidationError);
    await expect(loadConfig(f.project, { env: f.env })).rejects.toMatchObject({ code: 'CONFIG_VALIDATION', issues: [{ path: 'artifacts.maxBytes', reason: 'ARTIFACT_WORKER_EVENT_BUDGET' }] });
  }
});
it('admits the exact event-and-reserve bound and preserves it on config cache hits', async () => {
  const f = await fixture(minimum);
  expect((await loadConfig(f.project, { env: f.env })).artifacts.maxBytes).toBe(minimum);
  expect((await loadConfig(f.project, { env: f.env })).artifacts.maxBytes).toBe(minimum);
});
