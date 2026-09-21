import { resolve } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { ErrorRegistry, emit, loadConfig, resolveLocale, t, type ConfigLoadOptions } from '#platform/index.js';
import type { WorkerObservationQuery, WorkerObservationReport } from '#engine/index.js';
import type { CommandContext } from './kernel-commands.js';
export type WorkerObservationHandler = (root: string, query: WorkerObservationQuery, options: ConfigLoadOptions) => Promise<WorkerObservationReport>;
export async function workersCommand(argv: readonly string[], context: CommandContext) {
  const values = new Map<string, string>(); let json = false;
  const help = argv.length === 2 && ['--help', '-h'].includes(argv[1]!);
  if (!help && !['list', 'watch'].includes(argv[1] ?? '')) throw ErrorRegistry.createError('CLI_USAGE');
  for (let i = 2; i < argv.length; i++) {
    const flag = argv[i]!;
    if (flag === '--json' && !json) { json = true; continue; }
    if (flag === '--no-color') continue;
    if (!['--scope', '--source', '--after', '--limit', '--project', '--lang', '--samples'].includes(flag) || values.has(flag)) throw ErrorRegistry.createError('CLI_USAGE');
    const value = argv[++i]; if (!value || value.startsWith('--')) throw ErrorRegistry.createError('CLI_USAGE'); values.set(flag, value);
  }
  const locale = resolveLocale(values.get('--lang'), context.env); context.onLocale?.(locale);
  const sinks = { ...(context.stdout ? { stdout: context.stdout } : {}) };
  if (help) { emit(t('cli.workers.help', {}, locale), sinks); return; }
  const scopeId = values.get('--scope'); if (!scopeId || !context.inspectWorkers) throw ErrorRegistry.createError('CLI_USAGE');
  const number = (flag: string) => { const v = values.get(flag); if (v === undefined) return undefined;
    if (!/^[1-9][0-9]*$/.test(v) || !Number.isSafeInteger(Number(v))) throw ErrorRegistry.createError('CLI_USAGE'); return Number(v); };
  const limit = number('--limit'), samples = number('--samples');
  if (argv[1] !== 'watch' && samples !== undefined) throw ErrorRegistry.createError('CLI_USAGE');
  const root = resolve(context.root ?? process.cwd(), values.get('--project') ?? '.'); const options = { env: context.env ?? process.env };
  const config = await loadConfig(root, { ...options, heal: false }); let count = 0;
  const query = { schemaVersion: 1 as const, scopeId, ...(values.has('--source') ? { source: values.get('--source')! } : {}),
    after: values.get('--after') ?? null, ...(limit === undefined ? {} : { limit }) };
  do {
    if (context.signal?.aborted) return;
    const result = await context.inspectWorkers(root, query, options);
    emit(result, { ...sinks, json, render: report => [t('cli.workers.heading', { time: new Date(report.observedAt).toISOString() }, locale),
      ...report.sources.flatMap(source => [JSON.stringify({ source: source.id, path: source.path, status: source.status, truncated: source.truncated, nextAfter: source.nextAfter }),
        ...source.workers.map(worker => JSON.stringify(worker))]), t('cli.workers.notice', {}, locale)].join('\n') });
    if (argv[1] !== 'watch' || (samples !== undefined && ++count >= samples)) return;
    try { await wait(config.inspection.workers.heartbeatMs, undefined, { signal: context.signal }); } catch { if (context.signal?.aborted) return; throw ErrorRegistry.createError('WORKER_OBSERVATION_UNAVAILABLE'); }
  } while (!context.signal?.aborted);
}
