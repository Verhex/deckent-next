import { writeFile } from 'node:fs/promises';
import { PassThrough, Writable } from 'node:stream';
import { createElement, type ReactElement } from 'react';
import { render } from 'ink';
import { afterEach, describe, expect, it } from 'vitest';
import { WorklinePaletteProvider, resolveWorklinePalette } from '#surfaces/core/terminal-kit/index.js';
import { RenderGlyphsContext, cells, resolveRenderGlyphs } from '#surfaces/core/terminal-render/index.js';
import { WindowStackProvider } from '#surfaces/core/terminal-window/index.js';
import { ConfigRecordWindow, SettingsPanel, type ConfigPanelPort } from '#surfaces/core/terminal-panels/index.js';
import { terminalPanelLabels } from '#surfaces/core/work-labels/index.js';
import type { ConfigRecordPort } from '#surfaces/core/config/index.js';
class Screen extends Writable {
  frame = ''; readonly isTTY = true;
  constructor(readonly columns: number, readonly rows: number) { super(); }
  override _write(chunk: Buffer, _encoding: string, done: () => void) { this.frame = chunk.toString(); done(); }
}
const mounted: Array<{ unmount(): void }> = [];
afterEach(() => { for (const instance of mounted.splice(0)) instance.unmount(); });
const pause = () => new Promise(resolve => setTimeout(resolve, 50));
function mount(node: ReactElement, width = 100) {
  const stdout = new Screen(width, 40), stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() { return stdin; }, ref() { return stdin; }, unref() { return stdin; } });
  const tree = createElement(WorklinePaletteProvider, { palette: resolveWorklinePalette('none'), children: createElement(RenderGlyphsContext.Provider, { value: resolveRenderGlyphs(true) }, createElement(WindowStackProvider, null, node)) });
  mounted.push(render(tree, { stdout: stdout as unknown as NodeJS.WriteStream, stdin: stdin as unknown as NodeJS.ReadStream, debug: true, exitOnCtrlC: false, patchConsole: false }));
  return { frame: () => stdout.frame, press: async (...keys: string[]) => { for (const key of keys) { stdin.write(key); await pause(); } } };
}
const ENTER = '\r', DOWN = '\u001B[B', ESC = '\u001B';
function port(key: string, calls: string[]): ConfigRecordPort {
  const field = key === 'provider_spending.budgets' ? { id: 'usd', label: 'Budget (USD)', choices: [{ id: '25', label: '25 USD', value: 25 }], stepper: { min: 1, max: 1000, step: 1, current: 5, unit: 'count' as const } }
    : key === 'inspection.workers.sources' ? { id: 'scopeId', label: 'Scope', choices: [{ id: 'scope', label: 'My company', value: 'scope' }] }
    : { id: 'branch', label: 'Git branch', choices: [{ id: 'main', label: 'Main', value: 'refs/heads/main' }] };
  return { open: async () => ({ key, layer: 'project', digest: null, members: [{ id: '0', label: 'Existing member', detail: 'Current settings' }] }),
    draft: async (_member, values) => ({ fields: [field], values: values ?? {} }), preview: async (_member, value) => { calls.push('preview'); return { token: 'token', before: '["old"]', after: JSON.stringify(value) }; },
    browse: async () => [{ path: '/tmp/import.json', label: 'import.json', kind: 'file' }], importFile: async () => { calls.push('import'); return { token: 'token', before: '[]', after: '["selected catalog"]' }; },
    commit: async () => { calls.push('commit'); return { status: 'applied', approvalId: null, lines: ['saved'] }; } };
}
describe('record window Ink render and keyboard boundary', () => {
  for (const key of ['provider_spending.budgets', 'inspection.workers.sources', 'execution.adoption.targets', 'execution.workTargets.targets', 'layout.resources']) {
    it(`${key}: selection opens a before/after preview; typing creates no value or write; Enter commits once`, async () => {
      const calls: string[] = [], outcomes: unknown[] = [], errors: unknown[] = [];
      const view = mount(createElement(ConfigRecordWindow, { port: port(key, calls), keyPath: key, title: 'Selected records', layer: 'project', labels: terminalPanelLabels('en'), onResult: outcome => { outcomes.push(outcome); }, onError: error => { errors.push(error); }, onClose: () => undefined }), 40);
      await pause(); expect(view.frame()).toContain('Add a member'); for (const line of view.frame().split('\n')) expect(cells(line)).toBeLessThanOrEqual(40);
      await view.press(ENTER); expect(view.frame()).toContain('Select a value'); expect(view.frame()).not.toContain('New value');
      await view.press(ENTER, 'nonsense'); expect(calls).toEqual([]); await view.press(ESC, ENTER); // clear filter, choose current item
      await view.press(DOWN, ENTER); expect(calls).toEqual(['preview']); expect(view.frame()).toContain('Before'); expect(view.frame()).toContain('After'); expect(view.frame()).toContain('Enter confirms');
      if (process.env['W2_RENDER_DIR']) await writeFile(`${process.env['W2_RENDER_DIR']}/${key}.txt`, view.frame());
      await view.press('123'); expect(calls).toEqual(['preview']); await view.press(ENTER); expect(calls).toEqual(['preview', 'commit']); expect(outcomes).toHaveLength(1); expect(errors).toEqual([]);
    });
  }
  it('Esc closes without any write; imports offer file selection and preview only', async () => {
    const calls: string[] = []; let closed = 0;
    const view = mount(createElement(ConfigRecordWindow, { port: port('operations.targets', calls), keyPath: 'operations.targets', title: 'Operation targets', layer: 'project', labels: terminalPanelLabels('tr'), onResult: () => undefined, onError: () => undefined, onClose: () => { closed++; } }));
    await pause(); expect(view.frame()).toContain('dosyayı içe aktar'); expect(view.frame()).not.toContain('Kayıt ekle');
    await view.press(ENTER, ENTER); expect(calls).toEqual(['import']); expect(view.frame()).toContain('Önce'); expect(view.frame()).toContain('Sonra');
    await view.press(ESC, ESC); expect(closed).toBe(1); expect(calls).not.toContain('commit');
  });
  it('/config integrates the record editor and pending approval leaves one system summary', async () => {
    const calls: string[] = [], notices: unknown[] = [], approvals: string[] = [];
    const records = port('execution.adoption.targets', calls); records.commit = async () => ({ status: 'approval-pending', lines: ['Nothing written'], approvalId: 'approval-1' });
    const config: ConfigPanelPort = { records, parse: () => ({ ok: false, reason: 'selection only' }), write: async () => { throw new Error('scalar writer used'); },
      inspect: async () => ({ title: 'Configuration', notes: [], fields: [{ key: 'execution.adoption.targets', section: 'execution', description: 'Adoption targets', value: '[]', source: 'project', apply: 'restart', expected: 'array', choices: [], records: true, free: false, unsettable: false, sensitive: false,
        locks: { project: { blocked: null, note: null }, global: { blocked: 'denied', note: null } } }] }) };
    const view = mount(createElement(SettingsPanel, { kind: 'config', ports: { config }, labels: terminalPanelLabels('en'), push: next => { notices.push(...next); }, onError: () => undefined, errorText: String, onClose: () => undefined, openApproval: id => { approvals.push(id); } }));
    await pause(); await view.press(ENTER, ENTER, ENTER, ENTER); expect(view.frame()).toContain('Add a member');
    await view.press(ENTER, ENTER, ENTER, DOWN, ENTER, ENTER); expect(approvals).toEqual(['approval-1']); expect(notices).toEqual([{ level: 'warning', text: 'Config: Nothing written' }]);
  });
});
