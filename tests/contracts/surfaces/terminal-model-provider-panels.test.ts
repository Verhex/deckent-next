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
  { reference: ref('chat'), label: 'chat', detail: 'ready', group: 'local-openai', blocked: null, configured: true, exact: 'EXACT-chat', command: null },
  { reference: ref('coder'), label: 'coder', detail: 'cannot be chosen now', group: 'local-openai', exact: 'EXACT-coder', command: 'deckent models activate --model coder',
    blocked: 'NOT-ACTIVE deckent models activate --scope scope', configured: false },
  { reference: ref('fast'), label: 'fast', detail: 'ready', group: 'local-openai', blocked: null, configured: false, exact: 'EXACT-fast', command: null }] };
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
    // The exact reference and the fixing command are shown only for the focused row (dimmed), never in the row itself.
    expect(view.frame()).toContain('EXACT-coder'); expect(view.frame()).toContain('deckent models activate --model coder'); expect(view.frame()).not.toContain('EXACT-chat');
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
    endpointDefault: 'https://api.anthropic.com', keyRequired: true, endpointChoices: [], models: [], modelBlocked: null },
  { id: 'local-openai', label: 'Local server', detail: 'key DECKENT_LOCAL_ENDPOINT_KEY stored · 1 model profile(s) use it', blocked: null, keyName: 'DECKENT_LOCAL_ENDPOINT_KEY',
    keyStored: true, endpointEditable: true, endpointDefault: null, keyRequired: false,
    endpointChoices: [{ id: 'vllm', label: 'vLLM on this machine', url: 'http://127.0.0.1:8000' }, { id: 'ollama', label: 'Ollama on this machine', url: 'http://127.0.0.1:11434' }],
    models: [], modelBlocked: null },
  { id: 'chatgpt-login', label: 'ChatGPT sign-in', detail: '', blocked: 'Not available yet.', keyName: null, keyStored: false, endpointEditable: false,
    endpointDefault: null, keyRequired: false, endpointChoices: [], models: [], modelBlocked: null },
  // T4-B: a vendor row with its seed models, key stored; DeepSeek's key is not stored yet, so its model action is locked with the reason.
  { id: 'openai-api', label: 'OpenAI API', detail: 'key DECKENT_OPENAI_KEY stored', blocked: null, keyName: 'DECKENT_OPENAI_KEY', keyStored: true, endpointEditable: false,
    endpointDefault: 'https://api.openai.com/v1', keyRequired: true, endpointChoices: [], modelBlocked: null,
    models: [{ id: 'seed:gpt-6-luna', label: 'GPT-6 Luna', detail: 'gpt-6-luna' }, { id: 'seed:gpt-6.1-sol', label: 'GPT-6.1 Sol', detail: 'gpt-6.1-sol' }] },
  { id: 'deepseek-api', label: 'DeepSeek API', detail: 'not connected', blocked: null, keyName: 'DECKENT_DEEPSEEK_KEY', keyStored: false, endpointEditable: false,
    endpointDefault: 'https://api.deepseek.com', keyRequired: true, endpointChoices: [], modelBlocked: 'Store its key first (Connect).',
    models: [{ id: 'seed:deepseek-flash', label: 'DeepSeek V4.1 Flash', detail: 'deepseek-flash' }] }] };
function providerPort(outcome: { stored: boolean; check: string } = { stored: true, check: 'The provider accepted the key.' }, pending = false) {
  const requests: ProviderConnectRequest[] = [], removed: string[] = [], models: unknown[] = [];
  const port: ProviderPanelPort = {
    inspect: async () => KINDS,
    endpoint: (_kind, text) => text.startsWith('http://10.') ? { ok: false as const, reason: 'Plain http is allowed only on this machine; use https.' }
      : { ok: true as const, base: text.trim().replace(/\/v1\/?$/u, ''), check: `${text.trim().replace(/\/v1\/?$/u, '')}/v1/models` },
    connect: async request => { requests.push(request); return { stored: outcome.stored, title: outcome.stored ? 'Connected: X' : 'Not connected: X',
      lines: [{ label: 'Check', text: outcome.check }, { label: 'Key', text: outcome.stored ? 'stored as DECKENT_ANTHROPIC_KEY' : 'not stored.' }] }; },
    disconnect: async kind => { removed.push(kind); return [`removed ${kind}`]; },
    transparency: [{ label: 'Storage', text: 'TRANSPARENCY-NOTE same OS user can read it' }],
    keyName: kind => KINDS.kinds.find(item => item.id === kind)?.keyName ?? null,
    connectModel: async request => { models.push(request); return pending
      ? { connected: false, title: 'Waiting for approval: gpt-6-luna', lines: [{ label: 'Model', text: 'OpenAI API · gpt-6-luna' }], summary: 'gpt-6-luna waits for your approval', approvalId: 'approval-7' }
      : { connected: true, title: 'Model connected: gpt-6-luna', lines: [{ label: 'Model', text: 'OpenAI API · gpt-6-luna' }, { label: 'Spending', text: 'not metered yet', tone: 'warning' }],
        summary: 'gpt-6-luna is connected; choose it with /model.', approvalId: null }; },
  };
  return { port, requests, removed, models };
}

describe('/provider window', () => {
  it('lists the kinds with state and key names only; ChatGPT sign-in is shown locked with its reason', async () => {
    const tree = providerPanelTree(KINDS, terminalPanelLabels('en').provider);
    expect(tree.items.map(item => [item.id, item.blocked?.reason ?? null, item.children?.map(child => child.id) ?? null])).toEqual([
      ['anthropic-api', null, ['connect']], ['local-openai', null, ['connect', 'disconnect']], ['chatgpt-login', 'Not available yet.', null],
      ['openai-api', null, ['connect', 'disconnect']], ['deepseek-api', null, ['connect']]]);
    // T4-B: where the host binds models.connect, a kind that lists models offers "connect a model" (locked with its reason until the key is stored).
    const withModels = providerPanelTree(KINDS, terminalPanelLabels('en').provider, true);
    expect(withModels.items.slice(3).map(item => item.children?.map(child => [child.id, child.blocked?.reason ?? null]))).toEqual([
      [['connect', null], ['model', null], ['disconnect', null]], [['connect', null], ['model', 'Store its key first (Connect).']]]);
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
    // Owner 2026-10-08: slash output only in a window; the result leaves no scrollback line.
    expect(calls.notices).toEqual([]);
    await view.press(ENTER, 60);
    expect(view.frame()).toContain('Providers');
  });

  it('a local server: the address is chosen from the list; a new address is checked, previewed and only then used; nothing goes to scrollback', async () => {
    const { port, requests } = providerPort({ stored: false, check: 'The key was rejected: it is invalid or expired.' });
    const { element, calls } = panel('provider', { provider: port });
    const view = mount(element, 100, 40);
    await settle(80);
    await view.press(`${DOWN}${ENTER}${ENTER}`, 60);
    expect(view.frame()).toContain('Local server · Address');
    expect(view.frame()).toContain('vLLM on this machine'); expect(view.frame()).toContain('A new address…');
    // A listed address goes straight to the key step.
    await view.press(ENTER, 60);
    expect(view.frame()).toContain('empty Enter: this server takes no key');
    await view.press(ENTER, 120);
    expect(requests).toEqual([{ kind: 'local-openai', endpoint: 'http://127.0.0.1:8000', key: null }]);
    expect(view.frame()).toContain('Not connected: X');
    await view.press(ENTER, 60);
    // The last row is the narrow typed exception: refused in place, then previewed before use.
    await view.press(`${ENTER}${ENTER}${DOWN}${DOWN}${ENTER}`, 60); // the list kept its place on the local server
    await view.press(`http://10.0.0.2:8000${ENTER}`, 60);
    expect(view.frame()).toContain('Plain http is allowed only on this machine');
    for (let index = 0; index < 20; index++) await view.press('\u007f');
    await view.press(`http://127.0.0.1:9000/v1${ENTER}`, 60);
    expect(view.frame()).toContain('Use this address?'); expect(view.frame()).toContain('GET http://127.0.0.1:9000/v1/models');
    await view.press('n', 60);
    expect(view.frame()).toContain('http://127.0.0.1:9000/v1'); // back in the entry with the text kept
    await view.press(ENTER, 60); await view.press('y', 60); await view.press(ENTER, 120);
    expect(requests.at(-1)).toEqual({ kind: 'local-openai', endpoint: 'http://127.0.0.1:9000', key: null });
    expect(calls.notices).toEqual([]);
  });

  it('T4-B: connect a model — chosen from the kind\'s catalog list, connected through the port, its result in the window and one summary line on close', async () => {
    const { port, models } = providerPort();
    const { element, calls } = panel('provider', { provider: port });
    const view = mount(element, 100, 40);
    await settle(80);
    await view.press(`${DOWN}${DOWN}${DOWN}${ENTER}`, 60);
    expect(view.frame()).toContain('Connect a model (choose from its catalog)');
    await view.press(`${DOWN}${ENTER}`, 60);
    expect(view.frame()).toContain('OpenAI API · model to connect'); expect(view.frame()).toContain('GPT-6 Luna'); expect(view.frame()).toContain('gpt-6.1-sol');
    await view.press(ENTER, 120);
    expect(models).toEqual([{ kind: 'openai-api', endpoint: null, model: 'seed:gpt-6-luna' }]);
    expect(view.frame()).toContain('Model connected: gpt-6-luna'); expect(view.frame()).toContain('not metered yet');
    // Nothing reaches scrollback until the window closes; then exactly one system summary line.
    expect(calls.notices).toEqual([]);
    await view.press(ENTER, 60);
    expect(calls.notices).toEqual([{ level: 'info', text: 'gpt-6-luna is connected; choose it with /model.' }]);
    expect(view.frame()).toContain('Providers');
  });

  it('T4-B: a connection that waits for approval opens the approval card after its window closes', async () => {
    const { port } = providerPort(undefined, true);
    const { element, calls } = panel('provider', { provider: port });
    const view = mount(element, 100, 40);
    await settle(80);
    await view.press(`${DOWN}${DOWN}${DOWN}${ENTER}${DOWN}${ENTER}${ENTER}`, 120);
    expect(view.frame()).toContain('Waiting for approval: gpt-6-luna');
    await view.press(ENTER, 60);
    expect(calls.notices).toEqual([{ level: 'warning', text: 'gpt-6-luna waits for your approval' }]);
    expect(calls.approvals).toEqual(['approval-7']); expect(calls.closed).toBe(1);
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
    // The answer is shown in the window, not in scrollback.
    expect(view.frame()).toContain('removed local-openai'); expect(calls.notices).toEqual([]);
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

  it('without the streamed turn (the only one that carries a pin) /model opens no window', async () => {
    const { port } = modelPort(MODELS);
    const view = mountWorkline({ labels: WORKLINE_TEST_LABELS, panels: { ports: { model: { inspect: port.inspect } }, labels: terminalPanelLabels('en') } });
    mounted.push(view.instance);
    await settleWorkline(40);
    view.stdin.write(`/model${ENTER}`);
    await settleWorkline(150);
    expect(view.stdout.frame).not.toContain('Models · scope');
  });

  it('Astra 2452 P1: a pin belongs to its conversation — /clear starts unpinned, /resume brings back that conversation\'s own pin, never another\'s', async () => {
    const { port } = modelPort(MODELS);
    const turns: { sessionId: string; reference: unknown }[] = [];
    const saved = new Map<string, readonly { role: 'user' | 'assistant'; content: string }[]>();
    const streamTurn = async function* (_messages: unknown, _signal: AbortSignal, turn?: { sessionId?: string; reference?: unknown }) {
      turns.push({ sessionId: turn?.sessionId ?? '-', reference: turn?.reference ?? null }); yield { kind: 'text' as const, text: 'ok' }; yield { kind: 'done' as const, finish: 'stop' as const };
    };
    const sessions = { async save(input: { sessionId: string; messages: readonly { role: 'user' | 'assistant'; content: string }[] }) { saved.set(input.sessionId, input.messages); },
      async list() { return [...saved.entries()].map(([sessionId, messages]) => ({ sessionId, updatedAtMs: 1, messages: messages.length, preview: 'p' })); },
      async load(id: string) { return saved.get(id) ?? null; } };
    const view = mountWorkline({ labels: WORKLINE_TEST_LABELS, streamTurn, sessions: sessions as never, panels: { ports: { model: { inspect: port.inspect } }, labels: terminalPanelLabels('en') } });
    mounted.push(view.instance);
    await settleWorkline(40);
    const pick = async (keys: string[], model: string) => {
      view.stdin.write(`/model${ENTER}`);
      await until(() => view.stdout.frame.includes('Models · scope'), 'model window');
      await settleWorkline(60);
      for (const key of [...keys, ENTER]) { view.stdin.write(key); await settleWorkline(30); }
      view.stdin.write(ENTER);
      await until(() => view.stdout.text.includes(`This session uses ${model} from the next turn`), `pinned ${model}`);
      await until(() => !view.stdout.frame.includes('Models · scope'), 'window closed');
    };
    const say = async (text: string, count: number) => { view.stdin.write(`${text}${ENTER}`); await until(() => turns.length === count, text); await settleWorkline(40); };
    // Conversation A pins L (fast).
    await pick([DOWN, DOWN], 'fast');
    await say('a1', 1);
    const a = turns[0]!.sessionId;
    expect(turns[0]).toEqual({ sessionId: a, reference: ref('fast') });
    // /clear: conversation B starts without a pin (the configured model), then pins R (chat).
    view.stdin.write(`/clear${ENTER}`); await until(() => view.stdout.text.includes('NEW-SESSION'), 'new session'); await settleWorkline(40);
    await say('b0', 2);
    const b = turns[1]!.sessionId;
    expect(b).not.toBe(a); expect(turns[1]!.reference).toBeNull();
    await pick([], 'chat');
    await say('b1', 3);
    expect(turns[2]).toEqual({ sessionId: b, reference: ref('chat') });
    // /resume A: A's own pin (L) again; nothing of A goes to R.
    view.stdin.write(`/resume ${a}${ENTER}`); await until(() => view.stdout.text.includes(`RESUMED`), 'resumed'); await settleWorkline(40);
    await say('a2', 4);
    expect(turns[3]).toEqual({ sessionId: a, reference: ref('fast') });
    expect(turns.filter(turn => turn.sessionId === a).map(turn => turn.reference)).toEqual([ref('fast'), ref('fast')]);
    // The window shows the resumed conversation's own pin.
    view.stdin.write(`/model${ENTER}`);
    await until(() => view.stdout.frame.includes('Models · scope'), 'model window again'); await settleWorkline(60);
    expect(view.stdout.frame).toContain('fast · this session'); expect(view.stdout.frame).not.toContain('chat · default · this session');
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
