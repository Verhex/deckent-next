import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ErrorRegistry, emit, loadConfig, t, type Locale } from '#platform/index.js';
import { approvalCommandSchema, approvalListSchema, approvalQuerySchema, approvalRenewalSchema } from '#engine/index.js';
import { approvalRecordSchema, type ApprovalRecord } from '#domain/index.js';
import { commandLocale, readJsonInput } from '#surfaces/core/cli-kit/index.js';
import { cliMode, cliTableStyle, resolveCommandScope, scopeLister, scopeNotice, standingCardOptions, type CliTableStyle, type ScopeResolution } from '#surfaces/core/cli-human/index.js';
import type { ApprovalCommandContext } from './context.js';
import { APPROVAL_LIST, approvalLines, approvalPickLabel, approvalTable, approvalWhat, isPending, onHardFloor, readableApprovals } from './approval-view.js';
import { assertInputFields, inputSchemaText, type InputSchema } from './input-check.js';
import { cardIo, sinksOf } from './io.js';
import registry from './approval.json' with { type: 'json' };

type Action = 'list' | 'inspect' | 'decide' | 'renew';
const ACTIONS: readonly string[] = ['list', 'inspect', 'decide', 'renew'], LEAVE = '-leave';
const SCHEMAS: Readonly<Record<Action, InputSchema>> = { list: approvalListSchema, inspect: approvalQuerySchema, decide: approvalCommandSchema, renew: approvalRenewalSchema };
interface Parsed { action: Action; source?: string; language?: string; scope?: string; reason?: string; json: boolean; schema: boolean; verbose: boolean; help: boolean }

function parse(argv: readonly string[]): Parsed {
  const action = argv[1];
  if (argv.length === 2 && (action === '--help' || action === '-h')) return { action: 'list', json: false, schema: false, verbose: false, help: true };
  if (!ACTIONS.includes(action ?? '')) throw ErrorRegistry.createError('CLI_USAGE');
  const parsed: Parsed = { action: action as Action, json: false, schema: false, verbose: false, help: false }, seen = new Set<string>();
  for (let i = 2; i < argv.length; i++) {
    const flag = argv[i]!; if (seen.has(flag)) throw ErrorRegistry.createError('CLI_USAGE'); seen.add(flag);
    if (flag === '--json') { parsed.json = true; continue; }
    if (flag === '--schema') { parsed.schema = true; continue; }
    if (flag === '--verbose') { parsed.verbose = true; continue; }
    const value = argv[++i]; if (!value || value.startsWith('--')) throw ErrorRegistry.createError('CLI_USAGE');
    if (flag === '--input') parsed.source = value; else if (flag === '--lang') parsed.language = value;
    else if (flag === '--scope') parsed.scope = value; else if (flag === '--reason') parsed.reason = value;
    else throw ErrorRegistry.createError('CLI_USAGE');
  }
  // --input is the AI/JSON path (unchanged contract); --scope/--reason belong to the person's path; --schema stands alone.
  if ((parsed.schema && (parsed.source || parsed.json || parsed.scope || parsed.reason || parsed.verbose)) || (parsed.source && (parsed.scope || parsed.reason))
    || (parsed.reason !== undefined && (parsed.action !== 'decide' || !parsed.reason.trim())) || (parsed.verbose && parsed.json)) throw ErrorRegistry.createError('CLI_USAGE');
  return parsed;
}

/**
 * `deckent approval <list|inspect|decide|renew>` (C-APPROVE, CLI review §approval).
 * - `--input <file|->`: the AI/JSON path, unchanged; the input is checked against the application's schema first (the refusal names the field);
 *   the result is readable text, raw JSON only with `--json`. `--schema` prints the input contract.
 * - `list` without `--input` (bare `approval` once the catalog reads `list`): the scope's approvals, waiting ones first. On a person's terminal
 *   a waiting approval can then be picked and answered on the terminal's card (once / no: what the terminal offers a stored approval).
 * - `decide` without `--input`: the same pick and card on a terminal; anywhere else the missing `--input` is named (exit 2).
 * Every decision goes through the same `decideApproval` operation (runtime service) as the terminal; nothing here decides on its own.
 */
export async function approvalsCommand(argv: readonly string[], context: ApprovalCommandContext): Promise<void> {
  const args = parse(argv), locale = commandLocale(context, args.language), sinks = sinksOf(context);
  if (args.help) { emit(t('cli.approval.help', {}, locale), sinks); return; }
  if (args.schema) { emit(inputSchemaText(SCHEMAS[args.action]), sinks); return; }
  const root = context.root ?? process.cwd(), env = context.env ?? process.env, config = await loadConfig(root, { env });
  if (!args.source) return personApprovals(args, context, locale, config.approvals);
  const handler = args.action === 'renew' ? context.renewApproval : args.action === 'list' ? context.listApprovals : args.action === 'inspect' ? context.inspectApproval : context.decideApproval;
  if (!handler) throw ErrorRegistry.createError('CLI_USAGE');
  const input = await readJsonInput(args.source === '-' ? args.source : resolve(root, args.source), config.cli.invocationInputMaxBytes,
    { subject: 'cli.input.subject.approval', limit: 'CLI_INVOCATION_INPUT_LIMIT', invalid: 'CLI_INVOCATION_INPUT_INVALID', tty: 'CLI_INVOCATION_INPUT_TTY', unavailable: 'CLI_INVOCATION_INPUT_UNAVAILABLE' }, context.stdin);
  // B1: the CLI declares its channel (a record, never authority); a channel the input already names is kept as declared.
  const sent = args.action === 'decide' && input !== null && typeof input === 'object' && !Array.isArray(input) && !('channel' in input) ? { ...input, channel: 'local-cli' } : input;
  assertInputFields(`${registry.command} ${args.action}`, SCHEMAS[args.action], sent, JSON.stringify(registry.examples[args.action]));
  const result = await handler(sent);
  emit(result, { ...sinks, json: args.json, render: value => renderResult(value, locale, args.verbose, cliTableStyle(context)) });
}

/** A result as a person reads it: a page as the table, one record (or a decision answer's record) as lines. */
function renderResult(value: unknown, locale: Locale, verbose: boolean, style: CliTableStyle): string {
  const now = Date.now();
  if (Array.isArray(value)) {
    const records = readableApprovals(value, now), unreadable = value.length - records.length;
    return [records.length ? approvalTable(records, now, locale, style) : t('cli.approval.none', {}, locale),
      ...(unreadable ? [t('cli.approval.unreadable', { count: unreadable }, locale)] : [])].join('\n');
  }
  if (value === null) return t('cli.approval.notFound', {}, locale);
  const record = approvalRecordSchema.safeParse(typeof value === 'object' && 'record' in value ? (value as { record: unknown }).record : value);
  return record.success ? approvalLines(record.data, now, locale, verbose).join('\n') : JSON.stringify(value, null, 2);
}

type Scan = Readonly<{ records: readonly ApprovalRecord[]; truncated: boolean; raw: readonly unknown[] }>;
/** Bounded scan of the scope's approval pages (the service's page size, at most `maxPages` pages): never a silent drop, `truncated` says so. */
async function scan(list: (input: unknown) => Promise<unknown>, scopeId: string, pageSize: number): Promise<Scan> {
  const raw: unknown[] = []; let after: string | null = null;
  for (let page = 0; page < APPROVAL_LIST.maxPages; page++) {
    const rows = await list({ schemaVersion: 1, scopeId, afterId: after, limit: pageSize }), items = Array.isArray(rows) ? rows : [];
    raw.push(...items);
    const last = (items.at(-1) as { request?: { approvalId?: unknown } } | undefined)?.request?.approvalId;
    if (items.length < pageSize || typeof last !== 'string') return { records: readableApprovals(raw, Date.now()), truncated: false, raw };
    after = last;
  }
  return { records: readableApprovals(raw, Date.now()), truncated: true, raw };
}

async function personApprovals(args: Parsed, context: ApprovalCommandContext, locale: Locale, approvals: Readonly<{ pageSize: number; sessionTtlMs: number }>): Promise<void> {
  if (args.action === 'inspect' || args.action === 'renew') throw missingInput(args.action, locale);
  const root = context.root ?? process.cwd(), options = { env: context.env ?? process.env }, sinks = sinksOf(context), list = context.listApprovals;
  const interactive = cliMode(context, args.json).mode === 'interactive';
  // A decision is never taken off a person's terminal without the AI path's explicit JSON command.
  if (args.action === 'decide' && !interactive) throw missingInput('decide', locale);
  if (!list) throw ErrorRegistry.createError('CLI_USAGE');
  const configured = ((await loadConfig(root, options)).terminal as { scopeId?: unknown } | undefined)?.scopeId, io = cardIo(context, locale, approvals.sessionTtlMs);
  const scope = await resolveCommandScope({ command: `${registry.command} ${args.action}`, locale, explicit: args.scope, configured: typeof configured === 'string' ? configured : undefined,
    mutating: args.action === 'decide', interactive, listScopes: scopeLister(context, root, options), pick: io.ask });
  if (!scope) return;
  let view = await scan(list, scope.scopeId, approvals.pageSize);
  if (args.json) { emit(view.raw, { ...sinks, json: true }); return; }
  const print = (text: string) => emit(text, sinks);
  if (args.action === 'list') print(listText(view, scope, locale, cliTableStyle(context)));
  if (!interactive) return;
  // The person's terminal: pick a waiting approval and answer it on the card; repeat until "leave" or nothing waits (bounded rounds).
  for (let round = 0; round < APPROVAL_LIST.menuRounds; round++) {
    const now = Date.now(), waiting = view.records.filter(record => isPending(record, now));
    if (!waiting.length) { if (args.action === 'decide' || round > 0) print(t('cli.approval.noneWaiting', { scope: scope.scopeId }, locale)); return; }
    const picked = await io.ask({ title: t('cli.approval.pick.title', { count: waiting.length }, locale),
      options: [...waiting.slice(0, APPROVAL_LIST.rowsShown).map(record => ({ id: record.request.approvalId, label: approvalPickLabel(record, locale) })),
        { id: LEAVE, label: t('cli.approval.pick.leave', {}, locale), key: 'q' }] });
    const record = waiting.find(item => item.request.approvalId === picked);
    if (!record) return;
    print(await answerOnCard(record, args.reason, scope.scopeId, context, io.ask, locale));
    view = await scan(list, scope.scopeId, approvals.pageSize);
  }
}

/**
 * The terminal's approval card for one stored approval: once / no (a stored record has no running turn, so the terminal offers no "this
 * session"/"always" for it either; a hard-floor request never offers "always"). Revision and command id come from the system; the reason is
 * the person's own `--reason` or the default sentence. A cancelled card decides nothing.
 */
export async function answerOnCard(record: ApprovalRecord, reason: string | undefined, scopeId: string, context: ApprovalCommandContext,
  ask: ReturnType<typeof cardIo>['ask'], locale: Locale): Promise<string> {
  const own = reason?.trim(), now = Date.now();
  const answer = await ask({ title: t('cli.approval.card.title', { what: approvalWhat(record, locale) }, locale),
    body: [...approvalLines(record, now, locale), own ? t('cli.approval.card.reasonGiven', { reason: own }, locale) : t('cli.approval.card.reasonDefault', {}, locale)],
    options: standingCardOptions(locale, { hardFloor: onHardFloor(record) }) });
  if (answer !== 'once' && answer !== 'no') return t('cli.approval.card.nothing', {}, locale);
  if (!context.decideApproval) throw ErrorRegistry.createError('CLI_USAGE');
  const decision = answer === 'once' ? 'allow' : 'deny';
  const result = await context.decideApproval({ schemaVersion: 1, scopeId, approvalId: record.request.approvalId, commandId: `cli-${randomUUID()}`,
    expectedRevision: record.revision, decision, channel: 'local-cli',
    reason: own || (decision === 'allow' ? t('cli.approval.reason.allow', {}, locale) : t('cli.approval.reason.deny', {}, locale)), ...(own ? { approverNote: true } : {}) });
  return renderResult(result, locale, false, { width: Number.POSITIVE_INFINITY, ascii: false });
}

function listText(view: Scan, scope: ScopeResolution, locale: Locale, style: CliTableStyle): string {
  const now = Date.now(), shown = view.records.slice(0, APPROVAL_LIST.rowsShown), waiting = view.records.filter(record => isPending(record, now)).length;
  return [scopeNotice(scope, locale), t('cli.approval.summary', { waiting, total: view.records.length }, locale),
    ...(shown.length ? [approvalTable(shown, now, locale, style)] : [t('cli.approval.none', {}, locale)]),
    ...(view.records.length > shown.length ? [t('cli.approval.more', { count: view.records.length - shown.length }, locale)] : []),
    ...(view.truncated ? [t('cli.approval.truncated', { pages: APPROVAL_LIST.maxPages }, locale)] : []),
    // A record this build cannot read (e.g. written by a newer service) is counted, never silently dropped.
    ...(view.raw.length > view.records.length ? [t('cli.approval.unreadable', { count: view.raw.length - view.records.length }, locale)] : [])].join('\n');
}

function missingInput(action: Action, locale: Locale): Error {
  return ErrorRegistry.createError('CLI_ARGUMENT_MISSING', { params: { command: `${registry.command} ${action}`,
    usage: t('cli.approval.missingInput', { action, example: JSON.stringify(registry.examples[action]) }, locale) } });
}
