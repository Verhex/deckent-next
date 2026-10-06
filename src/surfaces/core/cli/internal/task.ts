import { inspectTask } from './task-inspect.js';
import { hasCliAction, renderAbandonedClosure, type AbandonedClosureView } from '#surfaces/core/cli-kit/index.js';
import { cliUsage } from './usage.js';
import { ErrorRegistry, emit, loadConfig, resolveLocale, t, type ConfigLoadOptions, type ProductLayout } from '#platform/index.js';
import { attemptIdentitySchema, type AttemptIdentity } from '#domain/index.js';
import { runLifecycleCommandSchema, taskEvaluationCommandSchema, type DispatchTerminal, type RunView, type TaskEvaluationCommand } from '#engine/index.js';
import type { WorkspaceAdoptionApplication, IntegrationAdoptionCommand, IntegrationRollbackCommand, WorkspaceDeliveryApplication, IntegrationDeliveryCommand, WorkspaceIntegrationInspection, IntegrationQuery, WorkspaceIntegrationApplication, IntegrationCommand, WorkspacePatch, PatchScope } from '#engine/index.js';
import type { ArtifactReceipt } from '#capabilities/index.js';
export type TaskIntegrationDeliverHandler = (root: string, command: IntegrationDeliveryCommand, options: ConfigLoadOptions) => ReturnType<WorkspaceDeliveryApplication['deliver']>;
export type TaskIntegrationAdoptHandler = (root: string, command: IntegrationAdoptionCommand, options: ConfigLoadOptions) => ReturnType<WorkspaceAdoptionApplication['adopt']>;
export type TaskIntegrationRollbackHandler = (root: string, command: IntegrationRollbackCommand, options: ConfigLoadOptions) => ReturnType<WorkspaceAdoptionApplication['rollback']>;
export type TaskIntegrationInspectHandler = (root: string, query: IntegrationQuery, options: ConfigLoadOptions) => ReturnType<WorkspaceIntegrationInspection['inspect']>;
export type TaskIntegrationCheckHandler = (root: string, identity: AttemptIdentity, options: ConfigLoadOptions) => ReturnType<WorkspaceIntegrationApplication['check']>;
export type TaskIntegrationPrepareHandler = (root: string, command: IntegrationCommand, options: ConfigLoadOptions) => ReturnType<WorkspaceIntegrationApplication['prepare']>;
export type TaskPatchHandler = (root: string, identity: AttemptIdentity, options: ConfigLoadOptions) => Promise<Readonly<{ schemaVersion: 1; receipt: ArtifactReceipt; patch: WorkspacePatch; scope: PatchScope; application: 'not-applied' }>>;
/** K6: one human line for the derived scope classification (prepare, preview, integration check); JSON carries the typed object. */
function scopeLine(scope: PatchScope, locale: ReturnType<typeof resolveLocale>) {
  const line = scope.status === 'unscoped' ? t('cli.task.patch.scope.unscoped', { mode: scope.mode }, locale)
    : scope.status === 'in-scope' ? t('cli.task.patch.scope.inScope', { mode: scope.mode }, locale)
      : t('cli.task.patch.scope.outOfScope', { mode: scope.mode, count: scope.outOfScope.length, paths: scope.outOfScope.join(', ') }, locale);
  const hints = scope.status === 'out-of-scope' ? (scope.directoryHints ?? [])
    .map(hint => t('cli.task.patch.scope.directoryHint', hint, locale)) : [];
  return [line, ...hints, ...(scope.mode === 'enforce' && scope.status !== 'in-scope'
    ? [t('cli.task.patch.scope.enforced', {}, locale)] : [])].join('\n');
}
import type { CommandContext } from './kernel-commands.js';
import { renderWorkerTranscript } from '#surfaces/core/monitor/index.js';

export type TaskExecutionHandler = (root: string, identity: AttemptIdentity, options: ConfigLoadOptions) => Promise<Readonly<{ schemaVersion: 1; layout: ProductLayout;
  execution: Readonly<{ identity: AttemptIdentity; status: 'terminal' | 'prevented' | 'unresolved'; terminal: DispatchTerminal | null; outputRecorded: boolean }> }>>;
export type TaskAbandonedClosureHandler = (root: string, identity: AttemptIdentity, options: ConfigLoadOptions) => Promise<Readonly<{ schemaVersion: 1; layout: ProductLayout; closure: AbandonedClosureView & Readonly<{ identity: AttemptIdentity }> }>>;
export type TaskEvaluationHandler = (root: string, command: TaskEvaluationCommand, options: ConfigLoadOptions) => Promise<Readonly<{ schemaVersion: 1; layout: ProductLayout;
  evaluation: Readonly<{ schemaVersion: 1; commandId: string; run: RunView }> }>>;
async function resolveLatestAttempt(context: CommandContext, scopeId: string, runId: string, taskId: string): Promise<AttemptIdentity> {
  let best: AttemptIdentity | undefined, after: string | null = null;
  do {
    const { page } = await context.inspectInventory!(context.root ?? process.cwd(), { schemaVersion: 1, scopeId, after }, { env: context.env ?? process.env });
    for (const { identity } of page.entries) if (identity.runId === runId && identity.taskId === taskId && (!best || identity.generation > best.generation)) best = identity;
    after = page.nextAfter;
  } while (after !== null);
  if (!best) throw ErrorRegistry.createError('ATTEMPT_NOT_FOUND', { params: { run: runId, task: taskId } });
  return best;
}
async function decideTask(action: 'accept' | 'reject', values: ReadonlyMap<string, string>, context: CommandContext, json: boolean, usage: (flag?: string) => Error) {
  const scopeId = values.get('--scope'), runId = values.get('--run'), taskId = values.get('--task');
  const commandId = values.get('--command-id'), revision = values.get('--expected-revision');
  if (!scopeId || !runId || !taskId || !commandId || !revision || !/^(0|[1-9][0-9]*)$/.test(revision) || !Number.isSafeInteger(Number(revision))) throw usage('--expected-revision');
  if (values.has('--attempt') || values.has('--layout-revision') || values.has('--generation')) throw usage('--attempt');
  if (!context.applyRunLifecycle) throw ErrorRegistry.createError('INVENTORY_UNAVAILABLE');
  const locale = resolveLocale(values.get('--lang'), context.env);
  const result = await context.applyRunLifecycle(context.root ?? process.cwd(), runLifecycleCommandSchema.parse({ schemaVersion: 1, commandId, scopeId, runId, taskId,
    action, expectedRevision: Number(revision) }), { env: context.env ?? process.env });
  emit(result, { json, ...(context.stdout ? { stdout: context.stdout } : {}), render: data => {
    const task = data?.lifecycle.run.tasks.find(value => value.id === taskId);
    return task?.acceptedEvidence === 'model-unverified' ? t('cli.task.decision.acceptedUnverified', {}, locale) : task?.phase ?? '';
  } }); return;
}

async function evaluateTask(values: ReadonlyMap<string, string>, context: CommandContext, identity: AttemptIdentity, json: boolean, usage: (flag?: string) => Error) {
  const taskId = identity.taskId, locale = resolveLocale(values.get('--lang'), context.env);
  const options = { env: context.env ?? process.env };
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
      reconciling: t('cli.run.inspect.states.reconciling', {}, locale), skipped: t('cli.run.inspect.states.skipped', {}, locale),
      'awaiting-decision': t('cli.run.inspect.states.awaitingDecision', {}, locale) };
    return [t('cli.task.evaluate.result', { task: taskId, command: commandId, phase: phases[task.phase], revision: data.evaluation.run.revision }, locale),
      ...(task.notAcceptedReason ? [t('task.acceptance.noChangeProduced', {}, locale)] : [])].join('\n');
  } });
}

const identityFlags = ['--scope', '--run', '--task', '--attempt', '--generation', '--layout-revision', '--lang'];
export async function taskCommand(argv: readonly string[], context: CommandContext): Promise<void> {
  const action = argv[1];
  const languageAt = argv.indexOf('--lang');
  const requestedLanguage = languageAt >= 0 ? argv[languageAt + 1] : undefined;
  const earlyLocale = resolveLocale(requestedLanguage?.startsWith('-') ? undefined : requestedLanguage, context.env);
  context.onLocale?.(earlyLocale);
  const usage = (flag?: string) => cliUsage('task', action, earlyLocale, flag);
  if (!hasCliAction('task', action)) throw usage();
  const flags = action === 'patch-preview' ? ['--stat', '--diff'] : [];
  const allowed = ['evaluate', 'accept', 'reject'].includes(action ?? '') ? [...identityFlags, '--command-id', '--expected-revision'] : action === 'integration-prepare' ? [...identityFlags, '--command-id', '--proposal', '--replaces-command-id'] : action === 'integration-deliver' ? [...identityFlags, '--command-id', '--candidate-command-id'] : action === 'integration-adopt' ? [...identityFlags, '--command-id', '--delivery-command-id', '--target', '--verification-run'] : action === 'integration-rollback' ? [...identityFlags, '--command-id', '--adoption-command-id'] : action === 'integration-inspect' ? [...identityFlags, '--command-id'] : identityFlags;
  const values = new Map<string, string>(); let json = false, stat = false, diff = false;
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--json') { if (json) throw usage(); json = true; continue; }
    if (arg === '--no-color') continue;
    if (flags.includes(arg)) { if (arg === '--stat' ? stat : diff) throw usage(arg); if (arg === '--stat') stat = true; else diff = true; continue; }
    if (!allowed.includes(arg)) throw usage();
    if (values.has(arg)) throw usage(arg);
    const value = argv[++i]; if (!value || value.startsWith('--')) throw usage(arg); values.set(arg, value);
  }
  if ((stat && diff) || (json && (stat || diff))) throw usage(stat ? '--stat' : '--diff');
  const scopeId = values.get('--scope'), runId = values.get('--run'), taskId = values.get('--task'), attemptId = values.get('--attempt');
  const layoutRevision = values.get('--layout-revision'), generation = values.get('--generation');
  if (action === 'accept' || action === 'reject') { await decideTask(action, values, context, json, usage); return; }
  const resolveLatest = ['patch-preview', 'transcript', 'integration-inspect'].includes(action ?? '') && !attemptId && !layoutRevision && !generation;
  let identity: AttemptIdentity;
  let resolvedNotice: Readonly<{ attempt: string; generation: number; layout: string; run: string; task: string }> | undefined;
  if (action === 'inspect') { await inspectTask(values, context, json, earlyLocale, usage); return; }
  if (resolveLatest) {
    if (!scopeId || !runId || !taskId) throw usage(!scopeId ? '--scope' : !runId ? '--run' : '--task');
    if (!context.inspectInventory) throw ErrorRegistry.createError('INVENTORY_UNAVAILABLE');
    identity = await resolveLatestAttempt(context, scopeId, runId, taskId);
    resolvedNotice = { attempt: identity.attemptId, generation: identity.generation, layout: identity.layoutRevision, run: runId, task: taskId };
  } else {
    if (!scopeId || !runId || !taskId || !attemptId || !layoutRevision || !generation || !/^[1-9][0-9]*$/.test(generation)
      || !Number.isSafeInteger(Number(generation))) throw usage(!scopeId ? '--scope' : !runId ? '--run' : !taskId ? '--task' : !attemptId ? '--attempt' : !layoutRevision ? '--layout-revision' : '--generation');
    identity = attemptIdentitySchema.parse({ scopeId, runId, taskId, attemptId, layoutRevision, generation: Number(generation) });
  }
  const locale = resolveLocale(values.get('--lang'), context.env); context.onLocale?.(locale);
  const options = { env: context.env ?? process.env };
  if (resolvedNotice) (json ? context.stderr ?? process.stderr : context.stdout ?? process.stdout).write(`${t('cli.task.resolvedAttempt', resolvedNotice, locale)}\n`);
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
      if (data.status === 'adopted' && data.verification.status === 'verified') return t('cli.task.integration.adoptedVerified', { ...params, run: data.verification.runId, kind: data.verification.kind, attempt: data.verification.attemptId }, locale);
      return data.status === 'adopted' ? t('cli.task.integration.adopted', params, locale) : t('cli.task.integration.rolledBack', params, locale);
    };
    if (action === 'integration-adopt') {
      const deliveryCommandId = values.get('--delivery-command-id'), targetRef = values.get('--target');
      if (!deliveryCommandId || !targetRef) throw usage(!deliveryCommandId ? '--delivery-command-id' : '--target');
      if (!context.adoptWorkspaceIntegration) throw ErrorRegistry.createError('INVENTORY_UNAVAILABLE');
      const root = context.root ?? process.cwd(), verificationRunId = values.get('--verification-run');
      // The verifying kind is the installation's (config); the adoption application re-checks it against the same configuration.
      const verificationKind = verificationRunId === undefined ? undefined : (await loadConfig(root, options)).execution?.adoption.verification?.kind;
      if (verificationRunId !== undefined && verificationKind === undefined) throw ErrorRegistry.createError('ADOPTION_VERIFICATION_NOT_CONFIGURED');
      emit(await context.adoptWorkspaceIntegration(root, { schemaVersion: 2, commandId, identity, deliveryCommandId, targetRef,
        ...(verificationRunId === undefined || verificationKind === undefined ? {} : { verificationRunId, verificationKind }) }, options), { ...sinks, render }); return;
    }
    const adoptionCommandId = values.get('--adoption-command-id'); if (!adoptionCommandId) throw usage('--adoption-command-id');
    if (!context.rollbackWorkspaceIntegration) throw ErrorRegistry.createError('INVENTORY_UNAVAILABLE');
    emit(await context.rollbackWorkspaceIntegration(context.root ?? process.cwd(), { schemaVersion: 1, commandId, identity, adoptionCommandId }, options), { ...sinks, render }); return;
  }
  if (action === 'transcript') {
    if (!context.inspectWorkerTranscript) throw ErrorRegistry.createError('INVENTORY_UNAVAILABLE');
    const result = await context.inspectWorkerTranscript(context.root ?? process.cwd(), identity, options);
    emit(result, { json, ...(context.stdout ? { stdout: context.stdout } : {}), render: data => renderWorkerTranscript(data, locale) }); return;
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
      [t('cli.task.integration.check', { source: data.observation.source, proposal: data.proposal }, locale), scopeLine(data.scope, locale)].join('\n') }); return;
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
    const heading = (data: typeof result) => t('cli.task.patch.heading', { task: identity.taskId, count: data.patch.changes.length }, locale);
    const notice = t('cli.task.patch.notice', {}, locale);
    if (action === 'patch-prepare' || json) {
      emit(result, { json, ...(context.stdout ? { stdout: context.stdout } : {}), render: data => [
        heading(data), scopeLine(data.scope, locale), ...data.patch.changes.map(change => JSON.stringify(change)), notice,
      ].join('\n') }); return;
    }
    if (!context.renderUnifiedDiff) throw ErrorRegistry.createError('INVENTORY_UNAVAILABLE');
    const render = context.renderUnifiedDiff;
    emit(result, { json, ...(context.stdout ? { stdout: context.stdout } : {}), render: data => {
      const sections = data.patch.changes.map(change => {
        let before = change.before?.text ?? null, after = change.after?.text ?? null;
        // A trailing newline is not a phantom empty line, unless it is the only difference.
        if ((before === null || before.endsWith('\n')) && (after === null || after.endsWith('\n'))) {
          before = before?.slice(0, -1) ?? null; after = after?.slice(0, -1) ?? null;
        }
        const modeChanged = change.before && change.after && change.before.mode !== change.after.mode;
        const body = change.before && change.after && change.before.text === change.after.text ? '' : render(change.path, before, after);
        const mode = modeChanged ? `mode ${change.before!.mode} -> ${change.after!.mode} ${change.path}` : '';
        return { path: change.path, body, mode };
      });
      if (!stat) return [heading(data), scopeLine(data.scope, locale), ...sections.flatMap(section => [section.body, section.mode].filter(Boolean)), notice].join('\n');
      let totalAdded = 0, totalRemoved = 0;
      const lines = sections.map(section => {
        const body = section.body.split('\n').slice(2).filter(line => !line.startsWith('@@'));
        const added = body.filter(line => line.startsWith('+')).length, removed = body.filter(line => line.startsWith('-')).length;
        totalAdded += added; totalRemoved += removed;
        return `${section.path} | +${added} -${removed}`;
      });
      return [heading(data), scopeLine(data.scope, locale), ...lines, t('cli.task.patch.stat.summary', { count: sections.length, added: totalAdded, removed: totalRemoved }, locale), notice].join('\n');
    } }); return;
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
  if (action === 'close-abandoned') { if (!context.closeAbandonedAttempt) throw ErrorRegistry.createError('INVENTORY_UNAVAILABLE'); emit(await context.closeAbandonedAttempt(context.root ?? process.cwd(), identity, options), { json, ...(context.stdout ? { stdout: context.stdout } : {}), render: data => renderAbandonedClosure(data.closure, locale) }); return; }
  await evaluateTask(values, context, identity, json, usage);
}
