import { randomUUID } from 'node:crypto';
import { brainPlanCommandSchema } from '#domain/index.js';
import { brainProposalLines } from '#surfaces/core/run-planning/index.js';
import { PACKAGE_NAME, emit, loadConfig, resolveLocale, ErrorRegistry, clockText, t, type Locale } from '#platform/index.js';
import type { BrainPlanProgress } from '#domain/index.js';
import { cliUsage, commandLocale } from '#surfaces/core/cli-kit/index.js';
import type { RunCommandContext } from './context.js';
export async function doCommand(argv: readonly string[], context: RunCommandContext, initialLocale: Locale = resolveLocale(undefined, context.env)) {
  const languageAt = argv.indexOf('--lang');
  initialLocale = commandLocale(context, languageAt < 0 ? undefined : argv[languageAt + 1]);
  const values = new Map<string, string>(); let json = false;
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--json' && !json) { json = true; continue; }
    if (arg === '--no-color') continue;
    if (!['--request', '--scope', '--command-id', '--lang'].includes(arg) || values.has(arg)) throw cliUsage('do', undefined, initialLocale);
    const value = argv[++i]; if (!value || value.startsWith('--')) throw cliUsage('do', undefined, initialLocale, arg);
    values.set(arg, value);
  }
  if (!context.planRun) throw ErrorRegistry.createError('INVENTORY_UNAVAILABLE');
  const root = context.root ?? process.cwd(), options = { env: context.env ?? process.env }, config = await loadConfig(root, options);
  const locale = resolveLocale(values.get('--lang'), context.env, config.language); context.onLocale?.(locale);
  const scopeId = values.get('--scope');
  if (!scopeId) throw ErrorRegistry.createError('CLI_SCOPE_REQUIRED', { locale, params: { command: `${PACKAGE_NAME} ${argv[0]}`, scopes: '-' } });
  const intent = values.get('--request'); if (!intent) throw cliUsage('do', undefined, locale, '--request');
  const command = brainPlanCommandSchema.parse({ schemaVersion: 1, commandId: values.get('--command-id') ?? randomUUID(), scopeId, intent });
  // f3 (owner Q-H4): a quota wait is shown on stderr (stdout keeps the one result, --json included); Ctrl+C cancels it through the signal.
  const stderr = context.stderr ?? process.stderr;
  const observe = (progress: BrainPlanProgress) => { stderr.write(`${progress.kind === 'quota-wait'
    ? t('brainwait.cli', { time: clockText(progress.untilMs), attempt: progress.attempt, maxAttempts: progress.maxAttempts }, locale)
    : t('brainwait.resumed', { attempt: progress.attempt }, locale)}\n`); };
  const result = await context.planRun(root, command, options, context.signal, observe);
  emit(result, { json, ...(context.stdout ? { stdout: context.stdout } : {}), render: value => [t('cli.do.command', { command: command.commandId }, locale), ...brainProposalLines(value, locale)].join('\n') });
}
