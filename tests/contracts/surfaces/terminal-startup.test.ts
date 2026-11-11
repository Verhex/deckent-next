import { openingGate } from '#surfaces/core/terminal-kit/index.js';
import { stripVTControlCharacters } from 'node:util';
import { describe, expect, it } from 'vitest';
import { CLEAR_VISIBLE_SCREEN, clearVisibleScreen, resolveWorklinePalette, startupFrame, STARTUP_BANNERS, TERMINAL_THEME_SETTINGS, writeStartup, type WorklineStartup } from '#surfaces/core/terminal/index.js';
import { terminalStartupLabels } from '#surfaces/core/terminal-labels/index.js';
import { terminalConfigSchema, TERMINAL_BANNERS, TERMINAL_THEMES } from '#adapters/index.js';
import { terminalScreen } from '../../fixtures/terminal-screen.js';

// T2 T-STARTUP (owner 2026-10-07): the rich surface clears the visible screen (never the scrollback) and starts with its banner at the top.
const facts = { version: '1.0.0-alpha.9', project: 'deckent-next', path: '~/deckent-next', model: 'local-openai/chat@1' };
const startup = (locale: 'en' | 'tr', options: Partial<WorklineStartup> = {}, ascii = false): WorklineStartup =>
  ({ clear: true, banner: 'full', ...terminalStartupLabels(locale, facts, ascii), ...options });
const plain = resolveWorklinePalette('none');

describe('opening frame (T2 T-STARTUP)', () => {
  it('scrolls the visible rows into the scrollback, homes and clears the screen, and never sends ED 3', () => {
    expect(clearVisibleScreen(5)).toBe(`\n\n\n\n\n${CLEAR_VISIBLE_SCREEN}`);
    expect(CLEAR_VISIBLE_SCREEN).toBe('\u001b[H\u001b[2J');
    for (const banner of ['full', 'compact', 'off'] as const) for (const locale of ['en', 'tr'] as const) {
      const frame = startupFrame(startup(locale, { banner }), resolveWorklinePalette('truecolor'), 100, 30);
      expect(frame).not.toContain('\u001b[3J');
      expect(frame.startsWith(`${'\n'.repeat(30)}${CLEAR_VISIBLE_SCREEN}`)).toBe(true);
    }
    // Earlier output survives in the replayed scrollback; the banner is the first row of the cleared screen.
    const before = 'old line 1\r\nold line 2\r\n';
    const frame = startupFrame(startup('en'), plain, 100, 10).replace(/\n/gu, '\r\n');
    const screen = terminalScreen(before + frame, 100, 10);
    expect(screen).toContain('old line 1');
    expect(screen.slice(screen.indexOf('⣀⣠⣀⡀'))).toContain('deckent 1.0.0-alpha.9');
    expect(screen.indexOf('old line 2')).toBeLessThan(screen.indexOf('⣀⣠⣀⡀'));
  });

  it('prints the mark beside version, project, model and the hint without stale mode — EN, TR, NO_COLOR and ASCII', () => {
    const en = stripVTControlCharacters(startupFrame(startup('en', { clear: false }), plain, 100, 30));
    expect(en.split('\n').slice(0, 5).map(line => line.trimEnd())).toEqual([
      '          ⣀⣠⣀⡀',
      '         ⢸⣟⡉⢻⣿⡄  deckent 1.0.0-alpha.9',
      '        ⢀⣠⣽⣶⣟⡿⠁  Project deckent-next · ~/deckent-next',
      '⣀⣀⣀⣠⣤⣴⣶⣟⣿⡷⠟⠉⠁    Model: local-openai/chat@1',
      '⣿⣿⣿⣽⡿⠾⠛⠋⠁        /help · Shift+Tab mode · ? shortcuts',
    ]);
    const tr = stripVTControlCharacters(startupFrame(startup('tr', { clear: false }), plain, 100, 30));
    expect(tr).toContain('Proje deckent-next · ~/deckent-next');
    expect(tr).toContain('Model: local-openai/chat@1');
    expect(tr).toContain('/help · Shift+Tab mod · ? kısayollar');
    expect(en).not.toContain('standard'); expect(tr).not.toContain('standart');
    // NO_COLOR: the `none` palette leaves no escape at all in the banner.
    expect(startupFrame(startup('tr', { clear: false }), plain, 100, 30)).not.toContain('\u001b');
    const ascii = stripVTControlCharacters(startupFrame(startup('en', { clear: false }, true), plain, 100, 30));
    expect(ascii.split('\n').slice(0, 4).map(line => line.slice(0, 9).trimEnd())).toEqual(['      .-.', "   .o-'o|", " .o'  `-'", "-'"]);
    expect(/[^ -~]/u.test(ascii.split('\n').slice(0, 4).map(line => line.slice(0, 9)).join(''))).toBe(false);
    for (const columns of [80, 120]) for (const locale of ['en', 'tr'] as const) for (const ascii of [false, true]) {
      const labels = startup(locale, { clear: false }, ascii), rendered = stripVTControlCharacters(startupFrame(labels, plain, columns, 30));
      const rows = rendered.trimEnd().split('\n');
      expect(rows).toHaveLength(ascii ? 4 : 5);
      expect(rows[ascii ? 0 : 1]).toContain('deckent 1.0.0-alpha.9');
      for (const row of rows) expect(row.length).toBeLessThanOrEqual(columns);
      for (const line of labels.lines) expect(rendered).toContain(line);
      expect(labels.logo.join('')).toMatch(ascii ? /^[ -~]+$/u : /^[ \u2801-\u28ff]+$/u);
    }
  });

  it('is one line below 60 columns or when compact, nothing but the clear when off, and nothing at all to a pipe or redirect', () => {
    const narrow = stripVTControlCharacters(startupFrame(startup('en', { clear: false }), plain, 59, 30));
    // One row, cut at the window width so the facts that matter (version and project) stay first.
    expect(narrow.trimEnd().split('\n')).toEqual(['deckent 1.0.0-alpha.9 · deckent-next · /help · ? shortcuts']);
    expect(stripVTControlCharacters(startupFrame(startup('tr', { clear: false, banner: 'compact' }), plain, 120, 30)).trimEnd())
      .toBe('deckent 1.0.0-alpha.9 · deckent-next · /help · ? kısayollar');
    expect(startupFrame(startup('en', { banner: 'off' }), plain, 100, 3)).toBe(`\n\n\n${CLEAR_VISIBLE_SCREEN}`);
    expect(startupFrame(startup('en', { banner: 'off', clear: false }), plain, 100, 3)).toBe('');
    // A pipe or redirect gets nothing at all (no clear sequence, no banner).
    const written: string[] = [];
    const sink = (isTTY: boolean) => ({ isTTY, columns: 100, rows: 30, write: (chunk: string) => { written.push(chunk); return true; } });
    writeStartup(sink(false) as never, startup('en'), plain);
    expect(written).toEqual([]);
    writeStartup(sink(true) as never, startup('en'), plain);
    expect(written).toHaveLength(1);
    expect(written[0]).toContain(CLEAR_VISIBLE_SCREEN);
  });

  it('registers theme, banner and clearOnStart in the terminal section with the workline\'s own vocabulary', () => {
    expect([...TERMINAL_THEMES]).toEqual([...TERMINAL_THEME_SETTINGS]);
    expect([...TERMINAL_BANNERS]).toEqual([...STARTUP_BANNERS]);
    for (const theme of TERMINAL_THEME_SETTINGS) expect(terminalConfigSchema.parse({ theme }).theme).toBe(theme);
    expect(terminalConfigSchema.parse({})).toMatchObject({ theme: 'auto', banner: 'full', clearOnStart: true });
    expect(terminalConfigSchema.safeParse({ banner: 'loud' }).success).toBe(false);
    expect(terminalConfigSchema.safeParse({ theme: 'solarized' }).success).toBe(false);
  });
});


it('local windows bypass pending startup; a real turn still waits and can be cancelled', async () => {
  let release: (() => void) | undefined;
  const gate = openingGate(new Promise<void>(resolve => { release = resolve; }));
  const abort = new AbortController(); let waiting = 0;
  for (const line of ['/model', '/provider', '/help', '/tasks', '/exit', '/quit']) {
    expect(await gate(line, abort.signal, () => waiting++)).toBe(true);
  }
  expect(waiting).toBe(0);
  let proceeded = false;
  const send = gate('hello', abort.signal, () => waiting++).then(result => { proceeded = result; });
  await Promise.resolve(); expect(proceeded).toBe(false); expect(waiting).toBe(1);
  abort.abort(); await send; expect(proceeded).toBe(false);
  release!();
  expect(await gate('hello', new AbortController().signal, () => waiting++)).toBe(true);
});
