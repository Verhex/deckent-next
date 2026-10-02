/**
 * Workline on the process stdout/stdin. The PTY test is the parent; this file is the child.
 * Imports the built surface (`#surfaces` → dist). Run only after `npm run build`.
 */
import { createElement } from 'react';
import { render } from 'ink';
import { WorklineApp, WorklinePaletteProvider, resolveWorklinePalette } from '#surfaces/core/terminal/index.js';

const FIRST = 'aaaaaaaa-1111-4111-8111-111111111111';
const SECOND = 'bbbbbbbb-2222-4222-8222-222222222222';
let sessionListCalls = 0;
const sessions = [
  { sessionId: FIRST, updatedAtMs: 1_700_000_000_000, messages: 1, preview: 'PREVIEW-TOKEN-FIRST' },
  { sessionId: SECOND, updatedAtMs: 1_700_000_100_000, messages: 3, preview: 'PREVIEW-TOKEN-SECOND' },
];
const approvals = ['ap-1', 'ap-2'].map(id => ({
  approvalId: id, runId: 'run-1', taskId: 'task-1', summary: `summary ${id}`, requester: 'svc', revision: 0,
  status: 'pending', decision: null, expiresAt: Date.now() + 600_000,
}));
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
    assuranceTurnElsewhere: 'R-TURN-ELSEWHERE', assurancePeer: 'R-PEER', assuranceOther: 'R-OTHER {level}' },
    cancelUsage: 'C', cancelTitle: 'C', cancelDetail: 'C', cancelAlreadyRequested: 'C', cancelPrompt: 'C',
    cancelPending: 'C', cancelKept: 'C',
  },
};

const view = createElement(WorklinePaletteProvider, {
  palette: resolveWorklinePalette('none'),
  children: createElement(WorklineApp, {
    labels, target: 'scope · model', systemPrompt: 'SYSTEM', historyMessages: 20,
    errorText: (error) => `ERR:${error instanceof Error ? error.message : 'error'}`,
    completeTurn: async () => 'unused',
    pollMs: 60_000, approvalPollMs: 60_000,
    sessions: {
      async save() {},
      async list() {
        // A real port can resolve after the test driver's former 500ms guess. The second open must wait for its own frame.
        if (++sessionListCalls === 2) await new Promise(resolve => setTimeout(resolve, 1_500));
        return sessions;
      },
      async load(id) {
        if (id === SECOND) return [{ role: 'user', content: 'from-second' }, { role: 'assistant', content: 'a2', toolCalls: [] },
          { role: 'assistant', content: 'a3', toolCalls: [] }];
        if (id === FIRST) return [{ role: 'user', content: 'from-first' }];
        return null;
      },
    },
    ledger: {
      workerHeartbeatMs: 60_000,
      async listApprovalPage() { return { items: approvals, nextAfter: null }; },
      async decideApproval(target, decision) {
        const found = approvals.find(item => item.approvalId === target.approvalId);
        return { ...found, status: 'decided', revision: 1, decision };
      },
    },
  }),
});
const instance = render(view, { exitOnCtrlC: false, patchConsole: false });
await instance.waitUntilExit();
