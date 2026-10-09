// Real Workline slash dispatch, selection window, composition and TTY approval over an isolated policy fixture.
import { createElement } from 'react';
import { render } from 'ink';
import { t } from '#platform/index.js';
import { composeCore } from '#composition/core/root/index.js';
import { WorklineApp, WorklinePaletteProvider, resolveWorklinePalette } from '#surfaces/core/terminal/index.js';
import { RenderGlyphsContext, resolveRenderGlyphs } from '#surfaces/core/terminal-render/index.js';
import { terminalPanelLabels, workSurfaceLabels } from '#surfaces/core/work-labels/index.js';
import { policyPanelPort } from '#surfaces/core/cli-terminal/index.js';
import { listConfiguredMcpCapabilityScopes, inspectConfiguredMcpCapabilities, changeConfiguredMcpCapabilities } from '#composition/core/approvals/index.js';

const [locale, root, tier] = process.argv.slice(2);
composeCore();
const w = key => t(key, {}, locale);
const labels = {
  banner: 'BANNER', prompt: '> ', statusReady: 'READY', statusBusy: 'BUSY', statusCancelling: 'CANCELLING',
  hint: 'HINT', roleUser: 'you', roleAssistant: 'bot', runCard: 'Run', workerCard: 'Worker', watchFailed: 'WATCH-FAILED', commandUnavailable: 'NO-PORT {part}',
  ledgerUnavailable: 'NO-LEDGER', runNotFound: 'NO-RUN', workersEmpty: 'NO-WORKERS', runsEmpty: 'NO-RUNS',
  serviceRestartUnavailable: 'NO-RESTART', queued: 'QUEUED', runUsage: 'USAGE', watchStarted: 'WATCH-ON',
  watchRunsStarted: 'RUNS-ON', watchStopped: 'WATCH-OFF', statusLine: 'STATUS-LINE', unknownCommand: 'UNKNOWN',
  render: { assistant: 'bot', thinking: 'THINKING', thought: 'THOUGHT', elapsed: '{seconds}s', tokens: '{prompt}', reasoningTokens: '{count}', truncated: 'TRUNCATED',
    cancelled: 'CANCELLED', failed: 'FAILED', code: 'code', moreAbove: '{count}', queued: '{count} queued', tool: 'TOOL', toolRunning: 'RUNNING', toolStatus: {},
    context: 'CTX', compacted: 'COMPACTED' },
  composer: { pasteChip: '[PASTE {lines}]', search: 'SEARCH', exitArmed: 'EXIT-ARMED', shortcuts: 'KEYS', slash: {} },
  work: { ...workSurfaceLabels(locale) },
  // The real words of the mode line, its stops and the full-access line (the composition builds the same from the catalog).
  mode: { current: w('terminal.mode.current'), changed: w('terminal.mode.changed'), inert: w('terminal.mode.inert'), unsupported: w('terminal.mode.unsupported'),
    usage: w('terminal.mode.usage'), stops: { standart: w('terminal.mode.stop.standart'), 'ask-edits': w('terminal.mode.stop.ask-edits'),
      'full-auto': w('terminal.mode.stop.full-auto'), 'full-access': w('terminal.mode.stop.full-access') },
    cycled: w('terminal.mode.cycled'), cycledFullAccess: w('terminal.mode.cycledFullAccess'), fullAccessLine: w('tui.panel.mode.fullAccessLine') },
};
const options = { heal: false };
const view = createElement(WorklinePaletteProvider, {
  palette: resolveWorklinePalette(tier === 'none' ? 'none' : 'ansi256'),
  children: createElement(RenderGlyphsContext.Provider, { value: resolveRenderGlyphs(false) }, createElement(WorklineApp, {
    context: { installationId: 'fixture-installation', projectId: 'fixture-project', scopeId: 'scope' },
    labels, target: 'scope · model', systemPrompt: 'SYSTEM', historyMessages: 20,
    errorText: error => `ERR:${error?.code ?? 'error'}`, completeTurn: async () => 'unused', pollMs: 60_000, approvalPollMs: 60_000,
    panels: { labels: terminalPanelLabels(locale), ports: { policy: policyPanelPort(root, { listMcpCapabilityScopes: listConfiguredMcpCapabilityScopes, inspectMcpCapabilities: inspectConfiguredMcpCapabilities, changeMcpCapabilities: changeConfiguredMcpCapabilities }, options, locale) } },
  })),
});
const instance = render(view, { exitOnCtrlC: false, patchConsole: false, interactive: true });
await instance.waitUntilExit();
