import { queueCommand } from '#surfaces/core/delivery-queue/index.js';
import { inspectTask, phaseWord } from './task-inspect.js';
import { groupedTaskActions, pickTaskTarget, taskMenu, type TaskMenuIo } from './task-menu.js';
import { cliUsage, commandLocale, hasCliAction } from '#surfaces/core/cli-kit/index.js';
import { askCliCard, cliMode, listRunIds, matchIdPrefix, requireIdPrefix } from '#surfaces/core/cli-human/index.js';
import { ErrorRegistry, emit, loadConfig, t, terminalSafeText, type ConfigLoadOptions, type Locale, type ProductLayout } from '#platform/index.js';
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
function scopeLine(scope: PatchScope, locale: Locale) {
  const line = scope.status === 'unscoped' ? t('cli.task.patch.scope.unscoped', { mode: scope.mode }, locale)
    : scope.status === 'in-scope' ? t('cli.task.patch.scope.inScope', { mode: scope.mode }, locale)
      : t('cli.task.patch.scope.outOfScope', { mode: scope.mode, count: scope.outOfScope.length, paths: scope.outOfScope.join(', ') }, locale);
  const hints = scope.status === 'out-of-scope' ? (scope.directoryHints ?? [])
    .map(hint => t('cli.task.patch.scope.directoryHint', hint, locale)) : [];
  return [line, ...hints, ...(scope.mode === 'enforce' && scope.status !== 'in-scope'
    ? [t('cli.task.patch.scope.enforced', {}, locale)] : [])].join('\n');
}
import type { TaskCommandContext } from './context.js';
import { patchStat, resolveLatestAttempt, terminalDeliveryPort } from '#surfaces/core/cli-terminal/index.js';
import { notAcceptedLabel, renderWorkerTranscript } from '#surfaces/core/monitor/index.js';
/**
 * SEC-5S F1: a worker-written file body reaches the owner's terminal only through `terminalSafeText`, line by line. A carriage return
 * inside a line, which would have overwritten it, becomes a visible continuation that keeps the diff marker (' ', '-', '+') of the
 * line it is part of. One CR at the end of a line is its CRLF ending (the next byte is the line break), not an overwrite: it is dropped.
 * J1b D1: a line whose control characters were neutralised is followed by one `\ ` meta line (unified diff's own form, as in
 * "\ No newline at end of file"), so the reviewer knows the file holds them; a continuation keeps its diff marker, so no content line
 * can pose as the marker.
 */
const safeDiff = (body: string, marker: string) => body.split('\n').flatMap(line => {
  const raw = line.endsWith('\r') ? line.slice(0, -1) : line, safe = terminalSafeText(raw);
  const shown = safe.split('\n').join(`\n${[' ', '+', '-'].includes(line[0] ?? '') ? line[0] : ''}`);
  return safe === raw ? [shown] : [shown, `\\ ${marker}`];
}).join('\n');

export type TaskExecutionHandler = (root: string, identity: AttemptIdentity, options: ConfigLoadOptions) => Promise<Readonly<{ schemaVersion: 1; layout: ProductLayout;
  execution: Readonly<{ identity: AttemptIdentity; status: 'terminal' | 'prevented' | 'unresolved'; terminal: DispatchTerminal | null; outputRecorded: boolean }> }>>;
export type TaskEvaluationHandler = (root: string, command: TaskEvaluationCommand, options: ConfigLoadOptions) => Promise<Readonly<{ schemaVersion: 1; layout: ProductLayout;
  evaluation: Readonly<{ schemaVersion: 1; commandId: string; run: RunView }> }>>;
/** Same resolution as the terminal delivery window (`resolveLatestAttempt` in cli-terminal). */
async function latestAttempt(context: TaskCommandContext, scopeId: string, runId: string, taskId: string): Promise<AttemptIdentity> {
  return resolveLatestAttempt(context.inspectInventory!, context.root ?? process.cwd(), scopeId, runId, taskId, { env: context.env ?? process.env });
}
async function decideTask(action: 'accept' | 'reject', values: ReadonlyMap<string, string>, context: TaskCommandContext, json: boolean, usage: (flag?: string) => Error) {
  const scopeId = values.get('--scope'), runId = values.get('--run'), taskId = values.get('--task');
  const commandId = values.get('--command-id'), revision = values.get('--expected-revision');
  if (!scopeId || !runId || !taskId || !commandId || !revision || !/^(0|[1-9][0-9]*)$/.test(revision) || !Number.isSafeInteger(Number(revision))) throw usage('--expected-revision');
  if (values.has('--attempt') || values.has('--layout-revision') || values.has('--generation')) throw usage('--attempt');
  if (!context.applyRunLifecycle) throw ErrorRegistry.createError('INVENTORY_UNAVAILABLE');
  const locale = commandLocale(context, values.get('--lang'));
  const result = await context.applyRunLifecycle(context.root ?? process.cwd(), runLifecycleCommandSchema.parse({ schemaVersion: 1, commandId, scopeId, runId, taskId,
    action, expectedRevision: Number(revision) }), { env: context.env ?? process.env });
  emit(result, { json, ...(context.stdout ? { stdout: context.stdout } : {}), render: data => {
    const task = data?.lifecycle.run.tasks.find(value => value.id === taskId);
    return task?.acceptedEvidence === 'model-unverified' ? t('cli.task.decision.acceptedUnverified', {}, locale) : task?.phase ?? '';
  } }); return;
}

async function evaluateTask(values: ReadonlyMap<string, string>, context: TaskCommandContext, identity: AttemptIdentity, json: boolean, usage: (flag?: string) => Error) {
  const taskId = identity.taskId, locale = commandLocale(context, values.get('--lang'));
  const options = { env: context.env ?? process.env };
  const commandId = values.get('--command-id'), revision = values.get('--expected-revision');
  if (!commandId || !revision || !/^(0|[1-9][0-9]*)$/.test(revision) || !Number.isSafeInteger(Number(revision))) throw usage(!commandId ? '--command-id' : !revision ? '--expected-revision' : undefined);
  if (!context.evaluateTask) throw ErrorRegistry.createError('INVENTORY_UNAVAILABLE');
  const command = taskEvaluationCommandSchema.parse({ schemaVersion: 1, commandId, identity, expectedRevision: Number(revision) });
  const result = await context.evaluateTask(context.root ?? process.cwd(), command, options);
  emit(result, { json, ...(context.stdout ? { stdout: context.stdout } : {}), render: data => {
    const task = data.evaluation.run.tasks.find(value => value.id === taskId); if (!task) throw ErrorRegistry.createError('RUN_STORE_CORRUPT');
    return [t('cli.task.evaluate.result', { task: taskId, command: commandId, phase: phaseWord(task.phase, locale), revision: data.evaluation.run.revision }, locale),
      ...(task.notAcceptedReason ? [notAcceptedLabel(task.notAcceptedReason, locale)] : [])].join('\n');
  } });
}

/**
 * Short run ids (CLI review "Kimlik", git-like): an exact id or the unique prefix of a Run the terminal's `/runs` lists resolves to that Run;
 * several candidates refuse (CLI_ID_AMBIGUOUS, exit 2). Anything else goes on as typed, so the AI path's full ids and an older Run outside
 * the listed page reach the application unchanged (RUN_NOT_FOUND keeps its meaning). A list that cannot be read resolves nothing.
 */
async function resolveRun(context: TaskCommandContext, scopeId: string, typed: string): Promise<string> {
  let ids: readonly string[];
  try { ids = await listRunIds(context, context.root ?? process.cwd(), scopeId, { env: context.env ?? process.env }); } catch { return typed; }
  const match = matchIdPrefix(typed, ids);
  if (match.kind === 'ambiguous') requireIdPrefix(typed, ids);
  return match.kind === 'unique' ? match.id : typed;
}
/** The menu's I/O on the person's terminal: CLI cards bounded by the session approval time (silence answers nothing) and this family's own read views. */
async function menuIo(context: TaskCommandContext, locale: Locale): Promise<TaskMenuIo> {
  const root = context.root ?? process.cwd(), options = { env: context.env ?? process.env }, out = context.stdout ?? process.stdout;
  const ttlMs = (await loadConfig(root, options)).approvals.sessionTtlMs;
  return { locale, root, options, print: text => out.write(`${text}\n`),
    ask: request => askCliCard(request, { locale, env: options.env, signal: AbortSignal.any([AbortSignal.timeout(ttlMs), ...(context.signal ? [context.signal] : [])]),
      ...(context.stdin ? { stdin: context.stdin } : {}), ...(context.stdout ? { stdout: context.stdout } : {}), ...(context.agentEnvironment ? { agentEnvironment: context.agentEnvironment } : {}) }),
    show: async (view, target) => taskCommand(['task', view, '--scope', target.scopeId, '--run', target.runId, '--task', target.taskId, '--lang', locale], context),
    deliveryPort: terminalDeliveryPort(root, context, options) };
}
/**
 * `deckent task` without an action (owner 2026-10-19 "boş komut yok"; reached once the catalog marks the family `bare: 'handler'`): a person on
 * a terminal gets the task menu (`--scope`/`--run`/`--task` preselect); a pipe, agent, CI or `--json` caller is never asked and gets the actions in
 * their four groups with the missing argument named (CLI_ARGUMENT_MISSING, exit 2).
 */
async function bareTask(argv: readonly string[], context: TaskCommandContext, locale: Locale): Promise<void> {
  const values = new Map<string, string>(); let json = false;
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--json' && !json) { json = true; continue; }
    if (arg === '--no-color') continue;
    const value = argv[i + 1];
    if (!['--scope', '--run', '--task', '--lang'].includes(arg) || values.has(arg) || !value || value.startsWith('--')) throw cliUsage('task', undefined, locale, arg);
    values.set(arg, value); i++;
  }
  if (cliMode(context, json).mode !== 'interactive') throw ErrorRegistry.createError('CLI_ARGUMENT_MISSING', { params: { command: ['deckent', argv[0]].join(' '), usage: [
    t('cli.help.bare.missing', { argument: `<${t('cli.help.placeholder.action', {}, locale)}>` }, locale), groupedTaskActions(locale), t('cli.help.bare.details', { command: 'task' }, locale)].join('\n') } });
  const scopeId = values.get('--scope'), typed = values.get('--run');
  await taskMenu(context, await menuIo(context, locale), { scopeId, runId: scopeId && typed ? await resolveRun(context, scopeId, typed) : typed, taskId: values.get('--task') });
}

/**
 * CLI review "TTY'de id yoksa seçici": a person on a terminal reading a task without naming it picks it (scope → Run → task) and the picked ids
 * fill the flags; everyone else keeps the usage error. False only when the person cancelled the pick (nothing is read).
 */
async function pickMissing(values: Map<string, string>, context: TaskCommandContext, json: boolean, locale: Locale): Promise<boolean> {
  if ((values.has('--scope') && values.has('--run') && values.has('--task')) || cliMode(context, json).mode !== 'interactive') return true;
  const picked = await pickTaskTarget(context, await menuIo(context, locale), { scopeId: values.get('--scope'), runId: values.get('--run'), taskId: values.get('--task') });
  if (picked) values.set('--scope', picked.scopeId).set('--run', picked.runId).set('--task', picked.taskId);
  return picked !== null;
}

const identityFlags = ['--scope', '--run', '--task', '--attempt', '--generation', '--layout-revision', '--lang'];
export async function taskCommand(argv: readonly string[], context: TaskCommandContext): Promise<void> {
  const action = argv[1];
  if (action?.startsWith('integration-queue-')) { await queueCommand(argv, context); return; }
  const languageAt = argv.indexOf('--lang'), earlyLocale = commandLocale(context, languageAt >= 0 ? argv[languageAt + 1] : undefined);
  if (action === undefined || action.startsWith('-')) { await bareTask(argv, context, earlyLocale); return; }
  const usage = (flag?: string) => cliUsage('task', action, earlyLocale, flag);
  if (!hasCliAction('task', action)) throw usage();
  const flags = action === 'patch-preview' ? ['--stat', '--diff'] : action === 'inspect' ? ['--verbose'] : [];
  const allowed = ['evaluate', 'accept', 'reject'].includes(action ?? '') ? [...identityFlags, '--command-id', '--expected-revision'] : action === 'integration-prepare' ? [...identityFlags, '--command-id', '--proposal', '--replaces-command-id'] : action === 'integration-deliver' ? [...identityFlags, '--command-id', '--candidate-command-id'] : action === 'integration-adopt' ? [...identityFlags, '--command-id', '--delivery-command-id', '--target', '--verification-run'] : action === 'integration-rollback' ? [...identityFlags, '--command-id', '--adoption-command-id'] : action === 'integration-inspect' ? [...identityFlags, '--command-id'] : identityFlags;
  const values = new Map<string, string>(), switches = new Set<string>(); let json = false;
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--json') { if (json) throw usage(); json = true; continue; }
    if (arg === '--no-color') continue;
    if (flags.includes(arg)) { if (switches.has(arg)) throw usage(arg); switches.add(arg); continue; }
    if (!allowed.includes(arg)) throw usage();
    if (values.has(arg)) throw usage(arg);
    const value = argv[++i]; if (!value || value.startsWith('--')) throw usage(arg); values.set(arg, value);
  }
  const stat = switches.has('--stat'), diff = switches.has('--diff');
  if ((stat && diff) || (json && (stat || diff))) throw usage(stat ? '--stat' : '--diff');
  const attemptId = values.get('--attempt'), layoutRevision = values.get('--layout-revision'), generation = values.get('--generation');
  // A typed short id resolves first, so a TTY pick that keeps it reads the full id (a picked id is already full).
  if (values.has('--scope') && values.has('--run')) values.set('--run', await resolveRun(context, values.get('--scope')!, values.get('--run')!));
  if (['inspect', 'transcript', 'patch-preview'].includes(action) && !attemptId && !layoutRevision && !generation && !await pickMissing(values, context, json, earlyLocale)) return;
  const scopeId = values.get('--scope'), runId = values.get('--run'), taskId = values.get('--task');
  if (action === 'accept' || action === 'reject') { await decideTask(action, values, context, json, usage); return; }
  const resolveLatest = ['patch-preview', 'transcript', 'integration-inspect'].includes(action) && !attemptId && !layoutRevision && !generation;
  let identity: AttemptIdentity;
  let resolvedNotice: Readonly<{ attempt: string; generation: number; layout: string; run: string; task: string }> | undefined;
  if (action === 'inspect') {
    if (!scopeId || !runId || !taskId || attemptId || layoutRevision || generation) throw usage('--task');
    await inspectTask({ scopeId, runId, taskId }, context, json, earlyLocale, switches.has('--verbose')); return;
  }
  if (resolveLatest) {
    if (!scopeId || !runId || !taskId) throw usage(!scopeId ? '--scope' : !runId ? '--run' : '--task');
    if (!context.inspectInventory) throw ErrorRegistry.createError('INVENTORY_UNAVAILABLE');
    identity = await latestAttempt(context, scopeId, runId, taskId);
    resolvedNotice = { attempt: identity.attemptId, generation: identity.generation, layout: identity.layoutRevision, run: runId, task: taskId };
  } else {
    if (!scopeId || !runId || !taskId || !attemptId || !layoutRevision || !generation || !/^[1-9][0-9]*$/.test(generation)
      || !Number.isSafeInteger(Number(generation))) throw usage(!scopeId ? '--scope' : !runId ? '--run' : !taskId ? '--task' : !attemptId ? '--attempt' : !layoutRevision ? '--layout-revision' : '--generation');
    identity = attemptIdentitySchema.parse({ scopeId, runId, taskId, attemptId, layoutRevision, generation: Number(generation) });
  }
  const locale = commandLocale(context, values.get('--lang'));
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
      // JSON.stringify escapes C0 controls but leaves C1 (e.g. U+009B CSI) raw; worker-written bodies reach the terminal only safe (SEC-5S F1).
      emit(result, { json, ...(context.stdout ? { stdout: context.stdout } : {}), render: data => terminalSafeText([
        heading(data), scopeLine(data.scope, locale), ...data.patch.changes.map(change => JSON.stringify(change)), notice,
      ].join('\n')) }); return;
    }
    if (!context.renderUnifiedDiff) throw ErrorRegistry.createError('INVENTORY_UNAVAILABLE');
    const render = context.renderUnifiedDiff;
    // Paths may carry C1 controls (the path schema refuses C0 and DEL only), so the whole human view is made terminal-safe too.
    emit(result, { json, ...(context.stdout ? { stdout: context.stdout } : {}), render: data => terminalSafeText((() => {
      if (stat) {
        // The same per-file count the terminal delivery window shows (TESLIM-PENCERESI).
        const counted = patchStat(data.patch.changes, render);
        return [heading(data), scopeLine(data.scope, locale), ...counted.files.map(file => `${file.path} | +${file.added} -${file.removed}`),
          t('cli.task.patch.stat.summary', { count: counted.files.length, added: counted.added, removed: counted.removed }, locale), notice].join('\n');
      }
      const sections = data.patch.changes.map(change => {
        let before = change.before?.text ?? null, after = change.after?.text ?? null;
        // A trailing newline is not a phantom empty line, unless it is the only difference.
        if ((before === null || before.endsWith('\n')) && (after === null || after.endsWith('\n'))) {
          before = before?.slice(0, -1) ?? null; after = after?.slice(0, -1) ?? null;
        }
        const modeChanged = change.before && change.after && change.before.mode !== change.after.mode;
        const body = change.before && change.after && change.before.text === change.after.text ? '' : render(change.path, before, after);
        const mode = modeChanged ? `mode ${change.before!.mode} -> ${change.after!.mode} ${change.path}` : '';
        return { body, mode };
      });
      return [heading(data), scopeLine(data.scope, locale), ...sections.flatMap(section => [safeDiff(section.body, t('cli.task.patch.neutralised', {}, locale)), section.mode].filter(Boolean)), notice].join('\n');
    })()) }); return;
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
  await evaluateTask(values, context, identity, json, usage);
}
