import { resolve } from 'node:path';
import { ErrorRegistry, emit, loadConfig, resolveLocale, t, type ConfigLoadOptions, type Locale } from '#platform/index.js';
import { parseModelInvocationCancellationCommand, parseModelInvocationCommand, parseModelInvocationPurgeCommand, parseModelInvocationQuery, type ModelInvocationCancellationCommand, type ModelInvocationCommand,
  type ModelInvocationPurgeCommand, type ModelInvocationPurgeReceipt, type ModelInvocationQuery, type ModelInvocationReceipt } from '#domain/index.js';
import type { ModelInvocationCancellationResult, ModelInvocationPurgeResult, ModelInvocationResult, ModelInvocationInspection } from '#engine/index.js';
import type { CommandContext } from './kernel-commands.js';
import { readJsonInput } from './json-input.js';

export type ModelInvocationHandler = (root: string, input: ModelInvocationCommand, options: ConfigLoadOptions,
  signal?: AbortSignal) => Promise<ModelInvocationResult>;
export type ModelInvocationInspectionHandler = (root: string, input: ModelInvocationQuery,
  options: ConfigLoadOptions) => Promise<ModelInvocationInspection>;
export type ModelInvocationPurgeHandler = (root: string, input: ModelInvocationPurgeCommand,
  options: ConfigLoadOptions) => Promise<ModelInvocationPurgeResult>;
export type ModelInvocationCancellationHandler = (root: string, input: ModelInvocationCancellationCommand,
  options: ConfigLoadOptions) => Promise<ModelInvocationCancellationResult>;
interface Parsed { action: 'invoke' | 'invocation' | 'purge-content' | 'cancel'; source?: string; language?: string; json: boolean; help: boolean }
function parse(argv: readonly string[]): Parsed {
  if (argv[0] !== 'models' || (argv[1] !== 'invoke' && argv[1] !== 'invocation' && argv[1] !== 'purge-content' && argv[1] !== 'cancel')) throw ErrorRegistry.createError('CLI_USAGE');
  const result: Parsed = { action: argv[1], json: false, help: false }, seen = new Set<string>();
  for (let i = 2; i < argv.length; i++) {
    const key = argv[i] === '-h' ? '--help' : argv[i]!;
    if (seen.has(key)) throw ErrorRegistry.createError('CLI_USAGE'); seen.add(key);
    if (key === '--json') result.json = true;
    else if (key === '--help') result.help = true;
    else if (key === '--no-color') continue;
    else if (key === '--input' || key === '--lang') {
      const value = argv[++i]; if (!value || (value.startsWith('-') && value !== '-')) throw ErrorRegistry.createError('CLI_USAGE');
      if (key === '--input') result.source = value; else result.language = value;
    } else throw ErrorRegistry.createError('CLI_USAGE');
  }
  if ((!result.help && !result.source) || (result.help && (result.source || result.json))) throw ErrorRegistry.createError('CLI_USAGE');
  return result;
}
function render(receipt: ModelInvocationReceipt | null, locale: Locale, replayed?: boolean, purge?: ModelInvocationPurgeReceipt | null): string {
  if (!receipt) return t('models.invocation.absent', {}, locale);
  const state = receipt.outcome === null ? t('models.invocation.claimed', {}, locale)
    : receipt.outcome.state === 'responded' ? (purge ? t('models.invocation.respondedPurged', {}, locale) : t('models.invocation.responded', {}, locale))
      : receipt.outcome.state === 'rejected' ? (purge ? t('models.invocation.rejectedPurged', {}, locale) : t('models.invocation.rejected', {}, locale))
        : receipt.outcome.state === 'unknown' ? (purge ? t('models.invocation.unknownPurged', {}, locale) : t('models.invocation.unknown', {}, locale))
          : t('models.invocation.notSent', { command: receipt.outcome.cancellationCommandId }, locale);
  return [t('models.invocation.receipt', { id: receipt.claim.invocationId, command: receipt.claim.commandId, state }, locale),
    ...(replayed === true ? [t('models.invocation.replayed', {}, locale)] : []),
    ...(purge ? [t('models.invocation.purged', { id: receipt.claim.invocationId }, locale), t('models.invocation.purgeNotice', {}, locale)] : []),
    purge ? t('models.invocation.noticePurged', {}, locale) : t('models.invocation.notice', {}, locale)].join('\n');
}
/** Native request JSON stays in a file/stdin, never a positional prompt or command-line log. */
export async function modelInvocationCommand(argv: readonly string[], context: CommandContext): Promise<void> {
  const args = parse(argv), locale = resolveLocale(args.language, context.env); context.onLocale?.(locale);
  const sinks = { ...(context.stdout ? { stdout: context.stdout } : {}), ...(context.stderr ? { stderr: context.stderr } : {}) };
  if (args.help) { emit(args.action === 'purge-content' ? t('cli.help.modelsPurgeContent', {}, locale)
    : args.action === 'cancel' ? t('cli.help.modelsCancelInvocation', {}, locale) : t('cli.help.modelsInvocation', {}, locale), sinks); return; }
  const root = context.root ?? process.cwd(), options = { env: context.env ?? process.env }, config = await loadConfig(root, options);
  const source = args.source!, input = await readJsonInput(source === '-' ? source : resolve(root, source), config.cli.invocationInputMaxBytes,
    { limit: 'CLI_INVOCATION_INPUT_LIMIT', invalid: 'CLI_INVOCATION_INPUT_INVALID', tty: 'CLI_INVOCATION_INPUT_TTY', unavailable: 'CLI_INVOCATION_INPUT_UNAVAILABLE' }, context.stdin);
  if (args.action === 'invoke') {
    if (!context.invokeModel) throw ErrorRegistry.createError('MODEL_INVOCATION_UNAVAILABLE');
    let command; try { command = parseModelInvocationCommand(input); } catch { throw ErrorRegistry.createError('CLI_INVOCATION_INPUT_INVALID'); }
    const result = await context.invokeModel(root, command, options, context.signal);
    emit(result, { ...sinks, json: args.json, render: item => render(item.receipt, locale, item.replayed, item.purge) });
  } else if (args.action === 'invocation') {
    if (!context.inspectModelInvocation) throw ErrorRegistry.createError('MODEL_INVOCATION_UNAVAILABLE');
    let query; try { query = parseModelInvocationQuery(input); } catch { throw ErrorRegistry.createError('CLI_INVOCATION_INPUT_INVALID'); }
    const result = await context.inspectModelInvocation(root, query, options);
    emit(result, { ...sinks, json: args.json, render: item => render(item.invocation, locale, undefined, item.purge) });
  } else if (args.action === 'purge-content') {
    if (!context.purgeModelInvocationContent) throw ErrorRegistry.createError('MODEL_INVOCATION_UNAVAILABLE');
    let command; try { command = parseModelInvocationPurgeCommand(input); } catch { throw ErrorRegistry.createError('CLI_INVOCATION_INPUT_INVALID'); }
    const result = await context.purgeModelInvocationContent(root, command, options);
    emit(result, { ...sinks, json: args.json, render: item => [t('models.invocation.purged', { id: item.receipt.command.invocationId }, locale),
      ...(item.replayed ? [t('models.invocation.replayed', {}, locale)] : []), t('models.invocation.purgeNotice', {}, locale)].join('\n') });
  } else {
    if (!context.cancelModelInvocation) throw ErrorRegistry.createError('MODEL_INVOCATION_UNAVAILABLE');
    let command; try { command = parseModelInvocationCancellationCommand(input); } catch { throw ErrorRegistry.createError('CLI_INVOCATION_INPUT_INVALID'); }
    const result = await context.cancelModelInvocation(root, command, options);
    emit(result, { ...sinks, json: args.json, render: item => [t('models.invocation.cancellationRecorded', { id: item.receipt.claim.invocationId }, locale),
      ...(item.replayed ? [t('models.invocation.replayed', {}, locale)] : []), t('models.invocation.cancellationNotice', {}, locale)].join('\n') });
  }
}
