import { ErrorRegistry, HOST_LIMITS_REGISTRY, loadConfig, mapBounded, t, type ConfigLoadOptions, type Locale } from '#platform/index.js';
import { askCliCard, displayId, listRunIds, matchIdPrefix, orderPendingFirst, requireIdPrefix, resolveCommandScope, scopeLister, scopeNotice, untitledWorkName,
  heldPoolId, runStatusKey, type CliCardRequest, type ScopeResolution } from '#surfaces/core/cli-human/index.js';
import { runQuerySchema, type RunView } from '#engine/index.js';
import type { RunCommandContext } from './context.js';

/** One question on the person's terminal (the CLI card launcher); null = cancelled, so the caller applies nothing. */
export type RunCardAsk = (request: CliCardRequest) => Promise<string | null>;
/** The person-facing I/O of the run family: the card launcher, a line printer, and the call's root, options and locale. */
export type RunHumanIo = Readonly<{ locale: Locale; root: string; options: ConfigLoadOptions; ask: RunCardAsk; print: (text: string) => void }>;

/** CLI cards on the person's terminal, bounded by the session approval time (silence answers nothing) and the command's own signal. */
export async function runHumanIo(context: RunCommandContext, locale: Locale): Promise<RunHumanIo> {
  const root = context.root ?? process.cwd(), options = { env: context.env ?? process.env }, out = context.stdout ?? process.stdout;
  const ttlMs = (await loadConfig(root, options)).approvals.sessionTtlMs;
  return { locale, root, options, print: text => out.write(`${text}\n`),
    ask: request => askCliCard(request, { locale, env: options.env, signal: AbortSignal.any([AbortSignal.timeout(ttlMs), ...(context.signal ? [context.signal] : [])]),
      ...(context.stdin ? { stdin: context.stdin } : {}), ...(context.stdout ? { stdout: context.stdout } : {}),
      ...(context.agentEnvironment ? { agentEnvironment: context.agentEnvironment } : {}) }) };
}

/** The Run as a person names it: its first titled task, else the first line of a task request, else (PRE-5: a delivery-queue verify Run records
 * no brief) its first task and kind; the terminal's untitled word only for a Run without tasks. */
export function runTitle(run: RunView, locale: Locale): string {
  const titled = run.tasks.find(task => task.taskBrief?.title)?.taskBrief?.title;
  if (titled) return titled;
  const task = run.tasks.find(item => item.taskBrief?.task?.trim())?.taskBrief?.task;
  if (task) return task.trim().split(/\r?\n/u)[0]!.replace(/\s+/gu, ' ').trim();
  const first = run.tasks[0];
  return first ? untitledWorkName(first.id, first.kind, locale) : t('terminal.jobs.runFallback', {}, locale);
}

/** The Run state in the `/runs` window's words (one catalog: `terminal.jobs.state.*`), with the park reason when parked. */
export function runStateWord(run: RunView, locale: Locale): string {
  const states: Readonly<Record<'running' | 'parked' | 'completed' | 'incomplete' | 'failed' | 'cancelled', () => string>> = {
    running: () => t('terminal.jobs.state.running', {}, locale), parked: () => t('terminal.jobs.state.parked', {}, locale),
    completed: () => t('terminal.jobs.state.completed', {}, locale), incomplete: () => t('terminal.jobs.state.incomplete', {}, locale),
    failed: () => t('terminal.jobs.state.failed', {}, locale), cancelled: () => t('terminal.jobs.state.cancelled', {}, locale) };
  if (runStatusKey(run) === 'pool-held') return t('terminal.jobs.state.pool-held', { pool: heldPoolId(run) ?? '' }, locale); // BeUser DR3-02: one status mapping
  const state = states[run.state.kind === 'terminal' ? run.state.outcome : run.state.kind]();
  if (run.state.kind !== 'parked') return state;
  const reasons: Readonly<Record<typeof run.state.reason, () => string>> = {
    'dependency-failed': () => t('terminal.jobs.parked.dependency-failed', {}, locale), 'dependency-cancelled': () => t('terminal.jobs.parked.dependency-cancelled', {}, locale),
    'awaiting-decision': () => t('terminal.jobs.parked.awaiting-decision', {}, locale), 'evaluation-not-ready': () => t('terminal.jobs.parked.evaluation-not-ready', {}, locale),
    'needs-input': () => t('terminal.jobs.parked.needs-input', {}, locale), 'operator-hold': () => t('terminal.jobs.parked.operator-hold', {}, locale),
    'progression-failed': () => t('terminal.jobs.parked.progression-failed', {}, locale), 'quota-exhausted': () => t('terminal.jobs.parked.quota-exhausted', {}, locale), 'quota-ask': () => t('quotaask.state', {}, locale),
    'environment-not-ready': () => t('terminal.jobs.parked.environment-not-ready', {}, locale) };
  const reason = reasons[run.state.reason]();
  // A hold laid over another park keeps the park's own reason and says the hold too.
  return t('cli.run.list.stateReason', { state, reason: run.state.operatorHold && run.state.reason !== 'operator-hold' ? `${reason}, ${t('terminal.jobs.parked.heldOver', {}, locale)}` : reason }, locale);
}

/** A Run waits for someone when it is parked (a decision, an answer, a hold, a quota) — such Runs are listed first. */
export const runWaits = (run: RunView): boolean => run.state.kind === 'parked';

/**
 * A typed Run id as the person meant it (git-like, over the same id query as `/runs`): a unique prefix becomes the full id; several candidates
 * refuse (CLI_ID_AMBIGUOUS, exit 2, nothing read). Anything else goes on as typed, so the AI path's full ids and an older Run outside the listed
 * ids reach the application unchanged (RUN_NOT_FOUND keeps its meaning). A list that cannot be read resolves nothing.
 */
export async function resolveRunId(context: RunCommandContext, scopeId: string, typed: string): Promise<string> {
  let ids: readonly string[];
  try { ids = await listRunIds(context, context.root ?? process.cwd(), scopeId, { env: context.env ?? process.env }); } catch { return typed; }
  const match = matchIdPrefix(typed, ids);
  if (match.kind === 'ambiguous') requireIdPrefix(typed, ids);
  return match.kind === 'unique' ? match.id : typed;
}

/** The configured default scope of this installation (`terminal.scopeId`, the one `/config` sets); reads only may use it. */
export async function configuredScope(root: string, options: ConfigLoadOptions): Promise<string | undefined> {
  return ((await loadConfig(root, options)).terminal as { scopeId?: string } | undefined)?.scopeId;
}

/**
 * The scope rule for this family (CLI review "Scope"): typed `--scope`; for a read, else the configured default (named in the output); a change
 * never takes a silent default — a person on a terminal picks (default preselected), anyone else gets CLI_SCOPE_REQUIRED with the valid scopes.
 */
export async function familyScope(context: RunCommandContext, input: Readonly<{ command: string; locale: Locale; explicit?: string | undefined; mutating: boolean;
  interactive: boolean; ask?: RunCardAsk }>): Promise<ScopeResolution | null> {
  if (input.explicit) return { scopeId: input.explicit, source: 'flag' };
  const root = context.root ?? process.cwd(), options = { env: context.env ?? process.env };
  return resolveCommandScope({ command: input.command, locale: input.locale, explicit: input.explicit, configured: await configuredScope(root, options), mutating: input.mutating,
    interactive: input.interactive, listScopes: scopeLister(context, root, options), ...(input.ask ? { pick: input.ask } : {}) });
}
/** The scope line a human view starts with when the scope was not typed (the person always sees which scope answered). */
export const scopeLine = (scope: ScopeResolution, locale: Locale): string[] => scope.source === 'flag' ? [] : [scopeNotice(scope, locale)];

/**
 * The scope's Runs as the terminal's `/runs` window reads them: the same id query (`listRunIds`), each Run read through the same inspect application,
 * then waiting Runs first and newest first (the id query is newest first). One query for both surfaces; a Run that is gone is skipped.
 */
export async function readScopeRuns(context: RunCommandContext, scopeId: string): Promise<readonly RunView[]> {
  if (!context.inspectRun) throw ErrorRegistry.createError('INVENTORY_UNAVAILABLE');
  const root = context.root ?? process.cwd(), options = { env: context.env ?? process.env }, inspect = context.inspectRun;
  const ids = await listRunIds(context, root, scopeId, options);
  const views = await mapBounded(ids, HOST_LIMITS_REGISTRY.observationConcurrency, async id => (await inspect(root, runQuerySchema.parse({ schemaVersion: 1, scopeId, runId: id }), options)).run);
  const order = new Map(ids.map((id, index) => [id, index]));
  return orderPendingFirst(views.filter((view): view is RunView => view !== null), { pending: runWaits, time: view => -(order.get(view.runId) ?? 0) });
}

/** The id a person sees: git-like short form of an opaque id, long enough to tell it from the others listed; any other id unchanged. */
export const shownId = (id: string, among: readonly string[] = []): string => displayId(id, among);

/** One Run row in a person's words: short id, state, accepted tasks, title. */
export function runRowLabel(run: RunView, ids: readonly string[], locale: Locale): string {
  return t('cli.run.pick.row', { id: shownId(run.runId, ids), state: runStateWord(run, locale), done: run.tasks.filter(task => task.phase === 'accepted').length,
    total: run.tasks.length, title: runTitle(run, locale) }, locale);
}

/** The person picks one of the given Runs on a card (waiting first, newest first); null when there is none or the person cancels. */
export async function pickRun(io: RunHumanIo, scopeId: string, runs: readonly RunView[], title: string): Promise<RunView | null> {
  if (!runs.length) { io.print(t('cli.run.list.empty', { scope: scopeId }, io.locale)); return null; }
  const ids = runs.map(run => run.runId);
  // The first Run (waiting first, then newest) is preselected: Enter takes it, ↑↓ move; nothing is changed by a pick itself.
  const chosen = await io.ask({ title, options: runs.map(run => ({ id: run.runId, label: runRowLabel(run, ids, io.locale) })), initial: runs[0]!.runId });
  return runs.find(run => run.runId === chosen) ?? null;
}
