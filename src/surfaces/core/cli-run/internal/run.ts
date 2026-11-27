import { runProposalCommand } from './run-proposal.js';
import { cliUsage, commandLocale, hasCliAction, shellIdentity } from '#surfaces/core/cli-kit/index.js';
import { cliMode, matchIdPrefix, renderInputSchema } from '#surfaces/core/cli-human/index.js';
import { projectInputSchema } from '#engine/index.js';
import { ErrorRegistry, EXIT_CODES, emit, loadConfig, t, type ConfigLoadOptions, type ExitCode, type Locale, type ProductLayout } from '#platform/index.js';
import { runLifecycleCommandSchema, runAdmissionSchema, runDeliveryAdmissionSchema, runReservationCommandSchema, type RunAdmission, type RunDeliveryAdmission, type RunView, type RunReservationCommand, type WorkerAdmissionWarning } from '#engine/index.js';
import { resolve } from 'node:path';
import { readGraphInput } from './graph-input.js';
import { identitySchema, taskGraphSchema, validateTaskGraph, TaskGraphError, sanitizeIssues, type AttemptIdentity } from '#domain/index.js';
import type { RunCommandContext } from './context.js';
import { renderRunCancellation, runCancellationExitCode } from './cancellation.js';
import { renderRunInspect } from './run-inspect.js';
import { runList } from './run-list.js';
import { runControlFlow } from './run-control.js';
import { familyScope, pickRun, readScopeRuns, resolveRunId, runHumanIo, scopeLine } from './run-human.js';
import REGISTRY from './run.json' with { type: 'json' };
export { renderRunCancellation } from './cancellation.js';
function withheldWarning(warning: Extract<WorkerAdmissionWarning, { code: 'WORKER_INSTRUCTIONS_WITHHELD' }>, locale: Locale) {
  const params = { source: warning.source, digest: warning.digest?.slice(0, 12) ?? '-' };
  if (warning.reason === 'absent') return t('run.warning.WORKER_INSTRUCTIONS_WITHHELD.absent', params, locale);
  if (warning.reason === 'untrusted') return t('run.warning.WORKER_INSTRUCTIONS_WITHHELD.untrusted', params, locale);
  return warning.reason === 'unsafe' ? t('run.warning.WORKER_INSTRUCTIONS_WITHHELD.unsafe', params, locale) : t('run.warning.WORKER_INSTRUCTIONS_WITHHELD.unreadable', params, locale);
}
/** S4B-5: memory left out of a worker prompt names the task and a count only (never which entries). */
function memoryWithheldWarning(warning: Extract<WorkerAdmissionWarning, { code: 'MEMORY_CONTEXT_WITHHELD' }>, locale: Locale) {
  const params = { taskId: warning.taskId ?? '-', count: warning.count };
  if (warning.reason === 'policy') return t('run.warning.MEMORY_CONTEXT_WITHHELD.policy', params, locale);
  if (warning.reason === 'sources') return t('run.warning.MEMORY_CONTEXT_WITHHELD.sources', params, locale);
  return warning.reason === 'budget' ? t('run.warning.MEMORY_CONTEXT_WITHHELD.budget', params, locale) : t('run.warning.MEMORY_CONTEXT_WITHHELD.contests', params, locale);
}
function admissionWarning(warning: WorkerAdmissionWarning, locale: Locale) {
  if (warning.code === 'WORKER_INSTRUCTIONS_WITHHELD') return withheldWarning(warning, locale);
  if (warning.code === 'MEMORY_CONTEXT_WITHHELD') return memoryWithheldWarning(warning, locale);
  return t('run.warning.WORKER_IMAGE_REFRESHING', { taskId: warning.taskId, modelId: warning.modelId, minCliVersion: warning.minCliVersion, cliVersion: warning.cliVersion ?? '-' }, locale);
}
export type { RunCancellationDeliveryHandler, RunQueryHandler } from '#surfaces/core/cli-terminal/index.js';
export type RunAdmissionHandler = (root: string, command: RunAdmission, options: ConfigLoadOptions) => Promise<Readonly<{ schemaVersion: 1; layout: ProductLayout; admission: Readonly<{ schemaVersion: 1; commandId: string; run: RunView }>; warnings?: readonly WorkerAdmissionWarning[] }>>;
/** Local (not runtime-service) admission of a Run pinned to a completed delivery's commit (B06-2a `createDeliveryRun`). */
export type RunDeliveryAdmissionHandler = (root: string, command: RunDeliveryAdmission, options: ConfigLoadOptions) => ReturnType<RunAdmissionHandler>;
export type RunReservationHandler = (root: string, command: RunReservationCommand, options: ConfigLoadOptions) => Promise<Readonly<{ schemaVersion: 1; layout: ProductLayout; reservation: Readonly<{ schemaVersion: 1; commandId: string; run: RunView; identities: readonly AttemptIdentity[] }> }>>;
export async function runCommand(argv: readonly string[], context: RunCommandContext): Promise<ExitCode | void> {
  const action = argv[1];
  const languageAt = argv.indexOf('--lang');
  const requestedLanguage = languageAt >= 0 ? argv[languageAt + 1] : undefined;
  const earlyLocale = commandLocale(context, requestedLanguage?.startsWith('-') ? undefined : requestedLanguage);
  const usage = (flag?: string) => cliUsage('run', action, earlyLocale, flag);
  if (action === 'propose' || action === 'inspect-proposal') return runProposalCommand(argv, context, earlyLocale);
  if (!hasCliAction('run', action)) throw usage();
  // BeUser D-12: the graph file's contract (JSON Schema), without a project; a bad graph names its field and points here.
  if (action === 'create' && argv.includes('--schema')) { emit(renderInputSchema(projectInputSchema(taskGraphSchema as never)), { json: false, ...(context.stdout ? { stdout: context.stdout } : {}) }); return; }
  const control = action === 'cancel' || action === 'close' || action === 'hold' || action === 'resume';
  const { values, json, verbose } = runFlags(argv, action, control, usage);
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
    const answer = values.get('--answer'), taskId = values.get('--task'), quota = quotaChoice(values.get('--quota'), usage);
    if ((answer !== undefined) !== (taskId !== undefined) || (answer !== undefined && !answer.trim()) || (quota !== undefined && answer !== undefined)) throw usage('--answer');
    return runControlFlow(action, context, await runHumanIo(context, locale), { scopeId: values.get('--scope'), runId: values.get('--id'), reason: values.get('--reason'), taskId, answer, ...(quota ? { quota } : {}) });
  }
  // A change never takes a silent default: no --scope names the valid scopes (CLI_SCOPE_REQUIRED) instead of blaming another flag.
  const io = interactive && !values.get('--scope') ? await runHumanIo(context, locale) : undefined;
  const scope = await familyScope(context, { command: `deckent run ${action}`, locale, explicit: values.get('--scope'), mutating: true, interactive, ...(io ? { ask: io.ask } : {}) });
  if (!scope) {
    if (!control) io?.print(t('cli.run.control.nothing', {}, locale));
    return EXIT_CODES.error;
  }
  const scopeId = scope.scopeId; const typedRunId = values.get('--id');
  if (!typedRunId) throw usage('--id');
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
    }, locale) + (data.warnings ?? []).map(warning => `\n${admissionWarning(warning, locale)}`).join('') }); return;
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
  // BeUser D-09: a person's card takes --reason for every control (the help says so); the typed path records one only for hold.
  if (values.has('--reason') && action !== 'hold') throw usage('--reason');
  if (action === 'close' || action === 'resume' || action === 'hold') {
    const commandId = values.get('--command-id'), revision = values.get('--expected-revision');
    if (!commandId || !revision || !/^(0|[1-9][0-9]*)$/.test(revision) || !Number.isSafeInteger(Number(revision))) throw usage(!commandId ? '--command-id' : '--expected-revision');
    if (!context.applyRunLifecycle) throw ErrorRegistry.createError('INVENTORY_UNAVAILABLE');
    const answer = values.get('--answer'), taskId = values.get('--task'), holdReason = values.get('--reason'), quota = quotaChoice(values.get('--quota'), usage);
    if (quota !== undefined && (action !== 'resume' || answer !== undefined)) throw usage('--quota');
    if (action === 'hold' && !holdReason?.trim()) throw usage('--reason');
    if (action === 'resume' && ((answer !== undefined) !== (taskId !== undefined) || (answer !== undefined && !answer.trim()))) throw usage('--answer');
    const repaired = action !== 'close' && !quota && answer === undefined ? context.repairedRunControlBinding : undefined;
    const result = await context.applyRunLifecycle(context.root ?? process.cwd(), runLifecycleCommandSchema.parse({ schemaVersion: 1, commandId, scopeId, runId,
      action: quota ? 'quota-answer' : answer === undefined ? action : 'answer', ...(quota ? { choice: quota } : {}), ...(holdReason === undefined ? {} : { holdReason }),
      ...(answer === undefined ? {} : { answer, taskId }), expectedRevision: Number(revision) }), { env: context.env ?? process.env }, ...(repaired === undefined ? [] : [repaired]));
    emit(result, { json, ...(context.stdout ? { stdout: context.stdout } : {}), render: data => data ? t('cli.run.lifecycle.result', { run: runId, revision: data.lifecycle.run.revision,
      state: data.lifecycle.run.state.kind, reason: 'reason' in data.lifecycle.run.state ? data.lifecycle.run.state.reason : '—' }, locale) : '' }); return;
  }
  if (action === 'cancel') {
    const commandId = values.get('--command-id'); const revision = values.get('--expected-revision');
    if (!commandId || !revision || !/^(0|[1-9][0-9]*)$/.test(revision) || !Number.isSafeInteger(Number(revision))) throw usage(!commandId ? '--command-id' : !revision ? '--expected-revision' : undefined);
    if (!context.deliverRunCancellation) throw ErrorRegistry.createError('INVENTORY_UNAVAILABLE');
    const result = await context.deliverRunCancellation(context.root ?? process.cwd(), { schemaVersion: 1, commandId, scopeId, runId, action: 'cancel', expectedRevision: Number(revision) }, { env: context.env ?? process.env });
    emit(result, { json, ...(context.stdout ? { stdout: context.stdout } : {}), render: data => renderRunCancellation(data, commandId, scopeId, runId, locale) });
    return runCancellationExitCode(result);
  }
  throw usage();
}

function runFlags(argv: readonly string[], action: string | undefined, control: boolean, usage: (flag?: string) => Error) {
  const allowed = action === 'list' ? ['--scope', '--limit', '--lang'] : action === 'inspect' ? ['--scope', '--id', '--lang'] : action === 'create'
    ? ['--scope', '--id', '--lang', '--command-id', '--graph', '--branch', '--delivery-command-id'] : ['--scope', '--id', '--lang', '--command-id', '--expected-revision', ...(control ? ['--reason'] : []), ...(action === 'resume' ? ['--task', '--answer', '--quota'] : [])];
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
  return { values, json, verbose };
}
/**
 * The scope of a local `run hold|resume` the CLI entry may repair a proven binding move for first (owner 2026-11-27), read with this handler's own
 * parse: the scope named, and either every typed flag valid with the Run named or a person's card or picker (owner decision: the picker repairs
 * first, then lists). A resume answer (`--task --answer`, `--quota`) is no control; it and every incomplete form keep the entry's refusal.
 */
export function runControlRepairScope(argv: readonly string[], context: RunCommandContext): string | undefined {
  const action = argv[1];
  if (argv[0] !== 'run' || (action !== 'hold' && action !== 'resume')) return undefined;
  let flags;
  try { flags = runFlags(argv, action, true, () => new Error()); } catch { return undefined; }
  const { values, json } = flags, scopeId = values.get('--scope'), commandId = values.get('--command-id'), revision = values.get('--expected-revision'), reason = values.get('--reason');
  const selection = values.get('--id');
  if (!scopeId || (selection !== undefined && !runSelection(selection)) || values.has('--task') || values.has('--answer') || values.has('--quota')) return undefined;
  const card = commandId === undefined && revision === undefined;
  // Without `--id` only a person's picker qualifies (owner decision): it lists the repaired scope, then takes the card.
  if (selection === undefined && !card) return undefined;
  if (card ? cliMode(context, json).mode !== 'interactive' : commandId === undefined || revision === undefined || !/^(0|[1-9][0-9]*)$/.test(revision)
    || !Number.isSafeInteger(Number(revision)) || (action === 'hold' ? !reason?.trim() : reason !== undefined)) return undefined;
  // Every value that needs no Run passes the control schema first (the Run id is judged after it resolves; the card's command id and revision
  // are the system's): placeholders stand for them here.
  const holdReason = action === 'hold' ? { holdReason: card ? reason?.trim() || 'held' : reason } : {};
  try {
    return runLifecycleCommandSchema.safeParse({ schemaVersion: 1, commandId: commandId ?? `cli-run-${action}-entry`, scopeId, runId: 'entry-run', action, ...holdReason,
      expectedRevision: card ? 0 : Number(revision) }).success ? scopeId : undefined;
  } catch { return undefined; }
}

/** Whether a typed `--id` can select a Run: a full id (`identitySchema`), or a prefix the short-id helper accepts (`matchIdPrefix`: at least
 * `shortId.minPrefix` characters) that a full id could start with (no leading space, no control character, so the value plus one more is an id). */
function runSelection(typed: string): boolean {
  return identitySchema.safeParse(typed).success || (identitySchema.safeParse(`${typed}x`).success && matchIdPrefix(typed, [`${typed}x`]).kind === 'unique');
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

/** S9: `run resume --quota wait|next-candidate` answers an expired subscription-quota wait (a person's choice; the service refuses AI and scripts). */
function quotaChoice(value: string | undefined, usage: (flag?: string) => Error): 'wait' | 'next-candidate' | undefined {
  if (value === undefined) return undefined;
  if (value !== 'wait' && value !== 'next-candidate') throw usage('--quota');
  return value;
}
