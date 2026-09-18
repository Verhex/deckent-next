import { cliUsage, shellIdentity } from './usage.js';
import { ErrorRegistry, emit, loadConfig, resolveLocale, t, type ConfigLoadOptions, type ProductLayout } from '#platform/index.js';
import { runAdmissionSchema, runReservationCommandSchema, type RunAdmission, type RunCommand, type RunQuery, type RunView, type RunCancellationOutcome, type RunReservationCommand } from '#engine/index.js';
import { resolve } from 'node:path';
import { readGraphInput } from './graph-input.js';
import { validateTaskGraph, TaskGraphError, sanitizeIssues, type AttemptIdentity } from '#domain/index.js';
import type { CommandContext } from './kernel-commands.js';
export type RunQueryHandler = (root: string, query: RunQuery, options: ConfigLoadOptions) => Promise<Readonly<{ schemaVersion: 1; layout: ProductLayout; run: RunView | null }>>;
export type RunAdmissionHandler = (root: string, command: RunAdmission, options: ConfigLoadOptions) => Promise<Readonly<{ schemaVersion: 1; layout: ProductLayout; admission: Readonly<{ schemaVersion: 1; commandId: string; run: RunView }> }>>;
export type RunCancellationDeliveryHandler = (root: string, command: RunCommand, options: ConfigLoadOptions) => Promise<Readonly<{ schemaVersion: 1; layout: ProductLayout; delivery: Readonly<{ schemaVersion: 2; runId: string; scopeId: string; cancellationRequested: true; outcomes: readonly RunCancellationOutcome[] }> }>>;
export type RunReservationHandler = (root: string, command: RunReservationCommand, options: ConfigLoadOptions) => Promise<Readonly<{ schemaVersion: 1; layout: ProductLayout; reservation: Readonly<{ schemaVersion: 1; commandId: string; run: RunView; identities: readonly AttemptIdentity[] }> }>>;
export async function runCommand(argv: readonly string[], context: CommandContext): Promise<void> {
  const action = argv[1]; const usage = (flag?: string) => cliUsage('run', action, resolveLocale(undefined, context.env), flag);
  if (action !== 'inspect' && action !== 'cancel' && action !== 'reserve' && action !== 'create') throw usage();
  const allowed = action === 'inspect' ? ['--scope', '--id', '--lang'] : action === 'create'
    ? ['--scope', '--id', '--lang', '--command-id', '--graph'] : ['--scope', '--id', '--lang', '--command-id', '--expected-revision'];
  const values = new Map<string, string>(); let json = false;
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--json') { if (json) throw usage(); json = true; continue; }
    if (arg === '--no-color') continue;
    if (!allowed.includes(arg)) throw usage();
    if (values.has(arg)) throw usage(arg);
    const value = argv[++i]; if (!value || value.startsWith('--')) throw usage(arg); values.set(arg, value);
  }
  const scopeId = values.get('--scope'); const runId = values.get('--id');
  if (!scopeId || !runId) throw usage(!scopeId ? '--scope' : '--id');
  const locale = resolveLocale(values.get('--lang'), context.env); context.onLocale?.(locale);
  if (action === 'create') {
    const commandId = values.get('--command-id'); const source = values.get('--graph');
    if (!commandId || !source) throw usage(!commandId ? '--command-id' : '--graph');
    if (!context.createRun) throw ErrorRegistry.createError('INVENTORY_UNAVAILABLE');
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
    const parsed = runAdmissionSchema.safeParse({ schemaVersion: 1, commandId, scopeId, runId, graph });
    if (!parsed.success) {
      const issue = sanitizeIssues(parsed.error.issues)[0];
      throw ErrorRegistry.createError('CLI_GRAPH_INPUT_INVALID', { params: { path: issue?.path.join('.') ?? 'graph', reason: issue?.code ?? 'invalid' } });
    }
    const result = await context.createRun(root, parsed.data, options);
    emit(result, { json, ...(context.stdout ? { stdout: context.stdout } : {}), render: data => t('cli.run.create.result', {
      run: data.admission.run.runId, revision: data.admission.run.revision,
    }, locale) }); return;
  }
  if (action === 'reserve') {
    const commandId = values.get('--command-id'); const revision = values.get('--expected-revision');
    if (!commandId || !revision || !/^(0|[1-9][0-9]*)$/.test(revision) || !Number.isSafeInteger(Number(revision))) throw usage();
    if (!context.reserveRunTasks) throw ErrorRegistry.createError('INVENTORY_UNAVAILABLE');
    const command = runReservationCommandSchema.parse({ schemaVersion: 1, commandId, scopeId, runId, expectedRevision: Number(revision) });
    const result = await context.reserveRunTasks(context.root ?? process.cwd(), command, { env: context.env ?? process.env });
    emit(result, { json, ...(context.stdout ? { stdout: context.stdout } : {}), render: data => [
      t('cli.run.reserve.heading', { run: runId, command: commandId, count: data.reservation.identities.length }, locale),
      ...data.reservation.identities.map(identity => t('cli.run.reserve.identity', Object.fromEntries(Object.entries(identity).map(([key, value]) => [key, shellIdentity(value)])), locale)),
    ].join('\n') });
    return;
  }
  if (action === 'cancel') {
    const commandId = values.get('--command-id'); const revision = values.get('--expected-revision');
    if (!commandId || !revision || !/^(0|[1-9][0-9]*)$/.test(revision) || !Number.isSafeInteger(Number(revision))) throw usage();
    if (!context.deliverRunCancellation) throw ErrorRegistry.createError('INVENTORY_UNAVAILABLE');
    const result = await context.deliverRunCancellation(context.root ?? process.cwd(), { schemaVersion: 1, commandId, scopeId, runId, action: 'cancel', expectedRevision: Number(revision) }, { env: context.env ?? process.env });
    emit(result, { json, ...(context.stdout ? { stdout: context.stdout } : {}), render: data => {
      const labels = {
        terminal: t('cli.run.cancel.terminal', {}, locale), unresolved: t('cli.run.cancel.unresolved', {}, locale),
        denied: t('cli.run.cancel.denied', {}, locale), unavailable: t('cli.run.cancel.unavailable', {}, locale),
        prevented: t('cli.run.cancel.prevented', {}, locale),
        'not-dispatched': t('cli.run.cancel.notDispatched', {}, locale),
      };
      const deliveryLabels = { queued: t('cli.run.cancel.deliveryQueued', {}, locale), claimed: t('cli.run.cancel.deliveryClaimed', {}, locale), exhausted: t('cli.run.cancel.deliveryExhausted', {}, locale), terminal: labels.terminal, prevented: labels.prevented };
      const unconfirmed = data.delivery.outcomes.filter(item => item.status !== 'terminal' && item.status !== 'not-dispatched' && item.status !== 'prevented').length;
      return [t('cli.run.cancel.heading', { run: data.delivery.runId, command: commandId }, locale),
        ...(unconfirmed ? [t('cli.run.cancel.unconfirmed', { count: unconfirmed, total: data.delivery.outcomes.length }, locale)] : []),
        ...data.delivery.outcomes.flatMap(item => [t('cli.run.cancel.outcome', { task: item.taskId, attempt: item.attemptId, status: labels[item.status] }, locale),
          ...(item.delivery && ['queued', 'claimed', 'exhausted'].includes(item.delivery.state)
            ? [t('cli.run.cancel.delivery', { count: item.delivery.attempts, state: deliveryLabels[item.delivery.state] }, locale)] : [])]),
        ...(data.delivery.outcomes.length ? [] : [t('cli.run.cancel.empty', {}, locale)]),
        t('cli.run.cancel.notice', { scope: scopeId, run: runId }, locale),
      ].join('\n');
    } });
    return;
  }
  if (!context.inspectRun) throw ErrorRegistry.createError('INVENTORY_UNAVAILABLE');
  const result = await context.inspectRun(context.root ?? process.cwd(), { schemaVersion: 1, scopeId, runId }, { env: context.env ?? process.env });
  emit(result, { json, ...(context.stdout ? { stdout: context.stdout } : {}), render: data => {
    const phases = {
      pending: t('cli.run.inspect.states.pending', {}, locale), active: t('cli.run.inspect.states.active', {}, locale),
      evaluating: t('cli.run.inspect.states.evaluating', {}, locale), accepted: t('cli.run.inspect.states.accepted', {}, locale),
      failed: t('cli.run.inspect.states.failed', {}, locale), cancelled: t('cli.run.inspect.states.cancelled', {}, locale),
      reconciling: t('cli.run.inspect.states.reconciling', {}, locale),
    };
    const run = data.run;
    if (!run) return t('cli.run.inspect.missing', { run: runId }, locale);
    return [t('cli.run.inspect.heading', { run: run.runId, revision: run.revision }, locale),
      run.cancellationRequested ? t('cli.run.inspect.cancelRequested', {}, locale) : t('cli.run.inspect.cancelAbsent', {}, locale),
      ...run.tasks.flatMap(task => [t('cli.run.inspect.task', { task: task.id, kind: task.kind }, locale),
        t('cli.run.inspect.stateLabel', { phase: phases[task.phase] }, locale),
        t('cli.run.inspect.profile', { profile: task.profile.id, version: task.profile.version, criteria: task.acceptanceCriteria.join(', ') }, locale),
        ...(task.unresolvedEffects ? [t('cli.run.inspect.unresolved', {}, locale)] : [])]),
      ...run.criteria.map(criterion => t('cli.run.inspect.criterion', { criterion: criterion.id, description: criterion.description, evaluator: criterion.evaluator.id, version: criterion.evaluator.version }, locale)),
    ].join('\n');
  } });
}
