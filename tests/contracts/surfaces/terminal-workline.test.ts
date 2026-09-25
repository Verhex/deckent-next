import { PassThrough, Writable } from 'node:stream';
import { createElement } from 'react';
import { render } from 'ink';
import { afterEach, describe, expect, it } from 'vitest';
import { appendLedger, boundAgentHistory, boundChatHistory, compactLedger, EMPTY_LEDGER, WorklineApp, WorklinePaletteProvider, resolveWorklinePalette,
  type WorklineLabels, type WorklineProps, type WorkLedgerEntry } from '#surfaces/core/terminal/index.js';
import type { WorkerObservationReport } from '#engine/index.js';

const labels: WorklineLabels = { banner: 'BANNER', prompt: '> ', statusReady: 'READY', statusBusy: 'BUSY', statusCancelling: 'CANCELLING',
  hint: 'HINT', roleUser: 'you', roleAssistant: 'bot', runCard: 'Run', workerCard: 'Worker', watchFailed: 'WATCH-FAILED',
  ledgerUnavailable: 'NO-LEDGER', runNotFound: 'NO-RUN', workersEmpty: 'NO-WORKERS', runsEmpty: 'NO-RUNS', serviceRestartUnavailable: 'NO-RESTART', queued: 'QUEUED', runUsage: 'USAGE', watchStarted: 'WATCH-ON',
  watchRunsStarted: 'RUNS-ON', watchStopped: 'WATCH-OFF', statusLine: 'STATUS-LINE', unknownCommand: 'UNKNOWN',
  render: { assistant: 'bot', thinking: 'THINKING {tokens} tok {seconds}s', thought: 'THOUGHT {seconds}s {tokens} tok', elapsed: '{seconds}s',
    tokens: '{prompt} in {completion} out', reasoningTokens: '{count} reasoning', truncated: 'TRUNCATED', cancelled: 'CANCELLED', failed: 'FAILED',
    code: 'code', moreAbove: '{count} more above', queued: '{count} queued', tool: 'TOOL {name} {target}', toolRunning: 'RUNNING {tool} {seconds}s',
    toolStatus: { error: 'TOOL-FAILED', denied: 'TOOL-DENIED', 'approval-required': 'TOOL-APPROVAL', 'invalid-arguments': 'TOOL-INVALID',
      duplicate: 'TOOL-DUPLICATE', cancelled: 'TOOL-CANCELLED' } },
  composer: { pasteChip: '[PASTE {lines}]', search: 'SEARCH', exitArmed: 'EXIT-ARMED', shortcuts: 'KEYS\nENTER-SENDS', slash: { 'terminal.slash.run': 'RUN-DESC', 'terminal.slash.runArgument': '<RUN-ID>' } } };
// The /help notice joins commands with " · "; the slash popup lists them one per row, so this only matches the notice.
const HELP_NOTICE = '/watch-runs · /watch-stop';

class Screen extends Writable {
  text = '';
  readonly isTTY = true; readonly columns = 200; readonly rows = 60;
  override _write(chunk: Buffer, _encoding: string, done: () => void) { this.text += chunk.toString('utf8'); done(); }
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
const mounted: Array<{ unmount(): void }> = [];
afterEach(() => { for (const instance of mounted.splice(0)) instance.unmount(); });

function mount(props: Partial<WorklineProps> & Pick<WorklineProps, 'completeTurn'>, tier: 'none' = 'none') {
  const stdout = new Screen(), stdin = keyboard();
  const instance = render(createElement(WorklinePaletteProvider, { palette: resolveWorklinePalette(tier), children: createElement(WorklineApp, {
    labels, target: 'scope-a · model', systemPrompt: 'SYSTEM', historyMessages: 4, errorText: (error: unknown) => `ERR:${(error as Error).message}`, ...props,
  }) }), { stdout: stdout as unknown as NodeJS.WriteStream, stdin: stdin as unknown as NodeJS.ReadStream, debug: true, exitOnCtrlC: false, patchConsole: false });
  mounted.push(instance);
  const type = async (text: string) => { for (const char of text) { stdin.write(char); await settle(2); } };
  return { stdout, stdin, instance, type };
}

function workers(count: number, offset: number): WorkerObservationReport {
  return { schemaVersion: 1, scopeId: 'scope-a', sources: [{ workers: Array.from({ length: count }, (_, index) => ({
    taskId: `task-${offset + index}`, process: 'running', provider: 'docker', authority: 'next-ledger' })) }] } as unknown as WorkerObservationReport;
}

describe('ledger buffer (Ink Static contract)', () => {
  it('submits when Enter arrives in the same input chunk as the text and keeps pasted newlines inside the message', async () => {
    const sent: string[] = [];
    const view = mount({ completeTurn: async messages => { sent.push(messages.at(-1)!.content); return 'ok'; } });
    await settle(20);
    view.stdin.write('hello there, one chunk\r');
    await until(() => sent.length === 1, 'chunked enter submits');
    expect(sent[0]).toBe('hello there, one chunk');
    view.stdin.write('first line\nsecond line');
    await settle(20);
    view.stdin.write('\r');
    await until(() => sent.length === 2, 'pasted lines submit on enter');
    expect(sent[1]).toBe('first line\nsecond line');
  });

  it('streams a turn: reasoning is narrated live, finished markdown goes to scrollback, and only the answer becomes history', async () => {
    const seen: string[][] = []; let release: () => void = () => undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const streamTurn = async function* (messages: readonly { role: string; content: string }[]) {
      seen.push(messages.map(message => `${message.role}:${message.content}`));
      yield { kind: 'reasoning' as const, text: 'SECRET-REASONING ' };
      await gate;
      yield { kind: 'text' as const, text: '## Title\nFirst **line**\n' };
      yield { kind: 'text' as const, text: 'tail' };
      yield { kind: 'usage' as const, promptTokens: 3, completionTokens: 4, reasoningTokens: 2 };
      yield { kind: 'done' as const, finish: 'stop' as const };
    };
    const view = mount({ completeTurn: async () => 'unused', streamTurn });
    await settle(20);
    view.stdin.write('hello\r');
    await until(() => view.stdout.text.includes('THINKING'), 'reasoning narration while thinking');
    release();
    await until(() => view.stdout.text.includes('First') && view.stdout.text.includes('tail') && view.stdout.text.includes('3 in 4 out'), 'answer and footer');
    expect(view.stdout.text).not.toContain('SECRET-REASONING');
    expect(view.stdout.text).not.toContain('**line**');
    view.stdin.write('again\r');
    await until(() => seen.length === 2, 'second turn');
    expect(seen[1]).toContain('assistant:## Title\nFirst **line**\ntail');
    expect(seen[1]!.join('\n')).not.toContain('SECRET-REASONING');
  });

  it('shows each tool call as one line, prints the closure note, and continues the next turn from the agent history', async () => {
    const seen: (readonly { role: string; content: string }[])[] = [];
    const call = { id: 'c1', name: 'read_file', argumentsJson: '{"path":"src/a.ts"}' };
    const streamTurn = async function* (messages: readonly { role: string; content: string }[]) {
      seen.push(messages);
      if (seen.length > 1) { yield { kind: 'text' as const, text: 'second' }; yield { kind: 'done' as const, finish: 'stop' as const }; return; }
      yield { kind: 'message' as const, message: { role: 'assistant' as const, content: '', toolCalls: [call] } };
      yield { kind: 'tool' as const, phase: 'started' as const, callId: 'c1', name: 'read_file', target: 'src/a.ts', status: null, ms: null };
      yield { kind: 'tool' as const, phase: 'finished' as const, callId: 'c1', name: 'read_file', target: 'src/a.ts', status: 'ok' as const, ms: 12 };
      yield { kind: 'message' as const, message: { role: 'tool' as const, toolCallId: 'c1', name: 'read_file', content: 'export const a = 1;' } };
      yield { kind: 'tool' as const, phase: 'started' as const, callId: 'c2', name: 'grep', target: 'secret', status: null, ms: null };
      yield { kind: 'tool' as const, phase: 'finished' as const, callId: 'c2', name: 'grep', target: 'secret', status: 'denied' as const, ms: 1 };
      yield { kind: 'done' as const, finish: 'error' as const, note: 'CLOSURE-NOTE' };
    };
    const view = mount({ completeTurn: async () => 'unused', streamTurn, historyMessages: 10 });
    await settle(20);
    view.stdin.write('read it\r');
    await until(() => view.stdout.text.includes('CLOSURE-NOTE'), 'closure note');
    expect(view.stdout.text).toContain('TOOL read_file src/a.ts');
    expect(view.stdout.text).toContain('TOOL grep secret'); expect(view.stdout.text).toContain('TOOL-DENIED');
    // The tool result is history, never printed as the answer.
    expect(view.stdout.text).not.toContain('export const a = 1;');
    view.stdin.write('again\r');
    await until(() => seen.length === 2, 'second turn');
    expect(seen[1]!.map(message => message.role)).toEqual(['system', 'user', 'assistant', 'tool', 'user']);
    expect(seen[1]![3]).toMatchObject({ role: 'tool', toolCallId: 'c1', content: 'export const a = 1;' });
  });

  it('bounds agent history at a user message so a tool result never loses the call that asked for it', () => {
    const system = { role: 'system' as const, content: 'S' };
    const call = { id: 'c', name: 'read_file', argumentsJson: '{}' };
    const exchange = (n: number) => [{ role: 'user' as const, content: `u${n}` }, { role: 'assistant' as const, content: '', toolCalls: [call] },
      { role: 'tool' as const, toolCallId: 'c', name: 'read_file', content: `r${n}` }, { role: 'assistant' as const, content: `a${n}`, toolCalls: [] }];
    const history = [...exchange(1), ...exchange(2), ...exchange(3)];
    expect(boundAgentHistory(system, history, 6)).toEqual([system, ...exchange(3)]);
    expect(boundAgentHistory(system, history, 9)).toEqual([system, ...exchange(2), ...exchange(3)]);
    // The newest exchange stays whole even when it alone exceeds the limit.
    expect(boundAgentHistory(system, history, 2)).toEqual([system, ...exchange(3)]);
  });

  it('keeps appending after any number of rows and bounds only the bridge tail', () => {
    let buffer = EMPTY_LEDGER;
    const notice = (index: number): WorkLedgerEntry => ({ schemaVersion: 1, kind: 'notice', id: 'n', level: 'info', text: `n${index}` });
    for (let index = 0; index < 1000; index++) {
      buffer = appendLedger(buffer, [notice(index)]);
      buffer = compactLedger(buffer, buffer.pending.length);
    }
    expect(buffer.nextSeq).toBe(1000); expect(buffer.pending.length).toBeLessThan(64); expect(buffer.tail).toHaveLength(200);
    expect(buffer.epoch).toBeGreaterThan(10);
    const partial = compactLedger(appendLedger(buffer, Array.from({ length: 70 }, (_, index) => notice(index))), 64);
    expect(partial.pending.map(row => row.seq)).toEqual(Array.from({ length: partial.pending.length }, (_, index) => partial.nextSeq - partial.pending.length + index));
  });

  it('keeps the system instruction when bounding chat history', () => {
    const system = { role: 'system' as const, content: 'S' };
    const history = Array.from({ length: 9 }, (_, index) => ({ role: 'user' as const, content: `u${index}` }));
    expect(boundChatHistory(system, [system, ...history], 4)).toEqual([system, { role: 'user', content: 'u6' }, { role: 'user', content: 'u7' }, { role: 'user', content: 'u8' }]);
  });
});

describe('workline view rendered by Ink', () => {
  it('renders pushed worker cards and does not poll when a follow port is connected', async () => {
    let polls = 0;
    async function* followWorkers() {
      yield [{ schemaVersion: 1 as const, kind: 'worker' as const, id: 'w', scopeId: 'scope-a', taskId: 'pushed-task', process: 'running', provider: 'docker', authority: 'next' }];
    }
    const view = mount({ completeTurn: async () => 'ok', pollMs: 5, ledger: { scopeId: 'scope-a',
      async listWorkers() { polls += 1; return workers(1, 0); }, async inspectRun() { return null; }, followWorkers } });
    await view.type('/watch-workers\r');
    await until(() => view.stdout.text.includes('pushed-task'), 'pushed worker');
    await settle(40);
    expect(polls).toBe(0);
  });

  it('prints every ledger row past the former 400-row cap', async () => {
    let offset = 0;
    const view = mount({ completeTurn: async () => 'unused', ledger: { scopeId: 'scope-a', async listWorkers() { const report = workers(300, offset); offset += 300; return report; },
      async inspectRun() { return null; } } });
    await view.type('/workers\r'); await until(() => view.stdout.text.includes('task-299'), 'first page');
    await view.type('/workers\r'); await until(() => view.stdout.text.includes('task-599'), 'second page');
    await view.type('/help\r'); await until(() => view.stdout.text.includes(HELP_NOTICE), 'help after 600 rows');
    for (const id of ['task-0', 'task-401', 'task-599']) expect(view.stdout.text).toContain(id);
  });

  it('appends one inspection card per inventory run and does not invent a run', async () => {
    const seen: string[] = [];
    const view = mount({ completeTurn: async () => 'unused', ledger: { scopeId: 'scope-a',
      async listWorkers() { return workers(0, 0); },
      async listRunIds() { return ['run-a', 'run-b']; },
      async inspectRun(runId: string) {
        seen.push(runId);
        return { runId, scopeId: 'scope-a', revision: 3, cancellationRequested: false, tasks: [{ phase: 'running' }] } as never;
      } } });
    await view.type('/runs\r');
    await until(() => view.stdout.text.includes('run-a') && view.stdout.text.includes('run-b'), 'run cards');
    expect(seen).toEqual(['run-a', 'run-b']);
  });

  it('reports an empty inventory and refuses /runs when inventory is not wired', async () => {
    const empty = mount({ completeTurn: async () => 'unused', ledger: { scopeId: 'scope-a',
      async listWorkers() { return workers(0, 0); }, async listRunIds() { return []; }, async inspectRun() { return null; } } });
    await empty.type('/runs\r');
    await until(() => empty.stdout.text.includes('NO-RUNS'), 'empty inventory');
    const unwired = mount({ completeTurn: async () => 'unused', ledger: { scopeId: 'scope-a',
      async listWorkers() { return workers(0, 0); }, async inspectRun() { return null; } } });
    await unwired.type('/runs\r');
    await until(() => unwired.stdout.text.includes('NO-LEDGER'), 'inventory not wired');
  });

  it('closes the view with /exit after a completed turn', async () => {
    const view = mount({ completeTurn: async () => { await settle(40); return 'Ankara'; } });
    await view.type('capital\r');
    await until(() => view.stdout.text.includes('● bot') && view.stdout.text.includes('  Ankara'), 'assistant reply');
    let exited = false;
    void view.instance.waitUntilExit().then(() => { exited = true; });
    await view.type('/exit\r');
    await until(() => exited, '/exit after turn');
  });

  it('cancels a running turn with Ctrl+C or Esc instead of exiting, then exits on a second idle Ctrl+C', async () => {
    const seen: string[][] = []; let aborted = 0;
    const view = mount({ completeTurn: (messages, signal) => new Promise((_resolve, reject) => {
      seen.push(messages.map(message => message.role));
      signal.addEventListener('abort', () => { aborted++; reject(new Error('TURN-ABORTED')); }, { once: true });
    }) });
    await view.type('hello\r'); await until(() => seen.length === 1, 'first turn');
    view.stdin.write('\u0003'); await until(() => aborted === 1, 'ctrl+c cancels busy turn');
    await until(() => view.stdout.text.includes('ERR:TURN-ABORTED'), 'cancel notice');
    await view.type('again\r'); await until(() => seen.length === 2, 'second turn');
    // Enter while busy queues the line instead of dropping or blocking it; it runs once the turn has finished.
    await view.type('/help\r'); await until(() => view.stdout.text.includes('QUEUED: /help'), 'input queued while busy');
    expect(view.stdout.text).not.toContain(HELP_NOTICE);
    view.stdin.write('\u001b'); await until(() => aborted === 2, 'esc cancels');
    await until(() => view.stdout.text.includes(HELP_NOTICE), 'queued line runs after the turn');
    expect(seen).toEqual([['system', 'user'], ['system', 'user', 'user']]);
    let exited = false; void view.instance.waitUntilExit().then(() => { exited = true; });
    // Idle Ctrl+C on an empty draft arms exit with a notice; the second press inside the window exits.
    await settle(50); view.stdin.write('\u0003'); await until(() => view.stdout.text.includes('EXIT-ARMED'), 'first idle ctrl+c arms');
    expect(exited).toBe(false);
    view.stdin.write('\u0003'); await until(() => exited, 'second idle ctrl+c exits');
  });

  // Astra 2054 R3: one serialized drain follows every line kind. Debug output repeats rows, so single execution is proven by port counters.
  it('drains the queue past an immediate slash command: text, /status, text all run in order and once', async () => {
    const sent: string[] = []; const gates: Array<() => void> = [];
    const view = mount({ completeTurn: messages => new Promise(resolve => {
      sent.push(messages.at(-1)!.content); gates.push(() => resolve(`REPLY-${sent.length}`));
    }) });
    await view.type('one\r'); await until(() => sent.length === 1, 'first turn busy');
    await view.type('two\r'); await view.type('/status\r'); await view.type('three\r');
    await until(() => view.stdout.text.includes('QUEUED: three'), 'three lines queued');
    gates[0]!(); await until(() => sent.length === 2, 'queued text turn');
    expect(view.stdout.text).not.toContain('STATUS-LINE');
    gates[1]!(); await until(() => view.stdout.text.includes('STATUS-LINE') && sent.length === 3, '/status then the next text turn');
    gates[2]!(); await until(() => view.stdout.text.includes('REPLY-3'), 'last reply');
    await settle(40);
    expect(sent).toEqual(['one', 'two', 'three']);
  });

  it('drains the queue after an awaited slash operation, once and in order', async () => {
    const sent: string[] = []; let calls = 0, release: () => void = () => undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const view = mount({ completeTurn: async messages => { sent.push(messages.at(-1)!.content); return 'REPLY-AFTER'; },
      ledger: { scopeId: 'scope-a', async listWorkers() { calls++; await gate; return workers(1, 0); }, async inspectRun() { return null; } } });
    await view.type('/workers\r'); await until(() => calls === 1, '/workers pending');
    await view.type('after\r'); await until(() => view.stdout.text.includes('QUEUED: after'), 'text queued behind /workers');
    await settle(40);
    expect(sent).toEqual([]);
    release();
    await until(() => sent.length === 1 && view.stdout.text.includes('REPLY-AFTER'), 'queued text runs after /workers');
    await settle(40);
    expect(calls).toBe(1); expect(sent).toEqual(['after']);
    expect(view.stdout.text.indexOf('task-0')).toBeLessThan(view.stdout.text.indexOf('REPLY-AFTER'));
  });

  it('applies queued watch toggles in order and exits on a queued /exit without running what follows it', async () => {
    const sent: string[] = []; const gates: Array<() => void> = [];
    const view = mount({ completeTurn: messages => new Promise(resolve => { sent.push(messages.at(-1)!.content); gates.push(() => resolve('ok')); }),
      ledger: { scopeId: 'scope-a', async listWorkers() { return workers(0, 0); }, async inspectRun() { return null; } } });
    let exited = false; void view.instance.waitUntilExit().then(() => { exited = true; });
    await view.type('one\r'); await until(() => sent.length === 1, 'turn busy');
    for (const line of ['/watch-workers', '/watch-stop', 'two', '/exit', 'never']) await view.type(`${line}\r`);
    await until(() => view.stdout.text.includes('QUEUED: never'), 'lines queued');
    gates[0]!(); await until(() => sent.length === 2, 'queued text turn after the watch toggles');
    // A stale watch would make the queued /watch-stop a no-op: both toggles must be applied in order before `two`.
    expect(view.stdout.text).toContain('WATCH-ON'); expect(view.stdout.text).toContain('WATCH-OFF');
    expect(exited).toBe(false);
    gates[1]!(); await until(() => exited, 'queued /exit closes the view');
    await settle(40);
    expect(sent).toEqual(['one', 'two']);
  });

  it('renders no colour escape sequences at the none tier (NO_COLOR / --no-color / non-TTY)', async () => {
    const plain = mount({ completeTurn: async () => 'ok', ledger: { scopeId: 'scope-a', async listWorkers() { return workers(1, 0); }, async inspectRun() { return null; } } }, 'none');
    await plain.type('/workers\r'); await until(() => plain.stdout.text.includes('task-0'), 'plain worker');
    const colour = new RegExp(`${String.fromCharCode(27)}\\[(3[0-7]|9[0-7]|38;)`);
    expect(plain.stdout.text).not.toMatch(colour);
  });

  it('reports a failing watch once per failure streak, never overlaps polls, and stops polling on /watch-stop', async () => {
    let calls = 0, active = 0, overlap = 0, reported = 0;
    const view = mount({ completeTurn: async () => 'ok', pollMs: 5, errorText: error => { reported++; return `ERR:${(error as Error).message}`; },
      ledger: { scopeId: 'scope-a', async listWorkers() {
        calls++; active++; if (active > 1) overlap++;
        await settle(15); active--; throw new Error('probe down');
      }, async inspectRun() { return null; } } });
    await view.type('/watch-workers\r'); await until(() => calls >= 5, 'several polls');
    expect(reported).toBe(1); expect(overlap).toBe(0);
    await view.type('/watch-stop\r'); await until(() => view.stdout.text.includes('WATCH-OFF'), 'stopped');
    const after = calls; await settle(120);
    expect(calls - after).toBeLessThanOrEqual(1);
  });
});
