import { ErrorRegistry, emit, loadConfig, t, terminalSafeText, type Locale } from '#platform/index.js';
import { cliMode, cliTableStyle, renderCliTable } from '#surfaces/core/cli-human/index.js';
import { commandLocale } from '#surfaces/core/cli-kit/index.js';
import type { RunCommandContext } from './context.js';
import { familyScope, runHumanIo, scopeLine, shownId } from './run-human.js';

type InventoryPage = Awaited<ReturnType<NonNullable<RunCommandContext['inspectInventory']>>>;
type Entry = InventoryPage['page']['entries'][number];

function stateText(entry: Entry, locale: Locale): string {
  return entry.launch === 'prevented-before-launch' ? t('cli.run.cancel.prevented', {}, locale) : entry.launch === 'pending' ? t('inventory.launchPending', {}, locale)
    : entry.terminal === null ? t('inventory.unresolved', {}, locale) : t('inventory.exited', { exit: entry.terminal.exitCode ?? entry.terminal.signal ?? '?' }, locale);
}

/** The page as a person reads it: short Run and attempt ids among the page's own (`--verbose`: full), owner, launch/exit state, cancellation, output. */
export function renderInventory(data: InventoryPage, context: RunCommandContext, locale: Locale, verbose: boolean, notice: readonly string[]): string {
  const entries = data.page.entries, runs = entries.map(entry => entry.identity.runId), attempts = entries.map(entry => entry.identity.attemptId);
  const id = (value: string, among: readonly string[]) => verbose ? value : shownId(value, among);
  return terminalSafeText([...notice, t('inventory.heading', { count: entries.length }, locale),
    ...(entries.length ? [renderCliTable([{ header: t('cli.run.inventory.col.run', {}, locale), shrink: false }, { header: t('cli.run.inventory.col.task', {}, locale) },
      { header: t('cli.run.inventory.col.attempt', {}, locale), shrink: false }, { header: t('cli.run.inventory.col.owner', {}, locale) },
      { header: t('cli.run.inventory.col.state', {}, locale) }, { header: t('cli.run.inventory.col.cancel', {}, locale) }, { header: t('cli.run.inventory.col.output', {}, locale) }],
    entries.map(entry => [id(entry.identity.runId, runs), entry.identity.taskId, id(entry.identity.attemptId, attempts), entry.owner, stateText(entry, locale),
      entry.cancellationRequested ? t('inventory.requested', {}, locale) : t('inventory.absent', {}, locale),
      entry.outputRecorded ? t('inventory.recorded', {}, locale) : t('inventory.absent', {}, locale)]), cliTableStyle(context))] : []),
    ...(data.page.nextAfter === null ? [] : [t('inventory.next', { after: data.page.nextAfter }, locale)]),
    t('cli.run.inventory.see', {}, locale),
  ].join('\n'));
}

/**
 * `deckent inventory` (CLI review §inventory; developer view of the stored execution records). Read scope rule: typed `--scope`, else the
 * configured default (named in the output), else a person on a terminal picks; anyone else gets CLI_SCOPE_REQUIRED with the valid scopes.
 * A page above `inspection.maxPageSize` is refused before the read with the same typed code (DISPATCH_INVENTORY_LIMIT) and the allowed maximum.
 *
 * Why it can show fewer records than `deckent workers list` for the same scope: inventory reads only this installation's dispatch journal
 * (`inspectConfiguredInventory`, current project's ledger); `workers list` reads that same journal plus every `inspection.workers.sources`
 * entry for the scope (other installations, legacy task folders), up to one page in total. The CLI review (2026-10-19) saw 8 here and 64 there
 * for scope `live`; that installation's config lists a second next-project source for `live`. Not a defect; the help says so.
 */
export async function inventoryCommand(argv: readonly string[], context: RunCommandContext): Promise<void> {
  const values = new Map<string, string>(); let json = false, verbose = false;
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--json') { if (json) throw ErrorRegistry.createError('CLI_USAGE'); json = true; continue; }
    if (arg === '--verbose') { if (verbose) throw ErrorRegistry.createError('CLI_USAGE'); verbose = true; continue; }
    if (arg === '--no-color') continue;
    if (!['--scope', '--after', '--limit', '--lang'].includes(arg) || values.has(arg)) throw ErrorRegistry.createError('CLI_USAGE');
    const value = argv[++i]; if (!value || value.startsWith('--')) throw ErrorRegistry.createError('CLI_USAGE'); values.set(arg, value);
  }
  const rawLimit = values.get('--limit');
  if ((rawLimit !== undefined && (!/^[1-9][0-9]*$/.test(rawLimit) || !Number.isSafeInteger(Number(rawLimit)))) || (verbose && json)) throw ErrorRegistry.createError('CLI_USAGE');
  const locale = commandLocale(context, values.get('--lang'));
  const root = context.root ?? process.cwd(), options = { env: context.env ?? process.env };
  const max = (await loadConfig(root, options)).inspection.maxPageSize;
  const limitError = () => ErrorRegistry.createError('DISPATCH_INVENTORY_LIMIT', { suggestion: t('cli.run.inventory.limitHint', { max }, locale) });
  if (rawLimit !== undefined && Number(rawLimit) > max) throw limitError();
  const interactive = cliMode(context, json).mode === 'interactive';
  const io = interactive && !values.get('--scope') ? await runHumanIo(context, locale) : undefined;
  const scope = await familyScope(context, { command: 'deckent inventory', locale, explicit: values.get('--scope'), mutating: false, interactive, ...(io ? { ask: io.ask } : {}) });
  if (!scope) return;
  if (!context.inspectInventory) throw ErrorRegistry.createError('INVENTORY_UNAVAILABLE');
  let result: InventoryPage;
  try {
    result = await context.inspectInventory(root, { schemaVersion: 1, scopeId: scope.scopeId, after: values.get('--after') ?? null, ...(rawLimit === undefined ? {} : { limit: Number(rawLimit) }) }, options);
  } catch (error) {
    // The runtime refused the page against its own configured bound: the same code, with the bound a person can use.
    if ((error as { code?: unknown } | null)?.code === 'DISPATCH_INVENTORY_LIMIT') throw limitError();
    throw error;
  }
  emit(result, { json, ...(context.stdout ? { stdout: context.stdout } : {}), render: data => renderInventory(data, context, locale, verbose, scopeLine(scope, locale)) });
}
