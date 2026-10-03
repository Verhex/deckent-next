import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createDefaultConfig, validateConfig, loadConfig, getConfigValue } from '#platform/core/config/index.js';
import { createConfiguredConfigApplication } from '#composition/core/config/index.js';
import { planConfigChange, validateConfigLayers } from '#engine/core/config/index.js';

describe('bounded concurrent Run configuration (schema 4 additive)', () => {
  it('defaults to the registry execution cap and derives from an authored effective service cap', () => {
    const defaults = createDefaultConfig();
    expect(getConfigValue(defaults, 'runRuntime.maxConcurrentRuns')).toBe(defaults.service.maxConcurrentExecutions);
    const config = validateConfig({ service: { maxConcurrentExecutions: 2 } }).config;
    expect(getConfigValue(config, 'runRuntime.maxConcurrentRuns')).toBe(2);
    expect(getConfigValue(validateConfig({ service: { maxConcurrentExecutions: 2 }, runRuntime: { maxConcurrentRuns: 3 } }).config,
      'runRuntime.maxConcurrentRuns')).toBe(3);
  });
  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, null, '2'])('refuses invalid bound %j', maxConcurrentRuns => {
    expect(() => validateConfig({ runRuntime: { maxConcurrentRuns } })).toThrow();
  });
  it('config set/unset derives the service default while preserving explicit Run bound precedence', () => {
    const snapshot = { document: {}, project: {}, global: { service: { maxConcurrentExecutions: 2 } }, effective: createDefaultConfig(),
      layer: 'project' as const, digest: null, env: {} };
    const bound = planConfigChange({}, 'runRuntime.maxConcurrentRuns', 3, false);
    expect(getConfigValue(validateConfigLayers(snapshot, bound).config, 'runRuntime.maxConcurrentRuns')).toBe(3);
    const changedService = planConfigChange(bound, 'service.maxConcurrentExecutions', 4, false);
    expect(getConfigValue(validateConfigLayers(snapshot, changedService).config, 'runRuntime.maxConcurrentRuns')).toBe(3);
    const unbound = planConfigChange(changedService, 'runRuntime.maxConcurrentRuns', undefined, true);
    expect(getConfigValue(validateConfigLayers(snapshot, unbound).config, 'runRuntime.maxConcurrentRuns')).toBe(4);
    const inherited = planConfigChange(unbound, 'service.maxConcurrentExecutions', undefined, true);
    expect(getConfigValue(validateConfigLayers(snapshot, inherited).config, 'runRuntime.maxConcurrentRuns')).toBe(2);
    expect(snapshot.global.service.maxConcurrentExecutions).toBe(2);
  });
  it('derives after global/project merge, keeps explicit global override and exposes inspect/explain en/tr', async () => {
    const root = await mkdtemp(join(tmpdir(), 'run-progression-config-'));
    try {
      const env = { DECKENT_GLOBAL_HOME: join(root, 'global') };
      await mkdir(join(root, '.deckent')); await mkdir(env.DECKENT_GLOBAL_HOME);
      const globalPath = join(env.DECKENT_GLOBAL_HOME, 'config.json'), projectPath = join(root, '.deckent/config.json');
      await writeFile(globalPath, JSON.stringify({ service: { maxConcurrentExecutions: 4 } }));
      const bytes = JSON.stringify({ schema_version: 4, service: { maxConcurrentExecutions: 2 }, runRuntime: { pageSize: 12 } });
      await writeFile(projectPath, bytes);
      expect(getConfigValue(await loadConfig(root, { env }), 'runRuntime.maxConcurrentRuns')).toBe(2);
      expect(await readFile(projectPath, 'utf8')).toBe(bytes);
      const app = createConfiguredConfigApplication(root, { env });
      expect((await app.inspect()).fields).toContainEqual(expect.objectContaining({ key: 'runRuntime.maxConcurrentRuns', value: 2 }));
      expect(await app.explain({ keyPath: 'runRuntime.maxConcurrentRuns' })).toMatchObject({
        value: 2, defaultValue: 8, source: 'default', binding: { state: 'bound', consumers: ['src/composition/core/run-progression'] }, apply: 'restart',
      });
      await writeFile(globalPath, JSON.stringify({ runRuntime: { maxConcurrentRuns: 3 } }));
      expect(getConfigValue(await loadConfig(root, { env }), 'runRuntime.maxConcurrentRuns')).toBe(3);
      const en = await app.explain({ keyPath: 'runRuntime.maxConcurrentRuns' });
      await writeFile(projectPath, JSON.stringify({ language: 'tr', service: { maxConcurrentExecutions: 2 } }));
      const tr = await app.explain({ keyPath: 'runRuntime.maxConcurrentRuns' });
      expect(en.description).toMatch(/concurrent Runs/i); expect(tr.description).toMatch(/eşzamanlı Run/);
      expect(await readFile(globalPath, 'utf8')).toBe(JSON.stringify({ runRuntime: { maxConcurrentRuns: 3 } }));
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
