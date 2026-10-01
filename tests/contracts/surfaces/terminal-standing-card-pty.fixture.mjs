/**
 * A scoped approval card on the process stdout/stdin (PERSISTENT-APPROVALS G6). The PTY test is the parent; this file is the child.
 * Imports the built surface (`#surfaces` → dist). Decisions are appended to the file named by DECISIONS (the port is in-process).
 * SCOPES = comma list offered on the card (`session,always`, `session` ...).
 */
import { appendFileSync } from 'node:fs';
import { createElement } from 'react';
import { render } from 'ink';
import { WorklineApp, WorklinePaletteProvider, resolveWorklinePalette } from '#surfaces/core/terminal/index.js';

const scopes = (process.env.SCOPES ?? 'session,always').split(',');
const labels = {
  banner: 'BANNER', prompt: '> ', statusReady: 'READY', statusBusy: 'BUSY', statusCancelling: 'CANCELLING',
  hint: 'HINT', roleUser: 'you', roleAssistant: 'bot', runCard: 'Run', workerCard: 'Worker', watchFailed: 'WATCH-FAILED',
  ledgerUnavailable: 'NO-LEDGER', runNotFound: 'NO-RUN', workersEmpty: 'NO-WORKERS', runsEmpty: 'NO-RUNS',
  serviceRestartUnavailable: 'NO-RESTART', queued: 'QUEUED', runUsage: 'USAGE', watchStarted: 'WATCH-ON',
  watchRunsStarted: 'RUNS-ON', watchStopped: 'WATCH-OFF', statusLine: 'STATUS-LINE', unknownCommand: 'UNKNOWN',
  render: { assistant: 'bot', thinking: 'THINKING', thought: 'THOUGHT', elapsed: '{seconds}s', tokens: '{prompt}',
    reasoningTokens: '{count}', truncated: 'TRUNCATED', cancelled: 'CANCELLED', failed: 'FAILED', code: 'code',
    moreAbove: '{count}', queued: '{count} queued', tool: 'TOOL', toolRunning: 'RUNNING', toolStatus: {},
    context: 'CTX', compacted: 'COMPACTED' },
  sessions: { entry: 'SESSION {index} {session} {count} {preview}', none: 'NO-SESSIONS', notFound: 'SESSION-NOT-FOUND',
    unavailable: 'NO-SESSION-PORT', saveFailed: 'SAVE-FAILED', resumed: 'RESUMED {count} {session}', started: 'NEW-SESSION',
    context: 'CTX', contextNone: 'CTX-NONE' },
  composer: { pasteChip: '[PASTE {lines}]', search: 'SEARCH', exitArmed: 'EXIT-ARMED', shortcuts: 'KEYS', slash: {} },
  work: {
    workerLine: { numberLocale: 'en', ordinal: 'worker {n}', phases: {}, durationSeconds: '{n}s', durationMinutes: '{n}m',
      durationHours: '{n}h', ago: '{duration} ago', tokens: '{tokens}', tokensCache: '{tokens}', reported: '{phase}',
      eventsTruncated: 'truncated', dropped: '{count}', unmapped: '{count}' },
    panel: { title: 'LIVE', more: '+{count}' }, unavailable: 'UNWIRED',
    transcriptUsage: 'T', transcriptNotFound: 'T', transcriptNoAttempt: 'T', transcriptHeader: 'T',
    approvalsNone: 'A-NONE', approvalItem: 'A-ITEM {n} {id} {summary}', approvalsTruncated: 'A-TRUNC',
    approvalNotFound: 'A-NOTFOUND', approvalTitle: 'A-TITLE', approvalSubject: 'A-SUBJECT {id} {run} {task} {requester}',
    approvalPreviewMore: 'MORE', approvalExpires: 'A-EXPIRES', approvalPrompt: 'A-PROMPT', approvalPending: 'A-PENDING',
    approvalAllowed: 'A-ALLOWED {id}', approvalDenied: 'A-DENIED {id}', approvalUnsettled: 'A-UNSETTLED',
    approvalMore: 'A-MORE', approvalNotify: 'A-NOTIFY {count}', approvalPollFailed: 'A-POLLFAIL', approvalCard: { risk: 'R-RISK {risk} {undo}', notDeclared: 'R-UNDECLARED', onExpiry: 'R-NOTHING-RUNS', assuranceTurnHere: 'R-TURN-HERE',
    assuranceTurnElsewhere: 'R-TURN-ELSEWHERE', assurancePeer: 'R-PEER' },
    cancelUsage: 'C', cancelTitle: 'C', cancelDetail: 'C', cancelAlreadyRequested: 'C', cancelPrompt: 'C',
    cancelPending: 'C', cancelKept: 'C',
    approvalStanding: { covers: 'S-COVERS {pattern}', promptBoth: 'S-PROMPT-BOTH', promptSession: 'S-PROMPT-SESSION', promptAlways: 'S-PROMPT-ALWAYS',
      savedSession: 'S-SAVED-SESSION {id}', savedAlways: 'S-SAVED-ALWAYS {id}', notSavedSession: 'S-NOT-SAVED-SESSION {id} {reason}', notSavedAlways: 'S-NOT-SAVED-ALWAYS {id} {reason}' },
  },
};


let release;
const decided = new Promise(resolve => { release = resolve; });
const streamTurn = async function* () {
  yield { kind: 'approval', phase: 'requested', callId: 'c1', approvalId: 'appr-pty', revision: 0, summary: 'run_shell · npm test · 0123456789ab',
    preview: '$ npm test', expiresAt: Date.now() + 600_000, standing: { scopes, pattern: 'npm test' } };
  // The turn continues once the card is decided (or after 30 s: the test's own failure path).
  await Promise.race([decided, new Promise(resolve => setTimeout(resolve, 30_000))]);
  yield { kind: 'text', text: 'Done.' };
  yield { kind: 'done', finish: 'stop' };
};
const view = createElement(WorklinePaletteProvider, {
  palette: resolveWorklinePalette('none'),
  children: createElement(WorklineApp, {
    labels, target: 'scope · model', systemPrompt: 'SYSTEM', historyMessages: 20,
    errorText: (error) => `ERR:${error instanceof Error ? error.message : 'error'}`,
    completeTurn: async () => 'unused', streamTurn,
    pollMs: 60_000, approvalPollMs: 60_000,
    ledger: {
      scopeId: 'scope', workerHeartbeatMs: 60_000,
      async listWorkers() { return { schemaVersion: 1, scopeId: 'scope', sources: [] }; },
      async inspectRun() { return null; },
      async listApprovalPage() { return { items: [], nextAfter: null }; },
      async decideApproval(target, decision, standing) {
        appendFileSync(process.env.DECISIONS, `${target.approvalId} ${decision} ${standing ?? 'once'}\n`);
        release();
        const saved = standing !== undefined && process.env.SAVED !== 'no';
        return { approvalId: target.approvalId, runId: '-', taskId: '-', summary: '', requester: '-', revision: 1, status: 'decided', decision, expiresAt: 0,
          ...(standing ? { standing: { scope: standing, saved, ...(saved ? {} : { reason: 'STANDING_DELEGATION' }) } } : {}) };
      },
    },
  }),
});
// This fixture owns a real PTY. Ink 7 defaults to deferred frames under CI even on a TTY;
// explicitly request the interactive contract whose raw keys and visible decisions we test.
if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('STANDING_CARD_FIXTURE_REQUIRES_PTY');
const instance = render(view, { exitOnCtrlC: false, patchConsole: false, interactive: true });
await instance.waitUntilExit();
