import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { loadConfig } from '#platform/index.js';
import { registerProviderConfig } from '#adapters/index.js';

it('the installed recovery fixture artifact budget is admitted by the effective provider config floor', async () => {
  registerProviderConfig();
  const source = await readFile(new URL('../composition/installed-runtime-recovery.test.ts', import.meta.url), 'utf8');
  const match = source.match(/config\.artifacts = \{ maxBytes: ([\d_]+) \}/);
  expect(match).not.toBeNull();
  const maxBytes = Number(match![1]!.replaceAll('_', ''));
  expect(maxBytes).toBeGreaterThanOrEqual(4_227_072);
  const root = await mkdtemp(join(tmpdir(), 'deckent-recovery-budget-'));
  try {
    const project = join(root, 'project'); await mkdir(join(project, '.deckent'), { recursive: true });
    await writeFile(join(project, '.deckent/config.json'), JSON.stringify({ artifacts: { maxBytes } }));
    const config = await loadConfig(project, { env: { HOME: join(root, 'home'), DECKENT_GLOBAL_HOME: join(root, 'global') } });
    expect(config.artifacts.maxBytes).toBe(maxBytes);
  } finally { await rm(root, { recursive: true, force: true }); }
});
