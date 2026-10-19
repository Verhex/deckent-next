import { t, terminalSafeText, type Locale } from '#platform/index.js';
import { acceptanceEvidenceText } from '#surfaces/core/cli-human/index.js';
import { poolDriftLine, poolWaitLine } from '#surfaces/core/cli-admin/index.js';
import type { RunView } from '#engine/index.js';
import { notAcceptedLabel, quotaWaitText, renderAcceptanceLine, renderBriefLines, renderCostSummary, renderGraphSummaryLines, renderWorkerModelLine } from '#surfaces/core/monitor/index.js';
import { runTitle, shownId } from './run-human.js';
import type { RunCommandContext } from './context.js';
import REGISTRY from './run.json' with { type: 'json' };

type TaskView = RunView['tasks'][number];
type InspectData = Pick<Awaited<ReturnType<NonNullable<RunCommandContext['inspectRun']>>>, 'run' | 'models'>;

export function phaseText(phase: TaskView['phase'], locale: Locale): string {
  const phases: Readonly<Record<TaskView['phase'], () => string>> = {
    skipped: () => t('cli.run.inspect.states.skipped', {}, locale), 'awaiting-decision': () => t('cli.run.inspect.states.awaitingDecision', {}, locale),
    pending: () => t('cli.run.inspect.states.pending', {}, locale), active: () => t('cli.run.inspect.states.active', {}, locale),
    evaluating: () => t('cli.run.inspect.states.evaluating', {}, locale), accepted: () => t('cli.run.inspect.states.accepted', {}, locale),
    failed: () => t('cli.run.inspect.states.failed', {}, locale), cancelled: () => t('cli.run.inspect.states.cancelled', {}, locale),
    reconciling: () => t('cli.run.inspect.states.reconciling', {}, locale) };
  return phases[phase]();
}

/** What an accepted task's acceptance rests on (law 1), one line per distinct evaluator of its criteria; a person's accept says so instead. */
export function acceptanceEvidenceLines(run: RunView, task: TaskView, locale: Locale): string[] {
  if (task.phase !== 'accepted') return [];
  if (task.acceptedEvidence === 'model-unverified') return [t('cli.task.decision.acceptedUnverified', {}, locale)];
  const evaluators = [...new Map(run.criteria.filter(criterion => task.acceptanceCriteria.includes(criterion.id))
    .map(criterion => [`${criterion.evaluator.id}@${criterion.evaluator.version}`, criterion.evaluator])).values()];
  return evaluators.map(evaluator => `  ${acceptanceEvidenceText(evaluator, locale)}`);
}

type Exclusions = NonNullable<TaskView['configExclusions']>;
/** Secret-gate exceptions (CLI review: "64 yol istisnayla geçti, 1'i red listesinden: .npmrc"): a short list whole; a long one in one line, every path under --verbose. */
function exclusionLines(exclusions: Exclusions, locale: Locale, verbose: boolean): string[] {
  if (verbose || exclusions.count <= REGISTRY.inspect.exclusionsListedUpTo) return [t('cli.run.inspect.configExcluded', { count: exclusions.count }, locale),
    ...exclusions.entries.map(entry => t('cli.run.inspect.configExcludedEntry', { path: entry.path, rule: entry.rule, by: entry.by }, locale))];
  const denied = exclusions.entries.filter(entry => entry.by.startsWith(REGISTRY.inspect.denyEntryPrefix)).map(entry => entry.path), shown = REGISTRY.inspect.denyPathsShown;
  const paths = denied.slice(0, shown).join(', ') + (denied.length > shown ? ', …' : '');
  return [denied.length ? t('cli.run.inspect.exclusionsDenied', { count: exclusions.count, denied: denied.length, paths }, locale)
    : t('cli.run.inspect.exclusions', { count: exclusions.count }, locale)];
}

function taskLines(run: RunView, task: TaskView, models: InspectData['models'], locale: Locale, verbose: boolean): string[] {
  const brief = renderBriefLines(task.taskBrief, task.resultBrief, locale);
  // With a result, the brief's last line is its delivery line: it closes the task block (request → result → acceptance evidence → delivery).
  const delivery = task.resultBrief ? brief.splice(-1) : [];
  return [t('cli.run.inspect.task', { task: task.id, kind: task.kind }, locale), ...brief,
    t('cli.run.inspect.stateLabel', { phase: task.acceptedEvidence === 'model-unverified' ? t('cli.task.decision.acceptedUnverified', {}, locale) : phaseText(task.phase, locale) }, locale),
    ...(task.notAcceptedReason ? [notAcceptedLabel(task.notAcceptedReason, locale)] : []),
    ...(task.skippedReason ? [t('cli.run.lifecycle.reason', { reason: task.skippedReason }, locale)] : []),
    ...(task.decision ? [t('cli.run.lifecycle.deadline', { since: task.decision.since, deadline: task.decision.deadline }, locale), t('cli.run.lifecycle.reason', { reason: task.decision.reason }, locale)] : []),
    ...(task.decision?.question ? [t('cli.run.lifecycle.question', { question: task.decision.question }, locale)] : []),
    ...(task.acceptedEvidence === 'model-unverified' ? [] : acceptanceEvidenceLines(run, task, locale)),
    ...delivery,
    ...(models ?? []).filter(model => model.taskId === task.id).map(model => t('cli.run.inspect.model', {
      attempt: model.attemptId ? (verbose ? model.attemptId : shownId(model.attemptId)) : '—', line: renderWorkerModelLine(model, locale) }, locale)),
    ...(task.handoffs ?? []).map(receipt => (receipt.kind === 'workspace-started-from-patch'
      ? t('cli.run.inspect.workspaceStartedFromPatch', { source: receipt.source.taskId, attempt: receipt.source.attemptId, digest: receipt.digest }, locale)
      : t('cli.run.inspect.handoffReceived', { source: receipt.source.taskId, attempt: receipt.source.attemptId, digest: receipt.digest }, locale))),
    ...(task.configExclusions ? exclusionLines(task.configExclusions, locale, verbose) : []),
    ...(task.unresolvedEffects ? [t('cli.run.inspect.unresolved', {}, locale)] : []),
    ...(verbose && task.acceptance ? [renderAcceptanceLine(task.acceptance, locale)] : []),
    ...(verbose ? [t('cli.run.inspect.profile', { profile: task.profile.id, version: task.profile.version, criteria: task.acceptanceCriteria.join(', ') }, locale)] : []),
  ];
}

/**
 * The `run inspect` human view (CLI review §run): request → result (Run state, waits) → tasks (each: request, result, state, what an acceptance
 * rests on, delivery) — the order a person reads. Internal records (authority record, cost summary, acceptance metadata, profile and criteria
 * lines, full attempt ids, every secret-gate path) are `--verbose`. Worker-written text (question, model names, notes, paths) reaches the
 * terminal only through `terminalSafeText` (SEC-5S F35).
 */
export function renderRunInspect(data: InspectData, locale: Locale, verbose: boolean, notice: readonly string[] = []): string {
  const run = data.run;
  if (!run) return '';
  const runShown = verbose ? run.runId : shownId(run.runId);
  return terminalSafeText([...notice,
    t('cli.run.inspect.heading', { run: runShown, revision: run.revision }, locale),
    t('cli.run.inspect.request', { title: runTitle(run, locale) }, locale),
    ...(run.proposal ? [t('proposal.budget.notice', {}, locale)] : []),
    t('cli.run.lifecycle.result', { run: runShown, revision: run.revision, state: run.state.kind, reason: 'reason' in run.state ? run.state.reason : '—' }, locale),
    ...(run.channelWaits ?? []).map(wait => `${wait.taskId}: ${quotaWaitText(wait.deadline, wait.resetsAtMs !== null, locale)}`),
    ...(run.state.kind === 'terminal' ? [t('cli.run.lifecycle.outcome', { outcome: run.state.outcome }, locale)] : []),
    ...(run.state.kind === 'parked' && run.state.reason === 'quota-exhausted' ? [quotaWaitText(run.state.deadline, (run.quotaWaits ?? []).every(wait => wait.resetsAtMs !== null), locale, (run.quotaWaits ?? []).some(wait => wait.retryLimitReached))] : []),
    ...(run.state.kind === 'parked' ? [t('cli.run.lifecycle.deadline', { since: run.state.since, deadline: run.state.deadline }, locale)] : []),
    ...(run.state.kind === 'parked' && run.state.failureCode ? [t('cli.run.lifecycle.failure', { code: run.state.failureCode }, locale)] : []),
    // Crash-loop breaker: the typed park reason in words (the per-attempt count and phase are in the audit event and the service journal).
    ...(run.state.kind === 'parked' && run.state.failureCode === 'DISPATCH_PREPARATION_ABORTED' ? [t('error.DISPATCH_PREPARATION_ABORTED.summary', {}, locale)] : []),
    ...(run.state.kind === 'parked' && run.state.note ? [t('cli.run.lifecycle.note', { note: run.state.note }, locale)] : []),
    ...(run.pool ? [...run.pool.drift.map(drift => poolDriftLine(drift, locale)), ...run.pool.waiting.map(wait => poolWaitLine(wait.taskId, wait.reason, locale))] : []),
    run.cancellationRequested ? t('cli.run.inspect.cancelRequested', {}, locale) : t('cli.run.inspect.cancelAbsent', {}, locale),
    ...(run.graphSummary ? renderGraphSummaryLines(run.graphSummary, locale).map(line => `  ${line}`) : []),
    ...run.tasks.flatMap(task => taskLines(run, task, data.models, locale, verbose)),
    ...(verbose ? [
      ...(run.authority ? [t('cli.run.inspect.authority', { record: run.authority.decision.eventId, sequence: run.authority.decision.sequence, approval: run.authority.approval?.approvalId ?? '-' }, locale)] : []),
      ...(run.costReport ? [renderCostSummary(run.costReport, locale)] : []),
      ...run.criteria.map(criterion => t('cli.run.inspect.criterion', { criterion: criterion.id, description: criterion.description, evaluator: criterion.evaluator.id, version: criterion.evaluator.version }, locale)),
    ] : [t('cli.run.inspect.more', {}, locale)]),
  ].join('\n'));
}
