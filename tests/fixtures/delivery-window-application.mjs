// TESLIM-PENCERESI host proof: the built Workline on this process's own controlling PTY, with the built cli-terminal delivery port over the
// real configured composition (inventory, patch preview, integration check/prepare, verified-terminal delivery/adoption). Only the Run
// view that triggers the window is a fixture (the ledger port); every write goes through the production applications and real Git.
// argv: <mode> where mode = window | port-direct | verify. Run from the fixture project directory (cwd).
// Y1 `verify`: the window's port also reads Runs (`inspectConfiguredRun`) for the verification choice. After the window's delivery, this process
// stands in for the person's other shell: it creates the verification Run on that delivery (`run create --delivery-command-id`'s application),
// executes and evaluates it, before the window shows the delivered stage. The adoption itself is the window's, with the real port.
import { runTerminalWorkline, resolveWorklinePalette } from '#surfaces/core/terminal/index.js';
import { terminalDeliveryPort } from '#surfaces/core/cli-terminal/index.js';
import { deliveryWindowLabels, workSurfaceLabels } from '#surfaces/core/work-labels/index.js';
import { terminalComposerLabels, terminalRenderLabels } from '#surfaces/core/terminal-labels/index.js';
import { checkConfiguredWorkspaceIntegration, interactiveDeliveryHandlers, prepareConfiguredWorkspaceIntegration, previewConfiguredWorkspacePatch } from '#composition/core/workspace-patch/index.js';
import { inspectConfiguredInventory } from '#composition/core/inventory/index.js';
import { createConfiguredDeliveryRun, inspectConfiguredRun, reserveConfiguredRunTasks, evaluateConfiguredTask } from '#composition/core/runs/index.js';
import { executeConfiguredTask } from '#composition/core/execution/index.js';
import { unifiedDiff } from '#adapters/core/workspace-write/index.js';

const mode = process.argv[2] ?? 'window', root = process.cwd(), options = { env: process.env };
const real = terminalDeliveryPort(root, { inspectInventory: inspectConfiguredInventory, previewWorkspacePatch: previewConfiguredWorkspacePatch,
  checkWorkspaceIntegration: checkConfiguredWorkspaceIntegration, prepareWorkspaceIntegration: prepareConfiguredWorkspaceIntegration, renderUnifiedDiff: unifiedDiff,
  interactiveDelivery: interactiveDeliveryHandlers, ...(mode === 'verify' ? { inspectRun: inspectConfiguredRun } : {}) }, options);
const verifyGraph = { schemaVersion: 2, revision: 1, tasks: [{ id: 'check', kind: 'verify', dependencies: [], acceptanceCriteria: ['exit'] }],
  criterionDefinitions: [{ id: 'exit', version: 1, description: 'Accepted exit', evaluator: { id: 'process-exit', version: 1 }, parameters: { acceptedExitCodes: [0] } }] };
const port = mode !== 'verify' ? real : { ...real, async deliver(...args) {
  const delivered = await real.deliver(...args);
  await createConfiguredDeliveryRun(root, { schemaVersion: 1, commandId: 'create-v', scopeId: 's', runId: 'v', graph: verifyGraph, deliveryCommandId: delivered.commandId }, options);
  const identity = (await reserveConfiguredRunTasks(root, { schemaVersion: 1, scopeId: 's', runId: 'v', commandId: 'reserve-v', expectedRevision: 0 }, options)).reservation.identities[0];
  await executeConfiguredTask(root, identity, options);
  const { run } = await inspectConfiguredRun(root, { schemaVersion: 1, scopeId: 's', runId: 'v' }, options);
  await evaluateConfiguredTask(root, { schemaVersion: 1, commandId: 'evaluate-v', identity, expectedRevision: run.revision }, options);
  return delivered;
} };
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
