import { PassThrough, Writable } from 'node:stream';
import { createElement, type ReactElement } from 'react';
import { render } from 'ink';
import { afterEach, describe, expect, it } from 'vitest';
import { WorklinePaletteProvider, resolveWorklinePalette } from '#surfaces/core/terminal-kit/index.js';
import { RenderGlyphsContext, plainText, resolveRenderGlyphs } from '#surfaces/core/terminal-render/index.js';
import { InfoWindow, SystemSummaryLine, WindowStackProvider, INFO_GLYPHS_ASCII, infoModelText, infoWindowLines, shortenIdentity, systemSummaryText,
  type InfoWindowModel } from '#surfaces/core/terminal-window/index.js';

// SW-1 (owner 2026-10-08): the shared information window and the one system summary line a slash window leaves behind.
class Screen extends Writable {
  frame = '';
  readonly isTTY = true;
  constructor(readonly columns: number, readonly rows: number) { super(); }
  override _write(chunk: Buffer, _encoding: string, done: () => void) { this.frame = chunk.toString('utf8'); done(); }
}
const settle = (ms = 30) => new Promise(resolve => setTimeout(resolve, ms));
const ESC = '\u001B', DOWN = '\u001B[B', UP = '\u001B[A';
const mounted: Array<{ unmount(): void }> = [];
afterEach(() => { for (const instance of mounted.splice(0)) instance.unmount(); });
function mount(node: ReactElement, columns = 100, rows = 40, ascii = false) {
  const stdout = new Screen(columns, rows);
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() { return stdin; }, ref() { return stdin; }, unref() { return stdin; } });
  const tree = createElement(WorklinePaletteProvider, { palette: resolveWorklinePalette('none'),
    children: createElement(RenderGlyphsContext.Provider, { value: resolveRenderGlyphs(ascii) }, createElement(WindowStackProvider, null, node)) });
  const instance = render(tree, { stdout: stdout as unknown as NodeJS.WriteStream, stdin: stdin as unknown as NodeJS.ReadStream, debug: true, exitOnCtrlC: false, patchConsole: false });
  mounted.push(instance);
  return { frame: () => stdout.frame, press: async (keys: string) => { stdin.write(keys); await settle(); } };
}
const LABELS = { hints: 'CLOSE-HINTS', pickHints: 'PICK-HINTS', position: '{from}-{to}/{total}' };
const DIGEST = '3f9a2c71e4b8d0aa55c1e2f3a4b5c6d7e8f90123';
const MODEL: InfoWindowModel = { title: 'Status', chips: [{ state: 'ok', text: 'running' }, { state: 'info', text: 'alpha.13' }], summary: 'Status: running',
  sections: [
    { title: 'Deckent', rows: [{ key: 'State', value: 'running', chip: { state: 'ok', text: 'ok' } }, { key: 'Version', value: '1.0.0-alpha.13' }] },
    { title: 'Service', chip: { state: 'warn', text: 'stale' }, rows: [{ key: 'Instance', value: 'runtime service', id: DIGEST }, { key: 'Process', value: '4242' }] },
    { title: 'Checks', items: [{ text: 'pool ready', chip: { state: 'fail', text: 'failed' } }], table: { columns: ['Area', 'State'], rows: [['pools', 'ready']] }, notes: ['a muted note'] },
  ] };

describe('information window model (SW-1)', () => {
  it('lays out bold keys in one column, chips with a shape and a word, and identities muted and shortened after the human label', () => {
    const { lines } = infoWindowLines(MODEL);
    const instance = lines.find(line => line.label && plainText(line.label) === 'Instance')!;
    expect(instance.label![0]!.role).toBe('keyLabel');
    expect(plainText(instance.spans)).toBe(`runtime service ${shortenIdentity(DIGEST)}`);
    expect(instance.spans[0]!.text).toBe('runtime service');
    expect(instance.spans.find(part => part.text.startsWith('3f9a'))!.role).toBe('mutedId');
    const header = lines.find(line => plainText(line.spans).includes('Service'))!;
    expect(header.spans[0]!.role).toBe('sectionHeader');
    expect(plainText(header.spans)).toBe('▸ Service [! stale]');
    expect(header.spans.find(part => part.text === '[! stale]')!.role).toBe('chipWarn');
    expect(plainText(lines[0]!.spans)).toBe('[✓ running] [i alpha.13]');
    // A digest is never shown whole and never as the primary label of a row.
    expect(lines.some(line => plainText(line.spans).includes(DIGEST))).toBe(false);
    for (const line of lines) if (line.label) expect(plainText(line.label)).not.toMatch(/[0-9a-f]{12,}/u);
  });

  it('reads without colour: ASCII shapes plus words, aligned keys (proof render)', () => {
    const text = infoModelText(MODEL, INFO_GLYPHS_ASCII);
    expect(text).toEqual(['Status', '[+ running] [i alpha.13]', '', '> Deckent', 'State    running [+ ok]', 'Version  1.0.0-alpha.13', '', '> Service [! stale]',
      'Instance runtime service 3f9a2c71...', 'Process  4242', '', '> Checks', '  - pool ready [x failed]', 'Area   State', 'pools  ready', 'a muted note']);
    expect(shortenIdentity('abc123')).toBe('abc123');
  });
});

describe('InfoWindow (SW-1)', () => {
  it.each([[ESC, 'Esc'], ['\r', 'Enter'], ['q', 'q']])('closes on %#: %s', async (key) => {
    const closed: Array<string | null> = [];
    const view = mount(createElement(InfoWindow, { model: MODEL, labels: LABELS, onClose: choice => closed.push(choice) }));
    await settle();
    expect(view.frame()).toContain('Status'); expect(view.frame()).toContain('▸ Deckent'); expect(view.frame()).toContain('[✓ running]');
    expect(view.frame()).toContain('3f9a2c71…'); expect(view.frame()).not.toContain(DIGEST); expect(view.frame()).toContain('CLOSE-HINTS');
    await view.press(key);
    expect(closed).toEqual([null]);
  });

  it('picks with the arrow keys and Enter, keeps the highlighted row in view on a short terminal, and answers its id', async () => {
    const choices = Array.from({ length: 30 }, (_, index) => ({ id: `cmd-${index}`, label: `/command-${index}`, detail: `does ${index}` }));
    const model: InfoWindowModel = { title: 'Help', summary: '', sections: [{ title: 'Commands', choices }] };
    const closed: Array<string | null> = [];
    const view = mount(createElement(InfoWindow, { model, labels: LABELS, onClose: choice => closed.push(choice) }), 80, 24);
    await settle();
    expect(view.frame()).toContain('› /command-0'); expect(view.frame()).toContain('PICK-HINTS'); expect(view.frame()).not.toContain('/command-25');
    for (let index = 0; index < 25; index++) await view.press(DOWN);
    expect(view.frame()).toContain('› /command-25');
    await view.press(UP);
    expect(view.frame()).toContain('› /command-24');
    await view.press('\r');
    expect(closed).toEqual(['cmd-24']);
  });

  it('Esc and q close a window with choices without picking', async () => {
    const closed: Array<string | null> = [];
    const model: InfoWindowModel = { title: 'Usage', summary: '', sections: [{ choices: [{ id: 'b1', label: 'Budget b1' }] }] };
    const view = mount(createElement(InfoWindow, { model, labels: LABELS, onClose: choice => closed.push(choice) }));
    await settle(); await view.press('q');
    expect(closed).toEqual([null]);
  });

  it('draws ASCII shapes on a terminal that cannot be assumed to draw Unicode (TERM=dumb)', async () => {
    const view = mount(createElement(InfoWindow, { model: MODEL, labels: LABELS, onClose: () => undefined }), 100, 40, true);
    await settle();
    expect(view.frame()).toContain('> Deckent'); expect(view.frame()).toContain('[+ running]'); expect(view.frame()).toContain('[x failed]');
    expect(view.frame()).toContain('3f9a2c71...'); expect(view.frame()).not.toMatch(/[✓✗▸›…]/u);
  });
});

describe('SystemSummaryLine (SW-1)', () => {
  it('is one framed line with its own mark and label, never the assistant row', async () => {
    const view = mount(createElement(SystemSummaryLine, { text: 'Status: Deckent is running\n · alpha.13', label: 'Deckent system' }));
    await settle();
    const rows = view.frame().split('\n').filter(row => row.trim());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatch(/^┃ ◆ Deckent system · Status: Deckent is running · alpha\.13/u);
    expect(rows[0]).not.toContain('●');
    expect(systemSummaryText('  a \n b  ')).toBe('a b');
  });

  it('keeps the label and a mark under ASCII (NO_COLOR / TERM=dumb)', async () => {
    const view = mount(createElement(SystemSummaryLine, { text: 'Health: 3 ok', label: 'Deckent sistemi' }), 100, 40, true);
    await settle();
    expect(view.frame()).toMatch(/\| # Deckent sistemi \| Health: 3 ok/u);
  });
});
