import type { Readable } from 'node:stream';
import { ErrorRegistry, t, type KnownSecretSnapshot, type Locale } from '#platform/index.js';
import { detectCliMode } from './mode.js';
import { lendHeldInput } from './input-hold.js';
import type { CardCopyLabels, QuestionOption } from '#surfaces/core/terminal-window/index.js';

/** One answer of a CLI card (the terminal's question option): a yes/no answer declares `role` (the card shows and takes (y)/(n)); others may show a `key`. */
export type CliCardOption = QuestionOption;
/** A card: title, body lines (untrusted text is redacted and made terminal-safe), answers; `initial` preselects one (none: Enter alone answers nothing). */
export type CliCardRequest = Readonly<{ title: string; body?: readonly string[]; options: readonly CliCardOption[]; initial?: string }>;
export type CliCardIo = Readonly<{ locale: Locale; stdin?: Readable & { isTTY?: boolean; setRawMode?: unknown }; stdout?: unknown; env?: NodeJS.ProcessEnv;
  agentEnvironment?: readonly string[]; signal?: AbortSignal; known?: KnownSecretSnapshot }>;

/**
 * Who may be asked: both streams a real terminal with raw mode and a person at it (never an agent, CI, pipe or dumb terminal), and a card
 * with at least one answer and distinct answer ids (a card with a yes/no answer has exactly one yes and one no). Refuses with `TERMINAL_TTY_REQUIRED` / `CLI_USAGE` before anything is drawn.
 * The card view itself (terminal window + question rows, Ink) mounts after this gate; it loads lazily, never at CLI start.
 */
export function cliCardGate(request: CliCardRequest, io: CliCardIo): Readonly<{ stdin: Readable & { isTTY?: boolean }; stdout: unknown; env: NodeJS.ProcessEnv }> {
  const stdin = io.stdin ?? process.stdin, stdout = io.stdout ?? process.stdout, env = io.env ?? process.env;
  const mode = detectCliMode({ env, stdin, stdout: stdout as { isTTY?: boolean }, ...(io.agentEnvironment ? { agentEnvironment: io.agentEnvironment } : {}) });
  if (mode.mode !== 'interactive' || typeof (stdin as { setRawMode?: unknown }).setRawMode !== 'function') throw ErrorRegistry.createError('TERMINAL_TTY_REQUIRED');
  if (!request.options.length || new Set(request.options.map(option => option.id)).size !== request.options.length) throw ErrorRegistry.createError('CLI_USAGE');
  const roles = (role: 'yes' | 'no') => request.options.filter(option => option.role === role).length;
  if ((roles('yes') || roles('no')) && (roles('yes') !== 1 || roles('no') !== 1)) throw ErrorRegistry.createError('CLI_USAGE');
  return { stdin, stdout, env };
}

export type StandingAnswer = 'once' | 'session' | 'always' | 'no';
/** The words of a card's Ctrl+Y copy (`tuicopy.card.*`) for a card drawn on its own stream (a CLI card, an onboarding step). */
export function cardCopyLabels(locale: Locale): CardCopyLabels {
  return { hint: t('tuicopy.card.hint', {}, locale), sent: t('tuicopy.card.sent', {}, locale), tooLarge: t('tuicopy.card.tooLarge', {}, locale), unavailable: t('tuicopy.card.unavailable', {}, locale) };
}
/**
 * The approval answers in the terminal card's words: once, this session, always, no. `always` is never offered on a hard-floor cell,
 * whatever the caller asked for; `session`/`always` appear only when offered. No option is preselected.
 */
export function standingCardOptions(locale: Locale, offer: Readonly<{ session?: boolean; always?: boolean; hardFloor: boolean }>): readonly CliCardOption[] {
  return Object.freeze([{ id: 'once', label: t('terminal.approval.window.choice.once', {}, locale), role: 'yes' },
    ...(offer.session ? [{ id: 'session', label: t('terminal.approval.window.choice.session', {}, locale), key: 's' }] : []),
    ...(offer.always && !offer.hardFloor ? [{ id: 'always', label: t('terminal.approval.window.choice.always', {}, locale), key: 'a' }] : []),
    { id: 'no', label: t('terminal.approval.window.choice.no', {}, locale), role: 'no' }]);
}

/**
 * Ask one question on the person's terminal with the terminal's own window and question keys (↑↓ or j/k, 1–9, Enter, the option letter;
 * Esc/Ctrl+C cancel; armed against keys typed before it appeared). Returns the chosen option id, or null when cancelled or aborted, so the
 * caller applies nothing. `cliCardGate` refuses first (TERMINAL_TTY_REQUIRED / CLI_USAGE). Ink loads only here, never at CLI start.
 */
export async function askCliCard(request: CliCardRequest, io: CliCardIo): Promise<string | null> {
  const { stdin, stdout, env } = cliCardGate(request, io);
  if (io.signal?.aborted) return null;
  const view = await import('./card-view.js');
  // A cancellation that landed while the view loaded fired no event the view could hear (Astra 2661 P2): never draw or wait then.
  if (io.signal?.aborted) return null;
  // A flow that holds the terminal between its cards (init) lends the input to this card and takes it back when the card closes.
  const giveBack = lendHeldInput(stdin);
  try {
    return await view.mountCliCard(request, { stdin: stdin as NodeJS.ReadStream, stdout: stdout as NodeJS.WriteStream, env, locale: io.locale,
      ...(io.signal ? { signal: io.signal } : {}), ...(io.known ? { known: io.known } : {}), hints: t('cli.human.card.hints', {}, io.locale) });
  } finally { giveBack(); }
}
// Scope picker for resolveCommandScope: `pick: request => askCliCard(request, io)`.
