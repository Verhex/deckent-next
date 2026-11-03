import { PassThrough, Writable } from 'node:stream';
import { createElement, useState, type ReactElement } from 'react';
import { Box, render, Text, useInput } from 'ink';
import { afterEach, describe, expect, it } from 'vitest';
import { WorklinePaletteProvider, resolveWorklinePalette } from '#surfaces/core/terminal-kit/index.js';
import { HumanTextContext, RenderGlyphsContext, cells, resolveRenderGlyphs, span } from '#surfaces/core/terminal-render/index.js';
import { CardCopyContext, QuestionRows, cardCopyText, Window, WindowStackProvider, WINDOW_PRIORITY, layoutWindowLines, scrollBy, topWindowLayer, useFocusOwner, type WindowLine } from '#surfaces/core/terminal-window/index.js';

import { ArrowPicker, ListPicker } from '#surfaces/core/terminal-picker/index.js';
import { clipboardRequest } from '#surfaces/core/terminal-host/index.js';
import { pickerLabels } from '#surfaces/core/work-labels/index.js';
import { snapshotKnownSecrets } from '#platform/index.js';

class Screen extends Writable {
  frame = '';
  readonly isTTY = true;
  constructor(readonly columns: number, readonly rows: number) { super(); }
  override _write(chunk: Buffer, _encoding: string, done: () => void) { this.frame = chunk.toString('utf8'); done(); }
}
function keyboard() {
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() { return stdin; }, ref() { return stdin; }, unref() { return stdin; } });
  return stdin;
}
const settle = (ms = 30) => new Promise(resolve => setTimeout(resolve, ms));
const ESC = '\u001B', DOWN = '\u001B[B', PAGE_DOWN = '\u001B[6~', END = '\u001B[F', HOME = '\u001B[H';
const mounted: Array<{ unmount(): void }> = [];
afterEach(() => { for (const instance of mounted.splice(0)) instance.unmount(); });

function mount(node: ReactElement, columns = 100, rows = 40, ascii = false) {
  const stdout = new Screen(columns, rows), stdin = keyboard();
  const tree = createElement(WorklinePaletteProvider, { palette: resolveWorklinePalette('none'),
    children: createElement(RenderGlyphsContext.Provider, { value: resolveRenderGlyphs(ascii) }, createElement(WindowStackProvider, null, node)) });
  const instance = render(tree, { stdout: stdout as unknown as NodeJS.WriteStream, stdin: stdin as unknown as NodeJS.ReadStream, debug: true, exitOnCtrlC: false, patchConsole: false });
  mounted.push(instance);
  const press = async (keys: string) => { stdin.write(keys); await settle(); };
  return { stdout, press, frame: () => stdout.frame };
}

/** A stand-in composer: it types only while no window is open, exactly as the workline composer's `active` is wired. */
function Composer({ typed }: { readonly typed: string[] }) {
  const owner = useFocusOwner();
  useInput(input => { typed.push(input); }, { isActive: owner.idle });
  return createElement(Text, null, owner.idle ? 'COMPOSER-ACTIVE' : 'COMPOSER-IDLE');
}

function Stacked({ log, typed }: { readonly log: string[]; readonly typed: string[] }) {
  const [open, setOpen] = useState({ a: true, b: true });
  return createElement(Box, { flexDirection: 'column' },
    open.a ? createElement(Window, { title: [span('WINDOW-A')], hints: 'A-HINTS', position: '{from}-{to}/{total}', body: [{ spans: [span('a body')] }],
      onInput: (input: string) => { if (input === 'x') { log.push('a:x'); return true; } return false; }, onClose: () => { log.push('a:close'); setOpen(state => ({ ...state, a: false })); } }) : null,
    open.b ? createElement(Window, { title: [span('WINDOW-B')], hints: 'B-HINTS', position: '{from}-{to}/{total}', body: [{ spans: [span('b body')] }],
      onInput: (input: string) => { if (input === 'x') { log.push('b:x'); return true; } return false; }, onClose: () => { log.push('b:close'); setOpen(state => ({ ...state, b: false })); } }) : null,
    createElement(Composer, { typed }));
}

describe('terminal window stack', () => {
  it('two windows stack: Esc closes the top first, focus returns to the one below, then to the composer', async () => {
    const log: string[] = [], typed: string[] = [];
    const view = mount(createElement(Stacked, { log, typed }));
    await settle(60);
    expect(view.frame()).toContain('WINDOW-A');
    expect(view.frame()).toContain('WINDOW-B');
    expect(view.frame()).toContain('COMPOSER-IDLE');
    await view.press('x');
    expect(log).toEqual(['b:x']);
    await view.press(ESC);
    expect(log).toEqual(['b:x', 'b:close']);
    expect(view.frame()).not.toContain('WINDOW-B');
    await view.press('x');
    expect(log).toEqual(['b:x', 'b:close', 'a:x']);
    await view.press(ESC);
    expect(log.at(-1)).toBe('a:close');
    expect(view.frame()).toContain('COMPOSER-ACTIVE');
    // Nothing reached the composer while a window was open.
    expect(typed).toEqual([]);
    await view.press('z');
    expect(typed).toEqual(['z']);
  });

  it('an approval-priority window owns input even when opened below a newer ordinary window', () => {
    const layers = [{ id: 'approval', priority: WINDOW_PRIORITY.approval, sequence: 1 }, { id: 'monitor', priority: WINDOW_PRIORITY.window, sequence: 2 }];
    expect(topWindowLayer(layers)?.id).toBe('approval');
    expect(topWindowLayer([layers[1]!])?.id).toBe('monitor');
    expect(topWindowLayer([])).toBeNull();
  });
});

describe('terminal window frame', () => {
  const body: WindowLine[] = Array.from({ length: 30 }, (_, index) => ({ spans: [span(`row ${index + 1}`)] }));

  it('caps the body to the terminal rows and scrolls with arrows, page keys, Home and End', async () => {
    // 24 rows: 8 reserved for the rest of the live area, 4 frame rows → 12 body rows, one of them the position line.
    const view = mount(createElement(Window, { title: [span('SCROLL')], hints: 'HINTS', position: 'POS {from}-{to}/{total}', body }), 60, 24);
    await settle(60);
    expect(view.frame()).toContain('POS 1-11/30');
    expect(view.frame()).toContain('row 11');
    expect(view.frame()).not.toContain('row 12');
    await view.press(DOWN);
    expect(view.frame()).toContain('POS 2-12/30');
    await view.press(PAGE_DOWN);
    expect(view.frame()).toContain('POS 12-22/30');
    await view.press(END);
    expect(view.frame()).toContain('POS 20-30/30');
    expect(view.frame()).toContain('row 30');
    await view.press(DOWN);
    expect(view.frame()).toContain('POS 20-30/30');
    await view.press(HOME);
    expect(view.frame()).toContain('POS 1-11/30');
    expect(view.frame().split('\n').length).toBeLessThanOrEqual(24 - 8);
  });

  it('a 40-column terminal: every frame row fits, labels move to their own row, long values wrap', async () => {
    const lines: WindowLine[] = [{ label: [span('Command:')], spans: [span('npm test -- --run tests/contracts/surfaces/terminal-window.test.ts --reporter=verbose')] },
      { label: [span('Where:')], spans: [span('/home/user/projects/deckent-next')] }];
    const view = mount(createElement(Window, { title: [span('Approval needed · shell command with a long title')], status: [span('4:32')], hints: 'y once · n deny · Tab reason', position: '{from}-{to}/{total}', body: lines }), 40, 30);
    await settle(60);
    const rows = view.frame().split('\n').filter(row => row.length);
    for (const row of rows) expect(cells(row)).toBeLessThanOrEqual(40);
    expect(view.frame()).toContain('Command:');
    expect(view.frame()).toContain('4:32');
    expect(view.frame()).toContain('window.test.ts --reporter=verbose');
  });

  it('ASCII glyphs draw a classic frame', async () => {
    const view = mount(createElement(Window, { title: [span('ASCII')], hints: 'H', position: '', body: [{ spans: [span('x')] }] }), 40, 20, true);
    await settle(60);
    expect(view.frame()).toMatch(/^\+-+\+/mu);
    expect(view.frame()).not.toMatch(/[╭╮╰╯│]/u);
  });
});

describe('window layout and scroll model', () => {
  it('labelled rows share one value column on a wide terminal', () => {
    const rows = layoutWindowLines([{ label: [span('What:')], spans: [span('run a shell command')] }, { label: [span('Expires:')], spans: [span('4:32')] }], 80)
      .map(row => row.map(part => part.text).join(''));
    expect(rows).toEqual(['What:    run a shell command', 'Expires: 4:32']);
  });
  it('scroll never leaves the content', () => {
    expect(scrollBy(0, 'up', 30, 10)).toBe(0);
    expect(scrollBy(0, 'end', 30, 10)).toBe(20);
    expect(scrollBy(19, 'pageDown', 30, 10)).toBe(20);
    expect(scrollBy(0, 'down', 5, 10)).toBe(0);
  });
});


it('card copy follows visible option labels across question/list/arrow/custom footers, projects secrets, excludes entries and keeps the byte cap', async () => {
  const copies: string[] = [], known = 'option-canary-7db54', token = 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  const writer = { write: (text: string) => { copies.push(text); return { ok: true as const, bytes: Buffer.byteLength(text) }; }, maxBytes: 65_536,
    labels: { hint: 'COPY', sent: 'SENT {count}', tooLarge: 'BIG {bytes}/{max}', unavailable: 'UNAVAILABLE' } };
  function Card() {
    const [mode, setMode] = useState(0);
    return createElement(Window, { title: [span('CARD')], body: [{ spans: [span('BODY')] }], hints: 'HINTS', position: '',
      copyOptions: mode === 3 ? ['Custom visible choice'] : [],
      onInput: (_input, key) => { if (key.ctrl && _input === 'n') { setMode(value => value + 1); return true; } return false; },
      footer: () => createElement(Box, { flexDirection: 'column' }, createElement(Text, null, 'ENTRY-MUST-NOT-COPY ••••'),
        mode === 0 ? createElement(QuestionRows, { kind: 'single', options: [{ id: 'authority-id-not-a-label', label: `Question ${known} ${token}` }], state: { at: 0, ticked: [] }, focused: true })
          : mode === 1 ? createElement(ListPicker, { embedded: true, maxRows: 3, tree: { title: 'List', items: Array.from({ length: 8 }, (_, i) => ({ id: `id-${i}`, label: `List ${i}` })) }, labels: pickerLabels('en'), onResult: () => {} })
            : mode === 2 ? createElement(ArrowPicker, { rows: ['Arrow A', 'Arrow B'], filter: { prompt: text => `FILTER ${text}`, none: 'NONE' }, onSelect: () => {}, onCancel: () => {} })
              : createElement(Text, null, 'Custom visible choice')) });
  }
  const view = mount(createElement(HumanTextContext.Provider, { value: snapshotKnownSecrets([{ name: 'OPTION', value: known }]) },
    createElement(CardCopyContext.Provider, { value: writer }, createElement(Card))));
  await settle(60); await view.press('\u0019');
  expect(copies[0]).toContain('Question ‹secret:OPTION› [REDACTED]');
  expect(copies[0]).not.toContain(known); expect(copies[0]).not.toContain(token); expect(copies[0]).not.toContain('authority-id');
  await view.press('\u000e'); await view.press('\u0019');
  expect(copies[1]).toBe('CARD\nBODY\nList 0\nList 1\nList 2');
  await view.press('\u001b[F'); await view.press('\u0019');
  expect(copies[2]).toContain('List 7'); expect(copies[2]).not.toContain('List 0');
  await view.press('\u000e'); await view.press('B'); await view.press('\u0019');
  expect(copies[3]).toBe('CARD\nBODY\nArrow B');
  await view.press('\u000e'); await view.press('\u0019');
  expect(copies[4]).toBe('CARD\nBODY\nCustom visible choice');
  expect(copies.join('')).not.toMatch(/ENTRY-MUST-NOT-COPY|••••|id-\d/u);
  expect(view.frame()).toContain(`SENT ${[...copies[4]!].length}`);
  expect(clipboardRequest(cardCopyText([span('T')], [], ['€€€€']), {}, 10)).toEqual({ ok: false, reason: 'too-large', bytes: 14 });
});
