import { resolve } from 'node:path';
import { ErrorRegistry, emit, loadConfig, resolveLocale, t, type ConfigLoadOptions, type Locale } from '#platform/index.js';
import { parseProviderSpendAccountQuery, type ProviderSpendAccountQuery } from '#domain/index.js';
import type { ProviderSpendAccountInspection } from '#engine/index.js';
import type { CommandContext } from './kernel-commands.js';
import { readJsonInput } from './json-input.js';

export type ProviderSpendAccountInspectionHandler = (root: string, query: ProviderSpendAccountQuery,
  options: ConfigLoadOptions) => Promise<ProviderSpendAccountInspection>;

interface Parsed { source?: string; language?: string; json: boolean; help: boolean }
function parse(argv: readonly string[]): Parsed {
  if (argv[0] !== 'models' || argv[1] !== 'spending') throw ErrorRegistry.createError('CLI_USAGE');
  const result: Parsed = { json: false, help: false }, seen = new Set<string>();
  for (let index = 2; index < argv.length; index++) {
    const key = argv[index] === '-h' ? '--help' : argv[index]!;
    if (seen.has(key)) throw ErrorRegistry.createError('CLI_USAGE');
    seen.add(key);
    if (key === '--json') result.json = true;
    else if (key === '--help') result.help = true;
    else if (key === '--no-color') continue;
    else if (key === '--input' || key === '--lang') {
      const value = argv[++index];
      if (!value || (value.startsWith('-') && value !== '-')) throw ErrorRegistry.createError('CLI_USAGE');
      if (key === '--input') result.source = value; else result.language = value;
    } else throw ErrorRegistry.createError('CLI_USAGE');
  }
  if ((!result.help && !result.source) || (result.help && (result.source || result.json))) throw ErrorRegistry.createError('CLI_USAGE');
  return result;
}

function render(result: ProviderSpendAccountInspection, locale: Locale): string {
  if (result.checkpoint === null) return [t('models.spending.absent', { scope: result.scopeId, budget: result.budgetId,
    revision: result.budgetRevision }, locale), t('models.spending.historyNotRecorded', {}, locale)].join('\n');
  const { account } = result.checkpoint;
  return [t('models.spending.account', { scope: result.scopeId, budget: result.budgetId, revision: result.budgetRevision,
    currency: account.budget.currency, limit: account.budget.limitMinorUnits, checkpoint: result.checkpoint.revision,
    reservations: result.checkpoint.reservationCount }, locale),
  t('models.spending.reserved', { amount: account.reservedMinorUnits, currency: account.budget.currency }, locale),
  t('models.spending.settledExact', { amount: account.settledExactMinorUnits, currency: account.budget.currency }, locale),
  t('models.spending.settledRounded', { amount: account.settledMinorUnits, currency: account.budget.currency }, locale),
  t('models.spending.frozen', { value: account.frozen ? t('models.spending.frozenYes', {}, locale) : t('models.spending.frozenNo', {}, locale) }, locale),
  t('models.spending.historyNotRecorded', {}, locale)].join('\n');
}

/** Account snapshots are read-only local evidence; they never claim an invoice or audited history. */
export async function modelSpendingCommand(argv: readonly string[], context: CommandContext): Promise<void> {
  const args = parse(argv), locale = resolveLocale(args.language, context.env); context.onLocale?.(locale);
  const sinks = { ...(context.stdout ? { stdout: context.stdout } : {}), ...(context.stderr ? { stderr: context.stderr } : {}) };
  if (args.help) { emit(t('cli.help.modelsSpending', {}, locale), sinks); return; }
  if (!context.inspectProviderSpendAccount) throw ErrorRegistry.createError('PROVIDER_SPEND_UNAVAILABLE');
  const root = context.root ?? process.cwd(), options = { env: context.env ?? process.env, heal: false }, config = await loadConfig(root, options);
  const source = args.source!, input = await readJsonInput(source === '-' ? source : resolve(root, source), config.cli.invocationInputMaxBytes,
    { limit: 'CLI_INVOCATION_INPUT_LIMIT', invalid: 'CLI_INVOCATION_INPUT_INVALID', tty: 'CLI_INVOCATION_INPUT_TTY', unavailable: 'CLI_INVOCATION_INPUT_UNAVAILABLE' }, context.stdin);
  let query: ProviderSpendAccountQuery;
  try { query = parseProviderSpendAccountQuery(input); } catch { throw ErrorRegistry.createError('CLI_INVOCATION_INPUT_INVALID'); }
  const result = await context.inspectProviderSpendAccount(root, query, options);
  emit(result, { ...sinks, json: args.json, render: value => render(value, locale) });
}
