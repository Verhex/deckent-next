import { describe, expect, it } from 'vitest';
import { resolveLocale, t } from '../../../src/platform/index.js';

describe('kernel/i18n contract', () => {
  it('interpolates named placeholders', () => {
    expect(t('cli.version', { name: 'x', version: '1', node: 'v24', platform: 'linux-x64' }, 'en')).toBe('x v1 | Node v24 | linux-x64');
  });
  it('leaves unknown placeholders visible instead of silently dropping them', () => {
    expect(t('cli.help', {}, 'en')).toContain('{name}');
  });
  it('resolves locale from explicit choice before environment', () => {
    expect(resolveLocale('tr', { LANG: 'en_US.UTF-8' })).toBe('tr');
    expect(resolveLocale(undefined, { DECKENT_LANG: 'tr' })).toBe('tr');
    expect(resolveLocale(undefined, { LANG: 'de_DE' })).toBe('en');
  });
  it('renders Turkish when asked', () => {
    expect(t('cli.unknownCommand', { command: 'x', name: 'deckent' }, 'tr')).toContain('Bilinmeyen komut');
  });
});
