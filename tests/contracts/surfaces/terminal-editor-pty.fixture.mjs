/**
 * T4 on a real PTY: the production Workline entry (`runTerminalWorkline`) with the production editor adapter (`openExternalEditor`) and
 * `$EDITOR` set by the parent test. argv[2] = `inline` chooses the inline layout; otherwise the full window (alternate screen, mouse filter).
 * Imports the built units (`#` → dist). Run only after `npm run build`.
 */
import { runTerminalWorkline, resolveWorklinePalette } from '#surfaces/core/terminal/index.js';
import { workSurfaceLabels } from '#surfaces/core/work-labels/index.js';
import { openExternalEditor } from '#adapters/index.js';

const labels = {
  banner: 'BANNER', prompt: '> ', statusReady: 'READY', statusBusy: 'BUSY', statusCancelling: 'CANCELLING', hint: 'HINT', roleUser: 'you', roleAssistant: 'bot',
  runCard: 'Run', workerCard: 'Worker', watchFailed: 'WATCH-FAILED', commandUnavailable: 'NO-PORT {part}', ledgerUnavailable: 'NO-LEDGER', runNotFound: 'NO-RUN',
  workersEmpty: 'NO-WORKERS', runsEmpty: 'NO-RUNS', serviceRestartUnavailable: 'NO-RESTART', queued: 'QUEUED', runUsage: 'USAGE',
  statusLine: 'STATUS-LINE', unknownCommand: 'UNKNOWN',
  render: { assistant: 'bot', thinking: 'THINKING', thought: 'THOUGHT', elapsed: '{seconds}s', tokens: '{prompt}', reasoningTokens: '{count}', truncated: 'TRUNCATED',
    cancelled: 'CANCELLED', failed: 'FAILED', code: 'code', moreAbove: '{count} more above', queued: '{count} queued', tool: 'TOOL {name} {target}', toolRunning: 'RUNNING {tool} {seconds}s',
    toolStatus: {}, context: 'CTX', compacted: 'COMPACTED' },
  composer: { pasteChip: '[PASTE {lines}]', search: 'SEARCH', exitArmed: 'EXIT-ARMED', shortcuts: 'KEYS', stashed: 'STASHED', slash: {} },
  handoff: { withdrawn: 'BACK: {text}', editor: { 'no-editor': 'NO-EDITOR', 'not-started': 'NOT-STARTED', exit: 'EDITOR-EXIT', 'too-large': 'TOO-LARGE', unsafe: 'UNSAFE', failed: 'EDITOR-FAILED' } },
  work: workSurfaceLabels('en'),
};
let turns = 0;
const streamTurn = async function* (messages, _signal, turn) {
  turns += 1;
  turn?.onTurnBound?.({ scopeId: 's', sessionId: turn.sessionId ?? null, turnId: `t-${turns}`, phase: 'command-generated' });
  const last = String(messages.at(-1)?.content ?? '');
  for (let i = 0; i < 3; i++) yield { kind: 'text', text: `${last}-line-${i}\n` };
  yield { kind: 'done', finish: 'stop' };
};
await runTerminalWorkline({ labels, palette: resolveWorklinePalette('none'), context: { installationId: 'i', projectId: 'p', scopeId: 's' }, target: 'scope', systemPrompt: 'S',
  historyMessages: 40, errorText: error => String(error), completeTurn: async () => 'unused', streamTurn, externalEditor: openExternalEditor({ env: process.env }),
  ...(process.argv[2] === 'inline' ? { fullscreen: false } : {}) });
process.stderr.write('EXIT-CLEAN\n');
