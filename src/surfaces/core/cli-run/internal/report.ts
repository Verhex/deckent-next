import { ErrorRegistry, emit, resolveLocale } from '#platform/index.js';
import { renderCostReport } from '#surfaces/core/monitor/index.js';
import type { RunCommandContext } from './context.js';
/** Observation through existing Run inspect; no independent report authorization or state writer. */
export async function reportCommand(argv: readonly string[], context: RunCommandContext) {
  const values = new Map<string, string>(); let json = false;
  for (let i = 1; i < argv.length; i++) {
    const key = argv[i]!;
    if (key === '--json' && !json) { json = true; continue; }
    if (key === '--no-color') continue;
    if (!['--scope', '--run', '--lang'].includes(key) || values.has(key)) throw ErrorRegistry.createError('CLI_USAGE');
    const value = argv[++i]; if (!value || value.startsWith('--')) throw ErrorRegistry.createError('CLI_USAGE'); values.set(key, value);
  }
  const scopeId = values.get('--scope'), runId = values.get('--run');
  if (!scopeId || !runId || !context.inspectRun) throw ErrorRegistry.createError('CLI_USAGE');
  const locale = resolveLocale(values.get('--lang'), context.env); context.onLocale?.(locale);
  const result = await context.inspectRun(context.root ?? process.cwd(), { schemaVersion: 1, scopeId, runId }, { env: context.env ?? process.env });
  if (!result.run) throw ErrorRegistry.createError('RUN_NOT_FOUND', { params: { run: runId } });
  if (!result.run.costReport) throw ErrorRegistry.createError('INVENTORY_UNAVAILABLE');
  emit(result.run.costReport, { json, ...(context.stdout ? { stdout: context.stdout } : {}), render: report => renderCostReport(report, locale) });
}
