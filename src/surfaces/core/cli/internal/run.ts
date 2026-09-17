import { ErrorRegistry, emit, resolveLocale, t, type ConfigLoadOptions, type ProductLayout } from '#platform/index.js';
import type { RunQuery, RunView } from '#engine/index.js';
import type { CommandContext } from './kernel-commands.js';
export type RunQueryHandler = (root: string, query: RunQuery, options: ConfigLoadOptions) => Promise<Readonly<{ schemaVersion: 1; layout: ProductLayout; run: RunView | null }>>;
export async function runInspectionCommand(argv: readonly string[], context: CommandContext): Promise<void> {
  if (argv[1] !== 'inspect') throw ErrorRegistry.createError('CLI_USAGE');
  const values = new Map<string, string>(); let json = false;
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--json') { if (json) throw ErrorRegistry.createError('CLI_USAGE'); json = true; continue; }
    if (arg === '--no-color') continue;
    if (!['--scope', '--id', '--lang'].includes(arg) || values.has(arg)) throw ErrorRegistry.createError('CLI_USAGE');
    const value = argv[++i]; if (!value || value.startsWith('--')) throw ErrorRegistry.createError('CLI_USAGE'); values.set(arg, value);
  }
  const scopeId = values.get('--scope'); const runId = values.get('--id');
  if (!scopeId || !runId) throw ErrorRegistry.createError('CLI_USAGE');
  const locale = resolveLocale(values.get('--lang'), context.env); context.onLocale?.(locale);
  if (!context.inspectRun) throw ErrorRegistry.createError('INVENTORY_UNAVAILABLE');
  const result = await context.inspectRun(context.root ?? process.cwd(), { schemaVersion: 1, scopeId, runId }, { env: context.env ?? process.env });
  emit(result, { json, ...(context.stdout ? { stdout: context.stdout } : {}), render: data => {
    const phases = {
      pending: t('cli.run.phase.pending', {}, locale), active: t('cli.run.phase.active', {}, locale),
      evaluating: t('cli.run.phase.evaluating', {}, locale), accepted: t('cli.run.phase.accepted', {}, locale),
      failed: t('cli.run.phase.failed', {}, locale), cancelled: t('cli.run.phase.cancelled', {}, locale),
      reconciling: t('cli.run.phase.reconciling', {}, locale),
    };
    const run = data.run;
    if (!run) return t('cli.run.missing', { run: runId }, locale);
    return [t('cli.run.heading', { run: run.runId, revision: run.revision }, locale),
      run.cancellationRequested ? t('cli.run.cancelRequested', {}, locale) : t('cli.run.cancelAbsent', {}, locale),
      ...run.tasks.flatMap(task => [t('cli.run.task', { task: task.id, kind: task.kind }, locale),
        t('cli.run.phase', { phase: phases[task.phase] }, locale),
        ...(task.unresolvedEffects ? [t('cli.run.unresolved', {}, locale)] : [])]),
    ].join('\n');
  } });
}
