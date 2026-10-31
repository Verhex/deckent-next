import { panelFixture } from '../support/workline-panel-fixture.js';
import { PassThrough, Writable } from 'node:stream';
import { createElement } from 'react';
import { render } from 'ink';
import { afterEach, describe, expect, it } from 'vitest';
import { WorklineApp, WorklinePaletteProvider, resolveWorklinePalette, type WorklineLabels, type WorklineProps } from '#surfaces/core/terminal/index.js';
import { terminalComposerLabels, terminalHandoffLabels } from '#surfaces/core/terminal-labels/index.js';
import type { ExternalEditorOutcome } from '#surfaces/core/terminal-host/index.js';

/**
 * T3 (Codex Alt+Up) and T4 (Claude Code / Codex Ctrl+G) on the workline: a queued message is taken back into the empty draft before it runs, and the
 * draft goes to the person's editor and back. Rows that arrive while the editor owns the screen are printed after it, never lost.
 */
const labels: WorklineLabels = { banner: 'BANNER', prompt: '> ', statusReady: 'READY', statusBusy: 'BUSY', statusCancelling: 'CANCELLING', hint: 'HINT',
  roleUser: 'you', roleAssistant: 'bot', runCard: 'Run', workerCard: 'Worker', watchFailed: 'WATCH-FAILED', commandUnavailable: 'NO-PORT {part}',
  ledgerUnavailable: 'NO-LEDGER', runNotFound: 'NO-RUN', workersEmpty: 'NO-WORKERS', runsEmpty: 'NO-RUNS', serviceRestartUnavailable: 'NO-RESTART', queued: 'QUEUED',
  runUsage: 'USAGE', statusLine: 'STATUS-LINE', unknownCommand: 'UNKNOWN',
  render: { assistant: 'bot', thinking: 'THINKING', thought: 'THOUGHT', elapsed: '{seconds}s', tokens: '{prompt} in {completion} out', reasoningTokens: '{count}',
    truncated: 'TRUNCATED', cancelled: 'CANCELLED', failed: 'FAILED', code: 'code', moreAbove: '{count} more above', queued: '{count} queued', tool: 'TOOL {name} {target}',
    toolRunning: 'RUNNING {tool} {seconds}s', toolStatus: { error: 'E', denied: 'D', 'approval-required': 'A', 'invalid-arguments': 'I', duplicate: 'U', cancelled: 'C' },
    context: 'CTX', compacted: 'COMPACTED {count}' },
  composer: { pasteChip: '[PASTE {lines}]', search: 'SEARCH', exitArmed: 'EXIT-ARMED', shortcuts: 'KEYS', slash: {} },
  handoff: { withdrawn: 'BACK: {text}', editor: { 'no-editor': 'NO-EDITOR', 'not-started': 'NOT-STARTED', exit: 'EDITOR-EXIT', 'too-large': 'TOO-LARGE', unsafe: 'UNSAFE', failed: 'EDITOR-FAILED' } } };
const ALT_UP = '\u001b[1;3A', CTRL_G = '\u0007';

class Screen extends Writable {
  text = '';
  readonly isTTY = true; readonly columns = 160; readonly rows = 50;
  override _write(chunk: Buffer, _encoding: string, done: () => void) { this.text += chunk.toString('utf8'); done(); }
}
const settle = (ms = 30) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean, label: string) {
  for (let attempt = 0; attempt < 200; attempt++) { if (check()) return; await settle(10); }
  throw new Error(`timed out waiting for ${label}`);
}
const mounted: Array<{ unmount(): void }> = [];
afterEach(() => { for (const instance of mounted.splice(0)) instance.unmount(); });

function mount(props: Partial<WorklineProps> & Pick<WorklineProps, 'completeTurn'>) {
  const stdout = new Screen();
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() { return stdin; }, ref() { return stdin; }, unref() { return stdin; } });
  const instance = render(createElement(WorklinePaletteProvider, { palette: resolveWorklinePalette('none'), children: createElement(WorklineApp, {
    labels, target: 'scope-a · model', systemPrompt: 'SYSTEM', historyMessages: 4, errorText: (error: unknown) => `ERR:${(error as Error).message}`, ...props, ...panelFixture(props),
  }) }), { stdout: stdout as unknown as NodeJS.WriteStream, stdin: stdin as unknown as NodeJS.ReadStream, debug: true, exitOnCtrlC: false, patchConsole: false });
  mounted.push(instance);
  const type = async (text: string) => { for (const char of text) { stdin.write(char); await settle(2); } };
  return { stdout, stdin, type };
}
function gatedTurns() {
  const sent: string[] = [], gates: Array<() => void> = [];
  const completeTurn: WorklineProps['completeTurn'] = messages => new Promise(resolve => { sent.push(messages.at(-1)!.content); gates.push(() => resolve(`REPLY-${sent.length}`)); });
  return { sent, gates, completeTurn };
}

describe('T3 Alt+Up takes the last queued message back (workline)', () => {
  it('withdraws the newest queued message into the empty draft; it never runs, the rest keep their order and the edit queues again', async () => {
    const turns = gatedTurns(), view = mount({ completeTurn: turns.completeTurn });
    await view.type('one\r'); await until(() => turns.sent.length === 1, 'first turn busy');
    await view.type('two\r'); await view.type('three\r');
    await until(() => view.stdout.text.includes('• three'), 'two lines queued');
    view.stdin.write(ALT_UP);
    await until(() => view.stdout.text.includes('BACK: three') && view.stdout.text.includes('> three|'), 'three back in the draft');
    // A draft is never replaced: a second Alt+Up leaves `two` queued.
    view.stdin.write(ALT_UP); await settle(40);
    expect(view.stdout.text).not.toContain('BACK: two');
    await view.type(' again\r'); await until(() => view.stdout.text.includes('• three again'), 'edited line queued again');
    turns.gates[0]!(); await until(() => turns.sent.length === 2, 'second turn');
    turns.gates[1]!(); await until(() => turns.sent.length === 3, 'third turn');
    turns.gates[2]!(); await until(() => view.stdout.text.includes('REPLY-3'), 'last reply');
    expect(turns.sent).toEqual(['one', 'two', 'three again']);
  });

  it('takes nothing back once the queued message has started or when nothing waits', async () => {
    const turns = gatedTurns(), view = mount({ completeTurn: turns.completeTurn });
    view.stdin.write(ALT_UP); await settle(30);
    await view.type('one\r'); await until(() => turns.sent.length === 1, 'first turn busy');
    await view.type('two\r'); await until(() => view.stdout.text.includes('• two'), 'queued');
    turns.gates[0]!(); await until(() => turns.sent.length === 2, 'two started');
    view.stdin.write(ALT_UP); await settle(40);
    expect(view.stdout.text).not.toContain('BACK:');
    turns.gates[1]!(); await until(() => view.stdout.text.includes('REPLY-2'), 'two answered once');
    expect(turns.sent).toEqual(['one', 'two']);
  });
});

describe('T4 Ctrl+G edits the draft in the external editor (workline)', () => {
  it('replaces the draft with the edited text and prints rows that arrived while the editor was open', async () => {
    const turns = gatedTurns(); let finish: (outcome: ExternalEditorOutcome) => void = () => undefined; const opened: string[] = [];
    const handover = { released: 0, reclaimed: 0, release() { this.released++; }, reclaim() { this.reclaimed++; } };
    const view = mount({ completeTurn: turns.completeTurn, handover, externalEditor: { edit: text => { opened.push(text); return new Promise(resolve => { finish = resolve; }); } } });
    await view.type('one\r'); await until(() => turns.sent.length === 1, 'turn busy');
    await view.type('draft'); view.stdin.write(CTRL_G);
    await until(() => opened.length === 1, 'editor opened'); expect(opened).toEqual(['draft']);
    expect(handover.released).toBe(1);
    // The reply lands while the editor owns the screen: it waits and is printed once the editor is done.
    turns.gates[0]!(); await settle(60);
    finish({ kind: 'edited', text: 'draft from the editor\n' });
    await until(() => view.stdout.text.includes('REPLY-1') && view.stdout.text.includes('> draft from the editor|'), 'reply printed and draft replaced');
    expect(handover.reclaimed).toBe(1);
    await view.type('\r'); await until(() => turns.sent.length === 2, 'edited draft sent');
    expect(turns.sent[1]).toBe('draft from the editor');
  });

  it('keeps the draft and says why when the editor refuses; without an editor Ctrl+G stays Esc', async () => {
    const turns = gatedTurns();
    const view = mount({ completeTurn: turns.completeTurn, externalEditor: { edit: async () => ({ kind: 'refused', reason: 'no-editor' }) } });
    await view.type('mine'); view.stdin.write(CTRL_G);
    await until(() => view.stdout.text.includes('NO-EDITOR'), 'refusal notice');
    await view.type('!'); await until(() => view.stdout.text.includes('> mine!|'), 'draft kept');
    let started = 0, aborted = 0;
    const bare = mount({ completeTurn: (_messages, signal) => new Promise((_resolve, reject) => {
      started++; signal.addEventListener('abort', () => { aborted++; reject(new Error('TURN-ABORTED')); }, { once: true });
    }) });
    await bare.type('x\r'); await until(() => started === 1, 'busy');
    bare.stdin.write(CTRL_G); await until(() => aborted === 1, 'Ctrl+G cancels like Esc');
  });

  it('carries the help lines and the refusal words in both languages', () => {
    for (const locale of ['en', 'tr'] as const) {
      const shortcuts = terminalComposerLabels(locale).shortcuts.split('\n');
      expect(shortcuts.at(-4)).toMatch(/^Alt\+/u); expect(shortcuts.at(-3)).toMatch(/^Ctrl\+Enter /u); expect(shortcuts.at(-2)).toMatch(/^Ctrl\+G /u);
      expect(Object.keys(terminalHandoffLabels(locale).editor).sort()).toEqual(['exit', 'failed', 'no-editor', 'not-started', 'too-large', 'unsafe']);
    }
    expect(terminalHandoffLabels('tr').withdrawn).not.toBe(terminalHandoffLabels('en').withdrawn);
  });
});
