import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { MESSAGE_KEYS, MESSAGE_REGISTRY, t, type MessageKey, type Locale } from '../../../src/platform/index.js';

interface UnchangedOracle { locales: Record<Locale, { groups: string[][]; count: number; sha256: string }> }
const fixtures = new URL('../../fixtures/i18n/', import.meta.url);
describe('K2 intentional reconciliation and unchanged-template evidence', () => {
  it('preserves all unaffected templates from the independently saved pre-reconciliation catalog', async () => {
    const oracle = JSON.parse(await readFile(new URL('unchanged-contract.json', fixtures), 'utf8')) as UnchangedOracle;
    for (const locale of ['en', 'tr'] as const) {
      const expected = oracle.locales[locale], keys = expected.groups.flat();
      expect(keys).toHaveLength(expected.count);
      const changes = JSON.parse(await readFile(new URL('cli-text-changes.json', fixtures), 'utf8')) as Record<Locale, Record<string, { before: string; after: string }>>;
      for (const [key, change] of Object.entries(changes[locale])) expect(MESSAGE_REGISTRY.catalogs[locale][key]).toBe(change.after);
      const actual = keys.map(key => [key, changes[locale][key]?.before ?? MESSAGE_REGISTRY.catalogs[locale][key]]);
      expect(createHash('sha256').update(JSON.stringify(actual)).digest('hex')).toBe(expected.sha256);
    }
  });
  it('uses canonical run keys without old-name lookup or obsolete compatibility commands', () => {
    for (const locale of ['en', 'tr'] as const) {
      for (const key of MESSAGE_KEYS) {
        expect(key + MESSAGE_REGISTRY.catalogs[locale][key]).not.toMatch(/sprint/i);
        expect(key).not.toMatch(/^(mode\.|config\.migrate|cli\.config\.migrate|plan\.adopt)/);
      }
      expect(t('cli.help', { name: 'deckent' }, locale)).not.toContain('config migrate');
      expect(t('run.notify_started_title', { runId: 'run-test' }, locale)).toContain('run-test');
      // Missing historical keys stay missing: this is not a compatibility alias registry.
      expect(t('sprint.notify_started_title' as MessageKey, { runId: 'run-test' }, locale)).toBe('sprint.notify_started_title');
      expect(MESSAGE_KEYS).not.toContain('run.alias_note');
      expect(MESSAGE_KEYS).not.toContain('cliContract.run.arg.alias_args');
    }
  });
  it('applies manifest floor defaults, explicit overrides and the newly defined switch-unavailable key', () => {
    for (const locale of ['en', 'tr'] as const) for (const key of ['error.node_version_low', 'desktop.error.node_not_found'] as const) {
      const template = MESSAGE_REGISTRY.catalogs[locale][key]!;
      expect(template).toContain('{floor}');
      expect(t(key, {}, locale)).toContain(MESSAGE_REGISTRY.defaultParams[key]!['floor']);
      expect(t(key, { floor: 'CUSTOM_FLOOR' }, locale)).toContain('CUSTOM_FLOOR');
    }
    expect(t('tui.switch_unavailable', { name: 'test-provider' }, 'en')).toContain('test-provider');
    expect(t('tui.switch_unavailable', { name: 'test-provider' }, 'tr')).toContain('geçilemiyor');
  });
});
