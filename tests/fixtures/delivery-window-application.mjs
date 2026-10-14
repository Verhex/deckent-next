// TESLIM-PENCERESI host proof: the built Workline on this process's own controlling PTY, with the built cli-terminal delivery port over the
// real configured composition (inventory, patch preview, integration check/prepare, verified-terminal delivery/adoption). Only the Run
// view that triggers the window is a fixture (the ledger port); every write goes through the production applications and real Git.
// argv: <mode> where mode = window | port-direct. Run from the fixture project directory (cwd).
import { runTerminalWorkline, resolveWorklinePalette } from '#surfaces/core/terminal/index.js';
import { terminalDeliveryPort } from '#surfaces/core/cli-terminal/index.js';
import { deliveryWindowLabels, workSurfaceLabels } from '#surfaces/core/work-labels/index.js';
import { terminalComposerLabels, terminalRenderLabels } from '#surfaces/core/terminal-labels/index.js';
import { checkConfiguredWorkspaceIntegration, interactiveDeliveryHandlers, prepareConfiguredWorkspaceIntegration, previewConfiguredWorkspacePatch } from '#composition/core/workspace-patch/index.js';
import { inspectConfiguredInventory } from '#composition/core/inventory/index.js';
import { unifiedDiff } from '#adapters/core/workspace-write/index.js';

const mode = process.argv[2] ?? 'window', root = process.cwd(), options = { env: process.env };
const port = terminalDeliveryPort(root, { inspectInventory: inspectConfiguredInventory, previewWorkspacePatch: previewConfiguredWorkspacePatch,
  checkWorkspaceIntegration: checkConfiguredWorkspaceIntegration, prepareWorkspaceIntegration: prepareConfiguredWorkspaceIntegration, renderUnifiedDiff: unifiedDiff,
  interactiveDelivery: interactiveDeliveryHandlers }, options);
const target = { key: 's:r:t', scopeId: 's', runId: 'r', taskId: 't', title: 'Ship useful change' };

if (mode === 'port-direct') {
  // The answer says yes; only the verified-terminal capability may still refuse (piped input), before any candidate is prepared.
  try {
    const preview = await port.preview(target);
    const result = await port.deliver(preview, { candidate: 'direct-candidate', delivery: 'direct-delivery' }, async () => true);
    process.stdout.write(`\n${JSON.stringify({ response: { ok: true, result } })}\n`);
  } catch (error) { process.stdout.write(`\n${JSON.stringify({ response: { ok: false, code: error.code ?? 'fixture-failed' } })}\n`); }
  process.exit(0);
}

const brief = { schemaVersion: 1, attemptId: 'a', claimLabel: 'CLAIM', report: null, evaluation: { verdict: 'accepted' }, runDelivery: null, openIssues: null, deliveryOutlook: 'awaiting-delivery' };
const run = { schemaVersion: 3, scopeId: 's', runId: 'r', revision: 9, cancellationRequested: false, state: { kind: 'terminal', outcome: 'completed', reason: 'completed' },
  tasks: [{ id: 't', phase: 'accepted', resultBrief: brief, taskBrief: { schemaVersion: 1, task: target.title, scopePaths: [], acceptance: null, criteria: [], profile: null, model: null,
    effort: null, contextRefs: [] } }] };
const ledger = { scopeId: 's', workerHeartbeatMs: 60_000, listRunIds: async () => ['r'], inspectRun: async () => run,
  listWorkers: async () => ({ schemaVersion: 1, scopeId: 's', sources: [] }), listApprovalPage: async () => ({ items: [], nextAfter: null }) };
const labels = { banner: 'BANNER', prompt: '', statusReady: 'READY', statusBusy: 'BUSY', statusCancelling: 'CANCELLING', hint: 'HINT',
  focus: { composer: 'INPUT-FOCUS', window: 'WINDOW-FOCUS' }, roleUser: 'you', roleAssistant: 'bot', runCard: 'Run', workerCard: 'Worker', watchFailed: 'WATCH-FAILED',
  commandUnavailable: 'NO-PORT {part}', ledgerUnavailable: 'NO-LEDGER', runNotFound: 'NO-RUN', workersEmpty: 'NO-WORKERS', runsEmpty: 'NO-RUNS',
  serviceRestartUnavailable: 'NO-RESTART', queued: 'QUEUED', runUsage: 'USAGE', watchStarted: 'WATCH-ON', watchRunsStarted: 'RUNS-ON', watchStopped: 'WATCH-OFF',
  statusLine: 'STATUS-LINE', unknownCommand: 'UNKNOWN', render: terminalRenderLabels('en'), composer: terminalComposerLabels('en'),
  work: workSurfaceLabels('en'), delivery: deliveryWindowLabels('en') };
await runTerminalWorkline({ labels, palette: resolveWorklinePalette('none'), context: { installationId: 'i', projectId: 'p', scopeId: 's' }, target: 's', systemPrompt: 'SYSTEM',
  historyMessages: 40, maxTrackedRuns: 4, pollMs: 50, ledger, completeTurn: async () => 'unused', errorText: error => `ERR ${error?.code ?? ''}: ${error?.message ?? error}`,
  delivery: { port, confirmTimeoutMs: 60_000 },
  doPlan: { planning: 'PLANNING', cancelHint: 'CANCEL', requestHint: 'REQUEST', lines: () => ['PLAN-RESULT'],
    plan: async () => ({ schemaVersion: 1, run, proposal: { status: 'accepted', approval: null } }) } });
process.exit(0);
