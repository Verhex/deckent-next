import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hubPanelPort } from '#surfaces/core/terminal-hub/index.js';
import { ConfigNumberWindow, PickerWindow } from '#surfaces/core/terminal-panels/index.js';
import { PassThrough, Writable } from 'node:stream';
import { createElement, type ReactElement } from 'react';
import { render } from 'ink';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PermissionModeView } from '#domain/index.js';
import { resolveWorklinePalette, WorklinePaletteProvider } from '#surfaces/core/terminal-kit-ink/index.js';
import { cells, resolveRenderGlyphs, RenderGlyphsContext, span } from '#surfaces/core/terminal-render-ink/index.js';
import { DECISION_ARM_DEFAULT, QueuedListOpeningContext, WindowStackProvider } from '#surfaces/core/terminal-window/index.js';
import { configPanelTree, editEntry, maskEntry, mcpPanelTree, mcpArgs, mcpPair, mcpWizardSteps, modePanelTree, type ConfigPanelPort, type ConfigPanelView, type McpPanelPort,
  type McpServerDraft, type McpTrustQuestion, type PanelNotice } from '#surfaces/core/terminal-panels/index.js';
import { SettingsPanel } from '#surfaces/core/terminal-provider/index.js';
import { terminalPanelLabels } from '#surfaces/core/work-labels/index.js';

// T3 L4 PANELS — the `/mode`, `/config` and `/mcp` windows on the real Ink view (in-process ports): locked rows say why and cannot be chosen,
// choices go only to the port, a 40-column terminal keeps every line inside its width, NO_COLOR/ASCII keeps the meaning in words and marks.
class Screen extends Writable {
  frame = '';
  readonly isTTY = true;
  constructor(readonly columns: number, readonly rows: number) { super(); }
  // G2-3: a decision window turns bracketed paste on and off around its frames; that mode switch is not a frame.
  override _write(chunk: Buffer, _encoding: string, done: () => void) { const text = chunk.toString('utf8'); if (text.length && !/^(?:\u001b\[\?2004[hl])+$/u.test(text)) this.frame = text; done(); } // eslint-disable-line no-control-regex
}
const settle = (ms = 40) => new Promise(resolve => setTimeout(resolve, ms));
const ESC = '\u001B', DOWN = '\u001B[B', ENTER = '\r';
/** G2-3: a panel question is a decision window — it counts keys once its key hints show after the quiet arming period (arming.ts). */
async function armed(frame: () => string, hint: string) {
  await settle(DECISION_ARM_DEFAULT + 80);
  for (let tries = 0; tries < 50 && !frame().includes(hint); tries++) await settle(20);
  expect(frame()).toContain(hint);
}
const mounted: Array<{ unmount(): void }> = [];
afterEach(() => { for (const instance of mounted.splice(0)) instance.unmount(); vi.useRealTimers(); });
/** One write per key: an escape sequence (arrows) stays whole, every other character is its own key. */
function splitKeys(keys: string): string[] {
  const out: string[] = [];
  for (let index = 0; index < keys.length; index++) {
    if (keys[index] === ESC && keys[index + 1] === '[') { const end = keys.slice(index + 2).search(/[A-Z~]/u); out.push(keys.slice(index, index + 3 + end)); index += 2 + end; }
    else out.push(keys[index]!);
  }
  return out;
}
function mount(node: ReactElement, columns = 100, rows = 40, ascii = false) {
  const stdout = new Screen(columns, rows);
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() { return stdin; }, ref() { return stdin; }, unref() { return stdin; } });
  const tree = createElement(WorklinePaletteProvider, { palette: resolveWorklinePalette('none'),
    children: createElement(RenderGlyphsContext.Provider, { value: resolveRenderGlyphs(ascii) }, createElement(WindowStackProvider, null, node)) });
  const instance = render(tree, { stdout: stdout as unknown as NodeJS.WriteStream, stdin: stdin as unknown as NodeJS.ReadStream, debug: true, exitOnCtrlC: false, patchConsole: false });
  mounted.push(instance);
  return { frame: () => stdout.frame, stdin, flush: () => instance.waitUntilRenderFlush(), press: async (keys: string, ms?: number) => { for (const key of splitKeys(keys)) { stdin.write(key); await settle(10); } await settle(ms); },
    /** One stdin chunk, as a terminal sends a modified key. */
    raw: async (keys: string, ms?: number) => { stdin.write(keys); await settle(ms); } };
}
const VIEW: PermissionModeView = { schemaVersion: 1, scopeId: 'scope', supported: true, mode: 'standart', askEdits: false, revision: 'r1', eligible: true, fullAccess: false } as PermissionModeView;
type Calls = { notices: PanelNotice[]; errors: unknown[]; closed: number; approvals: string[] };
function panel(kind: 'mode' | 'config' | 'mcp' | 'policy', ports: Parameters<typeof SettingsPanel>[0]['ports'], locale: 'en' | 'tr' = 'en') {
  const calls: Calls = { notices: [], errors: [], closed: 0, approvals: [] };
  const element = createElement(SettingsPanel, { kind, ports, labels: terminalPanelLabels(locale), push: notices => { calls.notices.push(...notices); },
    onError: error => { calls.errors.push(error); }, errorText: error => `ERR:${String((error as { code?: unknown })?.code)}`,
    openApproval: id => { calls.approvals.push(id); }, onClose: () => { calls.closed++; } });
  return { element, calls };
}

it('112: an armed queued catalog still waits anew when it enters a scope decision', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const results: unknown[] = [];
  const view = mount(createElement(QueuedListOpeningContext.Provider, { value: true }, createElement(PickerWindow, {
    title: [span('Queued catalog')], bodyRows: 1, position: '', labels: terminalPanelLabels('en').picker,
    tree: { title: 'Catalog', items: [{ id: 'value', label: 'Value' }], scopes: [{ id: 'project', label: 'Project' }] }, onResult: result => { results.push(result); } })));
  const tick = async (ms: number) => { await vi.advanceTimersByTimeAsync(ms); await view.flush(); };
  await tick(DECISION_ARM_DEFAULT);
  view.stdin.write(ENTER); await tick(20); // catalog → scope: both have input ownership, but this is a new decision
  expect(view.frame()).toContain('Project');
  view.stdin.write(ENTER); await tick(20);
  expect(results).toEqual([]);
  await tick(DECISION_ARM_DEFAULT);
  view.stdin.write(ENTER); await tick(20);
  expect(results).toEqual([{ kind: 'selected', path: ['value'], id: 'value', scope: 'project' }]);
});

describe('/mode window', () => {
  it('112: opens on the current full-auto row and Enter changes nothing; an unknown current mode starts on the first row', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const selected: string[] = [];
    const current = panel('mode', { mode: { inspect: async () => VIEW, current: () => 'full-auto', select: async stop => { selected.push(stop); } } });
    const view = mount(current.element);
    await vi.advanceTimersByTimeAsync(60); await view.flush();
    expect(view.frame()).toMatch(/>\s+full auto · now/u);
    view.stdin.write(ENTER); await vi.advanceTimersByTimeAsync(20); await view.flush();
    expect(selected).toEqual([]); expect(current.calls.closed).toBe(1);
    const unknown = panel('mode', { mode: { inspect: async () => VIEW, current: () => null, select: async stop => { selected.push(stop); } } });
    const fallback = mount(unknown.element);
    await vi.advanceTimersByTimeAsync(60); await fallback.flush();
    expect(fallback.frame()).toMatch(/>\s+standard/u);
    fallback.stdin.write(ENTER); await vi.advanceTimersByTimeAsync(20); await fallback.flush();
    expect(selected).toEqual(['standart']); expect(unknown.calls.closed).toBe(1);
  });
  it('every stop with what it does; full access without the company grant is locked with why and Enter does nothing; a free stop goes to the port', async () => {
    const selected: string[] = [];
    const { element, calls } = panel('mode', { mode: { inspect: async () => VIEW, current: () => 'standart', select: async stop => { selected.push(stop); } } }, 'tr');
    const view = mount(element, 40, 40, true);
    await settle(80);
    for (const line of view.frame().split('\n')) expect(cells(line)).toBeLessThanOrEqual(40);
    expect(view.frame()).toContain('standart · şu an');
    await view.press(`${DOWN}${DOWN}${DOWN}`);
    expect(view.frame()).toMatch(/x tam erişim/u); expect(view.frame()).toContain('[engellendi]');
    expect(view.frame()).toContain('izin gerekir');
    await view.press(ENTER);
    expect(selected).toEqual([]); expect(calls.closed).toBe(0);
    await view.press(`${DOWN}${DOWN}${DOWN}`); // wraps to full-auto (standart → ask-edits → full-auto)
    // Shift+Enter is a new line, never a selection, also in a catalog list (its own key handler; Astra 3136).
    await view.raw('\u001b[13;2u', 60); expect(selected).toEqual([]); expect(calls.closed).toBe(0);
    await view.press(ENTER);
    expect(selected).toEqual(['full-auto']); expect(calls.closed).toBe(1);
  });
  it('a load that lasts a second or more shows its live elapsed seconds (FIX8a R26)', async () => {
    const view = mount(panel('mode', { mode: { inspect: () => new Promise<PermissionModeView>(() => undefined), current: () => 'standart', select: async () => undefined } }).element);
    await settle(80);
    expect(view.frame()).toContain('Loading…'); expect(view.frame()).not.toContain('Loading… ·');
    await settle(1_100);
    expect(view.frame()).toContain('Loading… · 1s');
  });
  it('the tree: a v1 policy locks every stop; the company may leave full-auto out; the grant opens full access', () => {
    const labels = terminalPanelLabels('en').mode;
    expect(modePanelTree({ ...VIEW, supported: false }, null, labels).items.every(item => item.blocked)).toBe(true);
    expect(modePanelTree({ ...VIEW, fullAuto: false } as PermissionModeView, 'standart', labels).items.find(item => item.id === 'full-auto')!.blocked?.reason).toBe(labels.fullAutoOff);
    expect(modePanelTree({ ...VIEW, fullAuto: false, fullAccess: false }, 'standart', labels, true).items.every(item => !item.blocked)).toBe(true);
    expect(modePanelTree({ ...VIEW, fullAccess: true }, 'standart', labels).items.find(item => item.id === 'full-access')!.blocked).toBeUndefined();
  });
});

const CONFIG: ConfigPanelView = { title: 'Configuration · acme', notes: [], fields: [
  { key: 'terminal.theme', section: 'terminal', description: 'Colour theme', value: 'auto', source: 'default', apply: 'live', expected: 'string; auto, dark, light',
    choices: [{ id: '0', label: 'auto', value: 'auto' }, { id: '1', label: 'dark', value: 'dark' }], free: false, unsettable: false, sensitive: false,
    locks: { project: { blocked: null, note: null }, global: { blocked: 'GLOBAL-LOCKED', note: null } } },
  { key: 'max_workers', section: 'max_workers', description: 'Workers', value: '4', source: 'project', apply: 'restart', expected: 'integer; at least 1',
    choices: [{ id: '0', label: '2', value: 2 }], free: false, stepper: { min: 1, max: 8, step: 1, unit: 'count', current: 4 }, unsettable: true, sensitive: false, locks: { project: { blocked: null, note: 'asks for approval (rule r1)' }, global: { blocked: null, note: null } } },
  { key: 'language', section: 'language', description: 'Language', value: 'en', source: 'default', apply: 'live', expected: 'en, tr',
    choices: [{ id: '0', label: 'en', value: 'en' }], free: false, unsettable: false, sensitive: false,
    locks: { project: { blocked: 'POLICY-SAYS-NO', note: null }, global: { blocked: 'POLICY-SAYS-NO', note: null } } }] };
function configPort(writes: unknown[], pending = false): ConfigPanelPort {
  return { inspect: async () => CONFIG, parse: (_key, text) => /^\d+$/u.test(text) ? { ok: true, value: Number(text) } : { ok: false, reason: 'NOT-AN-INTEGER' },
    write: async request => { writes.push(request); return pending ? { status: 'approval-pending', lines: ['Nothing was written; appr-1 waits'], approvalId: 'appr-1' }
      : { status: 'applied', lines: [`saved ${request.keyPath}`], approvalId: null }; } };
}

describe('/config window', () => {
  it('section → key → value → layer: the choice goes to the write port; a locked layer cannot be chosen; a locked key says why', async () => {
    const writes: unknown[] = [];
    const { element, calls } = panel('config', { config: configPort(writes) });
    const view = mount(element);
    await settle(80);
    expect(view.frame()).toContain('general'); expect(view.frame()).toContain('terminal');
    await view.press(`${DOWN}${ENTER}`); // general (registry order: terminal first)
    await view.press('language');
    expect(view.frame()).toContain('POLICY-SAYS-NO');
    await view.press(ENTER);
    expect(writes).toEqual([]);
    await view.press(ESC, 60); await view.press(ESC, 60); // clear the filter, then back to the sections
    await view.press(`\u001B[A${ENTER}`); // back on general's row: up to terminal
    await view.press(ENTER); // theme
    expect(view.frame()).toContain('Colour theme');
    await view.press(`${DOWN}${ENTER}`); // dark → scope step
    await armed(view.frame, 'choose scope'); // owner 108: the layer step is a decision window; its keys count once its hints show
    await view.press(DOWN); // the user layer: locked, with the policy's reason under the cursor
    expect(view.frame()).toContain('GLOBAL-LOCKED');
    await view.press(ENTER, 60);
    expect(writes).toEqual([]);
    await view.press(DOWN); // back on project
    await view.press('x'); await view.press(ENTER, 60); // typed text and its Enter choose no layer
    expect(writes).toEqual([]); expect(view.frame()).toContain('choose scope');
    await view.press(ENTER, 80);
    expect(writes).toEqual([{ action: 'set', keyPath: 'terminal.theme', value: 'dark', layer: 'project' }]);
    expect(calls.notices).toEqual([{ level: 'info', text: 'Config: saved terminal.theme' }]);
    expect(view.frame()).toContain('theme'); // the key list again, ready for the next change
  });
  it('numeric selection has no EntryWindow; a held selection opens approval and leaves one system notice', async () => {
    const writes: unknown[] = [];
    const { element, calls } = panel('config', { config: configPort(writes, true) });
    const view = mount(element);
    await settle(80);
    await view.press(`${DOWN}${ENTER}max${ENTER}`);
    expect(view.frame()).toContain('Adjust with arrows');
    if (process.env['CS1_RENDER_DIR']) await writeFile(`${process.env['CS1_RENDER_DIR']}/config-values.txt`, view.frame());
    expect(view.frame()).not.toContain('New value');
    await view.press(ENTER); await armed(view.frame, 'choose scope'); await view.press(ENTER, 80);
    expect(writes).toEqual([{ action: 'set', keyPath: 'max_workers', value: 2, layer: 'project' }]);
    expect(calls.notices).toEqual([{ level: 'warning', text: 'Config: Nothing was written; appr-1 waits' }]);
    expect(calls.approvals).toEqual(['appr-1']); expect(calls.closed).toBe(1);
  });
});

describe('window height on a short terminal (owner 2026-10-07: capped to the terminal)', () => {
  it('80×24: /mode on a locked row and /config with many keys stay within the rows the live area leaves', async () => {
    const limit = 24 - 8; // WINDOW_RESERVED_ROWS: banner, status, composer and hints keep their rows
    const mode = panel('mode', { mode: { inspect: async () => VIEW, current: () => 'standart', select: async () => undefined } }, 'tr');
    const modeView = mount(mode.element, 80, 24);
    await settle(80);
    await modeView.press(`${DOWN}${DOWN}${DOWN}`);
    expect(modeView.frame()).toContain('[engellendi]');
    expect(modeView.frame().split('\n').length).toBeLessThanOrEqual(limit);
    const many: ConfigPanelView = { ...CONFIG, fields: Array.from({ length: 20 }, (_, index) => ({ ...CONFIG.fields[1]!, key: `max_workers_${index}`,
      description: 'A long description of what this setting changes, wrapping across the window when the terminal is narrow enough to need it' })) };
    const config = panel('config', { config: { ...configPort([]), inspect: async () => many } });
    const configView = mount(config.element, 80, 24);
    await settle(80);
    await configView.press(ENTER);
    expect(configView.frame()).toMatch(/1-\d+ of 20/u);
    expect(configView.frame().split('\n').length).toBeLessThanOrEqual(limit);
  });
});

function mcpPort(log: unknown[], answers: (boolean | null)[]): McpPanelPort {
  return {
    list: async () => ({ servers: [{ name: 'files', scope: 'local', state: 'connected', status: 'trusted', attention: false, tools: '2 tools', realm: 'sandbox', launch: 'npx files',
      trusted: true, selected: { scope: 'local', definitionDigest: 'a'.repeat(64) } }],
      problems: [] }),
    detail: async name => [{ label: 'Status', text: `trusted ${name}` }, { label: 'Tools', text: 'read_file 0123456789ab' }],
    revoke: async (name, selected) => { log.push(['revoke', name, selected]); return [`revoked ${name}`]; },
    approve: async (name, ask) => { answers.push(await ask({ title: `Trust ${name}?`, lines: [{ label: 'Command', text: 'npx files' }], prompt: 'y/n' })); return ['approved']; },
    reconnect: async name => { log.push(['reconnect', name]); return ['reconnect']; },
    remove: async (name, selected) => { log.push(['remove', name, selected]); return ['removed']; },
    add: async (draft: McpServerDraft, ask: (question: McpTrustQuestion) => Promise<boolean | null>) => {
      log.push(['add', draft]);
      if (draft.name === 'taken') throw Object.assign(new Error('exists'), { code: 'MCP_SERVER_EXISTS' });
      answers.push(await ask({ title: `Start ${draft.name}?`, lines: [{ label: 'Command', text: draft.target }], prompt: 'y yes' }));
      return [`added ${draft.name}`];
    },
    transports: [{ id: 'stdio', label: 'stdio' }, { id: 'http', label: 'HTTP', blocked: 'HTTP-NOT-YET' }],
    realms: [{ id: 'prefer-sandbox', label: 'sandbox if usable' }, { id: 'host', label: 'host' }],
    scopes: [{ id: 'local', label: 'local' }, { id: 'project', label: 'project' }, { id: 'user', label: 'user' }],
  };
}

describe('/mcp window', () => {
  it('lists servers with state; detail, revoke and remove (asked first) act through the port', async () => {
    const log: unknown[] = [], answers: (boolean | null)[] = [];
    const source = mcpPort(log, answers), initial = await source.list();
    const words = terminalPanelLabels('en').mcp;
    for (const ascii of [false, true]) {
      const tree = mcpPanelTree(initial, words, ascii), node = tree.items[1]!;
      expect(node).toMatchObject({ label: 'files', tone: 'stateConnected', glyph: ascii ? '+' : '✔' });
      for (const state of ['not-started', 'pending-approval', 'failed', 'timed-out'] as const)
        expect(mcpPanelTree({ ...initial, servers: [{ ...initial.servers[0]!, state }] }, words, ascii).items[1]).toMatchObject({ tone: 'stateDisconnected', glyph: '!' });
    }
    let signal: AbortSignal | undefined, finish: ((value: typeof initial) => void) | undefined;
    const stalled = panel('mcp', { mcp: { ...source, list: async options => {
      if (!options?.health) return { ...initial, servers: [{ ...initial.servers[0]!, state: 'checking', status: 'checking' }] };
      signal = options.signal; return new Promise(resolve => { finish = resolve; });
    } } });
    const loading = mount(stalled.element); await settle(80);
    expect(loading.frame()).toContain('checking'); expect(loading.frame()).toContain('files');
    await loading.press(ESC, 80); expect(signal?.aborted).toBe(true);
    finish?.(initial); await settle(); expect(stalled.calls.errors).toEqual([]);
    const { element, calls } = panel('mcp', { mcp: source });
    const view = mount(element);
    await settle(80);
    expect(view.frame()).toContain('+ Add a server'); expect(view.frame()).toMatch(/files ›\s+trusted · 2 tools · sandbox · local/u);
    await view.press(`${DOWN}${ENTER}${ENTER}`, 80); // files → Details
    expect(view.frame()).toContain('read_file 0123456789ab');
    await view.press(ESC, 80); // back to files' actions, on Details
    await view.press(`${DOWN}${DOWN}${ENTER}`, 80); // Revoke trust
    expect(log).toEqual([['revoke', 'files', { scope: 'local', definitionDigest: 'a'.repeat(64) }]]); expect(calls.notices.at(-1)).toEqual({ level: 'info', text: 'revoked files' });
    await view.press(`${DOWN}${ENTER}${DOWN}${DOWN}${DOWN}${DOWN}${ENTER}`, 60); // Remove → asks
    expect(log).toHaveLength(1);
    await armed(view.frame, 'y yes'); await view.press('y', 80);
    expect(log.at(-1)).toEqual(['remove', 'files', { scope: 'local', definitionDigest: 'a'.repeat(64) }]);
  });
  it('the add wizard: HTTP is locked until its transport lands; env values are masked; a taken name goes back to the name step; the trust window answers', async () => {
    const log: unknown[] = [], answers: (boolean | null)[] = [];
    const { element } = panel('mcp', { mcp: mcpPort(log, answers) });
    const view = mount(element);
    await settle(80);
    await view.press(ENTER); // + Add a server
    await view.press(`${DOWN}${ENTER}`);
    expect(view.frame()).toContain('HTTP-NOT-YET');
    await view.press(`${DOWN}${ENTER}`); // stdio
    await view.press(`taken${ENTER}`); await view.press(`npx${ENTER}`); await view.press(`-y "my server"${ENTER}`);
    await view.press('TOKEN=hunter2');
    expect(view.frame()).toContain('TOKEN=•••••••'); expect(view.frame()).not.toContain('hunter2');
    await view.press(`${ENTER}${ENTER}`); // one pair, then done
    await view.press(ENTER); await view.press(ENTER, 120); // realm, scope → add → refused name
    expect(log).toEqual([['add', { transport: 'stdio', name: 'taken', target: 'npx', args: ['-y', 'my server'], env: { TOKEN: 'hunter2' }, headers: {}, realm: 'prefer-sandbox', scope: 'local' }]]);
    expect(view.frame()).toContain('ERR:MCP_SERVER_EXISTS');
    await view.press(`\u007f\u007f\u007f\u007f\u007ffiles2${ENTER}`); // name step again; the rest of the draft is kept
    for (let step = 0; step < 4; step++) await view.press(ENTER); await view.press(ENTER, 120); // command, args, env (none more), realm, scope
    expect(view.frame()).toContain('Start files2?');
    await armed(view.frame, 'y yes'); await view.press('y', 80);
    expect(answers).toEqual([true]);
    expect((log.at(-1) as [string, McpServerDraft])[1]).toMatchObject({ name: 'files2', target: 'npx', env: { TOKEN: 'hunter2' } });
  });
  it('pure parts: steps per transport, NAME=value pairs, quoted arguments, masking keeps the name', () => {
    expect(mcpWizardSteps('http')).toEqual(['transport', 'name', 'url', 'headers', 'scope']);
    expect(mcpPair('A=b=c', '=')).toEqual(['A', 'b=c']); expect(mcpPair('=x', '=')).toBeNull(); expect(mcpPair('Authorization: Bearer x', ':')).toEqual(['Authorization', 'Bearer x']);
    expect(mcpArgs(`-y "a b" 'c d' e`)).toEqual(['-y', 'a b', 'c d', 'e']);
    expect(maskEntry('KEY=sécret', '*', '=')).toBe('KEY=******'); expect(maskEntry('noseparator', '*', '=')).toBe('noseparator');
    expect(editEntry({ text: 'ab', caret: 2 }, '', { backspace: true } as never)).toEqual({ text: 'a', caret: 1 });
    expect(editEntry({ text: 'ab', caret: 1 }, 'x\ny', {} as never)).toEqual({ text: 'ax yb', caret: 4 });
  });
});


describe('CS-1 number window', () => {
  it('shows human units with NO_COLOR, ignores digits, clamps arrows, Enter selects once and Esc cancels', async () => {
    const selected: number[] = []; let canceled = 0;
    const stepper = { min: 1000, max: 5000, step: 1000, unit: 'ms' as const, current: 2000 };
    const view = mount(createElement(ConfigNumberWindow, { title: 'Timeout', stepper, hints: terminalPanelLabels('en').config.stepperHint,
      position: '{pos} of {count}', onSubmit: value => selected.push(value), onCancel: () => { canceled++; } }), 40, 24, true);
    await settle(60);
    expect(view.frame()).toContain('2 s'); expect(view.frame()).toContain('1 s'); expect(view.frame()).toContain('5 s');
    await armed(view.frame, 'adjust'); // owner 108: a decision window; the 40-column hint row wraps, its first words show once keys count
    await view.press('999'); expect(view.frame()).toContain('2 s'); expect(selected).toEqual([]);
    await view.press(ENTER); expect(selected).toEqual([]); expect(view.frame()).toContain('2 s'); // digits are typed text: their Enter selects nothing
    await view.press('-----'); expect(view.frame()).toContain('1 s');
    await view.press('++++++'); expect(view.frame()).toContain('5 s');
    for (const line of view.frame().split('\n')) expect(cells(line)).toBeLessThanOrEqual(40);
    if (process.env['CS1_RENDER_DIR']) await writeFile(`${process.env['CS1_RENDER_DIR']}/number-window.txt`, view.frame());
    await view.press('9'); await view.press(ENTER); expect(selected).toEqual([]); expect(view.frame()).toContain('5 s');
    await view.press(`${ENTER}${ENTER}`); expect(selected).toEqual([5000]);
    const escape = mount(createElement(ConfigNumberWindow, { title: 'Timeout', stepper, hints: 'Esc', position: '-', onSubmit: value => selected.push(value), onCancel: () => { canceled++; } }));
    await armed(escape.frame, 'Esc'); await escape.press(ESC); expect(canceled).toBe(1); expect(selected).toEqual([5000]);
  });
  it('ignores a forged free-entry flag for any field outside the allowed-entry registry', () => {
    const forged = { ...CONFIG, fields: [{ ...CONFIG.fields[1]!, free: true }] };
    const tree = configPanelTree(forged, terminalPanelLabels('en').config, 'max_workers');
    expect(tree.items[0]?.children?.[0]?.children?.some(row => row.id === ':entry')).toBe(false);
  });
});


describe('CS-1 allowed new value preview', () => {
  it('URL entry validates, previews without writing, Esc cancels and Enter sends one governed request', async () => {
    const writes: unknown[] = [], urlField = { ...CONFIG.fields[0]!, key: 'toolchains.currency.registryEndpoint', description: 'Registry endpoint', expected: 'HTTPS URL', choices: [], free: true, value: 'https://registry.npmjs.org' };
    const port = { ...configPort(writes), inspect: async () => ({ ...CONFIG, fields: [urlField] }),
      parse: (_key: string, text: string) => text.startsWith('https://') ? { ok: true as const, value: text } : { ok: false as const, reason: 'INVALID-URL' } };
    const { element, calls } = panel('config', { config: port }), view = mount(element, 80, 24, true);
    await settle(80);
    await view.press(`${ENTER}${ENTER}${ENTER}`); await armed(view.frame, 'choose scope'); await view.press(ENTER); // section → key → new value → layer
    expect(view.frame()).toContain('New value');
    await view.press(`bad${ENTER}`); expect(view.frame()).toContain('INVALID-URL'); expect(writes).toEqual([]);
    await view.press(`\u007f\u007f\u007fhttps://registry.example.com${ENTER}`);
    expect(view.frame()).toContain('Preview change'); expect(view.frame()).toContain('https://registry.example.com'); expect(writes).toEqual([]);
    if (process.env['CS1_RENDER_DIR']) await writeFile(`${process.env['CS1_RENDER_DIR']}/config-preview.txt`, view.frame());
    // The preview is a decision window (owner 108): it arms first, and text typed on it and its Enter write nothing.
    await armed(view.frame, 'Enter confirms'); await view.press(ESC); expect(writes).toEqual([]);
    await view.press(`${ENTER}${ENTER}`); await armed(view.frame, 'choose scope'); await view.press(ENTER); expect(view.frame()).toContain('New value'); // key → new value → layer
    await view.press(`https://registry.example.com${ENTER}`); await armed(view.frame, 'Enter confirms');
    await view.press(`ok${ENTER}`); expect(writes).toEqual([]); expect(view.frame()).toContain('Preview change');
    await view.press(ENTER);
    expect(writes).toEqual([{ action: 'set', keyPath: urlField.key, value: 'https://registry.example.com', layer: 'project' }]);
    expect(calls.notices).toHaveLength(1); expect(calls.errors).toEqual([]);
  });
});

describe('owner 108: the confirmation steps of the settings panels are decision windows', () => {
  it('/policy: on the preview that applies, typed text, its Enter and a y inside it apply nothing; a deliberate Enter or y applies once', async () => {
    const applied: string[] = [], group = { id: 'g1', label: 'GROUP-ONE', detail: 'detail', note: 'note' }, words = terminalPanelLabels('en').policy!;
    const port: NonNullable<Parameters<typeof SettingsPanel>[0]['ports']['policy']> = { scopes: async () => ['scope-a'], inspect: async () => ({ groups: [group] }),
      delegations: async () => ({ groups: [{ ...group, id: 'decision:d1', label: 'DELEGATE-ONE' }] }),
      preview: async (scopeId, groupId, action) => ({ scopeId, groupId, action, digest: 'digest', lines: [{ label: '', text: `PREVIEW ${groupId}` }], applicable: true, ...(groupId.startsWith('decision:') ? { delegation: true } : {}) }),
      apply: async preview => { applied.push(preview.groupId); return []; } };
    const { element, calls } = panel('policy', { policy: port }), view = mount(element, 100, 30, true);
    await settle(80);
    await view.press(`${ENTER}${ENTER}${ENTER}`, 80); // scope → group → grant: the preview, "Approve and apply" highlighted
    expect(view.frame()).toContain('PREVIEW g1'); await armed(view.frame, 'Enter select');
    await view.press(`/polic${ENTER}`); expect(applied).toEqual([]); expect(view.frame()).toContain('PREVIEW g1'); // text and its Enter chose nothing
    await view.press(ENTER, 80); expect(applied).toEqual(['g1']);
    expect(view.frame()).toContain(words.delegations!);
    await view.press(`${DOWN}${ENTER}`, 80); await view.press(`${ENTER}${ENTER}`, 80); // delegations → the delegation → grant: the y/n preview
    expect(view.frame()).toContain('PREVIEW decision:d1'); await armed(view.frame, 'y: confirm');
    await view.press('/policy'); expect(applied).toEqual(['g1']); // the y inside typed text is text
    await view.press(ENTER); expect(applied).toEqual(['g1']); expect(view.frame()).toContain('PREVIEW decision:d1'); // that Enter is neither yes nor cancel
    await view.press('y', 80); expect(applied).toEqual(['g1', 'decision:d1']); expect(calls.errors).toEqual([]);
  });
  it('/config: the operations baseline offer takes no y out of typed text; a deliberate y applies it once', async () => {
    const writes: unknown[] = [], baseline: string[] = [];
    const field = { ...CONFIG.fields[0]!, key: 'operations.demo', section: 'operations', description: 'Demo operation' };
    const port: ConfigPanelPort = { ...configPort(writes), inspect: async () => ({ ...CONFIG, fields: [field] }),
      operationsBaseline: { offer: async () => ({ scopeId: 'scope', digest: 'digest', title: 'BASELINE-OFFER', lines: ['what it grants'], later: 'LATER' }), apply: async () => { baseline.push('applied'); return ['BASELINE-APPLIED']; } } };
    const { element, calls } = panel('config', { config: port }), view = mount(element, 100, 30, true);
    await settle(80);
    await view.press(`${ENTER}${ENTER}${ENTER}`); await armed(view.frame, 'choose scope'); await view.press(ENTER, 120); // section → key → value → layer: written, then the offer
    expect(writes).toHaveLength(1); expect(view.frame()).toContain('BASELINE-OFFER'); await armed(view.frame, 'y apply');
    await view.press('/policy'); await view.press(ENTER); expect(baseline).toEqual([]); expect(view.frame()).toContain('BASELINE-OFFER');
    await view.press('y', 80); expect(baseline).toEqual(['applied']); expect(calls.errors).toEqual([]);
  });
});

/** TERM-PANEL (owner 2026-10-19): the window in a frame — its height (border to border), how often a text shows inside it, its key-hint rows. */
function windowShape(frame: string, title: string) {
  const lines = frame.split('\n'), top = lines.findIndex(line => line.startsWith('╭')), bottom = lines.findIndex((line, index) => index > top && line.startsWith('╰'));
  const inside = lines.slice(top + 1, bottom);
  return { height: bottom - top + 1, titles: inside.filter(line => line.includes(title)).length, hints: inside.filter(line => /Esc /u.test(line)).length };
}
const never = <T,>() => new Promise<T>(() => undefined);

describe('TERM-PANEL: a window with a list draws one title and one key-hint row and keeps one height', () => {
  it('/config: Loading, the sections, a filter, a section\'s keys, a key\'s values and the layer step with a locked layer\'s reason', async () => {
    const loading = mount(panel('config', { config: { ...configPort([]), inspect: never } }).element);
    await settle(80);
    const height = windowShape(loading.frame(), 'Loading').height;
    expect(windowShape(loading.frame(), 'Loading')).toEqual({ height, titles: 1, hints: 1 });
    const view = mount(panel('config', { config: configPort([]) }).element);
    await settle(80);
    const shape = () => windowShape(view.frame(), 'Configuration · acme'), shapes = [shape()];
    for (const keys of ['th', '\u007f\u007f', ENTER, ENTER]) { await view.press(keys); shapes.push(shape()); }
    // Owner 108: the layer step is a decision window; it shows its key-hint row (and takes the arrow) once it is armed.
    await view.press(ENTER); await armed(view.frame, 'choose scope'); shapes.push(shape());
    await view.press(DOWN); shapes.push(shape());
    expect(view.frame()).toContain('GLOBAL-LOCKED'); expect(view.frame()).toContain('Configuration · acme › terminal › terminal.theme');
    expect(shapes).toEqual(shapes.map(() => ({ height, titles: 1, hints: 1 })));
  });
  it('/mode: Loading, the list and a locked stop with its long reason (Turkish, 40 columns)', async () => {
    const port = { current: () => 'standart' as const, select: async () => undefined };
    const loading = mount(panel('mode', { mode: { ...port, inspect: never } }, 'tr').element, 40, 40);
    await settle(80);
    const height = windowShape(loading.frame(), 'İzin modu').height;
    const view = mount(panel('mode', { mode: { ...port, inspect: async () => VIEW } }, 'tr').element, 40, 40);
    await settle(80);
    const first = windowShape(view.frame(), 'İzin modu');
    await view.press(`${DOWN}${DOWN}${DOWN}`);
    expect(view.frame()).toContain('izin gerekir');
    expect([first, windowShape(view.frame(), 'İzin modu')]).toEqual([{ height, titles: 1, hints: 1 }, { height, titles: 1, hints: 1 }]);
    for (const line of view.frame().split('\n')) expect(cells(line)).toBeLessThanOrEqual(40);
  });
  it('/mcp: Loading, the servers, a server\'s actions and the add wizard\'s transport step with a locked transport', async () => {
    const loading = mount(panel('mcp', { mcp: { ...mcpPort([], []), list: never } }).element);
    await settle(80);
    const height = windowShape(loading.frame(), 'MCP servers').height;
    const view = mount(panel('mcp', { mcp: mcpPort([], []) }).element);
    await settle(80);
    const shapes = [windowShape(view.frame(), 'MCP servers')];
    await view.press(`${DOWN}${ENTER}`); shapes.push(windowShape(view.frame(), 'MCP servers'));
    await view.press(ESC); await view.press(`\u001B[A${ENTER}`);
    const step = windowShape(view.frame(), 'Transport');
    await view.press(DOWN);
    expect(view.frame()).toContain('HTTP-NOT-YET');
    expect([...shapes, step, windowShape(view.frame(), 'Transport')]).toEqual([...shapes, step, step].map(() => ({ height, titles: 1, hints: 1 })));
  });
});



it('H7 Hub window shows the scope/source card, cancelling never writes, and only a fresh apply reaches the shared handler', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hub-window-')), path = join(root, 'source.json'), requests: unknown[] = [], errors: unknown[] = [];
  const input = { hubId: 'a'.repeat(64), publicKey: 'A'.repeat(59) + '=', expectedRevision: null, endpoint: 'https://hub.invalid/mcp', local: false, label: 'Company hub', trustPolicy: 'publisher-pinned' };
  await writeFile(path, JSON.stringify(input));
  const port = hubPanelPort({ root, scopeId: 's', options: {}, locale: 'en', maxBytes: 8192, timeoutMs: 10000,
    execute: async (_root, request) => { requests.push(request); return { applied: true }; } });
  const element = createElement(SettingsPanel, { kind: 'hub', ports: { hub: port }, labels: terminalPanelLabels('en'), push: () => undefined,
    onError: error => { errors.push(error); }, errorText: String, openApproval: () => undefined, onClose: () => undefined });
  const view = mount(element);
  try {
    await settle(80); await view.press(DOWN + ENTER); await view.press(path + ENTER, 100);
    if (process.platform === 'win32') {
      expect(errors).toEqual([expect.objectContaining({ code: 'CLI_INVOCATION_INPUT_UNAVAILABLE' })]); expect(requests).toHaveLength(0); return;
    }
    await armed(view.frame, 'y apply');
    expect(view.frame()).toContain('https://hub.invalid/mcp'); expect(requests).toHaveLength(0);
    await view.press('n'); expect(requests).toHaveLength(0);
    await view.press(DOWN + ENTER); await view.press(path + ENTER, 100); await armed(view.frame, 'y apply');
    await view.press('y', 100);
    expect(errors).toEqual([]); expect(requests).toEqual([expect.objectContaining({ operation: 'hub.sources.add', input: expect.objectContaining({ scopeId: 's', endpoint: input.endpoint }) })]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
