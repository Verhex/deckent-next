import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { CONFIG_FIELDS } from '#platform/core/config-fields/index.js';
import { configSections, getConfigMetadata, versionedConfig, validateConfig, registerConfigSection, loadConfig, clearConfigCache } from '#platform/core/config/index.js';
import { registerProviderConfig } from '#adapters/core/contract/index.js';
registerProviderConfig();
const retired = ['mode', 'spawn_backend', 'auth_mode', 'providers', 'live_trace'];
describe('configuration binding and schema 4 migration', () => {
  it('every shipped field and registered section declares a real binding and apply mode', () => {
    for (const row of getConfigMetadata()) {
      expect(row).toMatchObject({ binding: { state: 'bound' }, apply: expect.stringMatching(/^(live|restart)$/) });
      expect((row as unknown as { binding: { consumers: string[] } }).binding.consumers.length).toBeGreaterThan(0);
    }
    for (const [, section] of configSections()) expect(section.options.metadata).toHaveProperty('binding');
    for (const key of retired) expect(Object.hasOwn(CONFIG_FIELDS, key)).toBe(false);
  });
  it('requires binding metadata at extension admission and refuses new declared-only sections', () => {
    const schema = z.object({ enabled: z.boolean().default(false) }).strict();
    expect(() => registerConfigSection('config_surface_missing_metadata', schema)).toThrow(expect.objectContaining({ code: 'CONFIG_SECTION_INVALID' }));
    expect(() => registerConfigSection('config_surface_unbound_metadata', schema, {
      metadata: { descriptionKey: 'config.section', tier: 'core', since: '1.0.0-alpha.2', apply: 'restart', binding: { state: 'declared-only', reason: 'no consumer' } },
    })).toThrow(expect.objectContaining({ code: 'CONFIG_SECTION_INVALID' }));
  });
  it('current-schema dead knobs receive a typed refusal, never disappear silently', () => {
    for (const key of retired) expect(() => validateConfig({ schema_version: 4, [key]: {} })).toThrow(expect.objectContaining({
      issues: expect.arrayContaining([{ path: key, reason: 'CONFIG_FIELD_RETIRED' }]),
    }));
  });
  it('version 3 migrates only removed fields, carries no values in visible warnings, and leaves input intact', () => {
    const old = { schema_version: 3, language: 'tr', mode: 'api', providers: { brain: 'SECRET_FIXTURE' }, live_trace: { enabled: true }, future: 'preserved' };
    const warnings: unknown[] = [];
    const next = versionedConfig(old, (warning: unknown) => warnings.push(warning));
    expect(next).toEqual({ schema_version: 4, language: 'tr', future: 'preserved' });
    expect(warnings).toHaveLength(3);
    expect(JSON.stringify(warnings)).not.toContain('SECRET_FIXTURE');
    expect(warnings).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'CONFIG_FIELD_RETIRED', path: 'providers' })]));
    expect(old.schema_version).toBe(3); expect(old).toHaveProperty('providers');
  });
  it('production layer loading exposes migration warnings, replays them from cache, and preserves authored bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'deckent-config-retired-'));
    try {
      const path = join(root, '.deckent', 'config.json');
      await mkdir(join(root, '.deckent'));
      const bytes = JSON.stringify({ schema_version: 3, mode: 'api', providers: { brain: 'SECRET_FIXTURE' }, projectName: 'kept' });
      await writeFile(path, bytes);
      const env = { HOME: join(root, 'home'), XDG_CONFIG_HOME: join(root, 'xdg') }, first: unknown[] = [], second: unknown[] = [];
      const config = await loadConfig(root, { env, onWarning: warning => first.push(warning) });
      await loadConfig(root, { env, onWarning: warning => second.push(warning) });
      expect(config.schema_version).toBe(4); expect(config.projectName).toBe('kept');
      expect(config).not.toHaveProperty('mode'); expect(config).not.toHaveProperty('providers');
      expect(first).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'CONFIG_FIELD_RETIRED', path: 'mode' }),
        expect.objectContaining({ code: 'CONFIG_FIELD_RETIRED', path: 'providers' })]));
      expect(second).toEqual(first); expect(JSON.stringify(first)).not.toContain('SECRET_FIXTURE');
      expect(await readFile(path, 'utf8')).toBe(bytes);
    } finally { clearConfigCache(); await rm(root, { recursive: true, force: true }); }
  });

});
