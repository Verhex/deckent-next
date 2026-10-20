import { runProposalCommand } from './run-proposal.js';
import { cliUsage, commandLocale, hasCliAction, shellIdentity } from '#surfaces/core/cli-kit/index.js';
import { cliMode } from '#surfaces/core/cli-human/index.js';
import { ErrorRegistry, emit, loadConfig, t, type ConfigLoadOptions, type Locale, type ProductLayout } from '#platform/index.js';
import { runLifecycleCommandSchema, runAdmissionSchema, runDeliveryAdmissionSchema, runReservationCommandSchema, type RunAdmission, type RunDeliveryAdmission, type RunView, type RunReservationCommand } from '#engine/index.js';
import { resolve } from 'node:path';
import { readGraphInput } from './graph-input.js';
import { validateTaskGraph, TaskGraphError, sanitizeIssues, type AttemptIdentity } from '#domain/index.js';
import type { RunCommandContext } from './context.js';
import { renderRunCancellation } from './cancellation.js';
import { renderRunInspect } from './run-inspect.js';
import { runList } from './run-list.js';
import { runControlFlow } from './run-control.js';
import { familyScope, pickRun, readScopeRuns, resolveRunId, runHumanIo, scopeLine } from './run-human.js';
import REGISTRY from './run.json' with { type: 'json' };
export { renderRunCancellation } from './cancellation.js';
export type { RunCancellationDeliveryHandler, RunQueryHandler } from '#surfaces/core/cli-terminal/index.js';
export type RunAdmissionHandler = (root: string, command: RunAdmission, options: ConfigLoadOptions) => Promise<Readonly<{ schemaVersion: 1; layout: ProductLayout; admission: Readonly<{ schemaVersion: 1; commandId: string; run: RunView }>; warnings?: readonly Readonly<{ code: string; taskId: string; modelId: string; minCliVersion: string; cliVersion: string | null }>[] }>>;
/** Local (not runtime-service) admission of a Run pinned to a completed delivery's commit (B06-2a `createDeliveryRun`). */
export type RunDeliveryAdmissionHandler = (root: string, command: RunDeliveryAdmission, options: ConfigLoadOptions) => ReturnType<RunAdmissionHandler>;
export type RunReservationHandler = (root: string, command: RunReservationCommand, options: ConfigLoadOptions) => Promise<Readonly<{ schemaVersion: 1; layout: ProductLayout; reservation: Readonly<{ schemaVersion: 1; commandId: string; run: RunView; identities: readonly AttemptIdentity[] }> }>>;
export async function runCommand(argv: readonly string[], context: RunCommandContext): Promise<void> {
  const action = argv[1];
  const languageAt = argv.indexOf('--lang');
  const requestedLanguage = languageAt >= 0 ? argv[languageAt + 1] : undefined;
  const earlyLocale = commandLocale(context, requestedLanguage?.startsWith('-') ? undefined : requestedLanguage);
  const usage = (flag?: string) => cliUsage('run', action, earlyLocale, flag);
  if (action === 'propose' || action === 'inspect-proposal') return runProposalCommand(argv, context, earlyLocale);
  if (!hasCliAction('run', action)) throw usage();
  const control = action === 'cancel' || action === 'close' || action === 'hold' || action === 'resume';
  const allowed = action === 'list' ? ['--scope', '--limit', '--lang'] : action === 'inspect' ? ['--scope', '--id', '--lang'] : action === 'create'
    ? ['--scope', '--id', '--lang', '--command-id', '--graph', '--branch', '--delivery-command-id'] : ['--scope', '--id', '--lang', '--command-id', '--expected-revision', ...(action === 'hold' ? ['--reason'] : action === 'resume' ? ['--task', '--answer'] : [])];
  const values = new Map<string, string>(); let json = false, verbose = false;
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--json') { if (json) throw usage(); json = true; continue; }
    if (arg === '--verbose' && action === 'inspect') { if (verbose) throw usage(arg); verbose = true; continue; }
    if (arg === '--no-color') continue;
    if (!allowed.includes(arg)) throw usage();
    if (values.has(arg)) throw usage(arg);
    const value = argv[++i]; if (!value || value.startsWith('--')) throw usage(arg); values.set(arg, value);
  }
  if (verbose && json) throw usage('--verbose');
  const locale = commandLocale(context, values.get('--lang'));
  if (action === 'list') {
    const limit = values.get('--limit');
    if (limit !== undefined && (!/^[1-9][0-9]*$/.test(limit) || !Number.isSafeInteger(Number(limit)))) throw usage('--limit');
    await runList(values, json, context, locale); return;
  }
  const interactive = cliMode(context, json).mode === 'interactive';
  if (action === 'inspect') { await inspectRunAction(values, json, verbose, interactive, context, locale, usage); return; }
  // CLI review §run: on a person's terminal a control with neither --command-id nor --expected-revision picks, reads the revision and asks;
  // the AI and automation path keeps every typed flag mandatory (one of them typed: the usage error below, as before).
  if (control && interactive && !values.has('--command-id') && !values.has('--expected-revision')) {
    const answer = values.get('--answer'), taskId = values.get('--task');
    if ((answer !== undefined) !== (taskId !== undefined) || (answer !== undefined && !answer.trim())) throw usage('--answer');
    await runControlFlow(action, context, await runHumanIo(context, locale), { scopeId: values.get('--scope'), runId: values.get('--id'), reason: values.get('--reason'), taskId, answer });
    return;
  }
  const scopeId = values.get('--scope'); const typedRunId = values.get('--id');
  if (!scopeId || !typedRunId) throw usage(!scopeId ? '--scope' : '--id');
  // A short id resolves on every action that names an existing Run; never on `create`, whose --id names the new Run.
  const runId = action === 'create' ? typedRunId : await resolveRunId(context, scopeId, typedRunId);
  if (action === 'create') {
    const commandId = values.get('--command-id'); const source = values.get('--graph');
    if (!commandId || !source) throw usage(!commandId ? '--command-id' : '--graph');
    const deliveryCommandId = values.get('--delivery-command-id');
    if (!(deliveryCommandId === undefined ? context.createRun : context.createDeliveryRun)) throw ErrorRegistry.createError('INVENTORY_UNAVAILABLE');
    const root = context.root ?? process.cwd(); const options = { env: context.env ?? process.env };
    const config = await loadConfig(root, options);
    const graph = await readGraphInput(source === '-' ? source : resolve(root, source), config.cli.graphInputMaxBytes, context.stdin);
    try { validateTaskGraph(graph); }
    catch (error) {
      if (!(error instanceof TaskGraphError)) throw error;
      throw ErrorRegistry.createError('CLI_GRAPH_INPUT_INVALID', { params: {
        path: ['graph', ...(error.issues[0]?.path ?? [])].join('.'), reason: error.code,
      } });
    }
    const branchSource = values.get('--branch');
    if (branchSource === '-') throw usage('--branch'); // stdin is reserved for the graph.
    const branch = branchSource ? await readGraphInput(resolve(root, branchSource), config.cli.graphInputMaxBytes) : undefined;
    const parsed = runAdmissionSchema.safeParse({ schemaVersion: 1, commandId, scopeId, runId, graph, ...(branch === undefined ? {} : { branch }) });
    if (!parsed.success) {
      const issue = sanitizeIssues(parsed.error.issues)[0];
      throw ErrorRegistry.createError('CLI_GRAPH_INPUT_INVALID', { params: { path: issue?.path.join('.') ?? 'graph', reason: issue?.code ?? 'invalid' } });
    }
    const result = deliveryCommandId === undefined ? await context.createRun!(root, parsed.data, options)
      : await context.createDeliveryRun!(root, runDeliveryAdmissionSchema.parse({ ...parsed.data, deliveryCommandId }), options);
    emit(result, { json, ...(context.stdout ? { stdout: context.stdout } : {}), render: data => t('cli.run.create.result', {
      run: data.admission.run.runId, revision: data.admission.run.revision,
    }, locale) + (data.warnings ?? []).map(warning => `\n${t('run.warning.WORKER_IMAGE_REFRESHING', { taskId: warning.taskId, modelId: warning.modelId,
      minCliVersion: warning.minCliVersion, cliVersion: warning.cliVersion ?? '-' }, locale)}`).join('') }); return;
  }
  if (action === 'reserve') {
    const commandId = values.get('--command-id'); const revision = values.get('--expected-revision');
    if (!commandId || !revision || !/^(0|[1-9][0-9]*)$/.test(revision) || !Number.isSafeInteger(Number(revision))) throw usage(!commandId ? '--command-id' : !revision ? '--expected-revision' : undefined);
    if (!context.reserveRunTasks) throw ErrorRegistry.createError('INVENTORY_UNAVAILABLE');
    const command = runReservationCommandSchema.parse({ schemaVersion: 1, commandId, scopeId, runId, expectedRevision: Number(revision) });
    const result = await context.reserveRunTasks(context.root ?? process.cwd(), command, { env: context.env ?? process.env });
    emit(result, { json, ...(context.stdout ? { stdout: context.stdout } : {}), render: data => [
      t('cli.run.reserve.heading', { run: runId, command: commandId, count: data.reservation.identities.length }, locale),
      ...data.reservation.identities.map(identity => t('cli.run.reserve.identity', Object.fromEntries(Object.entries(identity).map(([key, value]) => [key, shellIdentity(value)])), locale)),
    ].join('\n') });
    return;
  }
  if (action === 'close' || action === 'resume' || action === 'hold') {
    const commandId = values.get('--command-id'), revision = values.get('--expected-revision');
    if (!commandId || !revision || !/^(0|[1-9][0-9]*)$/.test(revision) || !Number.isSafeInteger(Number(revision))) throw usage('--expected-revision');
    if (!context.applyRunLifecycle) throw ErrorRegistry.createError('INVENTORY_UNAVAILABLE');
    const answer = values.get('--answer'), taskId = values.get('--task'), holdReason = values.get('--reason');
    if (action === 'hold' && !holdReason?.trim()) throw usage('--reason');
    if (action === 'resume' && ((answer !== undefined) !== (taskId !== undefined) || (answer !== undefined && !answer.trim()))) throw usage('--answer');
    const result = await context.applyRunLifecycle(context.root ?? process.cwd(), runLifecycleCommandSchema.parse({ schemaVersion: 1, commandId, scopeId, runId,
      action: answer === undefined ? action : 'answer', ...(holdReason === undefined ? {} : { holdReason }),
      ...(answer === undefined ? {} : { answer, taskId }), expectedRevision: Number(revision) }), { env: context.env ?? process.env });
    emit(result, { json, ...(context.stdout ? { stdout: context.stdout } : {}), render: data => data ? t('cli.run.lifecycle.result', { run: runId, revision: data.lifecycle.run.revision,
      state: data.lifecycle.run.state.kind, reason: 'reason' in data.lifecycle.run.state ? data.lifecycle.run.state.reason : '—' }, locale) : '' }); return;
  }
  if (action === 'cancel') {
    const commandId = values.get('--command-id'); const revision = values.get('--expected-revision');
    if (!commandId || !revision || !/^(0|[1-9][0-9]*)$/.test(revision) || !Number.isSafeInteger(Number(revision))) throw usage(!commandId ? '--command-id' : !revision ? '--expected-revision' : undefined);
    if (!context.deliverRunCancellation) throw ErrorRegistry.createError('INVENTORY_UNAVAILABLE');
    const result = await context.deliverRunCancellation(context.root ?? process.cwd(), { schemaVersion: 1, commandId, scopeId, runId, action: 'cancel', expectedRevision: Number(revision) }, { env: context.env ?? process.env });
    emit(result, { json, ...(context.stdout ? { stdout: context.stdout } : {}), render: data => renderRunCancellation(data, commandId, scopeId, runId, locale) });
    return;
  }
  throw usage();
}

/** `run inspect` (CLI review §run): read scope rule; a short id resolves; on a person's terminal without --id, the Run is picked. */
async function inspectRunAction(values: ReadonlyMap<string, string>, json: boolean, verbose: boolean, interactive: boolean, context: RunCommandContext, locale: Locale,
  usage: (flag?: string) => Error): Promise<void> {
  if (!context.inspectRun) throw ErrorRegistry.createError('INVENTORY_UNAVAILABLE');
  const typed = values.get('--id');
  const io = interactive && (!values.get('--scope') || !typed) ? await runHumanIo(context, locale) : undefined;
  const scope = await familyScope(context, { command: 'deckent run inspect', locale, explicit: values.get('--scope'), mutating: false, interactive, ...(io ? { ask: io.ask } : {}) });
  if (!scope) return;
  let runId = typed ? await resolveRunId(context, scope.scopeId, typed) : undefined;
  if (!runId) {
    if (!io) throw usage('--id');
    const picked = await pickRun(io, scope.scopeId, (await readScopeRuns(context, scope.scopeId)).slice(0, REGISTRY.list.runsShown), t('cli.run.inspect.pick', { scope: scope.scopeId }, locale));
    if (!picked) return;
    runId = picked.runId;
  }
  const result = await context.inspectRun(context.root ?? process.cwd(), { schemaVersion: 1, scopeId: scope.scopeId, runId }, { env: context.env ?? process.env });
  if (!result.run) throw ErrorRegistry.createError('RUN_NOT_FOUND', { params: { run: runId } });
  emit(result, { json, ...(context.stdout ? { stdout: context.stdout } : {}), render: data => renderRunInspect(data, locale, verbose, scopeLine(scope, locale)) });
}
