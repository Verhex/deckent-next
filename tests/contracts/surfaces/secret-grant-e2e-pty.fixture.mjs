/**
 * PRE-8 v2 end to end on a real pseudo-terminal: the built workline and card port, the REAL credential resolver, the REAL governed grant
 * (terminal witness = this process's own pty, policy cell `secret`/`set`, sealed `authority-decision`, then `grants.json`) and the REAL main
 * vault (encrypted file in the throwaway HOME). No runtime service, no model call. Run only after `npm run build`. env PRE8_E2E_ROOT.
 */
import { join } from 'node:path';
import { createElement } from 'react';
import { render } from 'ink';
import { WorklineApp, WorklinePaletteProvider, resolveWorklinePalette } from '#surfaces/core/terminal/index.js';
import { workSurfaceLabels } from '#surfaces/core/work-labels/index.js';
import { secretGrantCardPort } from '#surfaces/core/cli-terminal/index.js';
import { terminalSecretGrantOffer } from '#composition/core/terminal-chat/index.js';
import { changeProjectSecretGrant, projectCredentialResolver } from '#composition/core/secrets/index.js';
import { loadConfiguredScopeContext } from '#composition/core/scoped-request/index.js';
import { registerProviderConfig } from '#adapters/index.js';

registerProviderConfig();
const root = process.env['PRE8_E2E_ROOT'], locale = process.argv[2] ?? 'en';
const projectRoot = join(root, 'project'), home = join(root, 'home');
const options = { env: { HOME: home, USERPROFILE: home, APPDATA: join(home, 'roaming'), LOCALAPPDATA: join(home, 'local'), XDG_CONFIG_HOME: join(home, '.config') } };
const work = workSurfaceLabels(locale);
const labels = {
  banner: 'BANNER', prompt: '> ', statusReady: 'READY', statusBusy: 'BUSY', statusCancelling: 'CANCELLING', hint: 'HINT', roleUser: 'you', roleAssistant: 'bot',
  runCard: 'Run', workerCard: 'Worker', watchFailed: 'WATCH-FAILED', ledgerUnavailable: 'NO-LEDGER', runNotFound: 'NO-RUN', workersEmpty: 'NO-WORKERS',
  runsEmpty: 'NO-RUNS', serviceRestartUnavailable: 'NO-RESTART', queued: 'QUEUED', runUsage: 'USAGE', watchStarted: 'WATCH-ON', watchRunsStarted: 'RUNS-ON',
  watchStopped: 'WATCH-OFF', statusLine: 'STATUS-LINE', unknownCommand: 'UNKNOWN',
  render: { assistant: 'bot', thinking: 'THINKING', thought: 'THOUGHT', elapsed: '{seconds}s', tokens: '{prompt}', reasoningTokens: '{count}', truncated: 'TRUNCATED',
    cancelled: 'CANCELLED', failed: 'FAILED', code: 'code', moreAbove: '{count}', queued: '{count} queued', tool: 'TOOL', toolRunning: 'RUNNING', toolStatus: {},
    context: 'CTX', compacted: 'COMPACTED' },
  composer: { pasteChip: '[PASTE {lines}]', search: 'SEARCH', exitArmed: 'EXIT-ARMED', shortcuts: 'KEYS', slash: {} },
  work: { ...work, workerLine: { numberLocale: 'en', ordinal: 'worker {n}', phases: {}, durationSeconds: '{n}s', durationMinutes: '{n}m', durationHours: '{n}h',
    ago: '{duration} ago', tokens: '{tokens}', tokensCache: '{tokens}', reported: '{phase}', eventsTruncated: 'truncated', dropped: '{count}', unmapped: '{count}' },
    panel: { title: 'LIVE', more: '+{count}' }, unavailable: 'UNWIRED' },
};
// The turn's credential step with the REAL resolver (.deck → ownership → project vault or main vault through a grant); the value only proves
// the main vault answered after the grant (its length is printed, never the value). The grant is the REAL governed application.
const streamTurn = (_messages, _signal, turn) => (async function* () {
  const context = await loadConfiguredScopeContext(projectRoot, 'scope-a', options, 'read');
  const value = await projectCredentialResolver(context, 'scope-a', options).resolve('DECKENT_ANTHROPIC_KEY');
  turn?.onTurnBound?.({ scopeId: 'scope-a', sessionId: turn.sessionId ?? null, turnId: 'pty-turn', phase: 'command-generated' });
  yield { kind: 'text', text: `ANSWER-AFTER-GRANT len=${value?.length ?? 0}` };
  yield { kind: 'done', finish: 'stop' };
})();
const secretGrant = secretGrantCardPort(projectRoot, 'scope-a', options, locale, {
  offer: (where, loaded) => terminalSecretGrantOffer(where, loaded),
  grant: (where, scope, name, loaded) => changeProjectSecretGrant(where, scope, name, 'grant', 'card', loaded).then(() => {}),
}, home);
const view = createElement(WorklinePaletteProvider, { palette: resolveWorklinePalette('none'), children: createElement(WorklineApp, {
  context: { installationId: 'fixture-installation', projectId: 'fixture-project', scopeId: 'scope-a' },
  labels, target: 'scope-a · model', systemPrompt: 'SYSTEM', historyMessages: 20, completeTurn: async () => 'unused', pollMs: 60_000, approvalPollMs: 60_000,
  errorText: error => `ERR:${error?.code ?? 'error'} ${error?.suggestion ?? ''}`, streamTurn, secretGrant,
}) });
// Ink 7 defers every frame under CI (is-in-ci) even on a TTY; the product terminal passes `interactive: true` on a TTY (workline.tsx), so does this PTY fixture.
const instance = render(view, { exitOnCtrlC: false, patchConsole: false, interactive: true });
await instance.waitUntilExit();
