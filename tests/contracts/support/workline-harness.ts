import { PassThrough, Writable } from 'node:stream';
import { createElement } from 'react';
import { render } from 'ink';
import { WorklineApp, WorklinePaletteProvider, resolveWorklinePalette, type WorklineLabels, type WorklineProps } from '#surfaces/core/terminal/index.js';

/** Placeholder labels: tests assert on these tokens, never on catalog text. */
export const WORKLINE_TEST_LABELS: WorklineLabels = { banner: 'BANNER', prompt: '> ', statusReady: 'READY', statusBusy: 'BUSY', statusCancelling: 'CANCELLING',
  hint: 'HINT', roleUser: 'you', roleAssistant: 'bot', runCard: 'Run', workerCard: 'Worker', watchFailed: 'WATCH-FAILED',
  ledgerUnavailable: 'NO-LEDGER', runNotFound: 'NO-RUN', workersEmpty: 'NO-WORKERS', runsEmpty: 'NO-RUNS', serviceRestartUnavailable: 'NO-RESTART', queued: 'QUEUED',
  runUsage: 'USAGE', watchStarted: 'WATCH-ON', watchRunsStarted: 'RUNS-ON', watchStopped: 'WATCH-OFF', statusLine: 'STATUS-LINE', unknownCommand: 'UNKNOWN',
  render: { assistant: 'bot', thinking: 'THINKING {tokens} tok {seconds}s', thought: 'THOUGHT {seconds}s {tokens} tok', elapsed: '{seconds}s',
    tokens: '{prompt} in {completion} out', reasoningTokens: '{count} reasoning', truncated: 'TRUNCATED', cancelled: 'CANCELLED', failed: 'FAILED',
    code: 'code', moreAbove: '{count} more above', queued: '{count} queued', tool: 'TOOL {name} {target}', toolRunning: 'RUNNING {tool} {seconds}s',
    toolStatus: { error: 'TOOL-FAILED', denied: 'TOOL-DENIED', 'approval-required': 'TOOL-APPROVAL', 'invalid-arguments': 'TOOL-INVALID',
      duplicate: 'TOOL-DUPLICATE', cancelled: 'TOOL-CANCELLED' }, context: 'CTX {approx}{percent}% of {window}', compacted: 'COMPACTED {count}' },
  sessions: { entry: 'SESSION {index} {session} {count} {preview}', none: 'NO-SESSIONS', notFound: 'SESSION-NOT-FOUND', unavailable: 'NO-SESSION-PORT',
    saveFailed: 'SAVE-FAILED', resumed: 'RESUMED {count} {session}', started: 'NEW-SESSION', context: 'CTX {approx}{prompt}/{window} {percent}% {count}',
    contextNone: 'CTX-NONE {count}' },
  composer: { pasteChip: '[PASTE {lines}]', search: 'SEARCH', exitArmed: 'EXIT-ARMED', shortcuts: 'KEYS\nENTER-SENDS', slash: {} } };

class Screen extends Writable {
  text = '';
  readonly isTTY = true; readonly columns = 200; readonly rows = 60;
  override _write(chunk: Buffer, _encoding: string, done: () => void) { this.text += chunk.toString('utf8'); done(); }
}
export const settle = (ms = 30) => new Promise(resolve => setTimeout(resolve, ms));
export async function until(check: () => boolean, label: string, attempts = 500) {
  for (let attempt = 0; attempt < attempts; attempt++) { if (check()) return; await settle(10); }
  throw new Error(`timed out waiting for ${label}`);
}
/** Mounts the real interactive workline on an in-memory TTY; the caller unmounts it. */
export function mountWorkline(props: Partial<WorklineProps>) {
  const stdout = new Screen();
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() { return stdin; }, ref() { return stdin; }, unref() { return stdin; } });
  const instance = render(createElement(WorklinePaletteProvider, { palette: resolveWorklinePalette('none'), children: createElement(WorklineApp, {
    labels: WORKLINE_TEST_LABELS, target: 'scope · model', systemPrompt: 'SYSTEM', historyMessages: 40, errorText: (error: unknown) => `ERR:${(error as Error).message}`,
    completeTurn: async () => 'unused', ...props,
  }) }), { stdout: stdout as unknown as NodeJS.WriteStream, stdin: stdin as unknown as NodeJS.ReadStream, debug: true, exitOnCtrlC: false, patchConsole: false });
  return { stdout, stdin, instance };
}
