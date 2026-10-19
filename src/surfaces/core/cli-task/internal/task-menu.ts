import { randomUUID } from 'node:crypto';
import { ErrorRegistry, loadConfig, t, type ConfigLoadOptions, type Locale } from '#platform/index.js';
import { displayId, listRunIds, resolveCommandScope, scopeLister, scopeNotice } from '#surfaces/core/cli-human/index.js';
import { runLifecycleCommandSchema, runQuerySchema, type RunView } from '#engine/index.js';
import type { TerminalDeliveryPort } from '#surfaces/core/terminal-delivery/index.js';
import type { TaskCommandContext } from './context.js';
import { deliverTask, type TaskCardAsk } from './task-deliver.js';
import { phaseWord } from './task-inspect.js';
import REGISTRY from './task.json' with { type: 'json' };

export type TaskTarget = Readonly<{ scopeId: string; runId: string; taskId: string }>;
type TaskView = RunView['tasks'][number];
export type TaskMenuAction = 'inspect' | 'transcript' | 'diff' | 'accept' | 'reject' | 'deliver';
export type TaskMenuIo = Readonly<{ locale: Locale; ask: TaskCardAsk; print: (text: string) => void; root: string; options: ConfigLoadOptions;
  /** The family's own read handlers for one task (`task inspect|transcript|patch-preview`): the menu never renders a second view. */
  show: (action: 'inspect' | 'transcript' | 'patch-preview', target: TaskTarget) => Promise<void>;
  /** The terminal `/deliver` port over the same CLI handlers; absent: delivery is not offered. */
  deliveryPort?: TerminalDeliveryPort | undefined }>;

function actionLabel(action: TaskMenuAction | 'exit', locale: Locale): string {
  const labels: Readonly<Record<TaskMenuAction | 'exit', () => string>> = { inspect: () => t('cli.task.menu.action.inspect', {}, locale),
    transcript: () => t('cli.task.menu.action.transcript', {}, locale), diff: () => t('cli.task.menu.action.diff', {}, locale),
    accept: () => t('cli.task.menu.action.accept', {}, locale), reject: () => t('cli.task.menu.action.reject', {}, locale),
    deliver: () => t('cli.task.menu.action.deliver', {}, locale), exit: () => t('cli.task.menu.action.exit', {}, locale) };
  return labels[action]();
}
const title = (task: TaskView | undefined) => task?.taskBrief?.title ?? task?.taskBrief?.task?.split(/\r?\n/u).find(line => line.trim())?.trim() ?? '';
/** The domain's decision rule (`resolveTaskDecision`), read from the Run view: a decision is open, no effect is unresolved, the Run is live. */
function decisionOpen(run: RunView, task: TaskView, kind: 'accept' | 'reject'): boolean {
  if (task.phase !== 'awaiting-decision' || !task.decision || task.unresolvedEffects || run.cancellationRequested || run.state.kind === 'terminal') return false;
  return kind === 'reject' || !['evaluation-not-ready', 'needs-input'].includes(task.decision.reason);
}

/**
 * Only the actions valid for the task's current state (CLI review §task): read it always; its transcript and diff once an attempt exists
 * (the diff once the attempt finished); accept/reject while a decision is open; delivery for an accepted patch awaiting delivery.
 * Execute and evaluate are not offered: the Run's progression and the AI/automation path own them (`task execute|evaluate`).
 */
export function taskActions(run: RunView, task: TaskView, delivery: boolean): readonly TaskMenuAction[] {
  const attempt = Boolean(task.resultBrief?.attemptId);
  return [
    'inspect', ...(attempt ? ['transcript' as const] : []), ...(attempt && ['awaiting-decision', 'accepted', 'failed'].includes(task.phase) ? ['diff' as const] : []),
    ...(decisionOpen(run, task, 'accept') ? ['accept' as const] : []), ...(decisionOpen(run, task, 'reject') ? ['reject' as const] : []),
    ...(delivery && task.phase === 'accepted' && task.resultBrief?.deliveryOutlook === 'awaiting-delivery' ? ['deliver' as const] : []),
  ];
}

async function readRun(context: TaskCommandContext, io: TaskMenuIo, scopeId: string, runId: string): Promise<RunView | null> {
  if (!context.inspectRun) throw ErrorRegistry.createError('INVENTORY_UNAVAILABLE');
  return (await context.inspectRun(io.root, runQuerySchema.parse({ schemaVersion: 1, scopeId, runId }), io.options)).run;
}

/**
 * Scope → Run → task, as on the terminal's `/runs`: the read scope rule (typed, else the configured default, else the person's choice), the
 * Run ids of the same query in the same order, then the Run's tasks. Values already given are kept. Null when the person cancels.
 */
export async function pickTaskTarget(context: TaskCommandContext, io: TaskMenuIo, given: Readonly<{ scopeId?: string | undefined; runId?: string | undefined;
  taskId?: string | undefined }>): Promise<TaskTarget | null> {
  const { locale, ask, root, options } = io;
  let scopeId = given.scopeId;
  if (!scopeId) {
    const configured = ((await loadConfig(root, options)).terminal as { scopeId?: string } | undefined)?.scopeId;
    const scope = await resolveCommandScope({ command: 'deckent task', locale, configured, mutating: false, interactive: true, listScopes: scopeLister(context, root, options), pick: ask });
    if (!scope) return null;
    io.print(scopeNotice(scope, locale)); scopeId = scope.scopeId;
  }
  let runId = given.runId, run: RunView | null = null;
  if (!runId) {
    const ids = (await listRunIds(context, root, scopeId, options)).slice(0, REGISTRY.menu.runsShown);
    if (!ids.length) { io.print(t('cli.task.menu.noRuns', { scope: scopeId }, locale)); return null; }
    const runs = new Map<string, RunView | null>();
    for (const id of ids) runs.set(id, await readRun(context, io, scopeId, id));
    runId = await ask({ title: t('cli.task.menu.pickRun', { scope: scopeId }, locale), options: ids.map(id => {
      const view = runs.get(id), done = view?.tasks.filter(task => task.phase === 'accepted').length ?? 0;
      return { id, label: t('cli.task.menu.runRow', { id: displayId(id, ids), done, total: view?.tasks.length ?? 0, title: title(view?.tasks[0]) }, locale) };
    }) }) ?? undefined;
    if (!runId) return null;
    run = runs.get(runId) ?? null;
  }
  if (given.taskId) return { scopeId, runId, taskId: given.taskId };
  run ??= await readRun(context, io, scopeId, runId);
  if (!run) throw ErrorRegistry.createError('RUN_NOT_FOUND', { params: { run: runId } });
  const tasks = run.tasks.slice(0, REGISTRY.menu.tasksShown);
  const taskId = tasks.length === 1 ? tasks[0]!.id : await ask({ title: t('cli.task.menu.pickTask', { run: runId.slice(0, 12) }, locale),
    options: tasks.map(task => ({ id: task.id, label: t('cli.task.menu.taskRow', { task: task.id, phase: phaseWord(task.phase, locale), title: title(task) }, locale) })) });
  return taskId ? { scopeId, runId, taskId } : null;
}

/** Accept or reject with the revision read just before the card and a system command id; a Run that changed meanwhile is read again and asked again (bounded). */
async function decide(kind: 'accept' | 'reject', target: TaskTarget, context: TaskCommandContext, io: TaskMenuIo): Promise<void> {
  const { locale, ask, print } = io;
  if (!context.applyRunLifecycle) throw ErrorRegistry.createError('INVENTORY_UNAVAILABLE');
  for (let round = 0; ; round++) {
    const run = await readRun(context, io, target.scopeId, target.runId), task = run?.tasks.find(value => value.id === target.taskId);
    if (!run || !task || !decisionOpen(run, task, kind)) { print(t('cli.task.menu.decide.closed', { task: target.taskId, phase: task ? phaseWord(task.phase, locale) : '-' }, locale)); return; }
    const answer = await ask({ title: kind === 'accept' ? t('cli.task.menu.decide.acceptTitle', { task: task.id }, locale) : t('cli.task.menu.decide.rejectTitle', { task: task.id }, locale), body: [
      t('cli.task.menu.decide.body', { run: target.runId.slice(0, 12), revision: run.revision, title: title(task) }, locale),
      ...(round ? [t('cli.task.menu.decide.reread', {}, locale)] : []), ...(kind === 'accept' ? [t('cli.task.menu.decide.acceptNote', {}, locale)] : []),
    ], options: [{ id: 'yes', label: t('cli.task.menu.yes', {}, locale), key: 'y' }, { id: 'no', label: t('cli.task.menu.no', {}, locale), key: 'n' }] });
    if (answer !== 'yes') { print(t('cli.task.menu.left', {}, locale)); return; }
    try {
      const result = await context.applyRunLifecycle(io.root, runLifecycleCommandSchema.parse({ schemaVersion: 1, commandId: `cli-decide-${randomUUID()}`, scopeId: target.scopeId,
        runId: target.runId, taskId: target.taskId, action: kind, expectedRevision: run.revision }), io.options);
      const after = result?.lifecycle.run.tasks.find(value => value.id === target.taskId);
      print(after?.acceptedEvidence === 'model-unverified' ? t('cli.task.decision.acceptedUnverified', {}, locale)
        : t('cli.task.menu.decide.done', { task: target.taskId, phase: after ? phaseWord(after.phase, locale) : '-' }, locale));
      return;
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      if (typeof code !== 'string' || !REGISTRY.menu.staleCodes.includes(code) || round >= REGISTRY.menu.staleRetries) throw error;
      print(t('cli.task.menu.decide.stale', {}, locale));
    }
  }
}

/**
 * Bare `deckent task` on a person's terminal: pick the task, then a menu of only its valid actions, repeated until the person leaves.
 * Reads run the family's own handlers; decisions and delivery go through the same applications as `/runs` and `/deliver`.
 */
export async function taskMenu(context: TaskCommandContext, io: TaskMenuIo, given: Readonly<{ scopeId?: string | undefined; runId?: string | undefined; taskId?: string | undefined }>): Promise<void> {
  const target = await pickTaskTarget(context, io, given);
  if (!target) return;
  for (;;) {
    const run = await readRun(context, io, target.scopeId, target.runId), task = run?.tasks.find(value => value.id === target.taskId);
    if (!run) throw ErrorRegistry.createError('RUN_NOT_FOUND', { params: { run: target.runId } });
    if (!task) throw ErrorRegistry.createError('ATTEMPT_NOT_FOUND', { params: { run: target.runId, task: target.taskId } });
    const actions = taskActions(run, task, Boolean(io.deliveryPort));
    const choice = await io.ask({ title: t('cli.task.menu.title', { task: task.id, phase: phaseWord(task.phase, io.locale) }, io.locale),
      body: [title(task), t('cli.task.menu.runLine', { run: target.runId.slice(0, 12), scope: target.scopeId }, io.locale)].filter(Boolean),
      options: [...actions, 'exit' as const].map(action => ({ id: action, label: actionLabel(action, io.locale), ...(action === 'exit' ? { key: 'q' } : {}) })) });
    if (choice === null || choice === 'exit' || !actions.includes(choice as TaskMenuAction)) return;
    if (choice === 'inspect' || choice === 'transcript') await io.show(choice, target);
    else if (choice === 'diff') await io.show('patch-preview', target);
    else if (choice === 'accept' || choice === 'reject') await decide(choice, target, context, io);
    else await deliverTask(io.deliveryPort!, { key: `${target.scopeId}:${target.runId}:${target.taskId}`, ...target, title: title(task) || task.id },
      { locale: io.locale, ask: io.ask, print: io.print, diff: () => io.show('patch-preview', target) });
  }
}

/** The four action groups of the family (registry data); `cli-task-human.test.ts` keeps their union equal to the catalog's task actions. */
export const TASK_ACTION_GROUPS: Readonly<Record<keyof typeof REGISTRY.groups, readonly string[]>> = REGISTRY.groups;
/** The family's actions in the review's four groups (İncele · Yürüt ve değerlendir · Teslim · Kuyruk), for the pipe/agent refusal of a bare call. */
export function groupedTaskActions(locale: Locale): string {
  const actions = (group: keyof typeof REGISTRY.groups) => ({ actions: REGISTRY.groups[group].join(' | ') });
  return [t('cli.task.group.inspect', actions('inspect'), locale), t('cli.task.group.work', actions('work'), locale),
    t('cli.task.group.deliver', actions('deliver'), locale), t('cli.task.group.queue', actions('queue'), locale)].join('\n');
}
