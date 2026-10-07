/**
 * The workline with the T3 L4 settings windows on the process stdout/stdin. The PTY test is the parent; this file is the child.
 * Imports the built surface (`#surfaces` → dist). Run only after `npm run build`.
 * argv: <locale en|tr> <root with .deckent/config.json> <grant 0|1> <tier none|ansi256>
 * The ports are in-process (no runtime service): the real panel port builders and catalog words over fake handlers for one person whose
 * company policy denies some settings and gives no full-access grant (grant 0), or gives it (grant 1).
 */
import { createElement } from 'react';
import { render } from 'ink';
import { t } from '#platform/index.js';
import { composeCore } from '#composition/core/root/index.js';
import { WorklineApp, WorklinePaletteProvider, resolveWorklinePalette } from '#surfaces/core/terminal/index.js';
import { RenderGlyphsContext, resolveRenderGlyphs } from '#surfaces/core/terminal-render/index.js';
import { terminalPanelLabels, workSurfaceLabels } from '#surfaces/core/work-labels/index.js';
import { configPanelPort } from '#surfaces/core/config/index.js';
import { mcpPanelPort } from '#surfaces/core/cli-terminal/index.js';

const [locale, root, grant, tier] = process.argv.slice(2);
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
let mode = { schemaVersion: 1, scopeId: 'scope', supported: true, mode: 'standart', askEdits: false, revision: 'r0', eligible: true, fullAccess: grant === '1', fullAuto: true };
const permissionMode = { async inspect() { return mode; },
  async set(next, revision, askEdits) { const previous = mode.mode; mode = { ...mode, mode: next, askEdits: askEdits ?? mode.askEdits, revision: `${revision}+` };
    return { ...mode, previous, changed: true }; } };
const field = (key, value, source, schema, apply = 'live') => ({ key, value, defaultValue: value, source, descriptionKey: 'x.none', description: `${key} setting`, schema,
  binding: { state: 'bound', consumers: ['terminal'] }, apply, redacted: false });
const fields = [field('language', locale, 'default', { type: 'string', enum: ['en', 'tr'] }), field('max_workers', 4, 'project', { type: 'integer', minimum: 1 }, 'restart'),
  field('terminal.theme', 'auto', 'default', { type: 'string', enum: ['auto', 'dark', 'light'] })];
const decide = (keyPath, layer) => layer === 'global' || keyPath === 'language' ? 'deny' : keyPath === 'max_workers' ? 'require-approval' : 'allow';
const application = { inspect: async () => ({ schemaVersion: 1, digest: null, layer: 'project', fields }), explain: async () => ({ apply: 'live' }),
  permissions: async input => input.keys.flatMap(keyPath => input.layers.map(layer => ({ keyPath, layer, decision: decide(keyPath, layer), ruleId: decide(keyPath, layer) === 'require-approval' ? 'company-config-approval' : null }))),
  submit: async () => { throw Object.assign(new Error('fixture writes nothing'), { code: 'POLICY_DENIED' }); } };
const configContext = { configApplication: () => application, resolveConfigPrincipal: async () => ({ id: 'owner', issuer: 'host', subject: '1000', scopeIds: ['scope'] }) };
const options = { env: { HOME: root, DECKENT_GLOBAL_HOME: `${root}/global` }, heal: false };
const mcpRun = async (_root, request) => request.verb === 'list' ? { servers: [{ name: 'files', scope: 'local', status: 'trusted', realm: 'prefer-sandbox', command: 'npx', args: ['-y', 'files'],
  pinnedTools: 2 }, { name: 'github', scope: 'project', status: 'pending-approval', realm: 'host', command: 'gh-mcp', args: [] }], problems: [] } : {};

const view = createElement(WorklinePaletteProvider, {
  palette: resolveWorklinePalette(tier === 'none' ? 'none' : 'ansi256'),
  children: createElement(RenderGlyphsContext.Provider, { value: resolveRenderGlyphs(false) }, createElement(WorklineApp, {
    context: { installationId: 'fixture-installation', projectId: 'fixture-project', scopeId: 'scope' },
    labels, target: 'scope · model', systemPrompt: 'SYSTEM', historyMessages: 20,
    errorText: error => `ERR:${error?.code ?? 'error'}`, completeTurn: async () => 'unused', pollMs: 60_000, approvalPollMs: 60_000,
    permissionMode,
    panels: { labels: terminalPanelLabels(locale), ports: { config: configPanelPort(root, configContext, options, locale), mcp: mcpPanelPort(root, mcpRun, options, locale) } },
  })),
});
const instance = render(view, { exitOnCtrlC: false, patchConsole: false, interactive: true });
await instance.waitUntilExit();
