import { PassThrough, Writable } from 'node:stream';
import { createElement, type ReactElement } from 'react';
import { render } from 'ink';
import { afterEach, describe, expect, it } from 'vitest';
import { WorklinePaletteProvider, resolveWorklinePalette } from '#surfaces/core/terminal-kit/index.js';
import { RenderGlyphsContext, cells, resolveRenderGlyphs } from '#surfaces/core/terminal-render/index.js';
import { WindowStackProvider } from '#surfaces/core/terminal-window/index.js';
import { SettingsPanel, modelPanelTree, providerPanelTree, type ConfigPanelOutcome, type ModelPanelChoice, type ModelPanelPort, type ModelPanelView, type PanelNotice,
  type ProviderConnectRequest, type ProviderPanelPort, type ProviderPanelView } from '#surfaces/core/terminal-panels/index.js';
import { terminalPanelLabels } from '#surfaces/core/work-labels/index.js';
import { mountWorkline, settle as settleWorkline, until, WORKLINE_TEST_LABELS } from '../support/workline-harness.js';

// T4-A (owner 2026-10-07/08): `/model` picks this session's model (exact catalog references; models that cannot be used are listed with their reason
// and never chosen; "also make default" goes through the governed /config writer or is locked with its reason) and `/provider` connects a kind
// (masked key, free check, typed result, key only to the port). The key is a canary: it may reach only the port's `connect` call.
const CANARY = 'sk-canary-T4-6f1d2e9c0b7a';
class Screen extends Writable {
  frame = ''; all = '';
  readonly isTTY = true;
  constructor(readonly columns: number, readonly rows: number) { super(); }
  override _write(chunk: Buffer, _encoding: string, done: () => void) { this.frame = chunk.toString('utf8'); this.all += this.frame; done(); }
}
const settle = (ms = 40) => new Promise(resolve => setTimeout(resolve, ms));
const ESC = '\u001B', DOWN = '\u001B[B', ENTER = '\r';
const mounted: Array<{ unmount(): void }> = [];
afterEach(() => { for (const instance of mounted.splice(0)) instance.unmount(); });
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
  mounted.push(render(tree, { stdout: stdout as unknown as NodeJS.WriteStream, stdin: stdin as unknown as NodeJS.ReadStream, debug: true, exitOnCtrlC: false, patchConsole: false }));
  return { frame: () => stdout.frame, all: () => stdout.all, press: async (keys: string, ms?: number) => { for (const key of splitKeys(keys)) { stdin.write(key); await settle(10); } await settle(ms); } };
}
type Calls = { notices: PanelNotice[]; errors: unknown[]; closed: number; approvals: string[] };
function panel(kind: 'model' | 'provider', ports: Parameters<typeof SettingsPanel>[0]['ports'], locale: 'en' | 'tr' = 'en') {
  const calls: Calls = { notices: [], errors: [], closed: 0, approvals: [] };
  const element = createElement(SettingsPanel, { kind, ports, labels: terminalPanelLabels(locale), push: notices => { calls.notices.push(...notices); },
    onError: error => { calls.errors.push(error); }, errorText: error => `ERR:${String((error as { code?: unknown })?.code)}`,
    openApproval: id => { calls.approvals.push(id); }, onClose: () => { calls.closed++; } });
  return { element, calls };
}

const ref = (modelId: string, providerId = 'local-openai') => ({ providerId, providerVersion: 1, modelId, modelVersion: 1 });
const MODELS: ModelPanelView = { title: 'Models · scope', notes: [], defaultBlocked: null, choices: [
  { reference: ref('chat'), label: 'chat', detail: 'native-chat · local-openai@1/chat@1 · ready', group: 'local-openai', blocked: null, configured: true },
  { reference: ref('coder'), label: 'coder', detail: 'native-coder · local-openai@1/coder@1 · cannot be chosen now', group: 'local-openai',
    blocked: 'NOT-ACTIVE deckent models activate --scope scope', configured: false },
  { reference: ref('fast'), label: 'fast', detail: 'native-fast · local-openai@1/fast@1 · ready', group: 'local-openai', blocked: null, configured: false }] };
function modelPort(view: ModelPanelView, makeDefault?: (choice: ModelPanelChoice) => Promise<ConfigPanelOutcome>) {
  const pins: string[] = [];
  let pinned: ModelPanelChoice['reference'] | null = null;
  const port: ModelPanelPort = { inspect: async () => view, pinned: () => pinned, pin: choice => { pins.push(choice.reference.modelId); pinned = choice.reference; },
    ...(makeDefault ? { makeDefault } : {}) };
  return { port, pins };
}

describe('/model window', () => {
  it('lists exact models; a blocked one shows its reason and Enter does nothing; a ready one asks the scope and pins this session', async () => {
    const { port, pins } = modelPort(MODELS);
    const { element, calls } = panel('model', { model: port });
    const view = mount(element, 60, 40, true);
    await settle(80);
    for (const line of view.frame().split('\n')) expect(cells(line)).toBeLessThanOrEqual(60);
    expect(view.frame()).toContain('chat · default');
    await view.press(DOWN);
    expect(view.frame()).toMatch(/x coder/u); expect(view.frame()).toContain('NOT-ACTIVE');
    await view.press(ENTER);
    expect(pins).toEqual([]); expect(calls.closed).toBe(0);
    await view.press(`${DOWN}${ENTER}`);
    // The scope step: this session, or (locked here: no governed default write is bound) also the default.
    expect(view.frame()).toContain('This session only (from the next turn)');
    expect(view.frame()).toContain('This session, and make it my default');
    await view.press(ENTER);
    expect(pins).toEqual(['fast']); expect(calls.closed).toBe(1);
    expect(calls.notices.map(notice => notice.text)).toEqual([expect.stringContaining('This session uses fast from the next turn')]);
  });

  it('"also make default" is locked with its reason when the host binds no default write', () => {
    const labels = terminalPanelLabels('en').model;
    const tree = modelPanelTree({ ...MODELS, defaultBlocked: 'DECISION-PENDING' }, null, labels, 'T', false);
    expect(tree.scopes).toEqual([{ id: 'session', label: labels.session }, { id: 'default', label: labels.sessionAndDefault, blocked: { reason: 'DECISION-PENDING' } }]);
    expect(modelPanelTree(MODELS, ref('fast'), labels, 'T', true).items.map(item => item.label)).toEqual(['chat · default', 'coder', 'fast · this session']);
    // More than one provider: one section per provider.
    const two = modelPanelTree({ ...MODELS, choices: [...MODELS.choices, { ...MODELS.choices[0]!, reference: ref('chat', 'anthropic'), group: 'anthropic' }] }, null, labels, 'T', true);
    expect(two.items.map(item => [item.label, item.children?.length])).toEqual([['local-openai', 3], ['anthropic', 1]]);
  });

  it('session and default: the pin comes first, the default goes through the governed writer; a held write opens its approval', async () => {
    const written: string[] = [];
    const { port, pins } = modelPort(MODELS, async choice => { written.push(choice.reference.modelId);
      return { status: 'approval-pending', lines: ['Setting held for approval'], approvalId: 'approval-7' }; });
    const { element, calls } = panel('model', { model: port });
    const view = mount(element, 100, 40);
    await settle(80);
    await view.press(`${DOWN}${DOWN}${ENTER}`);
    await view.press(`${DOWN}${ENTER}`, 80);
    expect(pins).toEqual(['fast']); expect(written).toEqual(['fast']);
    expect(calls.approvals).toEqual(['approval-7']); expect(calls.closed).toBe(1);
    expect(calls.notices.map(notice => notice.level)).toEqual(['info', 'warning']);
  });
});

const KINDS: ProviderPanelView = { title: 'Providers', notes: [], kinds: [
  { id: 'anthropic-api', label: 'Anthropic API', detail: 'not connected', blocked: null, keyName: 'DECKENT_ANTHROPIC_KEY', keyStored: false, endpointEditable: false,
    endpointDefault: 'https://api.anthropic.com', keyRequired: true },
  { id: 'local-openai', label: 'Local server', detail: 'key DECKENT_LOCAL_ENDPOINT_KEY stored · 1 model profile(s) use it', blocked: null, keyName: 'DECKENT_LOCAL_ENDPOINT_KEY',
    keyStored: true, endpointEditable: true, endpointDefault: null, keyRequired: false },
  { id: 'chatgpt-login', label: 'ChatGPT sign-in', detail: '', blocked: 'Not available yet.', keyName: null, keyStored: false, endpointEditable: false,
    endpointDefault: null, keyRequired: false }] };
function providerPort(outcome: { stored: boolean; check: string } = { stored: true, check: 'The provider accepted the key.' }) {
  const requests: ProviderConnectRequest[] = [], removed: string[] = [];
  const port: ProviderPanelPort = {
    inspect: async () => KINDS,
    endpoint: (_kind, text) => text.startsWith('http://10.') ? 'Plain http is allowed only on this machine; use https.' : null,
    connect: async request => { requests.push(request); return { stored: outcome.stored, title: outcome.stored ? 'Connected: X' : 'Not connected: X',
      lines: [{ label: 'Check', text: outcome.check }, { label: 'Key', text: outcome.stored ? 'stored as DECKENT_ANTHROPIC_KEY' : 'not stored.' }] }; },
    disconnect: async kind => { removed.push(kind); return [`removed ${kind}`]; },
    transparency: [{ label: 'Storage', text: 'TRANSPARENCY-NOTE same OS user can read it' }],
  };
  return { port, requests, removed };
}

describe('/provider window', () => {
  it('lists the kinds with state and key names only; ChatGPT sign-in is shown locked with its reason', async () => {
    const tree = providerPanelTree(KINDS, terminalPanelLabels('en').provider);
    expect(tree.items.map(item => [item.id, item.blocked?.reason ?? null, item.children?.map(child => child.id) ?? null])).toEqual([
      ['anthropic-api', null, ['connect']], ['local-openai', null, ['connect', 'disconnect']], ['chatgpt-login', 'Not available yet.', null]]);
    const { port } = providerPort();
    const { element } = panel('provider', { provider: port }, 'tr');
    const view = mount(element, 80, 40, true);
    await settle(80);
    expect(view.frame()).toContain('Anthropic API'); expect(view.frame()).toContain('DECKENT_LOCAL_ENDPOINT_KEY');
    for (const line of view.frame().split('\n')) expect(cells(line)).toBeLessThanOrEqual(80);
  });

  it('connect: the key is typed masked under the transparency note, goes only to the port, and the typed result is shown; the key is never drawn or pushed', async () => {
    const { port, requests } = providerPort();
    const { element, calls } = panel('provider', { provider: port });
    const view = mount(element, 100, 40);
    await settle(80);
    await view.press(`${ENTER}${ENTER}`, 60);
    expect(view.frame()).toContain('Anthropic API · API key'); expect(view.frame()).toContain('TRANSPARENCY-NOTE');
    await view.press(ENTER, 40); // an empty required key is refused in place
    expect(view.frame()).toContain('This provider needs a key.'); expect(requests).toEqual([]);
    await view.press(CANARY, 40);
    expect(view.frame()).toContain('•'.repeat(CANARY.length));
    await view.press(ENTER, 120);
    expect(requests).toEqual([{ kind: 'anthropic-api', endpoint: null, key: CANARY }]);
    expect(view.frame()).toContain('Connected: X'); expect(view.frame()).toContain('The provider accepted the key.');
    expect(view.all()).not.toContain(CANARY);
    expect(JSON.stringify(calls)).not.toContain(CANARY);
    expect(calls.notices).toEqual([{ level: 'info', text: 'Connected: X\nCheck: The provider accepted the key.\nKey: stored as DECKENT_ANTHROPIC_KEY' }]);
    await view.press(ENTER, 60);
    expect(view.frame()).toContain('Providers');
  });

  it('a local server: the endpoint step refuses plain http to another machine, then an empty key is allowed; a refused check is a warning, nothing stored', async () => {
    const { port, requests } = providerPort({ stored: false, check: 'The key was rejected: it is invalid or expired.' });
    const { element, calls } = panel('provider', { provider: port });
    const view = mount(element, 100, 40);
    await settle(80);
    await view.press(`${DOWN}${ENTER}${ENTER}`, 60);
    expect(view.frame()).toContain('Local server · Endpoint');
    await view.press(`http://10.0.0.2:8000${ENTER}`, 60);
    expect(view.frame()).toContain('Plain http is allowed only on this machine');
    for (let index = 0; index < 20; index++) await view.press('\u007f');
    await view.press(`http://127.0.0.1:8000/v1${ENTER}`, 60);
    expect(view.frame()).toContain('empty Enter: this server takes no key');
    await view.press(ENTER, 120);
    expect(requests).toEqual([{ kind: 'local-openai', endpoint: 'http://127.0.0.1:8000/v1', key: null }]);
    expect(view.frame()).toContain('Not connected: X');
    expect(calls.notices[0]!.level).toBe('warning');
  });

  it('disconnect asks first; y removes through the port, n keeps', async () => {
    const { port, removed } = providerPort();
    const { element, calls } = panel('provider', { provider: port });
    const view = mount(element, 100, 40);
    await settle(80);
    await view.press(`${DOWN}${ENTER}${DOWN}${ENTER}`, 60);
    expect(view.frame()).toContain('Disconnect Local server and remove its stored key?');
    await view.press('n', 60);
    expect(removed).toEqual([]);
    await view.press(`${ENTER}${DOWN}${ENTER}`, 60); // back on the same kind
    await view.press('y', 100);
    expect(removed).toEqual(['local-openai']);
    expect(calls.notices.map(notice => notice.text)).toEqual(['removed local-openai']);
  });
});

describe('/model in the workline: the pin rides on the next turn', () => {
  it('a bare /model opens the window; the chosen model is the next turn\'s exact reference, and later turns keep it', async () => {
    const { port } = modelPort(MODELS);
    const seen: unknown[] = [];
    const streamTurn = async function* (_messages: unknown, _signal: AbortSignal, turn?: { reference?: unknown }) {
      seen.push(turn?.reference ?? null); yield { kind: 'text' as const, text: 'ok' }; yield { kind: 'done' as const, finish: 'stop' as const };
    };
    const view = mountWorkline({ labels: WORKLINE_TEST_LABELS, streamTurn, panels: { ports: { model: { inspect: port.inspect } }, labels: terminalPanelLabels('en') } });
    mounted.push(view.instance);
    await settleWorkline(40);
    view.stdin.write(`hello${ENTER}`);
    await until(() => seen.length === 1, 'first turn');
    view.stdin.write(`/model${ENTER}`);
    await until(() => view.stdout.frame.includes('Models · scope'), 'model window');
    await settleWorkline(60);
    for (const key of [DOWN, DOWN, ENTER]) { view.stdin.write(key); await settleWorkline(30); }
    view.stdin.write(ENTER);
    await until(() => view.stdout.text.includes('This session uses fast from the next turn'), 'pinned');
    view.stdin.write(`again${ENTER}`);
    await until(() => seen.length === 2, 'second turn');
    view.stdin.write(`and again${ENTER}`);
    await until(() => seen.length === 3, 'third turn');
    expect(seen).toEqual([null, ref('fast'), ref('fast')]);
  });

  it('/provider without its port says the part is unavailable here (no chat turn)', async () => {
    const view = mountWorkline({ labels: WORKLINE_TEST_LABELS, panels: { ports: {}, labels: terminalPanelLabels('en') } });
    mounted.push(view.instance);
    await settleWorkline(40);
    view.stdin.write(`/provider${ENTER}`);
    await until(() => view.stdout.text.includes('provider'), 'unavailable notice');
    expect(view.stdout.text).not.toContain('UNKNOWN');
  });
});
