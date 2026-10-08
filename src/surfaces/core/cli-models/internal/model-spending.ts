import { resolve } from 'node:path';
import { DeckentError, ErrorRegistry, emit, loadConfig, resolveLocale, t, type ConfigLoadOptions, type Locale } from '#platform/index.js';
import { parseProviderSpendManagementCommand, type ProviderSpendManagementCommand, parseProviderSpendAccountQuery, parseProviderSpendAuditCommand, type ProviderSpendAccountQuery, type ProviderSpendAuditCommand } from '#domain/index.js';
import type { ProviderSpendManagementResult, ProviderSpendAccountInspection, ProviderSpendAuditResult } from '#engine/index.js';
import type { ModelCommandContext } from './context.js';
import { readJsonInput } from '#surfaces/core/cli-kit/index.js';
import { scopeBudgetCreateCommand, scopeBudgetLine, scopeBudgetRevisionCommand, scopeBudgetUsd } from './budget.js';

export type ProviderSpendAccountInspectionHandler = (root: string, query: ProviderSpendAccountQuery,
  options: ConfigLoadOptions) => Promise<ProviderSpendAccountInspection>;
export type ProviderSpendAuditHandler = (root: string, command: ProviderSpendAuditCommand,
  options: ConfigLoadOptions) => Promise<ProviderSpendAuditResult>;

export type ProviderSpendManagementHandler = (root: string, command: ProviderSpendManagementCommand, options: ConfigLoadOptions) => Promise<ProviderSpendManagementResult>;
interface Parsed { action: 'spending' | 'audit-spending' | 'reconcile-spending' | 'revise-budget' | 'create-budget'; source?: string; language?: string; json: boolean; help: boolean;
  /** Stage 1 budget flags: the command is built here, no JSON input (owner 2026-10-08). */
  scope?: string; usd?: string; commandId?: string; unfreeze?: boolean }
const ACTIONS = ['spending', 'audit-spending', 'reconcile-spending', 'revise-budget', 'create-budget'] as const;
function parse(argv: readonly string[]): Parsed {
  const action = ACTIONS.find(name => name === argv[1]);
  if (argv[0] !== 'models' || !action) throw ErrorRegistry.createError('CLI_USAGE');
  const result: Parsed = { action, json: false, help: false }, seen = new Set<string>();
  for (let index = 2; index < argv.length; index++) {
    const key = argv[index] === '-h' ? '--help' : argv[index]!;
    if (seen.has(key)) throw ErrorRegistry.createError('CLI_USAGE');
    seen.add(key);
    if (key === '--json') result.json = true;
    else if (key === '--help') result.help = true;
    else if (key === '--no-color') continue;
    else if (key === '--unfreeze' && action === 'revise-budget') result.unfreeze = true;
    else if (key === '--input' || key === '--lang' || (['--scope', '--usd', '--command-id'].includes(key) && (action === 'create-budget' || action === 'revise-budget'))) {
      const value = argv[++index];
      if (!value || (value.startsWith('-') && value !== '-')) throw ErrorRegistry.createError('CLI_USAGE');
      if (key === '--input') result.source = value; else if (key === '--lang') result.language = value;
      else if (key === '--scope') result.scope = value; else if (key === '--usd') result.usd = value; else result.commandId = value;
    } else throw ErrorRegistry.createError('CLI_USAGE');
  }
  // Budget flags and --input are two forms of one command, never mixed; create-budget has only the flag form.
  const flags = result.scope !== undefined || result.usd !== undefined || result.commandId !== undefined || result.unfreeze === true;
  const formed = result.source ? !flags && result.action !== 'create-budget' : result.scope !== undefined && result.usd !== undefined;
  if ((!result.help && !formed) || (result.help && (result.source || result.json || flags))) throw ErrorRegistry.createError('CLI_USAGE');
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
  result.spendingHistoryIntegrity === 'consistent' ? t('models.spending.historyConsistent', { command: result.audit!.command.commandId }, locale)
    : result.spendingHistoryIntegrity === 'stale' ? t('models.spending.historyStale', { command: result.audit!.command.commandId }, locale)
      : t('models.spending.historyNotRecorded', {}, locale)].join('\n');
}
function renderAudit(result: ProviderSpendAuditResult, locale: Locale): string {
  const receipt = result.receipt;
  return [t('models.spending.auditRecorded', { command: receipt.command.commandId, checkpoint: receipt.examinedCheckpoint.revision,
    replayed: result.replayed ? t('models.spending.auditReplayed', {}, locale) : t('models.spending.auditNew', {}, locale) }, locale),
  t('models.spending.auditNotice', {}, locale)].join('\n');
}

/** Account snapshots are read-only local evidence; they never claim an invoice or audited history. */
export async function modelSpendingCommand(argv: readonly string[], context: ModelCommandContext): Promise<void> {
  const args = parse(argv), locale = resolveLocale(args.language, context.env); context.onLocale?.(locale);
  const sinks = { ...(context.stdout ? { stdout: context.stdout } : {}), ...(context.stderr ? { stderr: context.stderr } : {}) };
  if (args.help) { emit(args.action === 'create-budget' || args.action === 'revise-budget' ? t('cli.help.modelsBudget', {}, locale) : args.action === 'reconcile-spending' ? t('cli.help.modelsManageSpending', {}, locale) : args.action === 'spending' ? t('cli.help.modelsSpending', {}, locale) : t('cli.help.modelsAuditSpending', {}, locale), sinks); return; }
  if (args.source === undefined) return budgetCommand(args, context, locale, sinks);
  if (args.action === 'spending' && !context.inspectProviderSpendAccount) throw ErrorRegistry.createError('PROVIDER_SPEND_UNAVAILABLE');
  if (args.action === 'audit-spending' && !context.auditProviderSpendAccount) throw ErrorRegistry.createError('PROVIDER_SPEND_UNAVAILABLE');
  const root = context.root ?? process.cwd(), options = { env: context.env ?? process.env, heal: false }, config = await loadConfig(root, options);
  const source = args.source!, input = await readJsonInput(source === '-' ? source : resolve(root, source), config.cli.invocationInputMaxBytes,
    { limit: 'CLI_INVOCATION_INPUT_LIMIT', invalid: 'CLI_INVOCATION_INPUT_INVALID', tty: 'CLI_INVOCATION_INPUT_TTY', unavailable: 'CLI_INVOCATION_INPUT_UNAVAILABLE' }, context.stdin);
  if (args.action === 'reconcile-spending' || args.action === 'revise-budget') {
    if (!context.manageProviderSpend) throw ErrorRegistry.createError('PROVIDER_SPEND_UNAVAILABLE');
    let command: ProviderSpendManagementCommand;
    try { command = parseProviderSpendManagementCommand(input); } catch { throw ErrorRegistry.createError('CLI_INVOCATION_INPUT_INVALID'); }
    if ((args.action === 'reconcile-spending') !== (command.kind === 'reconcile')) throw ErrorRegistry.createError('CLI_INVOCATION_INPUT_INVALID');
    const result = await context.manageProviderSpend(root, command, options);
    emit(result, { ...sinks, json: args.json, render: value => t('models.spending.managementRecorded', { command: value.receipt.command.commandId }, locale) });
  } else if (args.action === 'spending') {
    let query: ProviderSpendAccountQuery;
    try { query = parseProviderSpendAccountQuery(input); } catch { throw ErrorRegistry.createError('CLI_INVOCATION_INPUT_INVALID'); }
    const result = await context.inspectProviderSpendAccount!(root, query, options);
    emit(result, { ...sinks, json: args.json, render: value => render(value, locale) });
  } else {
    let command: ProviderSpendAuditCommand;
    try { command = parseProviderSpendAuditCommand(input); } catch { throw ErrorRegistry.createError('CLI_INVOCATION_INPUT_INVALID'); }
    const result = await context.auditProviderSpendAccount!(root, command, options);
    emit(result, { ...sinks, json: args.json, render: value => renderAudit(value, locale) });
  }
}

/** Stage 1 `models create-budget|revise-budget --scope --usd`: the same governed command the terminal window sends, built from the flags. */
async function budgetCommand(args: Parsed, context: ModelCommandContext, locale: Locale, sinks: Parameters<typeof emit>[1]): Promise<void> {
  const usd = scopeBudgetUsd(args.usd);
  if (usd === null) throw ErrorRegistry.createError('CLI_USAGE');
  if (!context.manageProviderSpend || (args.action === 'revise-budget' && !context.inspectProviderSpendAccount)) throw ErrorRegistry.createError('PROVIDER_SPEND_UNAVAILABLE');
  const root = context.root ?? process.cwd(), options = { env: context.env ?? process.env, heal: false }, scopeId = args.scope!;
  // A malformed scope or command id is a usage error (the domain parser refuses it before anything is sent).
  const built = (build: () => ProviderSpendManagementCommand) => { try { return build(); } catch (error) { if (error instanceof DeckentError) throw error; throw ErrorRegistry.createError('CLI_USAGE'); } };
  const command = args.action === 'create-budget' ? built(() => scopeBudgetCreateCommand(scopeId, usd, 'cli', args.commandId))
    : await context.inspectProviderSpendAccount!(root, { schemaVersion: 1, scopeId, current: true }, options)
      .then(current => built(() => scopeBudgetRevisionCommand(current, usd, args.unfreeze === true, 'cli', args.commandId)));
  const result = await context.manageProviderSpend(root, command, options);
  emit(result, { ...sinks, json: args.json, render: value => scopeBudgetLine(value, locale) });
}
