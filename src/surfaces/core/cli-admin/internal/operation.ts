import { resolve } from 'node:path';
import { DeckentError, ErrorRegistry, emit, loadConfig, t, type ConfigLoadOptions, type Locale } from '#platform/index.js';
import { effectCommandSchema, type EffectCommand, type EffectRecord } from '#domain/index.js';
import { projectInputSchema, type EffectOutcome } from '#engine/index.js';
import { commandLocale, readJsonInput } from '#surfaces/core/cli-kit/index.js';
import { cliTableStyle, renderCliTable, renderInputSchema, schemaRequested } from '#surfaces/core/cli-human/index.js';
import type { AdminCommandContext } from './context.js';
export type OperationEffectHandler = (root: string, command: EffectCommand, options: ConfigLoadOptions,
  submit?: { readonly awaitApproval?: { readonly timeoutMs: number } }) => Promise<EffectOutcome>;
export type OperationInspectHandler = (root: string, query: { readonly scopeId: string; readonly commandId: string }, options: ConfigLoadOptions)
  => Promise<Readonly<{ schemaVersion: 1; record: EffectRecord | null }>>;

type CatalogEntry = Readonly<{ operation: { id: string; version: number }; targetKind: string; effectClass: string; approval: string;
  compensation: { id: string; version: number } | null }>;
/** The operations section as configured (business policy data, empty by default): what `deckent operation` can run here. */
function operationsSection(config: Record<string, unknown>) {
  const section = config['operations'] as { catalog?: readonly CatalogEntry[]; targets?: readonly { adapter: string; options?: unknown }[] } | undefined;
  return { catalog: section?.catalog ?? [], targets: section?.targets ?? [] };
}
const targetKind = (target: { options?: unknown }) => typeof (target.options as { kind?: unknown } | null)?.kind === 'string' ? (target.options as { kind: string }).kind : '-';

/** `deckent operation execute|compensate --input <file|-> [--wait <ms>]` and `inspect --scope <id> --command-id <id>`. A required approval
 * is reported as pending (C12 G2); `--wait` polls the decision up to the given time and resubmits the same command once after an allow.
 * Bare `deckent operation` reads the configured catalog (C-SETUP, review §operation); `--schema` prints the effect command's contract. */
export async function operationCommand(argv: readonly string[], context: AdminCommandContext): Promise<void> {
  const action = argv[1]; const values = new Map<string, string>(); let json = false;
  const help = argv.length === 2 && (action === '--help' || action === '-h');
  const bare = action === undefined || action.startsWith('--') && !help;
  if (!help && !bare && action !== 'execute' && action !== 'compensate' && action !== 'inspect') throw ErrorRegistry.createError('CLI_USAGE');
  const schema = !help && !bare && action !== 'inspect' && schemaRequested(argv);
  const allowed = bare ? ['--lang'] : action === 'inspect' ? ['--scope', '--command-id', '--lang'] : ['--input', '--wait', '--lang'];
  for (let i = bare ? 1 : 2; i < argv.length; i++) {
    const flag = argv[i]!; if (flag === '--json' && !json) { json = true; continue; }
    if (flag === '--schema' && schema) continue;
    if (!allowed.includes(flag) || values.has(flag)) throw ErrorRegistry.createError('CLI_USAGE');
    const value = argv[++i]; if (!value || value.startsWith('--')) throw ErrorRegistry.createError('CLI_USAGE');
    values.set(flag, value);
  }
  const locale = commandLocale(context, values.get('--lang'));
  const sinks = { ...(context.stdout ? { stdout: context.stdout } : {}), ...(context.stderr ? { stderr: context.stderr } : {}) };
  if (help) { emit(t('cli.operation.help', {}, locale), sinks); return; }
  // The input contract is the same zod schema every producer validates (machine output, one projection with MCP).
  if (schema) { emit(renderInputSchema(projectInputSchema(effectCommandSchema)), { ...sinks, json: false }); return; }
  const root = context.root ?? process.cwd(); const options = { env: context.env ?? process.env };
  if (bare) {
    const config = await loadConfig(root, { ...options, heal: false }), section = operationsSection(config as Record<string, unknown>);
    emit({ schemaVersion: 1 as const, catalog: section.catalog, targets: section.targets.map(target => ({ adapter: target.adapter, kind: targetKind(target) })) },
      { ...sinks, json, render: data => renderCatalog(data.catalog, data.targets, locale, cliTableStyle(context)) });
    return;
  }
  if (action === 'inspect') {
    const scopeId = values.get('--scope'), commandId = values.get('--command-id');
    if (!scopeId || !commandId || !context.inspectOperation) throw ErrorRegistry.createError('CLI_USAGE');
    const result = await context.inspectOperation(root, { scopeId, commandId }, options);
    // A command this scope has no record of is a failed read (exit 1) for a person, as for `run inspect`. J2e: `--json` keeps the unchanged machine
    // contract (`record: null`, exit 0) that the SDK, MCP and the ERP process fixture read.
    if (!result.record && !json) throw ErrorRegistry.createError('CLI_OPERATION_NOT_FOUND', { params: { command: commandId, scope: scopeId }, locale });
    emit(result, { ...sinks, json, render: data => [t('cli.operation.inspect', { command: commandId, state: data.record!.state, sequence: data.record!.sequence }, locale),
      ...inspectNextStep(data.record!, locale)].join('\n') });
    return;
  }
  const source = values.get('--input'); const handler = action === 'execute' ? context.executeOperation : context.compensateOperation;
  if (!source || !handler) throw ErrorRegistry.createError('CLI_USAGE');
  const wait = values.get('--wait'); const timeoutMs = wait === undefined ? undefined : Number(wait);
  if (timeoutMs !== undefined && (!/^\d{1,9}$/.test(wait!) || timeoutMs < 1)) throw ErrorRegistry.createError('CLI_USAGE');
  const config = await loadConfig(root, options);
  const input = await readJsonInput(source === '-' ? source : resolve(root, source), config.cli.invocationInputMaxBytes,
    { subject: 'cli.input.subject.operation', limit: 'CLI_INVOCATION_INPUT_LIMIT', invalid: 'CLI_INVOCATION_INPUT_INVALID', tty: 'CLI_INVOCATION_INPUT_TTY', unavailable: 'CLI_INVOCATION_INPUT_UNAVAILABLE' }, context.stdin);
  // The command is checked here against its own schema, so a bad document names its field before anything is sent (no inventory wording).
  const command = effectCommandSchema.safeParse(input);
  if (!command.success) {
    const issue = command.error.issues[0]!;
    // The issue's code, not its message: the message is English and may quote the received value.
    throw ErrorRegistry.createError('CLI_OPERATION_INPUT_INVALID', { params: { field: issue.path.length ? issue.path.join('.') : '(document)', problem: issue.code }, locale });
  }
  let result: EffectOutcome;
  try { result = await handler(root, input as EffectCommand, options, timeoutMs === undefined ? undefined : { awaitApproval: { timeoutMs } }); }
  catch (error) { throw withNextStep(error, command.data, locale); }
  emit(result, { ...sinks, json, render: data => data.status === 'approval-pending'
    ? t('cli.operation.pending', { operation: data.operation.id, version: data.operation.version, kind: data.target.kind, id: data.target.id,
      approvalId: data.approval.approvalId, expiresAt: new Date(data.approval.expiresAt).toISOString() }, locale)
    : t('cli.operation.settled', { operation: data.operation.id, version: data.operation.version,
      kind: data.target.kind, id: data.target.id, sequence: data.sequence, recordVersion: data.version ?? t('cli.value.none', {}, locale) }, locale) });
}

/** BETA-RAKIP-3: an uncertain or blocked outcome names this command's scope, id and record, so the suggestion is the exact next step. The typed
 * code and category stay the engine's; nothing is retried here. */
function withNextStep(error: unknown, command: EffectCommand, locale: Locale): unknown {
  if (!(error instanceof DeckentError) || (error.code !== 'EFFECT_OUTCOME_UNKNOWN' && error.code !== 'EFFECT_TARGET_BUSY')) return error;
  return ErrorRegistry.createError(error.code, { params: { ...error.params, scope: command.scopeId, command: command.commandId,
    kind: command.target.kind, id: command.target.id }, locale, cause: error });
}
/** The next step a person can take for a recorded but unsettled operation; a settled or refused record has none. */
function inspectNextStep(record: EffectRecord, locale: Locale): string[] {
  const { kind, id } = record.intent.command.target;
  if (record.state === 'unknown') return [t('cli.operation.inspect.next.unknown', { kind, id }, locale)];
  if (record.state === 'claimed') return [t('cli.operation.inspect.next.claimed', { kind, id }, locale)];
  return [];
}

function renderCatalog(catalog: readonly CatalogEntry[], targets: readonly { adapter: string; kind: string }[], locale: Locale, style: ReturnType<typeof cliTableStyle>): string {
  if (!catalog.length) return [t('clisetup.operation.empty', { targets: targets.length }, locale), t('clisetup.operation.define', {}, locale)].join('\n');
  const columns = t('clisetup.operation.columns', {}, locale).split('|').map(header => ({ header }));
  return [t('clisetup.operation.title', { count: catalog.length, targets: targets.length }, locale),
    renderCliTable(columns, catalog.map(entry => [`${entry.operation.id}@${entry.operation.version}`, entry.targetKind, entry.effectClass,
      entry.approval === 'required' ? t('clisetup.operation.approval.required', {}, locale) : t('clisetup.operation.approval.policy', {}, locale),
      entry.compensation ? `${entry.compensation.id}@${entry.compensation.version}` : t('clisetup.operation.noCompensation', {}, locale)]), style),
    t('clisetup.operation.next', {}, locale)].join('\n');
}
