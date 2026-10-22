import { ErrorRegistry, EXIT_CODES, emit, loadConfig, t, terminalSafeText, type ConfigLoadOptions, type ExitCode, type Locale } from '#platform/index.js';
import type { WorkerInstructionStatus, WorkerInstructionTrustResult } from '#engine/index.js';
import { commandLocale } from '#surfaces/core/cli-kit/index.js';
import { cliMode, resolveCommandScope, scopeLister, scopeNotice } from '#surfaces/core/cli-human/index.js';
import type { AdminCommandContext } from './context.js';
import { adminSinks, askAdminCard, confirmOptions, reportCancelled } from './io.js';

/** `coding instructions status`: the configured work target's worker instruction file (read-only; never its whole content). */
export type WorkerInstructionStatusHandler = (root: string, options: ConfigLoadOptions) => Promise<{ readonly schemaVersion: 1; readonly targets: readonly WorkerInstructionStatus[] }>;
/** `coding instructions trust|revoke` in this process at the person's witnessed terminal (decided on `config`/`write`, sealed before the record changes). */
export type WorkerInstructionTrustHandler = (root: string, input: { readonly scopeId: string; readonly action: 'trust' | 'revoke'; readonly digest: string; readonly target?: string },
  options: ConfigLoadOptions) => Promise<WorkerInstructionTrustResult>;

const where = (row: WorkerInstructionStatus, locale: Locale) => row.target === null ? t('cli.coding.instructions.projectRoot', { root: terminalSafeText(row.root) }, locale)
  : t('cli.coding.instructions.target', { target: terminalSafeText(row.target), root: terminalSafeText(row.root) }, locale);
const fileLine = (row: WorkerInstructionStatus, locale: Locale) => t('cli.coding.instructions.file', { path: terminalSafeText(row.path ?? row.file ?? '-'),
  bytes: row.bytes ?? 0, digest: row.digest ?? '-' }, locale);
function stateLine(row: WorkerInstructionStatus, locale: Locale): string {
  const params = { source: row.source, file: row.file ?? '-', reason: row.reason ?? '-' };
  if (row.state === 'off') return row.off === 'source-none' ? t('cli.coding.instructions.state.sourceNone', params, locale) : t('cli.coding.instructions.state.noExecution', params, locale);
  if (row.state === 'absent') return t('cli.coding.instructions.state.absent', params, locale);
  if (row.state === 'blocked') return t('cli.coding.instructions.state.blocked', params, locale);
  return row.state === 'trusted' ? t('cli.coding.instructions.state.trusted', params, locale) : t('cli.coding.instructions.state.untrusted', params, locale);
}
/** Target · file (path, bytes, sha256) · whether workers get it now, and the next command when they do not. */
export function renderWorkerInstructionStatus(rows: readonly WorkerInstructionStatus[], locale: Locale): string {
  return rows.flatMap(row => [where(row, locale), ...(row.digest ? [`  ${fileLine(row, locale)}`] : []), `  ${stateLine(row, locale)}`,
    ...(row.state === 'untrusted' ? [`  ${t('cli.coding.instructions.next', {}, locale)}`] : [])]).join('\n');
}

/**
 * `deckent coding instructions [status] | trust | revoke [--target <id>] [--scope <id>]` (alpha.53 F1): the worker instruction file a Run
 * snapshots is trusted only by a person — a card on their own terminal showing path, size, sha256 and the first lines; AI tools, MCP, pipes
 * and `--json` are refused before anything is read (the composition checks the terminal witness again). Trust holds for exactly that folder
 * and content; any change makes it untrusted again. `status` is read-only and takes `--json`.
 */
export async function codingInstructionsCommand(argv: readonly string[], context: AdminCommandContext): Promise<void | ExitCode> {
  const named = argv[2] !== undefined && !argv[2].startsWith('-'), action = named ? argv[2]! : 'status';
  if (!['status', 'trust', 'revoke'].includes(action)) throw ErrorRegistry.createError('CLI_USAGE');
  let json = false, language: string | undefined, scope: string | undefined, target: string | undefined;
  for (let i = named ? 3 : 2; i < argv.length; i++) {
    const flag = argv[i]!, next = () => { const value = argv[++i]; if (!value || value.startsWith('-')) throw ErrorRegistry.createError('CLI_USAGE'); return value; };
    if (flag === '--json' && !json) json = true;
    else if (flag === '--lang' && language === undefined) language = next();
    else if (flag === '--scope' && scope === undefined && action !== 'status') scope = next();
    else if (flag === '--target' && target === undefined && action !== 'status') target = next();
    else if (flag !== '--no-color') throw ErrorRegistry.createError('CLI_USAGE');
  }
  const operation = `coding instructions ${action}`;
  // A trust change is a person's terminal act, like `secret grant`: an agent, CI, pipe or `--json` caller is refused before anything is read.
  if (action !== 'status' && cliMode(context, json).mode !== 'interactive') throw ErrorRegistry.createError('AUTHORITY_WITNESS_REQUIRED', { params: { operation } });
  const { inspectWorkerInstructions, changeWorkerInstructionTrust } = context;
  if (!inspectWorkerInstructions || (action !== 'status' && !changeWorkerInstructionTrust)) throw ErrorRegistry.createError('CLI_USAGE');
  const root = context.root ?? process.cwd(), env = context.env ?? process.env, options = { env }, locale = commandLocale(context, language), sinks = adminSinks(context);
  if (action === 'status') {
    const view = await inspectWorkerInstructions(root, options);
    emit(view, { ...sinks, json, render: () => renderWorkerInstructionStatus(view.targets, locale) });
    return;
  }
  const configured = await loadConfig(root, options).then(config => (config['terminal'] as { scopeId?: unknown } | undefined)?.scopeId, () => undefined);
  const resolved = await resolveCommandScope({ command: `deckent ${operation}`, locale, explicit: scope, configured: typeof configured === 'string' ? configured : undefined,
    mutating: true, interactive: true, listScopes: () => scopeLister(context, root, options)().catch(() => []), pick: request => askAdminCard(context, locale, request) });
  const cancelled = () => { reportCancelled(context, locale); return EXIT_CODES.error; };
  if (!resolved) return cancelled();
  const row = (await inspectWorkerInstructions(root, options)).targets.find(item => target === undefined || item.target === target);
  if (!row) throw ErrorRegistry.createError('WORKER_INSTRUCTIONS_UNAVAILABLE', { params: { reason: 'target' } });
  if (row.state === 'off' || row.state === 'absent' || row.state === 'blocked') {
    throw ErrorRegistry.createError('WORKER_INSTRUCTIONS_UNAVAILABLE', { params: { reason: row.state === 'off' ? row.off ?? 'no-execution' : row.state === 'absent' ? 'absent' : row.reason ?? 'unreadable' } });
  }
  emit(scopeNotice(resolved, locale), sinks);
  if ((row.state === 'trusted') === (action === 'trust')) {
    emit(action === 'trust' ? t('cli.coding.instructions.done.already', {}, locale) : t('cli.coding.instructions.done.notTrusted', {}, locale), sinks);
    return;
  }
  const trust = action === 'trust';
  const answer = await askAdminCard(context, locale, { title: trust ? t('cli.coding.instructions.card.trustTitle', {}, locale) : t('cli.coding.instructions.card.revokeTitle', {}, locale),
    body: [where(row, locale), fileLine(row, locale), trust ? t('cli.coding.instructions.card.trustBody', {}, locale) : t('cli.coding.instructions.card.revokeBody', {}, locale),
      ...(trust ? ['', ...row.preview.map(line => `  ${terminalSafeText(line)}`)] : [])], options: confirmOptions(locale) });
  if (answer !== 'apply') return cancelled();
  const result = await changeWorkerInstructionTrust!(root, { scopeId: resolved.scopeId, action: action as 'trust' | 'revoke', digest: row.digest!, ...(row.target === null ? {} : { target: row.target }) }, options);
  emit(result.trusted ? t('cli.coding.instructions.done.trusted', { digest: result.digest }, locale) : t('cli.coding.instructions.done.revoked', { digest: result.digest }, locale), sinks);
}
