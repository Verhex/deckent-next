import { ErrorRegistry, emit, t, terminalSafeText, type Locale } from '#platform/index.js';
import { acceptanceEvidenceText, cliMode, cliTableStyle, formatBytes, formatDecimal, formatDuration, renderCliTable } from '#surfaces/core/cli-human/index.js';
import { commandLocale } from '#surfaces/core/cli-kit/index.js';
import type { WorkCostReport } from '#domain/index.js';
import type { RunView } from '#engine/index.js';
import { renderCostReport } from '#surfaces/core/monitor/index.js';
import type { RunCommandContext } from './context.js';
import { familyScope, pickRun, readScopeRuns, resolveRunId, runHumanIo, runRowLabel, scopeLine, shownId } from './run-human.js';
import REGISTRY from './run.json' with { type: 'json' };

type Attempt = WorkCostReport['attempts'][number];
const USD_NANOS = 1_000_000_000;

/** One "not measurable" line per axis: the reason in words and on how many attempts; the axes this version does not record are in `run.json` (`report.notCollected`). */
function notMeasurable(report: WorkCostReport, locale: Locale): string[] {
  const count = (test: (row: Attempt) => boolean) => report.attempts.filter(test).length;
  const line = (axis: string, reason: string, n: number) => t('cli.run.report.unmeasured', { axis, reason, count: n }, locale);
  const lines: string[] = [];
  const api = t('cli.run.report.axis.api', {}, locale);
  const subscriptionCost = count(row => row.axes.apiMoney === null && row.axes.subscription !== null), noMetric = count(row => row.axes.apiMoney === null && row.axes.subscription === null);
  if (subscriptionCost) lines.push(line(api, t('cli.run.report.reason.subscription', {}, locale), subscriptionCost));
  if (noMetric) lines.push(line(api, t('cli.run.report.reason.noMetric', {}, locale), noMetric));
  const wall = count(row => row.axes.wallMs === null), resources = count(row => row.axes.cpuSeconds === null || row.axes.sampledPeakBytes === null), model = count(row => row.model === null);
  if (wall) lines.push(line(t('cli.run.report.axis.wall', {}, locale), t('cli.run.report.reason.noContainerTimes', {}, locale), wall));
  if (resources) lines.push(line(t('cli.run.report.axis.resources', {}, locale), t('cli.run.report.reason.noSample', {}, locale), resources));
  if (model) lines.push(line(t('cli.run.report.axis.model', {}, locale), t('cli.run.report.reason.noModelPin', {}, locale), model));
  const collected: Readonly<Record<string, Readonly<{ has: (row: Attempt) => boolean; word: () => string }>>> = {
    subscriptionCalls: { has: row => row.axes.subscription === null || row.axes.subscription.calls !== null, word: () => t('cli.run.report.axis.subscriptionCalls', {}, locale) },
    localModel: { has: row => row.axes.localModel?.calls != null, word: () => t('cli.run.report.axis.localModel', {}, locale) },
    humanInterventions: { has: row => row.axes.humanInterventions !== null, word: () => t('cli.run.report.axis.human', {}, locale) },
    rework: { has: row => row.quality.reworkCount !== null, word: () => t('cli.run.report.axis.rework', {}, locale) },
    rollback: { has: row => row.quality.rollbackCount !== null, word: () => t('cli.run.report.axis.rollback', {}, locale) } };
  for (const axis of REGISTRY.report.notCollected) {
    const entry = collected[axis], missing = entry ? count(row => !entry.has(row)) : 0;
    if (entry && missing) lines.push(line(entry.word(), t('cli.run.report.reason.notCollected', {}, locale), missing));
  }
  if (report.withheld) lines.push(t('cli.run.report.withheld', { count: report.withheld }, locale));
  return lines;
}

/** Read-only channel totals of this Run's visible attempts; missing measurements remain explicit, without billing periods or budget changes. */
function channelUsage(report: WorkCostReport, context: RunCommandContext, locale: Locale): string[] {
  if (!report.attempts.length) return [];
  const groups = new Map<string | null, Attempt[]>();
  for (const attempt of report.attempts) {
    const channel = attempt.model?.channelId ?? null;
    const rows = groups.get(channel) ?? []; rows.push(attempt); groups.set(channel, rows);
  }
  const unknown = t('resource.unknown', {}, locale);
  const columns = t('cli.run.report.channelColumns', {}, locale).split('|').map(header => ({ header }));
  const rows = [...groups].map(([channel, attempts]) => {
    const api = attempts.flatMap(row => row.axes.apiMoney ? [BigInt(row.axes.apiMoney.amountUsdNanos)] : []);
    const calls = attempts.flatMap(row => row.axes.subscription?.calls == null ? [] : [row.axes.subscription.calls]);
    return [channel ?? unknown, String(attempts.length), api.length ? formatDecimal(Number(api.reduce((sum, value) => sum + value, 0n)) / USD_NANOS, locale, 4) : unknown,
      String(attempts.length - api.length), calls.length ? String(calls.reduce((sum, value) => sum + value, 0)) : unknown];
  });
  return [t('cli.run.report.channelHeading', {}, locale), renderCliTable(columns, rows, cliTableStyle(context)), t('cli.run.report.channelEvidence', {}, locale)];
}

/**
 * The report a person reads (CLI review §report): Known — result, what acceptance rests on, per attempt duration, CPU, peak memory, model —
 * then Not measurable, each axis with its reason (e.g. "a subscription call has no measurable charge"). Readable units (0,49 s, 557 MB, 20,9 s);
 * full ids, profile versions and every raw axis (`renderCostReport`) are `--verbose`. Worker-written values reach the terminal only safe.
 */
export function renderHumanReport(report: WorkCostReport, run: RunView, context: RunCommandContext, locale: Locale, verbose: boolean): string {
  const unknown = '—', s = report.summary;
  const outcomes = { accepted: t('resource.cost.outcome.accepted', {}, locale), failed: t('resource.cost.outcome.failed', {}, locale),
    'awaiting-decision': t('resource.cost.outcome.awaiting', {}, locale), incomplete: t('resource.cost.outcome.incomplete', {}, locale) };
  const evaluators = [...new Map(run.criteria.map(criterion => [`${criterion.evaluator.id}@${criterion.evaluator.version}`, criterion.evaluator])).values()];
  const table = report.attempts.length ? renderCliTable([{ header: t('cli.run.report.col.task', {}, locale) }, { header: t('cli.run.report.col.outcome', {}, locale) },
    { header: t('cli.run.report.col.wall', {}, locale), align: 'right', shrink: false }, { header: t('cli.run.report.col.cpu', {}, locale), align: 'right', shrink: false },
    { header: t('cli.run.report.col.peak', {}, locale), align: 'right', shrink: false }, { header: t('cli.run.report.col.model', {}, locale) }],
  report.attempts.map(row => [row.identity.taskId, outcomes[row.acceptance.outcome], row.axes.wallMs === null ? unknown : formatDuration(row.axes.wallMs, locale),
    row.axes.cpuSeconds === null ? unknown : formatDuration(row.axes.cpuSeconds * 1000, locale), row.axes.sampledPeakBytes === null ? unknown : formatBytes(row.axes.sampledPeakBytes, locale),
    row.model ? `${row.model.modelId}${row.effort ? ` · ${row.effort}` : ''}` : unknown]), cliTableStyle(context)) : t('cli.run.report.noAttempts', {}, locale);
  const unmeasured = notMeasurable(report, locale);
  return terminalSafeText([
    t('cli.run.report.heading', { run: verbose ? report.runId : shownId(report.runId), revision: report.runRevision }, locale),
    t('cli.run.report.known', {}, locale),
    t('cli.run.report.result', { accepted: s.acceptedTasks, failed: s.failedTasks, unknown: s.unknownTasks }, locale),
    ...(s.acceptedTasks ? evaluators.map(evaluator => `  ${acceptanceEvidenceText(evaluator, locale)}`) : []),
    ...(s.measuredCpuSeconds === null ? [] : [t('cli.run.report.cpuTotal', { cpu: formatDuration(s.measuredCpuSeconds * 1000, locale) }, locale)]),
    ...(s.sampledPeakBytes === null ? [] : [t('cli.run.report.peakTotal', { peak: formatBytes(s.sampledPeakBytes, locale) }, locale)]),
    ...(s.measuredApiUsdNanos === null ? [] : [t('cli.run.report.apiTotal', { api: formatDecimal(Number(s.measuredApiUsdNanos) / USD_NANOS, locale, 4) }, locale)]),
    table, ...channelUsage(report, context, locale),
    t('cli.run.report.unmeasuredHeading', {}, locale),
    ...(unmeasured.length ? unmeasured : [t('cli.run.report.allMeasured', {}, locale)]),
    report.recommendations?.length ? t('cli.run.report.comparison', { count: report.recommendations.length }, locale) : t('resource.recommendation.empty', {}, locale),
    ...(verbose ? ['', renderCostReport(report, locale)] : [t('cli.run.report.more', {}, locale)]),
  ].join('\n'));
}

/**
 * `deckent report` (CLI review §report): observation through the existing Run inspect (no report authority or state writer of its own).
 * With `--run` (a short id resolves): the report. Without: the scope's recent Runs (read scope rule) — a person on a terminal picks one, a pipe
 * gets one line per Run and the command to read one, `--json` the Run list as read.
 */
export async function reportCommand(argv: readonly string[], context: RunCommandContext) {
  const values = new Map<string, string>(); let json = false, verbose = false;
  for (let i = 1; i < argv.length; i++) {
    const key = argv[i]!;
    if (key === '--json' && !json) { json = true; continue; }
    if (key === '--verbose' && !verbose) { verbose = true; continue; }
    if (key === '--no-color') continue;
    if (!['--scope', '--run', '--lang'].includes(key) || values.has(key)) throw ErrorRegistry.createError('CLI_USAGE');
    const value = argv[++i]; if (!value || value.startsWith('--')) throw ErrorRegistry.createError('CLI_USAGE'); values.set(key, value);
  }
  const locale = commandLocale(context, values.get('--lang'));
  if (verbose && json) throw ErrorRegistry.createError('CLI_USAGE');
  const interactive = cliMode(context, json).mode === 'interactive';
  const io = interactive && (!values.get('--scope') || !values.get('--run')) ? await runHumanIo(context, locale) : undefined;
  const scope = await familyScope(context, { command: 'deckent report', locale, explicit: values.get('--scope'), mutating: false, interactive, ...(io ? { ask: io.ask } : {}) });
  if (!scope) return;
  if (!context.inspectRun) throw ErrorRegistry.createError('INVENTORY_UNAVAILABLE');
  let runId = values.get('--run') ? await resolveRunId(context, scope.scopeId, values.get('--run')!) : undefined;
  if (!runId) {
    const runs = await readScopeRuns(context, scope.scopeId);
    if (!io) {
      const shown = runs.slice(0, REGISTRY.report.recentShown), ids = shown.map(run => run.runId);
      emit({ schemaVersion: 1 as const, scopeId: scope.scopeId, runs: shown }, { json, ...(context.stdout ? { stdout: context.stdout } : {}), render: data => terminalSafeText([
        ...scopeLine(scope, locale), ...(data.runs.length ? [...data.runs.map(run => runRowLabel(run, ids, locale)), t('cli.run.report.hint', {}, locale)]
          : [t('cli.run.list.empty', { scope: data.scopeId }, locale)])].join('\n')) });
      return;
    }
    const offered = runs.slice(0, REGISTRY.list.runsShown), picked = await pickRun(io, scope.scopeId, offered, t('cli.run.report.pick', { scope: scope.scopeId }, locale));
    if (!picked) return;
    runId = picked.runId;
    // PRE-5: a pick is not scriptable; the person gets the command that prints the same report without a picker.
    io.print(t('cli.run.report.again', { command: ['deckent report --scope', scope.scopeId, '--run', shownId(runId, runs.map(run => run.runId)), ...(verbose ? ['--verbose'] : [])].join(' ') }, locale));
  }
  const result = await context.inspectRun!(context.root ?? process.cwd(), { schemaVersion: 1, scopeId: scope.scopeId, runId }, { env: context.env ?? process.env });
  if (!result.run) throw ErrorRegistry.createError('RUN_NOT_FOUND', { params: { run: runId } });
  const run = result.run, costReport = run.costReport;
  if (!costReport) throw ErrorRegistry.createError('INVENTORY_UNAVAILABLE');
  emit(costReport, { json, ...(context.stdout ? { stdout: context.stdout } : {}), render: report => [...scopeLine(scope, locale), renderHumanReport(report, run, context, locale, verbose)].join('\n') });
}
