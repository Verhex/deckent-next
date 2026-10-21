/**
 * PRE-8 first-use card on a real pseudo-terminal. The PTY test is the parent; this file is the child. Imports the built units (`#…` → dist):
 * run only after `npm run build`. The workline, the card port with its catalog words and the composition's offer decision (identity profile
 * of a throwaway installation + this process's own terminal attestation) are the shipped code; the turn and the grant record are in-process
 * stand-ins (P8-CORE's resolver and `secret grant` application plug into the same ports at fan-in). No runtime service, no model call.
 * argv: <locale en|tr> | offer; env PRE8_PTY_ROOT: the throwaway root (home, project, grant marker). `offer` prints the offer decision only.
 */
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { render } from 'ink';
import { WorklineApp, WorklinePaletteProvider, resolveWorklinePalette } from '#surfaces/core/terminal/index.js';
import { workSurfaceLabels } from '#surfaces/core/work-labels/index.js';
import { secretGrantCardPort } from '#surfaces/core/cli-terminal/index.js';
import { terminalSecretGrantOffer } from '#composition/core/terminal-chat/index.js';
import { credentialSourceError } from '#engine/index.js';

const root = process.env['PRE8_PTY_ROOT'], locale = process.argv[2] ?? 'en';
const projectRoot = join(root, 'project'), home = join(root, 'home'), marker = join(root, 'grant-DECKENT_ANTHROPIC_KEY');
const options = { env: { HOME: home, USERPROFILE: home, APPDATA: join(home, 'roaming'), LOCALAPPDATA: join(home, 'local'), XDG_CONFIG_HOME: join(home, '.config') } };
if (locale === 'offer') { process.stdout.write(String(await terminalSecretGrantOffer(projectRoot, options))); process.exit(0); }
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
// The turn as the shipped agent stream runs it: the local credential preflight refuses before anything is bound or sent; an admitted turn binds.
const streamTurn = (_messages, _signal, turn) => (async function* () {
  if (!existsSync(marker)) throw credentialSourceError('SECRET_GRANT_REQUIRED', { name: 'DECKENT_ANTHROPIC_KEY', project: projectRoot, scopeId: 'scope-a' });
  turn?.onTurnBound?.({ scopeId: 'scope-a', sessionId: turn.sessionId ?? null, turnId: 'pty-turn', phase: 'command-generated' });
  yield { kind: 'text', text: 'ANSWER-AFTER-GRANT' };
  yield { kind: 'done', finish: 'stop' };
})();
const secretGrant = secretGrantCardPort(projectRoot, 'scope-a', options, locale, {
  offer: (where, loaded) => terminalSecretGrantOffer(where, loaded),
  grant: async (_where, _scope, name) => { writeFileSync(join(root, `grant-${name}`), 'card\n'); },
}, home);
const view = createElement(WorklinePaletteProvider, { palette: resolveWorklinePalette('none'), children: createElement(WorklineApp, {
  context: { installationId: 'fixture-installation', projectId: 'fixture-project', scopeId: 'scope-a' },
  labels, target: 'scope-a · model', systemPrompt: 'SYSTEM', historyMessages: 20, completeTurn: async () => 'unused', pollMs: 60_000, approvalPollMs: 60_000,
  errorText: error => `ERR:${error?.code ?? 'error'} ${error?.suggestion ?? ''}`, streamTurn, secretGrant,
}) });
const instance = render(view, { exitOnCtrlC: false, patchConsole: false });
await instance.waitUntilExit();
