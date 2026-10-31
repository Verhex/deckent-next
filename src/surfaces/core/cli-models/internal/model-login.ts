import { ErrorRegistry, EXIT_CODES, emit, t, terminalSafeText, type ConfigLoadOptions, type ExitCode, type Locale } from '#platform/index.js';
import { commandLocale } from '#surfaces/core/cli-kit/index.js';
import { askModelsCard, modelsConfirmOptions, modelsInteractive, modelsSinks, reportModelsCancelled } from './io.js';
import type { ModelCommandContext } from './context.js';

/** s3c: what the sign-in reported (the composition's result; login kind and plan only, never an account name or a token). */
export type HeadlessLoginView = Readonly<{ configDir: string; owned: boolean; exit: 'completed' | 'cancelled' | 'failed'; signedIn: boolean; authMethod: string | null;
  subscriptionType: string | null }>;
export type HeadlessLoginHandler = (command: Readonly<{ connection: string; configDir?: string; executable?: string; sso?: boolean }>, options: ConfigLoadOptions,
  confirm: (dir: Readonly<{ configDir: string; owned: boolean }>) => Promise<boolean>) => Promise<HeadlessLoginView | null>;
const FLAGS = ['--connection', '--config-dir', '--executable', '--lang'] as const;

function parse(argv: readonly string[]) {
  const values = new Map<string, string>(); let help = false, json = false, sso = false;
  for (let index = 2; index < argv.length; index++) {
    const flag = argv[index]!;
    if (flag === '--no-color') continue;
    if ((flag === '--help' || flag === '-h') && !help) { help = true; continue; }
    if (flag === '--json' && !json) { json = true; continue; }
    if (flag === '--sso' && !sso) { sso = true; continue; }
    if (!(FLAGS as readonly string[]).includes(flag) || values.has(flag)) throw ErrorRegistry.createError('CLI_USAGE');
    const value = argv[++index]; if (!value || value.startsWith('-')) throw ErrorRegistry.createError('CLI_USAGE');
    values.set(flag, value);
  }
  if (!help && !values.has('--connection')) throw ErrorRegistry.createError('CLI_USAGE');
  return { help, json, sso, values };
}
/** Which login dir it is: the Brain's own, or one the person named. */
const dirLine = (dir: Readonly<{ configDir: string; owned: boolean }>, locale: Locale) => dir.owned ? t('headless.login.dirOwned', { dir: terminalSafeText(dir.configDir) }, locale)
  : t('headless.login.dirOther', { dir: terminalSafeText(dir.configDir) }, locale);
/** The sign-in's outcome in the person's words: signed in (kind and plan), not signed in, or stopped. */
export function renderHeadlessLogin(view: HeadlessLoginView, locale: Locale, connection: string): string {
  const lines = [dirLine(view, locale)];
  if (view.exit !== 'completed') lines.push(view.exit === 'cancelled' ? t('headless.login.cancelled', {}, locale) : t('headless.login.failed', {}, locale));
  lines.push(view.signedIn ? t('headless.login.signedIn', { method: terminalSafeText(view.authMethod ?? '-'), plan: view.subscriptionType ? ` (${terminalSafeText(view.subscriptionType)})` : '',
    connection: terminalSafeText(connection) }, locale) : t('headless.login.notSignedIn', { connection: terminalSafeText(connection) }, locale));
  return lines.join('\n');
}

/**
 * s3c `deckent models login --connection <cli kind> [--config-dir <abs>] [--executable <abs>] [--sso]`: the person signs the subscription Brain's own
 * login dir in with the CLI's own sign-in, in this terminal. A person's terminal act: an AI tool, CI, pipe or `--json` is refused before anything is
 * read (the composition checks the terminal witness again); a card names the exact dir first. Switching account (Max, Team) = signing in again.
 */
export async function modelLoginCommand(argv: readonly string[], context: ModelCommandContext): Promise<void | ExitCode> {
  const parsed = parse(argv), locale = commandLocale(context, parsed.values.get('--lang')), sinks = modelsSinks(context);
  if (parsed.help) { emit(t('headless.help.login', {}, locale), sinks); return; }
  if (!modelsInteractive(context, parsed.json)) throw ErrorRegistry.createError('AUTHORITY_WITNESS_REQUIRED', { params: { operation: argv.slice(0, 2).join(' ') } });
  const login = context.loginHeadless;
  if (!login) throw ErrorRegistry.createError('CLI_USAGE');
  const value = (flag: string) => parsed.values.get(flag);
  const command = { connection: value('--connection')!, ...(value('--config-dir') ? { configDir: value('--config-dir')! } : {}),
    ...(value('--executable') ? { executable: value('--executable')! } : {}), ...(parsed.sso ? { sso: true } : {}) };
  const view = await login(command, { env: context.env ?? process.env }, async dir => await askModelsCard(context, locale, { title: t('headless.login.card.title', { connection: terminalSafeText(command.connection) }, locale),
    body: [dirLine(dir, locale), t('headless.login.card.what', {}, locale)],
    options: modelsConfirmOptions(locale) }) === 'apply');
  if (!view) { reportModelsCancelled(context, locale); return EXIT_CODES.error; }
  // PV 2e: the CLI's own sign-in wrote to this terminal; its last line may lack a line break, so the result starts on a line of its own.
  (context.stdout ?? process.stdout).write('\n');
  emit(renderHeadlessLogin(view, locale, command.connection), { ...sinks, ...(view.signedIn ? {} : { level: 'warning' as const }) });
  return view.signedIn && view.exit === 'completed' ? undefined : EXIT_CODES.error;
}
