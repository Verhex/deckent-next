import { PassThrough, Writable } from 'node:stream';
import { createElement } from 'react';
import { render, renderToString } from 'ink';
import { describe, expect, it } from 'vitest';
import { CONFIG_FIELDS } from '#platform/index.js';
import { loadMonitorSurface } from '#surfaces/core/monitor/index.js';
import { configMonitorFieldKeys } from '#surfaces/core/monitor-view/index.js';
import { resolveWorklinePalette } from '#surfaces/core/terminal-kit/index.js';
import { cells } from '#surfaces/core/terminal-render/index.js';
import type { MonitorInstall, MonitorSnapshot } from '#engine/index.js';
import { emptySnapshot, fullSnapshot, OBSERVED_AT } from '../../fixtures/monitor/snapshots.js';

// PB-MON-UX (owner-accepted mock 2026-10-19): status-first Installs cards, Map tables, a Config tab of changed settings by section, framed
// tables with ✓ ! ○ ● markers on every tab, ASCII/NO_COLOR fallbacks and narrow widths; plus the two N1 defects and MON-SCOPE-NAMES.
const surface = await loadMonitorSurface();
const widest = (text: string) => Math.max(...text.split('\n').map(line => cells(line)));
// Frame glyphs and the monitor's own markers (sentences from other catalogs may still carry an arrow).
const BOX = /[─│┌┐└┘├┤┬┴┼✓○●⚠]/u;
const section = (text: string, from: string, to?: string) => { const start = text.indexOf(from); return text.slice(start, to ? text.indexOf(to, start + from.length) : undefined); };
const installsOf = (text: string, locale: 'en' | 'tr') => section(text, locale === 'en' ? '── Installs' : '── Kurulumlar', locale === 'en' ? '── Map' : '── Harita');
const n1Like: MonitorInstall = { ...fullSnapshot.installs[0]!, diagnostics: ['runs-truncated:259', 'info:image-current'],
  service: { ...fullSnapshot.installs[0]!.service!, build: { ...fullSnapshot.installs[0]!.service!.build!, builtAt: null } } };
const one = (install: MonitorInstall): MonitorSnapshot => ({ ...fullSnapshot, sourcesRead: [install.id], installs: [install] });

describe('Installs: status and next step first, developer details last', () => {
  for (const [locale, words] of [['en', { state: 'RUNNING', status: 'Status', warn: 'Warning', next: 'Next step', load: 'Workload', build: 'Build', ok: 'Service running',
    image: 'Worker image current', action: 'deckent inventory --scope' }], ['tr', { state: 'ÇALIŞIYOR', status: 'Durum', warn: 'Uyarı', next: 'Yapılacak', load: 'İş yükü',
    build: 'Sürüm', ok: 'Servis açık', image: 'İşçi imajı güncel', action: 'deckent inventory --scope' }]] as const) {
    it(`renders the card in order (${locale})`, () => {
      const text = installsOf(surface.renderMonitorText(one(n1Like), { locale, width: 120, ascii: false }), locale);
      expect(text).toContain(`● deckent-next (current)   ${words.state}   ! 1`);
      const at = (needle: string) => { const index = text.indexOf(needle); expect(index, needle).toBeGreaterThan(-1); return index; };
      expect(at(words.status)).toBeLessThan(at(`! ${words.warn}`));
      expect(at(`! ${words.warn}`)).toBeLessThan(at(`→ ${words.next}`));
      expect(at(`→ ${words.next}`)).toBeLessThan(at(words.load));
      expect(at(words.load)).toBeLessThan(at(words.build));
      expect(text).toContain(`✓ ${words.ok}`); expect(text).toContain(`✓ ${words.image}`); expect(text).toContain(words.action);
      expect(text).toMatch(/┌─+┬─+┐/u); expect(text).toMatch(/└─+┴─+┘/u);
    });
    it(`prints no empty parentheses and no missing build time (${locale})`, () => {
      const text = surface.renderMonitorText(one(n1Like), { locale, width: 160, ascii: false });
      expect(text).not.toMatch(/\(\s*\)/); expect(text).not.toMatch(/\(—\s*(derlendi|built)?\)/u); expect(text).not.toMatch(/— derlendi|built —/u);
      expect(text).toContain(locale === 'tr' ? 'derleme b0e66d92c0ff' : 'build b0e66d92c0ff');
      const dated = surface.renderMonitorText(fullSnapshot, { locale, width: 160, ascii: false });
      expect(dated).toContain(locale === 'tr' ? '2026-10-02' : 'built 2026-10-02');
    });
  }
  it('a hidden pool is a count on the card and the Pools tab, never a name (M-VIS stays hidden)', () => {
    const viewer: MonitorInstall = { ...n1Like, pools: [], hiddenPools: 2, runs: [] };
    for (const locale of ['en', 'tr'] as const) {
      const text = surface.renderMonitorText(one(viewer), { locale, width: 140, ascii: false });
      const count = locale === 'en' ? '2 pool(s) not shown to you' : '2 havuz size gösterilmiyor';
      const pools = section(text, locale === 'en' ? '── Pools' : '── Havuzlar', locale === 'en' ? '── Installs' : '── Kurulumlar');
      // The Pools tab has no table row at all (nothing to name), only the count; the Installs card carries the same count.
      expect(pools).not.toContain('│'); expect(pools).toContain(count); expect(installsOf(text, locale)).toContain(count);
    }
  });
  it('a note with a real next step carries it too (the ledger reports a cut Run list as a note)', () => {
    const text = installsOf(surface.renderMonitorText(one({ ...n1Like, diagnostics: ['info:runs-truncated:200'] }), { locale: 'tr', width: 120, ascii: false }), 'tr');
    expect(text.indexOf('○ Not')).toBeGreaterThan(-1); expect(text.indexOf('○ Not')).toBeLessThan(text.indexOf('→ Yapılacak'));
    expect(text).toContain('deckent inventory --scope <kapsam>');
  });
  it('a refused scope is a count, never a name (MON-SCOPE-NAMES)', () => {
    const viewer: MonitorInstall = { ...n1Like, diagnostics: ['scopes-denied:2'] };
    const en = surface.renderMonitorText(one(viewer), { locale: 'en', width: 140, ascii: false });
    expect(en).toContain('access to 2 scope(s) was refused (their names are not shown)');
    expect(surface.renderMonitorText(one(viewer), { locale: 'tr', width: 140, ascii: false })).toContain('2 kapsama erişim reddedildi');
  });
  it('a scope whose access check failed is a count with its reason, never a name — also from an older reader\'s named code (MON-SCOPE-NAMES, J2)', () => {
    const failed: MonitorInstall = { ...n1Like, diagnostics: ['scopes-unavailable:2:LEDGER_LOCKED', 'scopes-unavailable:1', 'scope-unavailable:scope-legacy-name:POLICY_UNAVAILABLE'] };
    for (const [locale, words] of [['en', ['2 scope(s) could not be read (LEDGER_LOCKED); their names are not shown', '1 scope(s) could not be read; their names are not shown',
      '1 scope(s) could not be read (POLICY_UNAVAILABLE); their names are not shown']], ['tr', ['2 kapsam okunamadı (LEDGER_LOCKED); adları gösterilmez',
      '1 kapsam okunamadı; adları gösterilmez', '1 kapsam okunamadı (POLICY_UNAVAILABLE); adları gösterilmez']]] as const) {
      const text = surface.renderMonitorText(one(failed), { locale, width: 160, ascii: false });
      for (const line of words) expect(text).toContain(line);
      expect(text).not.toContain('scope-legacy-name');
    }
  });
  it('a viewer holding the scope-diagnostics grant reads refused and failed scopes by name and reason; a failed decision is one nameless line (MON-NAMES)', () => {
    const named: MonitorInstall = { ...n1Like, diagnostics: ['scope-refused:POLICY_DENIED:scope-alpha', 'scope-failed:LEDGER_LOCKED:team:beta', 'scope-failed::scope-gamma',
      'scope-diagnostics-unavailable:POLICY_UNAVAILABLE'] };
    for (const [locale, words] of [['en', ['access to scope scope-alpha was refused (POLICY_DENIED)', 'scope team:beta could not be read (LEDGER_LOCKED)',
      'scope scope-gamma could not be read', 'Scope names could not be checked (POLICY_UNAVAILABLE); only counts are shown']],
    ['tr', ['scope-alpha kapsamına erişim reddedildi (POLICY_DENIED)', 'team:beta kapsamı okunamadı (LEDGER_LOCKED)', 'scope-gamma kapsamı okunamadı',
      'Kapsam adlarını görme izni denetlenemedi (POLICY_UNAVAILABLE); yalnız sayılar gösteriliyor']]] as const) {
      const text = surface.renderMonitorText(one(named), { locale, width: 160, ascii: false });
      for (const line of words) expect(text).toContain(line);
      expect(text).not.toContain('scope-gamma could not be read ()'); expect(text).not.toContain('scope-gamma kapsamı okunamadı ()');
    }
  });
});

describe('Map: tables, collapsed old profile versions, grouped permissions', () => {
  const map = fullSnapshot.installs[0]!.map!;
  const mapped: MonitorInstall = { ...fullSnapshot.installs[0]!, map: { ...map,
    registry: { profiles: [...map.registry.profiles, { id: 'coding-default', version: 1, adapter: 'docker' }, { id: 'coding-default', version: 2, adapter: 'docker' }], kinds: map.registry.kinds },
    policy: { ...map.policy!, byResourceKind: { run: 4, 'model-invocation': 2, 'mcp-server': 1, approval: 3, 'brand-new': 1 } } } };
  for (const [locale, words] of [['en', ['Layer', 'Task kind', 'Runner', '2 older profile version(s) unused', 'Execution', 'Models', 'Tools', 'Administration', 'Other']],
    ['tr', ['Katman', 'Görev türü', 'Çalıştırıcı', '2 eski profil sürümü kullanılmıyor', 'Çalıştırma', 'Modeller', 'Araçlar', 'Yönetim', 'Diğer']]] as const) {
    it(`renders tables (${locale})`, () => {
      const text = section(surface.renderMonitorText(one(mapped), { locale, width: 140, ascii: false }), locale === 'en' ? '── Map' : '── Harita');
      for (const word of words) expect(text).toContain(word);
      // Unused old versions are a count; an unused profile of another id is still named.
      expect(text).not.toContain('coding-default@1'); expect(text).not.toContain('coding-default@2'); expect(text).toContain('legacy-shell@1');
      // One next-step line for the three models sharing one reason, not three repeats.
      expect(text.split('/model').length - 1).toBe(1);
      expect(text).toMatch(/│ #\s*│/u);
    });
  }
});

describe('Config tab: changed settings by section, a shows all, unread flagged', () => {
  const field = (key: string, source: 'default' | 'global' | 'project' | 'env', bound = true) => ({ key, value: 1, defaultValue: 1, source, descriptionKey: `config.field.${key}`,
    description: `${key} description`, schema: {}, binding: bound ? { state: 'bound' as const, consumers: ['x'] } : { state: 'declared-only' as const, reason: 'fixture' },
    apply: 'restart' as const, redacted: false });
  const view = { schemaVersion: 1 as const, layer: 'project' as const, digest: null,
    fields: [field('projectName', 'project'), field('max_workers', 'global'), field('backup', 'default'), field('mcp', 'default', false), field('brand_new_field', 'env'),
      field('inspection.workers.maxEntries', 'project')] };
  const texts = (blocks: ReturnType<typeof surface.configMonitorBlocks>) => surface.flattenBlocks(blocks, 120, '…').map(entry => surface.lineText(entry.line)).join('\n');
  it('every declared config field has a section and a human name', () => {
    expect(configMonitorFieldKeys()).toEqual(expect.arrayContaining(Object.keys(CONFIG_FIELDS)));
  });
  for (const locale of ['en', 'tr'] as const) it(`changed only by default, all with a (${locale})`, () => {
    const changed = texts(surface.configMonitorBlocks(view, locale, { all: false, warn: '!' }));
    expect(changed).toContain(locale === 'en' ? 'Worker ceiling (max_workers)' : 'İşçi tavanı (max_workers)');
    // A section the view does not know is still headed (by its key) and sorts last; a nested key shows whole under its section's name.
    expect(changed).toMatch(/├─ brand_new_field ─/u); expect(changed.indexOf('├─ brand_new_field')).toBeGreaterThan(changed.indexOf('(max_workers)'));
    expect(changed).toMatch(locale === 'en' ? /├─ Inspection and monitor ─[^\n]*\n[^\n]*inspection\.workers\.maxEntries/u : /├─ İnceleme ve izleme ─[^\n]*\n[^\n]*inspection\.workers\.maxEntries/u);
    expect(changed).not.toContain('(backup)'); expect(changed).not.toContain('(mcp)');
    expect(changed).toMatch(locale === 'en' ? /├─ Worker ceiling ─/u : /├─ İşçi tavanı ─/u);
    expect(changed).toContain(locale === 'en' ? '1 setting(s) declared but read by no component' : '1 ayar tanımlı ama hiçbir bileşen okumuyor');
    const all = texts(surface.configMonitorBlocks(view, locale, { all: true, warn: '!' }));
    expect(all).toContain('(backup)'); expect(all).toContain(locale === 'en' ? '! not read' : '! okunmuyor');
  });
  it('a toggles all/changed and / searches in the fullscreen view', async () => {
    const stdout = Object.assign(new Writable({ write(chunk, _encoding, done) { const text = String(chunk); if (text.trim()) frame = text; done(); } }), { columns: 120, rows: 40, isTTY: true });
    let frame = '';
    const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() { return stdin; }, ref() { return stdin; }, unref() { return stdin; } });
    const instance = render(createElement(surface.MonitorApp, { load: async () => fullSnapshot, loadConfigView: async () => view, intervalMs: 60_000, locale: 'en', ascii: false,
      palette: resolveWorklinePalette('none'), errorText: () => 'x' }), { stdout: stdout as never, stdin: stdin as never, debug: true, exitOnCtrlC: false, patchConsole: false });
    const press = async (key: string) => { stdin.write(key); await new Promise(resolve => setTimeout(resolve, 40)); };
    try {
      for (let i = 0; i < 100 && !frame.includes('Stuck or waiting'); i++) await new Promise(resolve => setTimeout(resolve, 10));
      await press('8');
      expect(frame).toContain('(max_workers)'); expect(frame).not.toContain('(backup)'); expect(frame).toContain('a all/changed');
      await press('a'); expect(frame).toContain('(backup)'); expect(frame).toContain('Showing all 6 settings');
      await press('/'); await press('backup'); await press('\r');
      expect(frame).toContain('(backup)'); expect(frame).not.toContain('(max_workers)');
      await press('\u001b'); await press('a'); expect(frame).not.toContain('(backup)');
    } finally { instance.unmount(); }
  });
});

describe('shared rules: framed tables, ASCII, NO_COLOR, narrow widths', () => {
  it('ASCII uses + - | and no Unicode marker on any tab', () => {
    for (const locale of ['en', 'tr'] as const) {
      const text = surface.renderMonitorText(fullSnapshot, { locale, width: 120, ascii: true });
      expect(text).not.toMatch(BOX); expect(text).toMatch(/\+-+\+-+/); expect(text).toMatch(/\| /);
    }
  });
  it('NO_COLOR keeps every state readable by its marker (frame dump without any colour)', () => {
    const frame = renderToString(createElement(surface.MonitorApp, { load: async () => fullSnapshot, initial: fullSnapshot, intervalMs: 2000, locale: 'en', ascii: false,
      palette: resolveWorklinePalette('none'), errorText: () => 'x', size: { columns: 100, rows: 30 } }), { columns: 100 });
    expect(frame.includes('\u001b[')).toBe(false); expect(frame).toContain('● deckent-next (current)'); expect(frame).toContain('○ remote-lab'); expect(frame).toContain('! 1 warning(s)');
  });
  for (const width of [40, 60, 80]) it(`never wider than ${width} cells, frames intact`, () => {
    for (const locale of ['en', 'tr'] as const) for (const ascii of [false, true]) {
      const text = surface.renderMonitorText(fullSnapshot, { locale, width, ascii });
      expect(widest(text), `${locale} ${ascii}`).toBeLessThanOrEqual(width);
      // Every framed line closes on its own right border (no cut frame).
      for (const line of text.split('\n').filter(value => /^.{2}[│|]/u.test(value))) expect(line.trimEnd(), line).toMatch(/[│|]$/u);
    }
  });
  it('the empty install keeps its card and the hint for adding installs', () => {
    const text = surface.renderMonitorText(emptySnapshot, { locale: 'en', width: 100, ascii: false });
    expect(installsOf(text, 'en')).toContain('● fresh (current)'); expect(text).toContain('inspection.workers.sources');
    expect(OBSERVED_AT).toBeGreaterThan(0);
  });
});
