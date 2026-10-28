import { emit, t, terminalSafeText, type Locale } from '#platform/index.js';
import { formatAgo } from '#surfaces/core/cli-human/index.js';
import { cliMode, cliTableStyle, renderCliTable } from '#surfaces/core/cli-human/index.js';
import type { RunView } from '#engine/index.js';
import type { RunCommandContext } from './context.js';
import { familyScope, readScopeRuns, runHumanIo, runStateWord, runTitle, scopeLine, shownId } from './run-human.js';
import REGISTRY from './run.json' with { type: 'json' };

/** A table of Runs as a person reads it: short id (git-like), state in the `/runs` words, accepted tasks, title. Cells are made safe by the table. */
export function renderRunTable(runs: readonly RunView[], context: RunCommandContext, locale: Locale): string {
  const ids = runs.map(run => run.runId);
  return renderCliTable([{ header: t('cli.run.list.col.id', {}, locale), shrink: false }, { header: t('cli.run.list.col.state', {}, locale) },
    { header: t('cli.run.list.col.tasks', {}, locale), align: 'right', shrink: false }, { header: t('cli.run.list.col.title', {}, locale) }],
  runs.map(run => [shownId(run.runId, ids), runStateWord(run, locale), `${run.tasks.filter(task => task.phase === 'accepted').length}/${run.tasks.length}`, runTitle(run, locale)]),
  cliTableStyle(context));
}

/**
 * `deckent run list` (CLI review §run, the CLI counterpart of the terminal's `/runs`): the scope's Runs from the same query, waiting Runs first,
 * then newest. Read scope rule (typed, else the configured default, else a person picks on a terminal). `--json` carries the Run views as read.
 */
export async function runList(values: ReadonlyMap<string, string>, json: boolean, context: RunCommandContext, locale: Locale): Promise<void> {
  const interactive = cliMode(context, json).mode === 'interactive';
  const io = interactive && !values.get('--scope') ? await runHumanIo(context, locale) : undefined;
  const scope = await familyScope(context, { command: 'deckent run list', locale, explicit: values.get('--scope'), mutating: false, interactive, ...(io ? { ask: io.ask } : {}) });
  if (!scope) return;
  const limit = Number(values.get('--limit') ?? REGISTRY.list.runsShown);
  const all = await readScopeRuns(context, scope.scopeId), runs = all.slice(0, limit);
  const refused = await refusedRequests(context, scope.scopeId);
  emit({ schemaVersion: 1 as const, scopeId: scope.scopeId, runs, refused }, { json, ...(context.stdout ? { stdout: context.stdout } : {}), render: data => terminalSafeText([
    ...scopeLine(scope, locale),
    ...(data.runs.length ? [renderRunTable(data.runs, context, locale), t('cli.run.list.footer', { shown: data.runs.length, total: all.length }, locale)]
      : [t('cli.run.list.empty', { scope: data.scopeId }, locale)]),
    ...refusedLines(data.refused, locale),
  ].join('\n')) });
}
/** BeUser D-08: requests the planner refused before any Run existed (none when no record or no reader). */
export const refusedRequests = (context: RunCommandContext, scopeId: string) => context.listRefusedRequests?.(context.root ?? process.cwd(), scopeId, REGISTRY.list.refusedShown,
  { env: context.env ?? process.env }).catch(() => []) ?? Promise.resolve([]);
export function refusedLines(rows: readonly Readonly<{ atMs: number; code: string; title: string }>[], locale: Locale): string[] {
  return rows.length ? ['', t('cli.run.refused.title', { count: rows.length }, locale), ...rows.map(row => t('cli.run.refused.row', { ago: formatAgo(row.atMs, Date.now(), locale),
    code: row.code, title: row.title }, locale))] : [];
}
