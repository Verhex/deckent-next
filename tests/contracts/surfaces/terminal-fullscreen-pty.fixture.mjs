/**
 * The production Workline entry (`runTerminalWorkline`: alternate screen, mouse filter) on the process TTY with a fake streaming model.
 * The PTY test is the parent; this file is the child. Imports the built surface (`#surfaces` → dist). Run only after `npm run build`.
 * "long" answers 80 lines slowly; "card" asks for an approval and waits for the decision.
 */
import { runTerminalWorkline, resolveWorklinePalette } from '#surfaces/core/terminal/index.js';
import { workSurfaceLabels } from '#surfaces/core/work-labels/index.js';

const decisions = [];
const labels = {
  banner: 'BANNER', prompt: '> ', statusReady: 'READY', statusBusy: 'BUSY', statusCancelling: 'CANCELLING', hint: 'HINT', roleUser: 'you', roleAssistant: 'bot',
  runCard: 'Run', workerCard: 'Worker', watchFailed: 'WATCH-FAILED', commandUnavailable: 'NO-PORT {part}', ledgerUnavailable: 'NO-LEDGER', runNotFound: 'NO-RUN',
  workersEmpty: 'NO-WORKERS', runsEmpty: 'NO-RUNS', serviceRestartUnavailable: 'NO-RESTART', queued: 'QUEUED', runUsage: 'USAGE', watchStarted: 'WATCH-ON',
  watchRunsStarted: 'RUNS-ON', watchStopped: 'WATCH-OFF', statusLine: 'STATUS-LINE', unknownCommand: 'UNKNOWN',
  render: { assistant: 'bot', thinking: 'THINKING', thought: 'THOUGHT', elapsed: '{seconds}s', tokens: '{prompt}', reasoningTokens: '{count}', truncated: 'TRUNCATED',
    cancelled: 'CANCELLED', failed: 'FAILED', code: 'code', moreAbove: '{count} more above', queued: '{count} queued', tool: 'TOOL {name} {target}', toolRunning: 'RUNNING {tool} {seconds}s',
    toolStatus: {}, context: 'CTX', compacted: 'COMPACTED' },
  composer: { pasteChip: '[PASTE {lines}]', search: 'SEARCH', exitArmed: 'EXIT-ARMED', shortcuts: 'KEYS', stashed: 'STASHED', slash: {} },
  focus: { composer: 'INPUT-FOCUS', window: 'WINDOW-FOCUS', decide: 'DECIDE-HERE' },
  viewport: { below: 'BELOW {count} END', newMessages: 'NEW {count} END', search: 'FIND[{query}]{state}', searchNone: ' NONE' },
  work: workSurfaceLabels('en'),
};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let decided = false, turns = 0;
const ledger = { scopeId: 's', async listWorkers() { return { schemaVersion: 1, scopeId: 's', sources: [] }; }, async inspectRun() { return null; },
  async decideApproval(approval, decision) { decided = true; decisions.push(decision); process.stderr.write(`DECIDED ${decision}\n`);
    return { approvalId: approval.approvalId, runId: '-', taskId: '-', summary: '', requester: '-', revision: 1, status: 'decided', decision, expiresAt: 0 }; } };
const streamTurn = async function* (messages, signal, turn) {
  turns += 1;
  turn?.onTurnBound?.({ scopeId: 's', sessionId: turn.sessionId ?? null, turnId: `t-${turns}`, phase: 'command-generated' });
  const last = String(messages.at(-1)?.content ?? '');
  if (last === 'card') {
    yield { kind: 'approval', phase: 'requested', callId: 'c', approvalId: 'appr-pty', revision: 0, summary: 'run_shell · rm -rf build · 0123456789ab', preview: '$ rm -rf build',
      expiresAt: Date.now() + 600_000, risk: 'shell-destructive', tool: 'run_shell', target: 'rm -rf build' };
    while (!decided && !signal.aborted) await sleep(20);
    yield { kind: 'done', finish: 'stop' }; return;
  }
  const count = last === 'long' ? 80 : 4;
  for (let i = 0; i < count && !signal.aborted; i++) { yield { kind: 'text', text: `${last}-line-${i}\n` }; await sleep(last === 'long' ? 40 : 1); }
  yield { kind: 'done', finish: 'stop' };
};
await runTerminalWorkline({ labels, palette: resolveWorklinePalette('none'), context: { installationId: 'i', projectId: 'p', scopeId: 's' }, target: 'scope', systemPrompt: 'S',
  historyMessages: 40, errorText: error => String(error), completeTurn: async () => 'unused', streamTurn, ledger });
process.stderr.write(`EXIT ${JSON.stringify(decisions)}\n`);
