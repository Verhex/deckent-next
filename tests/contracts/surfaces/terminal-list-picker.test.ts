import { PassThrough, Writable } from 'node:stream';
import { createElement, useState, type ReactElement } from 'react';
import { Box, Text, render, useInput } from 'ink';
import { afterEach, describe, expect, it } from 'vitest';
import { WorklinePaletteProvider, resolveWorklinePalette } from '#surfaces/core/terminal-kit/index.js';
import { RenderGlyphsContext, cells, resolveRenderGlyphs } from '#surfaces/core/terminal-render/index.js';
import { WindowStackProvider, useFocusOwner } from '#surfaces/core/terminal-window/index.js';
import { ListPicker, type PickerResult, type PickerTree } from '#surfaces/core/terminal-picker/index.js';
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
