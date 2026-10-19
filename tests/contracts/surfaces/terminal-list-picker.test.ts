import { PassThrough, Writable } from 'node:stream';
import { createElement, useState, type ReactElement } from 'react';
import { Box, Text, render, useInput } from 'ink';
import { afterEach, describe, expect, it } from 'vitest';
import { WorklinePaletteProvider, resolveWorklinePalette } from '#surfaces/core/terminal-kit/index.js';
import { RenderGlyphsContext, cells, resolveRenderGlyphs } from '#surfaces/core/terminal-render/index.js';
import { WindowStackProvider, useFocusOwner } from '#surfaces/core/terminal-window/index.js';
import { ListPicker, PICKER_INITIAL, embeddedPickerLayout, pickerHints, pickerView, type PickerResult, type PickerTree } from '#surfaces/core/terminal-picker/index.js';
import { pickerWindowGeometry } from '#surfaces/core/terminal-panels/index.js';
import { pickerLabels } from '#surfaces/core/work-labels/index.js';

// Ink görünümü: dar terminal (40 sütun), NO_COLOR/ASCII, engelli satır, pencere yığınıyla odak devri.
class Screen extends Writable {
  frame = '';
  readonly isTTY = true;
  constructor(readonly columns: number, readonly rows: number) { super(); }
  override _write(chunk: Buffer, _encoding: string, done: () => void) { this.frame = chunk.toString('utf8'); done(); }
}
const settle = (ms = 30) => new Promise(resolve => setTimeout(resolve, ms));
const ESC = '\u001B', DOWN = '\u001B[B', PAGE_DOWN = '\u001B[6~', ENTER = '\r', TAB = '\t';
const mounted: Array<{ unmount(): void }> = [];
afterEach(() => { for (const instance of mounted.splice(0)) instance.unmount(); });

function mount(node: ReactElement, columns: number, rows = 30, ascii = false) {
  const stdout = new Screen(columns, rows);
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() { return stdin; }, ref() { return stdin; }, unref() { return stdin; } });
  const tree = createElement(WorklinePaletteProvider, { palette: resolveWorklinePalette('none'),
    children: createElement(RenderGlyphsContext.Provider, { value: resolveRenderGlyphs(ascii) }, createElement(WindowStackProvider, null, node)) });
  mounted.push(render(tree, { stdout: stdout as unknown as NodeJS.WriteStream, stdin: stdin as unknown as NodeJS.ReadStream, debug: true, exitOnCtrlC: false, patchConsole: false }));
  return { frame: () => stdout.frame, press: async (keys: string) => { stdin.write(keys); await settle(); } };
}

const TREE: PickerTree = {
  title: 'Settings',
  items: [
    { id: 'model', label: 'Model', children: [{ id: 'temp', label: 'Temperature setting with a rather long label' }] },
    { id: 'theme', label: 'Theme' },
    { id: 'locked', label: 'Locked item', blocked: { reason: 'managed by policy and cannot be changed here' } },
    ...Array.from({ length: 12 }, (_, i) => ({ id: `extra${i}`, label: `Extra ${i}` })),
  ],
  scopes: [{ id: 'project', label: 'Project' }, { id: 'user', label: 'User' }],
};
const el = (results: PickerResult[], extra: Record<string, unknown> = {}) =>
  createElement(ListPicker, { tree: TREE, labels: pickerLabels('en'), onResult: (r: PickerResult) => { results.push(r); }, ...extra });

describe('ListPicker view', () => {
  it('40 columns: every line fits, rows page, and the position line shows', async () => {
    const results: PickerResult[] = [];
    const view = mount(el(results), 40, 24);
    await settle(60);
    const lines = view.frame().split('\n');
    for (const line of lines) expect(cells(line)).toBeLessThanOrEqual(40);
    expect(view.frame()).toContain('Settings');
    expect(view.frame()).toMatch(/1-\d+ of 15/);
    await view.press(PAGE_DOWN);
    expect(view.frame()).toMatch(/\d+-\d+ of 15/);
  });
  it('NO_COLOR/ASCII: a blocked row is marked by words and x, not colour; its reason shows under the cursor and Enter does nothing', async () => {
    const results: PickerResult[] = [];
    const view = mount(el(results), 60, 30, true);
    await settle(60);
    await view.press(DOWN); await view.press(DOWN);
    expect(view.frame()).toContain('Locked item');
    expect(view.frame()).toContain('[blocked]');
    expect(view.frame()).toContain('managed by policy');
    expect(view.frame()).not.toMatch(/[⊘›]/u);
    await view.press(ENTER);
    expect(results).toEqual([]);
    expect(view.frame()).toContain('Locked item');
  });
  it('type to filter, Enter picks, Tab chooses the scope, and a typed result comes back once', async () => {
    const results: PickerResult[] = [];
    const view = mount(el(results), 80);
    await settle(60);
    for (const ch of 'the') await view.press(ch);
    expect(view.frame()).toContain('filter: the');
    expect(view.frame()).not.toContain('Model');
    await view.press(ENTER);
    expect(view.frame()).toContain('Project');
    await view.press(TAB);
    await view.press(ENTER);
    expect(results).toEqual([{ kind: 'selected', path: ['theme'], id: 'theme', scope: 'user' }]);
    await view.press(ENTER);
    expect(results).toHaveLength(1);
  });
  it('multi-level: Enter opens a section, Esc climbs, Esc at the root cancels', async () => {
    const results: PickerResult[] = [];
    const view = mount(el(results), 80);
    await settle(60);
    await view.press(ENTER);
    expect(view.frame()).toContain('Temperature');
    await view.press(ESC);
    expect(view.frame()).toContain('Theme');
    expect(results).toEqual([]);
    await view.press(ESC);
    expect(results).toEqual([{ kind: 'cancelled' }]);
  });
  it('windowed: the base layer hears nothing while a picker is open; stacked pickers answer top first; focus returns on close', async () => {
    const typed: string[] = [], results: string[] = [];
    function Base() { const owner = useFocusOwner(); useInput(input => { typed.push(input); }, { isActive: owner.idle }); return createElement(Text, null, owner.idle ? 'BASE-ACTIVE' : 'BASE-IDLE'); }
    function Screen2() {
      const [open, setOpen] = useState({ low: true, high: true });
      const one = (name: 'low' | 'high', title: string) => createElement(ListPicker, { key: name, windowed: true,
        tree: { title, items: [{ id: name, label: name }] }, labels: pickerLabels('en'),
        onResult: (r: PickerResult) => { results.push(`${name}:${r.kind}`); setOpen(state => ({ ...state, [name]: false })); } });
      return createElement(Box, { flexDirection: 'column' }, open.low ? one('low', 'LOW-PICKER') : null, open.high ? one('high', 'HIGH-PICKER') : null, createElement(Base));
    }
    const view = mount(createElement(Screen2), 80);
    await settle(80);
    expect(view.frame()).toContain('BASE-IDLE');
    await view.press('z');
    expect(typed).toEqual([]);
    expect(view.frame()).toContain('filter: z');
    await view.press(ESC);
    expect(results).toEqual([]);
    await view.press(ESC);
    expect(results).toEqual(['high:cancelled']);
    expect(view.frame()).not.toContain('HIGH-PICKER');
    await view.press(ESC);
    expect(results).toEqual(['high:cancelled', 'low:cancelled']);
    await view.press('z');
    expect(view.frame()).toContain('BASE-ACTIVE');
    expect(typed).toEqual(['z']);
  });
});

// TERM-PANEL (owner 2026-10-19): inside a window the list draws neither the title nor the key hints and keeps one height; on its own it is unchanged.
describe('embedded ListPicker (TERM-PANEL)', () => {
  const labels = pickerLabels('en');
  it('the hints that are true now: the list\'s (or the panel\'s more exact words), the open filter\'s, the scope step\'s', () => {
    expect(pickerHints(labels, PICKER_INITIAL)).toBe(labels.hintList);
    expect(pickerHints(labels, PICKER_INITIAL, 'PANEL')).toBe('PANEL');
    expect(pickerHints(labels, { ...PICKER_INITIAL, filter: 'x' }, 'PANEL')).toBe(labels.hintFilter);
    expect(pickerHints(labels, { ...PICKER_INITIAL, stage: 'scope' }, 'PANEL')).toBe(labels.hintScope);
  });
  it('a blocked row\'s reason keeps one row and borrows page rows down to the minimum; the rest ends in an ellipsis; the total never changes', () => {
    const view = (reason: string) => pickerView({ title: 'T', items: [{ id: 'a', label: 'A', blocked: { reason } }] }, PICKER_INITIAL);
    expect(embeddedPickerLayout(pickerView(TREE, PICKER_INITIAL), 6, 20, 'x', '~')).toEqual({ listRows: 6, reason: [] });
    expect(embeddedPickerLayout(view('short'), 6, 20, 'x', '~')).toEqual({ listRows: 6, reason: ['x short'] });
    const long = embeddedPickerLayout(view('one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen'), 6, 20, 'x', '~');
    expect(long.listRows + long.reason.length).toBe(7); expect(long.reason).toHaveLength(4); expect(long.reason.at(-1)!.endsWith('~')).toBe(true);
    for (const row of long.reason) expect(cells(row)).toBeLessThanOrEqual(20);
  });
  it('the window geometry: the same page and body room whatever the hints wrap to; the body room never exceeds what the body keeps', () => {
    const one = pickerWindowGeometry({ terminalRows: 40, reserved: 8, bodyRows: 4, hintRows: 1, minimumBody: 1 });
    expect(one).toEqual({ pageSize: 6, footerRows: 24, body: 4 });
    expect(pickerWindowGeometry({ terminalRows: 40, reserved: 8, bodyRows: 4, hintRows: 2, minimumBody: 1 })).toEqual({ ...one, body: 3 });
    expect(pickerWindowGeometry({ terminalRows: 20, reserved: 8, bodyRows: 4, hintRows: 1, minimumBody: 1 })).toEqual({ pageSize: 3, footerRows: 5, body: 3 });
  });
  it('embedded: no breadcrumb and no hint row; the same number of rows at the root, in a section, with a filter and on a blocked row', async () => {
    const heights: number[] = [];
    const view = mount(createElement(ListPicker, { tree: TREE, labels, onResult: () => undefined, embedded: true, maxRows: 6 }), 60);
    await settle();
    expect(view.frame()).not.toContain('Settings'); expect(view.frame()).not.toContain('Enter select');
    heights.push(view.frame().split('\n').length);
    for (const keys of [ENTER, ESC, 'e', '\u007f', `${DOWN}${DOWN}`]) { await view.press(keys); heights.push(view.frame().split('\n').length); }
    expect(view.frame()).toContain('managed by policy');
    expect(heights).toEqual(heights.map(() => 6 + 2));
  });
  it('on its own (not embedded) the list still draws its breadcrumb and its hints', async () => {
    const view = mount(createElement(ListPicker, { tree: TREE, labels, onResult: () => undefined }), 100);
    await settle();
    expect(view.frame()).toContain('Settings'); expect(view.frame()).toContain(labels.hintList);
  });
});

