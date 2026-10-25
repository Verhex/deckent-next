import { ErrorRegistry, t, terminalSafeText, type Locale } from '#platform/index.js';
import { askCliCard, cliMode, scopeLister } from '#surfaces/core/cli-human/index.js';
import { initCommand } from '#surfaces/core/cli-installation/index.js';
import { offerTarget } from '#surfaces/core/cli-kit/index.js';
import type { CommandContext } from './kernel-commands.js';
import { relative, sep } from 'node:path';

const code = (error: unknown) => (error as { code?: unknown } | null)?.code;
/** The J2d answer: only a missing policy file means "no installation here"; an installation with no scope to read keeps its own error. */
async function installationMissing(context: CommandContext, root: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  return scopeLister(context, root, { env })().then(() => false, (error: unknown) => code(error) === 'CLI_INSTALLATION_MISSING');
}

/**
 * I-S5 (owner D8): bare `deckent` stopped with no scope (`refusal`). In a folder with no installation, a person on a real terminal is asked once
 * whether to start the guided setup; anyone else (pipe, AI agent, CI, dumb terminal) and an installation without a scope get `refusal` unchanged.
 * The card writes nothing. Yes runs `deckent init` itself (the setup window owns the terminal only after the card unmounted and stdin paused), then
 * the terminal starts again on the configuration as it is now; No, Esc or a still missing scope give the human answer naming `deckent init`.
 */
export async function offerSetup(refusal: unknown, context: CommandContext, locale: Locale, launch: (context: CommandContext) => Promise<void>): Promise<void> {
  const root = context.root ?? process.cwd(), env = context.env ?? process.env, stdin = context.stdin ?? process.stdin;
  if (cliMode(context).reason !== 'tty' || !(await installationMissing(context, root, env))) throw refusal;
  const target = offerTarget(context.rootResolution?.found ?? false, context.rootResolution?.gitTop ?? null, root);
  const answer = await askCliCard({ title: t('setup.offer.title', {}, locale), body: [t('setup.offer.folder', { path: terminalSafeText(target) }, locale), t('setup.offer.body', {}, locale)],
    options: [{ id: 'yes', label: target === root ? t('setup.window.yes', {}, locale) : t('setup.offer.recommended', { path: terminalSafeText(target) }, locale), key: 'y' },
      ...(target === root ? [] : [{ id: 'here', label: t('setup.offer.here', { path: terminalSafeText(root) }, locale), key: 'h' }]),
      { id: 'no', label: t('setup.window.no', {}, locale), key: 'n' }], initial: 'yes' },
  { locale, env, stdin, ...(context.stdout ? { stdout: context.stdout } : {}), ...(context.agentEnvironment ? { agentEnvironment: context.agentEnvironment } : {}),
    ...(context.signal ? { signal: context.signal } : {}) });
  stdin.pause();
  if (answer !== 'yes' && answer !== 'here') throw ErrorRegistry.createError('CLI_INSTALLATION_MISSING');
  const chosen = answer === 'here' ? root : target;
  const selected = { ...context, root: chosen, rootResolution: { root: chosen, folder: relative(chosen, root).split(sep).join('/'), found: false, gitTop: null } };
  await initCommand(['init'], selected);
  // The terminal reads the configuration again; the card is never offered twice in one call. Its input reads stdin as a fresh process has it:
  // flowing (an explicitly paused stream never starts again for a new 'data' reader), paused again when the terminal does not open.
  stdin.resume();
  await launch(selected).catch(async (error: unknown) => {
    stdin.pause();
    if (code(error) === 'TERMINAL_SCOPE_REQUIRED' && await installationMissing(selected, chosen, env)) throw ErrorRegistry.createError('CLI_INSTALLATION_MISSING');
    throw error;
  });
}
