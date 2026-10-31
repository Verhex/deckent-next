import { afterEach, describe, expect, it } from 'vitest';
import type { PanelPorts } from '#surfaces/core/terminal-panels/index.js';
import { terminalPanelLabels } from '#surfaces/core/work-labels/index.js';
import { resolveWorklinePalette } from '#surfaces/core/terminal-kit/index.js';
import { mountWorkline, settle, until, WORKLINE_TEST_LABELS } from '../support/workline-harness.js';
import { SLASH_WINDOW_TEST_LABELS, TYPED_ARGUMENT_NOTE } from '../support/slash-window-labels.js';

// T3 L4 PANELS on the real interactive workline (in-memory TTY): a bare `/mode`, `/config` or `/mcp` opens its window (one input owner: the
// composer and Shift+Tab wait), typed config arguments remain in the picker, a held write opens approval in the same command, and
// full access shows one standing warning line above the composer.
const mounted: Array<{ unmount(): void }> = [];
afterEach(() => { for (const view of mounted.splice(0)) view.unmount(); });
const ESC = '\u001B', DOWN = '\u001B[B', ENTER = '\r', SHIFT_TAB = '\u001b[Z';
const MODE_LABELS = { current: 'MODE {mode}', changed: 'MODE {previous}->{mode}', inert: '', unsupported: 'NO-MODES', usage: 'MODE-USAGE',
  stops: { standart: 'std', 'ask-edits': 'careful', 'full-auto': 'auto', 'full-access': 'FULL' }, cycled: 'CYCLED {previous}->{mode}', cycledFullAccess: 'INTO-FULL {previous}->{mode}',
  fullAccessLine: 'FA-LINE commands run without asking' };
const labels = { ...WORKLINE_TEST_LABELS, mode: MODE_LABELS };
function modePort(fullAccess = true) {
  const calls: unknown[] = [];
  let current = { schemaVersion: 1 as const, scopeId: 'scope', supported: true, mode: 'standart' as 'standart' | 'full-auto' | 'full-access', askEdits: false, revision: 'r0', eligible: true,
    fullAccess, fullAuto: true };
  return { calls, port: { async inspect() { return current; },
    async set(mode: 'standart' | 'full-auto' | 'full-access', expectedRevision: string, askEdits?: boolean) {
      calls.push([mode, expectedRevision, askEdits]); const previous = current.mode;
      current = { ...current, mode, askEdits: askEdits ?? current.askEdits, revision: `r${calls.length}` };
      return { ...current, previous, changed: true };
    } } };
}
const frameOf = (view: ReturnType<typeof mountWorkline>) => view.stdout.frame;

describe('settings windows in the workline', () => {
  it('/mode opens the window: the composer and Shift+Tab wait while it is open; the chosen mode goes through the same service set', async () => {
    const { calls, port } = modePort(false);
    const view = mountWorkline({ labels, permissionMode: port, panels: { ports: {}, labels: terminalPanelLabels('en') } });
    mounted.push(view.instance);
    await settle(40);
    view.stdin.write(`/mode${ENTER}`);
    await until(() => frameOf(view).includes('Permission mode'), 'mode window');
    await settle(60);
    view.stdin.write(SHIFT_TAB); await settle(40);
    for (const key of 'zz') { view.stdin.write(key); await settle(20); }
    await settle(60);
    expect(calls).toEqual([]);
    expect(frameOf(view)).toContain('filter: zz'); // the keys went to the window's list, not the composer
    view.stdin.write(ESC); await settle(60); // clear the filter
    for (const key of [DOWN, DOWN]) { view.stdin.write(key); await settle(20); }
    view.stdin.write(ENTER);
    await until(() => calls.length === 1, 'mode set');
    expect(calls).toEqual([['full-auto', 'r0', false]]);
    await until(() => !frameOf(view).includes('Permission mode'), 'window closed');
    expect(view.stdout.text).toContain('CYCLED std->auto');
  });
  it('rich terminal (I-1): a typed /config argument opens the config window with the one-time note and never shows the typed text', async () => {
    const texts: string[] = [], modelInputs: unknown[] = [];
    const themes: string[] = [], writes: string[] = [];
    const ports: PanelPorts = { config: { inspect: async () => ({ title: 'CONFIG-WINDOW', notes: [], fields: [] }), parse: () => ({ ok: false, reason: '-' }),
      write: async () => { throw new Error('no write'); } }, theme: {
        title: 'THEME-WINDOW', inspect: async () => ({ current: 'auto', source: 'SOURCE-PROJECT-SHADOW', notes: [],
          choices: [{ id: 'auto', label: 'AUTO', detail: 'BACKGROUND #f0ece5' }, { id: 'light', label: 'LIGHT', detail: '' }] }),
        palette: setting => resolveWorklinePalette('truecolor', setting === 'light' ? 'light' : 'dark'), background: () => '#f0ece5',
        words: { hints: 'PREVIEW SAVE ESC', current: 'CURRENT', preview: 'SAMPLES', contrast: '{ratio}:1', inherited: 'UNMEASURED', noColor: 'NO-COLOR', sessionOnly: 'SESSION-ONLY',
          samples: [{ text: 'LINK-PREVIEW', role: 'link' }] }, apply: setting => themes.push(setting),
        write: async setting => { writes.push(setting); return { status: 'applied', lines: ['THEME-SAVED'], approvalId: null }; } } };
    const view = mountWorkline({ labels: { ...labels, windows: SLASH_WINDOW_TEST_LABELS }, panels: { ports, labels: terminalPanelLabels('en') },
      config: async args => { texts.push(args); return ['TEXT-CONFIG']; }, completeTurn: async messages => { modelInputs.push(messages); return 'MODEL-OUTPUT'; } });
    mounted.push(view.instance);
    await settle(40);
    view.stdin.write(`/config set max_workers 7${ENTER}`);
    await until(() => frameOf(view).includes('CONFIG-WINDOW') && frameOf(view).includes(TYPED_ARGUMENT_NOTE), 'config window with the note');
    expect(texts).toEqual([]); expect(modelInputs).toEqual([]); expect(frameOf(view)).not.toContain('max_workers 7');
    view.stdin.write(ESC);
    await until(() => !frameOf(view).includes('CONFIG-WINDOW'), 'closed');
    expect(frameOf(view)).not.toContain(TYPED_ARGUMENT_NOTE);
    // TH-A L4: /config's Theme row and /theme share the window. Preview/Esc never touch either writer; Enter applies exactly the chosen row.
    view.stdin.write(`/config${ENTER}`);
    await until(() => frameOf(view).includes('CONFIG-WINDOW'), 'config again');
    await settle(60); view.stdin.write(ENTER);
    await until(() => frameOf(view).includes('THEME-WINDOW') && frameOf(view).includes('LINK-PREVIEW'), 'theme from config');
    await settle(60); view.stdin.write(DOWN);
    await until(() => frameOf(view).includes('5.00:1'), 'light link contrast against owner background');
    expect(themes).toEqual([]); expect(writes).toEqual([]);
    view.stdin.write(ESC); await until(() => !frameOf(view).includes('THEME-WINDOW'), 'theme discarded');
    expect(themes).toEqual([]); expect(writes).toEqual([]);
    view.stdin.write(`/theme${ENTER}`);
    await until(() => frameOf(view).includes('SOURCE-PROJECT-SHADOW'), 'theme direct');
    await settle(60); view.stdin.write(DOWN); await settle(40); view.stdin.write(ENTER);
    await until(() => writes.length === 1, 'theme saved');
    expect(themes).toEqual(['light']); expect(writes).toEqual(['light']); expect(modelInputs).toEqual([]);
  });

  it('typed config arguments still open selection;  Esc at the window\'s first level closes it and the composer takes keys again', async () => {
    const texts: string[] = [], modelInputs: unknown[] = [];
    const ports: PanelPorts = { config: { inspect: async () => ({ title: 'CONFIG-WINDOW', notes: [], fields: [] }), parse: () => ({ ok: false, reason: '-' }),
      write: async () => { throw new Error('no write'); } } };
    const view = mountWorkline({ labels, panels: { ports, labels: terminalPanelLabels('en') }, config: async args => { texts.push(args); return ['TEXT-CONFIG']; }, completeTurn: async messages => { modelInputs.push(messages); return 'MODEL-OUTPUT'; } });
    mounted.push(view.instance);
    await settle(40);
    view.stdin.write(`/config set max_workers 2${ENTER}`);
    expect(texts).toEqual([]);
    await until(() => frameOf(view).includes('CONFIG-WINDOW'), 'config window');
    expect(modelInputs).toEqual([]); expect(view.stdout.text).not.toContain('TEXT-CONFIG');
    view.stdin.write(ESC);
    await until(() => !frameOf(view).includes('CONFIG-WINDOW'), 'closed');
    view.stdin.write('hello');
    await until(() => frameOf(view).includes('hello'), 'composer has the keys');
  });
  it('a config write the policy holds opens its approval window, in the words of a setting, right after the window closes', async () => {
    const approval = { approvalId: 'ap-cfg-1', runId: '-', taskId: '-', summary: 'Setting will change: max_workers 4 → 2 (project)', requester: 'owner', revision: 0,
      status: 'pending' as const, decision: null, expiresAt: Date.now() + 600_000, config: { action: 'set' as const, layer: 'project' as const, keyPath: 'max_workers', ruleId: 'company-rule' } };
    const ports: PanelPorts = { config: { parse: () => ({ ok: true, value: 2 }),
      inspect: async () => ({ title: 'CONFIG-WINDOW', notes: [], fields: [{ key: 'max_workers', section: 'max_workers', description: 'Workers', value: '4', source: 'project', apply: 'restart',
        expected: 'integer', choices: [{ id: '0', label: '2', value: 2 }], free: false, unsettable: false, sensitive: false,
        locks: { project: { blocked: null, note: null }, global: { blocked: null, note: null } } }] }),
      write: async () => ({ status: 'approval-pending', lines: ['HELD: nothing was written'], approvalId: 'ap-cfg-1' }) } };
    const view = mountWorkline({ labels, panels: { ports, labels: terminalPanelLabels('en') },
      ledger: { workerHeartbeatMs: 60_000, scopeId: 'scope', listApprovalPage: async () => ({ items: [approval], nextAfter: null }),
        decideApproval: async () => ({ ...approval, status: 'decided', revision: 1, decision: 'deny' }) } as never, approvalPollMs: 60_000, pollMs: 60_000 });
    mounted.push(view.instance);
    await settle(40);
    view.stdin.write(`/config${ENTER}`);
    await until(() => frameOf(view).includes('CONFIG-WINDOW'), 'config window');
    await settle(60); // the list listens from the commit after its first frame
    for (const key of [ENTER, ENTER, ENTER, ENTER]) { view.stdin.write(key); await settle(60); } // general → max_workers → 2 → project
    await until(() => frameOf(view).includes('setting change'), 'approval window');
    expect(view.stdout.text).toContain('HELD: nothing was written');
    expect(frameOf(view)).toContain('company-rule'); expect(frameOf(view)).toContain('the previous value is kept');
  });
  it('full access: one standing warning line above the composer while the session holds it, gone when Shift+Tab leaves it', async () => {
    const { port } = modePort(true);
    const view = mountWorkline({ labels, permissionMode: port, fullAccess: true });
    mounted.push(view.instance);
    await until(() => frameOf(view).includes('FA-LINE commands run without asking'), 'warning line');
    expect(frameOf(view)).toMatch(/⏵⏵⏵ FA-LINE/u); expect(frameOf(view)).not.toContain('⚠');
    view.stdin.write(SHIFT_TAB);
    await until(() => !frameOf(view).includes('FA-LINE'), 'line gone after leaving full access');
  });
  it('entering full access with Shift+Tab says so in the warning tone and shows the line', async () => {
    const { port } = modePort(true);
    const view = mountWorkline({ labels, permissionMode: port });
    mounted.push(view.instance);
    await settle(60);
    for (let step = 0; step < 3; step++) { view.stdin.write(SHIFT_TAB); await settle(80); }
    await until(() => frameOf(view).includes('FA-LINE'), 'line after entering');
    expect(view.stdout.text).toContain('INTO-FULL auto->FULL');
  });
});
