import { PassThrough, Writable } from 'node:stream';
import { createElement } from 'react';
import { render } from 'ink';
import { afterEach, describe, expect, it } from 'vitest';
import { appendLedger, boundChatHistory, compactLedger, EMPTY_LEDGER, WorklineApp, WorklinePaletteProvider, resolveWorklinePalette,
  type WorklineLabels, type WorklineProps, type WorkLedgerEntry } from '#surfaces/core/terminal/index.js';
import type { WorkerObservationReport } from '#engine/index.js';

const labels: WorklineLabels = { banner: 'BANNER', prompt: '> ', statusReady: 'READY', statusBusy: 'BUSY', statusCancelling: 'CANCELLING',
  hint: 'HINT', roleUser: 'you', roleAssistant: 'bot', runCard: 'Run', workerCard: 'Worker', watchFailed: 'WATCH-FAILED',
  ledgerUnavailable: 'NO-LEDGER', runNotFound: 'NO-RUN', workersEmpty: 'NO-WORKERS', runUsage: 'USAGE', watchStarted: 'WATCH-ON',
  watchRunsStarted: 'RUNS-ON', watchStopped: 'WATCH-OFF', statusLine: 'STATUS-LINE', unknownCommand: 'UNKNOWN' };

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
  it('prints every ledger row past the former 400-row cap', async () => {
    let offset = 0;
    const view = mount({ completeTurn: async () => 'unused', ledger: { scopeId: 'scope-a', async listWorkers() { const report = workers(300, offset); offset += 300; return report; },
      async inspectRun() { return null; } } });
    await view.type('/workers\r'); await until(() => view.stdout.text.includes('task-299'), 'first page');
    await view.type('/workers\r'); await until(() => view.stdout.text.includes('task-599'), 'second page');
    await view.type('/help\r'); await until(() => view.stdout.text.includes('/watch-runs'), 'help after 600 rows');
    for (const id of ['task-0', 'task-401', 'task-599']) expect(view.stdout.text).toContain(id);
  });

  it('cancels a running turn with Ctrl+C or Esc instead of exiting, then exits on idle Ctrl+C', async () => {
    const seen: string[][] = []; let aborted = 0;
    const view = mount({ completeTurn: (messages, signal) => new Promise((_resolve, reject) => {
      seen.push(messages.map(message => message.role));
      signal.addEventListener('abort', () => { aborted++; reject(new Error('TURN-ABORTED')); }, { once: true });
    }) });
    await view.type('hello\r'); await until(() => seen.length === 1, 'first turn');
    view.stdin.write('\u0003'); await until(() => aborted === 1, 'ctrl+c cancels busy turn');
    await until(() => view.stdout.text.includes('ERR:TURN-ABORTED'), 'cancel notice');
    await view.type('again\r'); await until(() => seen.length === 2, 'second turn');
    view.stdin.write('\u001b'); await until(() => aborted === 2, 'esc cancels');
    expect(seen).toEqual([['system', 'user'], ['system', 'user', 'user']]);
    let exited = false; void view.instance.waitUntilExit().then(() => { exited = true; });
    await settle(50); view.stdin.write('\u0003'); await until(() => exited, 'idle ctrl+c exits');
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
