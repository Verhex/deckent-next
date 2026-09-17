import { ErrorRegistry, emit, resolveLocale, t, type ConfigLoadOptions, type ProductLayout } from '#platform/index.js';
import type { DispatchInventoryInput, DispatchInventoryPage } from '#engine/index.js';
import type { CommandContext } from './kernel-commands.js';
export type InventoryQueryHandler = (root: string, query: DispatchInventoryInput, options: ConfigLoadOptions) => Promise<Readonly<{ schemaVersion: 1; layout: ProductLayout; page: DispatchInventoryPage }>>;
export async function runInventoryCommand(argv: readonly string[], context: CommandContext): Promise<void> {
  const values = new Map<string, string>(); let json = false;
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--json') { if (json) throw ErrorRegistry.createError('CLI_USAGE'); json = true; continue; }
    if (arg === '--no-color') continue;
    if (!['--scope', '--after', '--limit', '--lang'].includes(arg) || values.has(arg)) throw ErrorRegistry.createError('CLI_USAGE');
    const value = argv[++i]; if (!value || value.startsWith('--')) throw ErrorRegistry.createError('CLI_USAGE'); values.set(arg, value);
  }
  const scopeId = values.get('--scope'); const rawLimit = values.get('--limit');
  if (!scopeId || (rawLimit !== undefined && (!/^[1-9][0-9]*$/.test(rawLimit) || !Number.isSafeInteger(Number(rawLimit))))) throw ErrorRegistry.createError('CLI_USAGE');
  const locale = resolveLocale(values.get('--lang'), context.env); context.onLocale?.(locale);
  if (!context.inspectInventory) throw ErrorRegistry.createError('INVENTORY_UNAVAILABLE');
  const result = await context.inspectInventory(context.root ?? process.cwd(), { schemaVersion: 1, scopeId,
    after: values.get('--after') ?? null, ...(rawLimit === undefined ? {} : { limit: Number(rawLimit) }) }, { env: context.env ?? process.env });
  emit(result, { json, ...(context.stdout ? { stdout: context.stdout } : {}), render: data => [
    t('inventory.heading', { count: data.page.entries.length }, locale),
    ...data.page.entries.map(entry => t('inventory.row', { run: entry.identity.runId, task: entry.identity.taskId, attempt: entry.identity.attemptId,
      owner: entry.owner, state: entry.terminal === null ? t('inventory.unresolved', {}, locale) : t('inventory.exited', { exit: entry.terminal.exitCode ?? entry.terminal.signal ?? '?' }, locale),
      cancel: entry.cancellationRequested ? t('inventory.requested', {}, locale) : t('inventory.absent', {}, locale),
      output: entry.outputRecorded ? t('inventory.recorded', {}, locale) : t('inventory.absent', {}, locale) }, locale)),
    ...(data.page.nextAfter === null ? [] : [t('inventory.next', { after: data.page.nextAfter }, locale)]),
  ].join('\n') });
}
