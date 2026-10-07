import { panelFixture } from './workline-panel-fixture.js';
import { PassThrough, Writable } from 'node:stream';
import { createElement, Fragment, StrictMode } from 'react';
import { render } from 'ink';
import { WorklineApp, WorklinePaletteProvider, resolveWorklinePalette, type WorklineLabels, type WorklineProps, type WorkSurfaceLabels } from '#surfaces/core/terminal/index.js';
import { workSurfaceLabels } from '#surfaces/core/work-labels/index.js';
import { WORKER_LINE_EN } from './worker-line-labels.js';

/** The real EN window catalog (TS-WINDOW / T-APPROVAL-WINDOW); the older fields keep their probe tokens. */
const EN_WORK = workSurfaceLabels('en');
const work: WorkSurfaceLabels = { workerLine: WORKER_LINE_EN, panel: { title: 'LIVE-PANEL', more: '+{count} MORE' }, unavailable: 'UNWIRED',
  transcriptUsage: 'T-USAGE', transcriptNotFound: 'T-NOTFOUND {ref}', transcriptNoAttempt: 'T-NOATTEMPT {ref}', transcriptHeader: 'T-HEADER {n} {attempt}',
  approvalsNone: 'A-NONE', approvalItem: 'A-ITEM {n} {id} {summary}', approvalsTruncated: 'A-TRUNC {pages}', approvalNotFound: 'A-NOTFOUND {ref}',
  approvalTitle: 'A-TITLE', approvalSubject: 'A-SUBJECT {id} {run} {task} {requester}', approvalPreviewMore: 'A-PREVIEW-MORE {count}', approvalExpires: 'A-EXPIRES {duration}',
  approvalPrompt: 'A-PROMPT', approvalPending: 'A-PENDING', approvalAllowed: 'A-ALLOWED {id}', approvalDenied: 'A-DENIED {id}', approvalUnsettled: 'A-UNSETTLED {id}',
  approvalMore: 'A-MORE {count}', approvalNotify: 'A-NOTIFY {count}', approvalPollFailed: 'A-POLLFAIL',
  approvalCard: { risk: 'R-RISK {risk} {undo}', notDeclared: 'R-UNDECLARED', onExpiry: 'R-NOTHING-RUNS', assuranceTurnHere: 'R-TURN-HERE', assuranceTurnElsewhere: 'R-TURN-ELSEWHERE',
    assurancePeer: 'R-PEER', assuranceOther: 'R-OTHER {level}' }, cancelUsage: 'C-USAGE', cancelTitle: 'C-TITLE {run}',
  cancelDetail: 'C-DETAIL {revision} {phases}', cancelAlreadyRequested: 'C-ALREADY', cancelPrompt: 'C-PROMPT', cancelPending: 'C-PENDING', cancelKept: 'C-KEPT {run}', window: EN_WORK.window, approvalWindow: EN_WORK.approvalWindow };

/** Placeholder labels: tests assert on these tokens, never on catalog text. */
export const WORKLINE_TEST_LABELS: WorklineLabels = { banner: 'BANNER', prompt: '> ', statusReady: 'READY', statusBusy: 'BUSY', statusCancelling: 'CANCELLING',
  hint: 'HINT', roleUser: 'you', roleAssistant: 'bot', runCard: 'Run', workerCard: 'Worker', watchFailed: 'WATCH-FAILED', commandUnavailable: 'NO-PORT {part}',
  ledgerUnavailable: 'NO-LEDGER', runNotFound: 'NO-RUN', workersEmpty: 'NO-WORKERS', runsEmpty: 'NO-RUNS', serviceRestartUnavailable: 'NO-RESTART', queued: 'QUEUED',
  runUsage: 'USAGE', watchStarted: 'WATCH-ON', watchRunsStarted: 'RUNS-ON', watchStopped: 'WATCH-OFF', statusLine: 'STATUS-LINE', unknownCommand: 'UNKNOWN',
  render: { assistant: 'bot', thinking: 'THINKING {tokens} tok {seconds}s', thought: 'THOUGHT {seconds}s {tokens} tok', elapsed: '{seconds}s',
    tokens: '{prompt} in {completion} out', reasoningTokens: '{count} reasoning', truncated: 'TRUNCATED', cancelled: 'CANCELLED', failed: 'FAILED',
    code: 'code', moreAbove: '{count} more above', queued: '{count} queued', tool: 'TOOL {name} {target}', toolRunning: 'RUNNING {tool} {seconds}s',
    toolStatus: { error: 'TOOL-FAILED', denied: 'TOOL-DENIED', 'approval-required': 'TOOL-APPROVAL', 'invalid-arguments': 'TOOL-INVALID',
      duplicate: 'TOOL-DUPLICATE', cancelled: 'TOOL-CANCELLED', 'approval-expired': 'TOOL-APPROVAL-EXPIRED' }, context: 'CTX {approx}{percent}% of {window}', compacted: 'COMPACTED {count}' },
  sessions: { entry: 'SESSION {index} {session} {count} {preview}', none: 'NO-SESSIONS', notFound: 'SESSION-NOT-FOUND', unavailable: 'NO-SESSION-PORT',
    saveFailed: 'SAVE-FAILED', resumed: 'RESUMED {count} {session}', started: 'NEW-SESSION', context: 'CTX {approx}{prompt}/{window} {percent}% {count}',
    contextNone: 'CTX-NONE {count}' },
  composer: { pasteChip: '[PASTE {lines}]', search: 'SEARCH', exitArmed: 'EXIT-ARMED', shortcuts: 'KEYS\nENTER-SENDS', slash: {} }, work };

class Screen extends Writable {
  text = '';
  /** Ink debug mode writes the whole view each time; this is the latest frame, not the scrollback. */
  frame = '';
  readonly isTTY = true;
  constructor(readonly columns = 200, private readonly onFrame?: (text: string) => void, readonly rows = 60) { super(); }
  override _write(chunk: Buffer, _encoding: string, done: () => void) {
    const text = chunk.toString('utf8');
    this.text += text;
    // Paste toggles and waitUntilRenderFlush's empty write are not visible frames.
    if (text.length > 0 && !isPasteToggle(text)) { this.frame = text; this.onFrame?.(text); }
    done();
  }
}
const PASTE_ON = '\u001b[?2004h', PASTE_OFF = '\u001b[?2004l';
function isPasteToggle(text: string): boolean {
  if (text.length === 0 || text.length % PASTE_ON.length !== 0) return false;
  for (let index = 0; index < text.length; index += PASTE_ON.length) {
    const piece = text.slice(index, index + PASTE_ON.length);
    if (piece !== PASTE_ON && piece !== PASTE_OFF) return false;
  }
  return true;
}
export const settle = (ms = 30) => new Promise(resolve => setTimeout(resolve, ms));
export async function until(check: () => boolean, label: string, attempts = 500) {
  for (let attempt = 0; attempt < attempts; attempt++) { if (check()) return; await settle(10); }
  throw new Error(`timed out waiting for ${label}`);
}
/** Mounts the real interactive workline on an in-memory TTY; the caller unmounts it. */
export function mountWorkline(props: Partial<WorklineProps>, columns = 200, observation: { onFrame?: (text: string) => void; debug?: boolean; strict?: boolean; rows?: number } = {}) {
  const stdout = new Screen(columns, observation.onFrame, observation.rows);
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() { return stdin; }, ref() { return stdin; }, unref() { return stdin; } });
  const wrapper = observation.strict ? StrictMode : Fragment;
  const instance = render(createElement(wrapper, null, createElement(WorklinePaletteProvider, { palette: resolveWorklinePalette('none'), children: createElement(WorklineApp, {
    labels: WORKLINE_TEST_LABELS, target: 'scope · model', systemPrompt: 'SYSTEM', historyMessages: 40, errorText: (error: unknown) => `ERR:${(error as Error).message}`,
    completeTurn: async () => 'unused', ...props, ...panelFixture(props),
  }) })), { stdout: stdout as unknown as NodeJS.WriteStream, stdin: stdin as unknown as NodeJS.ReadStream, debug: observation.debug ?? true,
    interactive: true, exitOnCtrlC: false, patchConsole: false });
  return { stdout, stdin, instance };
}
