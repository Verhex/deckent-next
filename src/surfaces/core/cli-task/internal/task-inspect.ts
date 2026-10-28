import { briefQualifiesAcceptance, renderAcceptanceLine, renderBriefLines } from '#surfaces/core/monitor/index.js';
import { acceptanceEvidenceText } from '#surfaces/core/cli-human/index.js';
import { emit, ErrorRegistry, t, terminalSafeText, type Locale } from '#platform/index.js';
import { runQuerySchema, type RunView } from '#engine/index.js';
import type { TaskCommandContext } from './context.js';
import REGISTRY from './task.json' with { type: 'json' };

/** The task state in the reader's words (the same words as `run inspect`). */
export function phaseWord(phase: RunView['tasks'][number]['phase'], locale: Locale): string {
  const words: Readonly<Record<RunView['tasks'][number]['phase'], () => string>> = { pending: () => t('cli.run.inspect.states.pending', {}, locale),
    active: () => t('cli.run.inspect.states.active', {}, locale), evaluating: () => t('cli.run.inspect.states.evaluating', {}, locale),
    accepted: () => t('cli.run.inspect.states.accepted', {}, locale), failed: () => t('cli.run.inspect.states.failed', {}, locale),
    cancelled: () => t('cli.run.inspect.states.cancelled', {}, locale), reconciling: () => t('cli.run.inspect.states.reconciling', {}, locale),
    skipped: () => t('cli.run.inspect.states.skipped', {}, locale), 'awaiting-decision': () => t('cli.run.inspect.states.awaitingDecision', {}, locale) };
  return words[phase]();
}

type Exclusions = NonNullable<RunView['tasks'][number]['configExclusions']>;
const exclusionLines = (exclusions: Exclusions, locale: Locale) => [t('cli.run.inspect.configExcluded', { count: exclusions.count }, locale),
  ...exclusions.entries.map(entry => t('cli.run.inspect.configExcludedEntry', { path: entry.path, rule: entry.rule, by: entry.by }, locale))];
/**
 * The secret-gate exceptions (CLI review: "64 yol istisnayla geçti, 1'i red listesinden: .npmrc"): a short list is shown whole; a long one
 * is one line naming the deny-list exceptions, with every entry under --verbose.
 */
function exclusionView(exclusions: Exclusions, locale: Locale, verbose: boolean): readonly string[] {
  if (verbose || exclusions.count <= REGISTRY.inspect.exclusionsListedUpTo) return exclusionLines(exclusions, locale);
  const denied = exclusions.entries.filter(entry => entry.by.startsWith('acknowledgedDenyPaths:')).map(entry => entry.path);
  const paths = denied.slice(0, REGISTRY.inspect.denyPathsShown).join(', ') + (denied.length > REGISTRY.inspect.denyPathsShown ? ', …' : '');
  return [denied.length ? t('cli.task.inspect.exclusionsDenied', { count: exclusions.count, denied: denied.length, paths }, locale)
    : t('cli.task.inspect.exclusions', { count: exclusions.count }, locale)];
}

/**
 * Local read surface of the existing Run operation (no worker execution, no new protocol), in `run inspect` order: the task and its state,
 * the request, the result, what an acceptance rests on (law 1), then delivery. The acceptance metadata line and a long secret-gate list
 * appear only with --verbose.
 */
export async function inspectTask(target: Readonly<{ scopeId: string; runId: string; taskId: string }>, context: TaskCommandContext, json: boolean, locale: Locale, verbose: boolean) {
  const { scopeId, runId, taskId } = target;
  if (!context.inspectRun) throw ErrorRegistry.createError('INVENTORY_UNAVAILABLE');
  const result = await context.inspectRun(context.root ?? process.cwd(), runQuerySchema.parse({ schemaVersion: 1, scopeId, runId }), { env: context.env ?? process.env });
  if (!result.run) throw ErrorRegistry.createError('RUN_NOT_FOUND', { params: { run: runId } });
  const run = result.run, task = run.tasks.find(value => value.id === taskId);
  if (!task) throw ErrorRegistry.createError('ATTEMPT_NOT_FOUND', { params: { run: runId, task: taskId } });
  const evaluators = [...new Map(run.criteria.filter(criterion => task.acceptanceCriteria.includes(criterion.id))
    .map(criterion => [`${criterion.evaluator.id}@${criterion.evaluator.version}`, criterion.evaluator])).values()];
  emit({ schemaVersion: 1 as const, runId, task, models: (result.models ?? []).filter(value => value.taskId === taskId) }, {
    json, ...(context.stdout ? { stdout: context.stdout } : {}), render: data => {
      const brief = renderBriefLines(data.task.taskBrief, data.task.resultBrief, locale, { scope: scopeId, run: runId, task: taskId });
      // With a result, the brief's last line is its delivery line: the acceptance evidence goes just before it (request → result → acceptance → delivery).
      const delivery = data.task.resultBrief ? brief.splice(-1) : [];
      // SEC-5S sweep: config-exclusion paths come from the worker tree (any text up to 4096 chars); the human view reaches the terminal only safe.
      return terminalSafeText([
        t('cli.run.inspect.task', { task: data.task.id, kind: data.task.kind }, locale),
        t('cli.run.inspect.stateLabel', { phase: phaseWord(data.task.phase, locale) }, locale),
        ...(data.task.custodyDisposition ? [data.task.custodyDisposition === 'released' ? t('task.custody.released', {}, locale) : t('task.custody.hold-manual', {}, locale)] : []),
        ...brief,
        ...(data.task.phase !== 'accepted' ? [] : data.task.acceptedEvidence === 'model-unverified' ? [t('cli.task.decision.acceptedUnverified', {}, locale)]
          : data.task.resultBrief && briefQualifiesAcceptance(data.task.taskBrief, data.task.resultBrief.evaluation.verdict) ? [] : evaluators.map(evaluator => acceptanceEvidenceText(evaluator, locale))),
        ...delivery,
        ...(verbose && data.task.acceptance ? [renderAcceptanceLine(data.task.acceptance, locale)] : []),
        ...(data.task.handoffs ?? []).map(receipt => (receipt.kind === 'workspace-started-from-patch'
          ? t('cli.run.inspect.workspaceStartedFromPatch', { source: receipt.source.taskId, attempt: receipt.source.attemptId, digest: receipt.digest }, locale)
          : t('cli.run.inspect.handoffReceived', { source: receipt.source.taskId, attempt: receipt.source.attemptId, digest: receipt.digest }, locale))),
        ...(data.task.configExclusions ? exclusionView(data.task.configExclusions, locale, verbose) : []),
      ].join('\n'));
    } });
}
