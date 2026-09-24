import { PassThrough, Writable } from 'node:stream';
import { createElement, type ReactElement } from 'react';
import { render } from 'ink';
import { afterEach, describe, expect, it } from 'vitest';
import { AssistantLive, WorklineApp, WorklinePaletteProvider, resolveWorklinePalette, type AssistantRenderLabels, type ColorTier,
  type WorklineLabels, type WorklineProps } from '#surfaces/core/terminal/index.js';

const render_: AssistantRenderLabels = { assistant: 'bot', thinking: 'THINKING {tokens} tok {seconds}s', thought: 'THOUGHT {seconds}s {tokens} tok',
  elapsed: '{seconds}s', tokens: '{prompt} in {completion} out', reasoningTokens: '{count} reasoning', truncated: 'TRUNCATED', cancelled: 'CANCELLED',
  failed: 'FAILED', code: 'code', moreAbove: '{count} more above', queued: '{count} queued' };
const labels: WorklineLabels = { banner: 'BANNER', prompt: '> ', statusReady: 'READY', statusBusy: 'BUSY', statusCancelling: 'CANCELLING',
  hint: 'HINT', roleUser: 'you', roleAssistant: 'bot', runCard: 'Run', workerCard: 'Worker', watchFailed: 'WATCH-FAILED',
  ledgerUnavailable: 'NO-LEDGER', runNotFound: 'NO-RUN', workersEmpty: 'NO-WORKERS', runsEmpty: 'NO-RUNS', serviceRestartUnavailable: 'NO-RESTART', queued: 'QUEUED',
  runUsage: 'USAGE', watchStarted: 'WATCH-ON', watchRunsStarted: 'RUNS-ON', watchStopped: 'WATCH-OFF', statusLine: 'STATUS-LINE', unknownCommand: 'UNKNOWN', render: render_,
  composer: { pasteChip: '[PASTE {lines}]', search: 'SEARCH', exitArmed: 'EXIT-ARMED', shortcuts: 'KEYS\nENTER-SENDS', slash: { 'terminal.slash.run': 'RUN-DESC', 'terminal.slash.runArgument': '<RUN-ID>' } } };

/** Ink debug mode writes the whole frame (static + dynamic) on every render; `last` is the current screen. */
class Screen extends Writable {
  text = ''; last = '';
  readonly isTTY = true; readonly rows = 60;
  constructor(public columns = 100) { super(); }
  override _write(chunk: Buffer, _encoding: string, done: () => void) { const value = chunk.toString('utf8'); this.text += value; this.last = value; done(); }
}
function keyboard() {
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() { return stdin; }, ref() { return stdin; }, unref() { return stdin; } });
  return stdin;
}
const settle = (ms = 30) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean, label: string) {
  for (let attempt = 0; attempt < 200; attempt++) { if (check()) return; await settle(10); }
  throw new Error(`timed out waiting for ${label}`);
}
const COLOUR = new RegExp(`${String.fromCharCode(27)}\\[(3[0-7]|9[0-7]|38;)`);
const mounted: Array<{ unmount(): void }> = [];
afterEach(() => { for (const instance of mounted.splice(0)) instance.unmount(); });

function mountElement(element: ReactElement, tier: ColorTier = 'none', columns = 100) {
  const stdout = new Screen(columns), stdin = keyboard();
  const wrap = (child: ReactElement) => createElement(WorklinePaletteProvider, { palette: resolveWorklinePalette(tier), children: child });
  const instance = render(wrap(element), { stdout: stdout as unknown as NodeJS.WriteStream, stdin: stdin as unknown as NodeJS.ReadStream, debug: true, exitOnCtrlC: false, patchConsole: false });
  mounted.push(instance);
  return { stdout, stdin, rerender: (next: ReactElement) => instance.rerender(wrap(next)), type: async (text: string) => { for (const char of text) { stdin.write(char); await settle(2); } } };
}
function mountWorkline(props: Partial<WorklineProps> & Pick<WorklineProps, 'completeTurn'>, tier: ColorTier = 'none', columns = 100) {
  return mountElement(createElement(WorklineApp, { labels, target: 'scope-a · model', systemPrompt: 'SYSTEM', historyMessages: 4, errorText: (error: unknown) => `ERR:${(error as Error).message}`, ...props }), tier, columns);
}

const REPLY = ['# Plan', 'Use **bold** and `npm test`.', '', '```ts', 'const answer = 42; // ok', '```', '', '| Step | Owner |', '|---|---|', '| build | ci |'].join('\n');

describe('rendered assistant output in the Ink workline', () => {
  it('renders a complete reply as markdown units with a lead line and a footer, without raw markers or colour at the none tier', async () => {
    const view = mountWorkline({ completeTurn: async () => REPLY });
    await view.type('plan\r');
    await until(() => view.stdout.text.includes('└'), 'rendered reply');
    const screen = view.stdout.last;
    for (const expected of ['● bot', '  Plan', '  Use bold and npm test.', '  ╭─ ts', '  │ const answer = 42; // ok', '  ╰─', '  │ Step  │ Owner │', '  │ build │ ci    │'])
      expect(screen).toContain(expected);
    expect(screen).toMatch(/\n {2}\d+\.\ds\n/);
    expect(screen).not.toContain('```'); expect(screen).not.toContain('**');
    expect(view.stdout.text).not.toMatch(COLOUR);
  });

  it('resolves the rendered-answer roles per tier: colours and attributes at ansi16, nothing at none', () => {
    const colour = resolveWorklinePalette('ansi16'), none = resolveWorklinePalette('none');
    expect([colour.code.color, colour.success.color, colour.warning.color, colour.link.underline]).toEqual(['blueBright', 'green', 'yellow', true]);
    expect([colour.strong, colour.emphasis, colour.strike]).toEqual([{ bold: true }, { italic: true }, { strikethrough: true }]);
    for (const role of ['code', 'link', 'info', 'success', 'warning', 'strong', 'emphasis', 'strike'] as const) expect(none[role]).toEqual({});
  });

  it('keeps the status row on one line at 40 columns with a long scope', async () => {
    const view = mountWorkline({ completeTurn: async () => 'ok', target: 'company-acme/site-istanbul/project-erp · local-qwen-32b' }, 'none', 40);
    await until(() => view.stdout.last.includes('READY'), 'status row');
    const row = view.stdout.last.split('\n').find(text => text.includes('READY'))!;
    expect(row.length).toBeLessThanOrEqual(40);
    expect(row.startsWith('…')).toBe(true);
  });

  it('re-fits the status row when the terminal narrows', async () => {
    const view = mountWorkline({ completeTurn: async () => 'ok', target: 'company-acme/site-istanbul/project-erp · local-qwen-32b' }, 'none', 120);
    await until(() => view.stdout.last.includes('company-acme/site-istanbul'), 'wide status row');
    view.stdout.columns = 36; view.stdout.emit('resize');
    await until(() => (view.stdout.last.split('\n').find(text => text.includes('READY'))?.length ?? 99) <= 36, 'narrowed status row');
  });
});

describe('streaming live region', () => {
  it('shows the reasoning narration only until the answer starts, then the lead and the live tail', async () => {
    const view = mountElement(createElement(AssistantLive, { tail: { markdown: '', open: null }, narration: { tokens: 3, approximate: true, startedAtMs: Date.now() }, labels: render_, lead: true }));
    await until(() => view.stdout.last.includes('THINKING ~3 tok 0s'), 'narration');
    view.rerender(createElement(AssistantLive, { tail: { markdown: 'Partial **answer', open: null }, narration: null, labels: render_, lead: true }));
    await until(() => view.stdout.last.includes('Partial'), 'live tail');
    expect(view.stdout.last).not.toContain('THINKING');
    expect(view.stdout.last).toContain('● bot');
  });

  it('renders an open fence live, bounded to its last lines', async () => {
    const code = Array.from({ length: 20 }, (_, index) => `echo ${index}`).join('\n');
    const view = mountElement(createElement(AssistantLive, { tail: { markdown: `\`\`\`sh\n${code}`, open: 'code' }, narration: null, labels: render_, lead: false }));
    await until(() => view.stdout.last.includes('echo 19'), 'open fence tail');
    expect(view.stdout.last).toContain('… 13 more above');
    expect(view.stdout.last).toContain('│ echo 12');
    expect(view.stdout.last).not.toContain('echo 11\n');
    expect(view.stdout.last).not.toContain('╰─');
  });
});
