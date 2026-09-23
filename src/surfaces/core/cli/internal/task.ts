import { cliUsage } from './usage.js';
import { ErrorRegistry, emit, resolveLocale, t, type ConfigLoadOptions, type ProductLayout } from '#platform/index.js';
import { attemptIdentitySchema, type AttemptIdentity } from '#domain/index.js';
import { taskEvaluationCommandSchema, type DispatchTerminal, type RunView, type TaskEvaluationCommand } from '#engine/index.js';
import type { WorkspaceAdoptionApplication, IntegrationAdoptionCommand, IntegrationRollbackCommand, WorkspaceDeliveryApplication, IntegrationDeliveryCommand, WorkspaceIntegrationInspection, IntegrationQuery, WorkspaceIntegrationApplication, IntegrationCommand, WorkspacePatch } from '#engine/index.js';
import type { ArtifactReceipt } from '#capabilities/index.js';
export type TaskIntegrationDeliverHandler = (root: string, command: IntegrationDeliveryCommand, options: ConfigLoadOptions) => ReturnType<WorkspaceDeliveryApplication['deliver']>;
export type TaskIntegrationAdoptHandler = (root: string, command: IntegrationAdoptionCommand, options: ConfigLoadOptions) => ReturnType<WorkspaceAdoptionApplication['adopt']>;
export type TaskIntegrationRollbackHandler = (root: string, command: IntegrationRollbackCommand, options: ConfigLoadOptions) => ReturnType<WorkspaceAdoptionApplication['rollback']>;
export type TaskIntegrationInspectHandler = (root: string, query: IntegrationQuery, options: ConfigLoadOptions) => ReturnType<WorkspaceIntegrationInspection['inspect']>;
export type TaskIntegrationCheckHandler = (root: string, identity: AttemptIdentity, options: ConfigLoadOptions) => ReturnType<WorkspaceIntegrationApplication['check']>;
export type TaskIntegrationPrepareHandler = (root: string, command: IntegrationCommand, options: ConfigLoadOptions) => ReturnType<WorkspaceIntegrationApplication['prepare']>;
export type TaskPatchHandler = (root: string, identity: AttemptIdentity, options: ConfigLoadOptions) => Promise<Readonly<{ schemaVersion: 1; receipt: ArtifactReceipt; patch: WorkspacePatch; application: 'not-applied' }>>;
import type { CommandContext } from './kernel-commands.js';

export type TaskExecutionHandler = (root: string, identity: AttemptIdentity, options: ConfigLoadOptions) => Promise<Readonly<{ schemaVersion: 1; layout: ProductLayout;
  execution: Readonly<{ identity: AttemptIdentity; status: 'terminal' | 'prevented' | 'unresolved'; terminal: DispatchTerminal | null; outputRecorded: boolean }> }>>;
export type TaskEvaluationHandler = (root: string, command: TaskEvaluationCommand, options: ConfigLoadOptions) => Promise<Readonly<{ schemaVersion: 1; layout: ProductLayout;
  evaluation: Readonly<{ schemaVersion: 1; commandId: string; run: RunView }> }>>;
const identityFlags = ['--scope', '--run', '--task', '--attempt', '--generation', '--layout-revision', '--lang'];
export async function taskCommand(argv: readonly string[], context: CommandContext): Promise<void> {
  const action = argv[1];
  const languageAt = argv.indexOf('--lang');
  const requestedLanguage = languageAt >= 0 ? argv[languageAt + 1] : undefined;
  const earlyLocale = resolveLocale(requestedLanguage?.startsWith('-') ? undefined : requestedLanguage, context.env);
  context.onLocale?.(earlyLocale);
  const usage = (flag?: string) => cliUsage('task', action, earlyLocale, flag);
  if (!['execute', 'evaluate', 'patch-prepare', 'patch-preview', 'integration-check', 'integration-prepare', 'integration-inspect', 'integration-deliver', 'integration-adopt', 'integration-rollback'].includes(action ?? '')) throw usage();
  const allowed = action === 'evaluate' ? [...identityFlags, '--command-id', '--expected-revision'] : action === 'integration-prepare' ? [...identityFlags, '--command-id', '--proposal', '--replaces-command-id'] : action === 'integration-deliver' ? [...identityFlags, '--command-id', '--candidate-command-id'] : action === 'integration-adopt' ? [...identityFlags, '--command-id', '--delivery-command-id', '--target'] : action === 'integration-rollback' ? [...identityFlags, '--command-id', '--adoption-command-id'] : action === 'integration-inspect' ? [...identityFlags, '--command-id'] : identityFlags;
  const values = new Map<string, string>(); let json = false;
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--json') { if (json) throw usage(); json = true; continue; }
    if (arg === '--no-color') continue;
    if (!allowed.includes(arg)) throw usage();
    if (values.has(arg)) throw usage(arg);
    const value = argv[++i]; if (!value || value.startsWith('--')) throw usage(arg); values.set(arg, value);
  }
  const scopeId = values.get('--scope'), runId = values.get('--run'), taskId = values.get('--task'), attemptId = values.get('--attempt');
  const layoutRevision = values.get('--layout-revision'), generation = values.get('--generation');
  if (!scopeId || !runId || !taskId || !attemptId || !layoutRevision || !generation || !/^[1-9][0-9]*$/.test(generation)
    || !Number.isSafeInteger(Number(generation))) throw usage(!scopeId ? '--scope' : !runId ? '--run' : !taskId ? '--task' : !attemptId ? '--attempt' : !layoutRevision ? '--layout-revision' : '--generation');
  const identity = attemptIdentitySchema.parse({ scopeId, runId, taskId, attemptId, layoutRevision, generation: Number(generation) });
  const locale = resolveLocale(values.get('--lang'), context.env); context.onLocale?.(locale);
  const options = { env: context.env ?? process.env };
  if (action === 'integration-deliver') {
    const commandId = values.get('--command-id'), integrationCommandId = values.get('--candidate-command-id');
    if (!commandId || !integrationCommandId) throw usage(!commandId ? '--command-id' : '--candidate-command-id');
    if (!context.deliverWorkspaceIntegration) throw ErrorRegistry.createError('INVENTORY_UNAVAILABLE');
    const result = await context.deliverWorkspaceIntegration(context.root ?? process.cwd(), { schemaVersion: 1, identity, commandId, integrationCommandId }, options);
    emit(result, { json, ...(context.stdout ? { stdout: context.stdout } : {}), render: data =>
      t('cli.task.integration.delivered', { ref: data.plan.ref, commit: data.plan.commit }, locale) }); return;
  }
  if (action === 'integration-adopt' || action === 'integration-rollback') {
    const commandId = values.get('--command-id'); if (!commandId) throw usage('--command-id');
    const sinks = { json, ...(context.stdout ? { stdout: context.stdout } : {}) };
    const render = (data: Awaited<ReturnType<TaskIntegrationAdoptHandler>>) => {
      const params = { ref: data.targetRef, from: data.fromCommit, to: data.toCommit, sequence: data.sequence };
      return data.status === 'adopted' ? t('cli.task.integration.adopted', params, locale) : t('cli.task.integration.rolledBack', params, locale);
    };
    if (action === 'integration-adopt') {
      const deliveryCommandId = values.get('--delivery-command-id'), targetRef = values.get('--target');
      if (!deliveryCommandId || !targetRef) throw usage(!deliveryCommandId ? '--delivery-command-id' : '--target');
      if (!context.adoptWorkspaceIntegration) throw ErrorRegistry.createError('INVENTORY_UNAVAILABLE');
      emit(await context.adoptWorkspaceIntegration(context.root ?? process.cwd(), { schemaVersion: 1, commandId, identity, deliveryCommandId, targetRef }, options), { ...sinks, render }); return;
    }
    const adoptionCommandId = values.get('--adoption-command-id'); if (!adoptionCommandId) throw usage('--adoption-command-id');
    if (!context.rollbackWorkspaceIntegration) throw ErrorRegistry.createError('INVENTORY_UNAVAILABLE');
    emit(await context.rollbackWorkspaceIntegration(context.root ?? process.cwd(), { schemaVersion: 1, commandId, identity, adoptionCommandId }, options), { ...sinks, render }); return;
  }
  if (action === 'integration-inspect') {
    const commandId = values.get('--command-id'); if (!commandId) throw usage('--command-id');
    if (!context.inspectWorkspaceIntegration) throw ErrorRegistry.createError('INVENTORY_UNAVAILABLE');
    const result = await context.inspectWorkspaceIntegration(context.root ?? process.cwd(), { schemaVersion: 1, identity, commandId }, options);
    emit(result, { json, ...(context.stdout ? { stdout: context.stdout } : {}), render: data => {
      const statuses = { absent: t('cli.task.integration.absent', {}, locale), pending: t('cli.task.integration.pending', {}, locale),
        'manifest-recorded': t('cli.task.integration.recorded', {}, locale) };
      return [statuses[data.status], t('cli.task.integration.inspectNotice', {}, locale)].join('\n');
    } }); return;
  }
  if (action === 'integration-check') {
    if (!context.checkWorkspaceIntegration) throw ErrorRegistry.createError('INVENTORY_UNAVAILABLE');
    const result = await context.checkWorkspaceIntegration(context.root ?? process.cwd(), identity, options);
    emit(result, { json, ...(context.stdout ? { stdout: context.stdout } : {}), render: data =>
      t('cli.task.integration.check', { source: data.observation.source, proposal: data.proposal }, locale) }); return;
  }
  if (action === 'integration-prepare') {
    const commandId = values.get('--command-id'), proposal = values.get('--proposal');
    if (!commandId || !proposal) throw usage(!commandId ? '--command-id' : '--proposal');
    if (!context.prepareWorkspaceIntegration) throw ErrorRegistry.createError('INVENTORY_UNAVAILABLE');
    const result = await context.prepareWorkspaceIntegration(context.root ?? process.cwd(), { schemaVersion: 1, commandId, identity, proposal, ...(values.has('--replaces-command-id') ? { replacesCommandId: values.get('--replaces-command-id')! } : {}) }, options);
    emit(result, { json, ...(context.stdout ? { stdout: context.stdout } : {}), render: data =>
      t('cli.task.integration.prepared', { path: data.manifest.workspace }, locale) }); return;
  }
  if (action === 'patch-prepare' || action === 'patch-preview') {
    const handler = action === 'patch-prepare' ? context.prepareWorkspacePatch : context.previewWorkspacePatch;
    if (!handler) throw ErrorRegistry.createError('INVENTORY_UNAVAILABLE');
    const result = await handler(context.root ?? process.cwd(), identity, options);
    emit(result, { json, ...(context.stdout ? { stdout: context.stdout } : {}), render: data => [
      t('cli.task.patch.heading', { task: identity.taskId, count: data.patch.changes.length }, locale),
      ...data.patch.changes.map(change => JSON.stringify(change)),
      t('cli.task.patch.notice', {}, locale),
    ].join('\n') }); return;
  }
  if (action === 'execute') {
    if (!context.executeTask) throw ErrorRegistry.createError('INVENTORY_UNAVAILABLE');
    const result = await context.executeTask(context.root ?? process.cwd(), identity, options);
    emit(result, { json, ...(context.stdout ? { stdout: context.stdout } : {}), render: data => [
      t('cli.task.execute.heading', data.execution.identity, locale),
      data.execution.status === 'terminal'
        ? t('cli.task.execute.terminal', { exitCode: data.execution.terminal?.exitCode ?? t('cli.value.none', {}, locale), signal: data.execution.terminal?.signal ?? t('cli.value.none', {}, locale) }, locale)
        : ({ prevented: t('cli.task.execute.prevented', {}, locale), unresolved: t('cli.task.execute.unresolved', {}, locale) })[data.execution.status],
      t('cli.task.execute.notice', {}, locale),
    ].join('\n') }); return;
  }
  const commandId = values.get('--command-id'), revision = values.get('--expected-revision');
  if (!commandId || !revision || !/^(0|[1-9][0-9]*)$/.test(revision) || !Number.isSafeInteger(Number(revision))) throw usage(!commandId ? '--command-id' : !revision ? '--expected-revision' : undefined);
  if (!context.evaluateTask) throw ErrorRegistry.createError('INVENTORY_UNAVAILABLE');
  const command = taskEvaluationCommandSchema.parse({ schemaVersion: 1, commandId, identity, expectedRevision: Number(revision) });
  const result = await context.evaluateTask(context.root ?? process.cwd(), command, options);
  emit(result, { json, ...(context.stdout ? { stdout: context.stdout } : {}), render: data => {
    const task = data.evaluation.run.tasks.find(value => value.id === taskId); if (!task) throw ErrorRegistry.createError('RUN_STORE_CORRUPT');
    const phases = { pending: t('cli.run.inspect.states.pending', {}, locale), active: t('cli.run.inspect.states.active', {}, locale),
      evaluating: t('cli.run.inspect.states.evaluating', {}, locale), accepted: t('cli.run.inspect.states.accepted', {}, locale),
      failed: t('cli.run.inspect.states.failed', {}, locale), cancelled: t('cli.run.inspect.states.cancelled', {}, locale),
      reconciling: t('cli.run.inspect.states.reconciling', {}, locale) };
    return t('cli.task.evaluate.result', { task: taskId, command: commandId, phase: phases[task.phase], revision: data.evaluation.run.revision }, locale);
  } });
}
