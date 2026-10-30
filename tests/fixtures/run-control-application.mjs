// Y1 host proof: the built Workline on this process's own controlling PTY with the built cli-terminal ledger ports over the real configured
// composition: the Run list comes from the inventory, each Run from `inspectConfiguredRun`, and hold/resume/close go through
// `applyConfiguredRunLifecycle` — the same in-process application `deckent run hold|resume|close` uses. Nothing here is a fixture port.
// Run from the fixture project directory (cwd); the locale is argv[2] (default en).
import { runTerminalWorkline, resolveWorklinePalette } from '#surfaces/core/terminal/index.js';
import { createWorklineLedgerPorts } from '#surfaces/core/cli-terminal/index.js';
import { workSurfaceLabels } from '#surfaces/core/work-labels/index.js';
import { terminalComposerLabels, terminalRenderLabels } from '#surfaces/core/terminal-labels/index.js';
import { applyConfiguredRunLifecycle, inspectConfiguredRun } from '#composition/core/runs/index.js';
import { inspectConfiguredInventory } from '#composition/core/inventory/index.js';
import { inspectConfiguredWorkers } from '#composition/core/worker-observation/index.js';
import { DeckentError, ErrorRegistry, t } from '#platform/index.js';

const locale = process.argv[2] === 'tr' ? 'tr' : 'en', root = process.cwd(), options = { env: process.env };
const ledger = createWorklineLedgerPorts({ root, scopeId: 's', options, locale, workerHeartbeatMs: 60_000, renderRunCancellation: () => '',
  inspectWorkers: inspectConfiguredWorkers, inspectRun: inspectConfiguredRun, inspectInventory: inspectConfiguredInventory, applyRunLifecycle: applyConfiguredRunLifecycle });
const labels = { banner: 'BANNER', prompt: '', statusReady: 'READY', statusBusy: 'BUSY', statusCancelling: 'CANCELLING', hint: 'HINT',
  focus: { composer: 'INPUT-FOCUS', window: 'WINDOW-FOCUS' }, roleUser: 'you', roleAssistant: 'bot', runCard: 'Run', workerCard: 'Worker', watchFailed: 'WATCH-FAILED',
  commandUnavailable: 'NO-PORT {part}', ledgerUnavailable: 'NO-LEDGER', runNotFound: 'NO-RUN', workersEmpty: 'NO-WORKERS', runsEmpty: 'NO-RUNS',
  serviceRestartUnavailable: 'NO-RESTART', queued: 'QUEUED', runUsage: 'USAGE',
  statusLine: 'STATUS-LINE', unknownCommand: 'UNKNOWN', render: terminalRenderLabels(locale), composer: terminalComposerLabels(locale), work: workSurfaceLabels(locale) };
await runTerminalWorkline({ labels, palette: resolveWorklinePalette('none'), context: { installationId: 'i', projectId: 'p', scopeId: 's' }, target: 's', systemPrompt: 'SYSTEM',
  historyMessages: 40, maxTrackedRuns: 4, pollMs: 60_000, ledger, completeTurn: async () => 'unused',
  // The production terminal's typed-error text (cli-terminal `errorText`): the catalog message in the session language and its code line.
  errorText: error => error instanceof DeckentError && ErrorRegistry.has(error.code)
    ? `${ErrorRegistry.get(error.code, locale, error.params ?? {})?.message ?? error.code}\n${t('terminal.error.code', { code: error.code }, locale)}` : `UNTYPED ${error?.message ?? error}` });
process.exit(0);
