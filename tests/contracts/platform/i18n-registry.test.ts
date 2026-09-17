import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import { MESSAGE_REGISTRY, MESSAGE_KEYS, createMessageRegistry, resolveLocale, t, LOCALES,
  type Locale, type MessageKey, type MessageFamily } from '../../../src/platform/index.js';

const unit = new URL('../../../src/platform/core/i18n/', import.meta.url);
const params = (text: string) => [...new Set([...text.matchAll(/\{(\w+)\}/g)].map(m => m[1]))].sort();
describe('K2 catalog registry contract', () => {
  it('has ten bilingual families with matching key/placeholder sets, no empty values and no ANSI', async () => {
    const names = (await readdir(new URL('locales/en/', unit))).sort();
    expect(names).toHaveLength(10); expect((await readdir(new URL('locales/tr/', unit))).sort()).toEqual(names);
    const keys: string[] = [];
    for (const name of names) {
      const en = JSON.parse(await readFile(new URL(`locales/en/${name}`, unit), 'utf8')) as Record<string, string>;
      const tr = JSON.parse(await readFile(new URL(`locales/tr/${name}`, unit), 'utf8')) as Record<string, string>;
      expect(Object.keys(en).sort()).toEqual(Object.keys(tr).sort());
      for (const key of Object.keys(en)) {
        keys.push(key); expect(en[key]?.trim()).not.toBe(''); expect(tr[key]?.trim()).not.toBe('');
        expect(params(en[key]!)).toEqual(params(tr[key]!));
        expect(en[key] + tr[key]).not.toContain('\u001b');
      }
    }
    expect(keys.sort()).toEqual(MESSAGE_KEYS); expect(new Set(keys).size).toBe(keys.length);
  });
  it('allows identical text only for the reviewed catalog inventory and the existing machine version format', async () => {
    const allowed = new Set(JSON.parse(await readFile(new URL('internal/identical-messages.json', unit), 'utf8')) as string[]);
    allowed.add('cli.version');
    for (const key of MESSAGE_KEYS) if (MESSAGE_REGISTRY.catalogs.en[key] === MESSAGE_REGISTRY.catalogs.tr[key]) expect(allowed.has(key)).toBe(true);
    expect(() => createMessageRegistry([{ en: { new: 'unchanged' }, tr: { new: 'unchanged' } }])).toThrow('I18N_TRANSLATION_REQUIRED');
  });
  it('rejects duplicate family keys and asymmetric locales before exposing a registry', () => {
    const family = { en: { label: 'Label' }, tr: { label: 'Etiket' } };
    expect(() => createMessageRegistry([family, family])).toThrow('I18N_DUPLICATE');
    expect(() => createMessageRegistry([{ en: { label: 'Label' }, tr: {} }])).toThrow('I18N_KEY_PARITY');
  });
  it('rejects mismatched placeholders, empty messages and control sequences', () => {
    for (const family of [{ en: { label: '{name}' }, tr: { label: '{other}' } },
      { en: { label: '' }, tr: { label: 'Dolu' } }, { en: { label: '\u001b[31mColor' }, tr: { label: 'Renk' } }]) {
      expect(() => createMessageRegistry([family])).toThrow();
    }
  });
  it('deeply freezes registry authority and makes independent copies of supplied data/defaults', () => {
    const family: MessageFamily = { en: { label: 'Label {name}' }, tr: { label: 'Etiket {name}' } };
    const defaults = { label: { name: 'initial' } }, registry = createMessageRegistry([family], defaults);
    defaults.label.name = 'mutated';
    expect(registry.defaultParams['label']?.['name']).toBe('initial');
    for (const value of [registry, registry.keys, registry.catalogs, registry.catalogs.en, registry.catalogs.tr, registry.defaultParams, registry.defaultParams['label']]) expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(MESSAGE_REGISTRY.catalogs.en)).toBe(true); expect(Object.isFrozen(LOCALES)).toBe(true);
  });
  it('preserves unknown keys without prototype lookup and unsupported locales fall back to English', () => {
    for (const key of ['not.a.key', '__proto__', 'constructor', 'toString']) expect(t(key as MessageKey, {}, 'en')).toBe(key);
    expect(t('cli.help', {}, 'de' as Locale)).toBe(t('cli.help', {}, 'en'));
    expect(t('cli.help', {}, 'tr')).not.toBe(t('cli.help', {}, 'en'));
  });
  it('preserves missing placeholders and substitutes literal values without regex replacement expansion', () => {
    expect(t('cli.help', {}, 'en')).toContain('{name}');
    expect(t('cli.help', { name: '$&{unknown}' }, 'en')).toContain('$&{unknown}');
    expect(t('cli.version', { name: 'x', version: 0, node: 'n', platform: 'p' }, 'en')).toContain('v0');
  });
  it('resolves explicit, both product envs, config, LC_ALL, LANG and normalized/fallback locales in order', () => {
    const all = { DECKENT_LANGUAGE: 'en', DECKENT_LANG: 'tr', LC_ALL: 'tr_TR.UTF-8', LANG: 'en_US' };
    expect(resolveLocale('tr', all, 'en')).toBe('tr');
    expect(resolveLocale(undefined, all, 'tr')).toBe('en');
    expect(resolveLocale(undefined, { ...all, DECKENT_LANGUAGE: '' }, 'en')).toBe('tr');
    expect(resolveLocale(undefined, { LC_ALL: 'tr', LANG: 'tr' }, 'en')).toBe('en');
    expect(resolveLocale(undefined, { LC_ALL: 'tr_TR.UTF-8', LANG: 'en' })).toBe('tr');
    expect(resolveLocale(undefined, { LANG: 'tr_TR.UTF-8' })).toBe('tr');
    expect(resolveLocale(undefined, { LANG: 'de_DE' })).toBe('en');
    expect(resolveLocale('xx', { DECKENT_LANG: 'tr' })).toBe('tr');
  });
  it('registers floor defaults from the package manifest without altering the source templates', async () => {
    const manifest = JSON.parse(await readFile(new URL('../../../package.json', import.meta.url), 'utf8')) as { engines: { node: string } };
    for (const key of ['error.node_version_low', 'desktop.error.node_not_found']) expect(MESSAGE_REGISTRY.defaultParams[key]).toEqual({ floor: manifest.engines.node });
  });
  it('contains no top-level await or Node imports in the renderer-facing translation unit', async () => {
    for (const name of await readdir(new URL('internal/', unit))) {
      if (!name.endsWith('.ts')) continue;
      const path = new URL(`internal/${name}`, unit), text = await readFile(path, 'utf8');
      const source = ts.createSourceFile(fileURLToPath(path), text, ts.ScriptTarget.Latest, true);
      function visit(node: ts.Node, depth = 0) {
        expect(!(ts.isAwaitExpression(node) && depth === 0)).toBe(true);
        if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) expect(node.moduleSpecifier.text.startsWith('node:')).toBe(false);
        ts.forEachChild(node, child => visit(child, depth + Number(ts.isFunctionLike(node))));
      }
      visit(source);
    }
  });
});
