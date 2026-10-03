import { emit, ErrorRegistry, t, type Locale } from '#platform/index.js';
import { runQuerySchema } from '#engine/index.js';
import type { CommandContext } from './kernel-commands.js';
/** Local read surface of the existing Run operation: no worker execution or new runtime protocol. */
export async function inspectTask(values: ReadonlyMap<string, string>, context: CommandContext, json: boolean, locale: Locale, usage: (flag?: string) => Error) {
  const scopeId = values.get('--scope'), runId = values.get('--run'), taskId = values.get('--task');
  if (!scopeId || !runId || !taskId || ['--attempt', '--layout-revision', '--generation'].some(flag => values.has(flag))) throw usage('--task');
  if (!context.inspectRun) throw ErrorRegistry.createError('INVENTORY_UNAVAILABLE');
  const result = await context.inspectRun(context.root ?? process.cwd(), runQuerySchema.parse({ schemaVersion: 1, scopeId, runId }), { env: context.env ?? process.env });
  if (!result.run) throw ErrorRegistry.createError('RUN_NOT_FOUND', { params: { run: runId } });
  const task = result.run.tasks.find(value => value.id === taskId);
  if (!task) throw ErrorRegistry.createError('ATTEMPT_NOT_FOUND', { params: { run: runId, task: taskId } });
  const phases = { pending: t('cli.run.inspect.states.pending', {}, locale), active: t('cli.run.inspect.states.active', {}, locale),
    evaluating: t('cli.run.inspect.states.evaluating', {}, locale), accepted: t('cli.run.inspect.states.accepted', {}, locale),
    failed: t('cli.run.inspect.states.failed', {}, locale), cancelled: t('cli.run.inspect.states.cancelled', {}, locale),
    reconciling: t('cli.run.inspect.states.reconciling', {}, locale), skipped: t('cli.run.inspect.states.skipped', {}, locale),
    'awaiting-decision': t('cli.run.inspect.states.awaitingDecision', {}, locale) };
  emit({ schemaVersion: 1 as const, runId, task, models: (result.models ?? []).filter(value => value.taskId === taskId) }, {
    json, ...(context.stdout ? { stdout: context.stdout } : {}), render: data => [
      t('cli.run.inspect.task', { task: data.task.id, kind: data.task.kind }, locale),
      t('cli.run.inspect.stateLabel', { phase: phases[data.task.phase] }, locale),
      ...(data.task.handoffs ?? []).map(receipt => t('cli.run.inspect.handoffReceived', { source: receipt.source.taskId, attempt: receipt.source.attemptId, digest: receipt.digest }, locale)),
    ].join('\n') });
}
