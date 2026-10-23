import { randomUUID } from 'node:crypto';
import { ErrorRegistry, t, terminalSafeText, type Locale } from '#platform/index.js';
import { runLifecycleCommandSchema, runQuerySchema, type RunView } from '#engine/index.js';
import type { RunCommandContext } from './context.js';
import { familyScope, pickRun, readScopeRuns, resolveRunId, runStateWord, runTitle, shownId, type RunHumanIo } from './run-human.js';
import { renderRunCancellation } from './cancellation.js';
import REGISTRY from './run.json' with { type: 'json' };

export type RunControl = 'cancel' | 'hold' | 'resume' | 'close';

/**
 * The controls a Run's observed state offers — display only, the service re-checks state and policy at the confirmed revision. The same rule as
 * the terminal's `/runs` keys (`runControlActions` in terminal-work, not importable here: that barrel carries Ink and the CLI start must not reach
 * it; `cli-run-human.test.ts` keeps the two equal over every state) plus `/cancel`: cancel any Run that has not finished (again when a request
 * is already recorded: confirming retries delivery to its workers).
 */
export function runControls(run: RunView): readonly RunControl[] {
  if (run.state.kind === 'terminal') return [];
  if (run.cancellationRequested) return ['cancel'];
  if (run.state.kind !== 'parked') return ['cancel', 'hold'];
  const held = run.state.reason === 'operator-hold' || run.state.operatorHold !== undefined;
  return ['cancel', ...(held ? [] : ['hold' as const]), ...(held || run.state.reason === 'progression-failed' || run.state.reason === 'environment-not-ready' ? ['resume' as const] : []), 'close'];
}

/** The card of one control in the terminal's own words (`terminal.runControl.*`, `terminal.cancel.*`; the hold consequence names the CLI resume, not the window's `r` key): what it does, the scope, the Run's state at its revision, its identity. */
function controlCard(action: RunControl, run: RunView, scopeId: string, locale: Locale, extra: readonly string[]) {
  const params = { run: shownId(run.runId), title: runTitle(run, locale) };
  const title = action === 'cancel' ? t('terminal.cancel.title', params, locale) : action === 'hold' ? t('terminal.runControl.holdTitle', params, locale)
    : action === 'resume' ? t('terminal.runControl.resumeTitle', params, locale) : t('terminal.runControl.closeTitle', params, locale);
  const detail = action === 'cancel' ? t('cli.run.control.cancelDetail', {}, locale) : action === 'hold' ? t('cli.run.control.holdDetail', {}, locale)
    : action === 'resume' ? t('terminal.runControl.resumeDetail', {}, locale) : t('terminal.runControl.closeDetail', {}, locale);
  return { title, body: [detail, t('cli.run.control.scope', { scope: scopeId }, locale), t('terminal.runControl.state', { state: runStateWord(run, locale), revision: run.revision }, locale),
    ...(action === 'cancel' && run.cancellationRequested ? [t('terminal.cancel.alreadyRequested', {}, locale)] : []), ...extra,
    t('terminal.runControl.identity', { run: run.runId }, locale)].map(line => terminalSafeText(line)),
  options: [{ id: 'yes', label: t('cli.run.control.yes', {}, locale), key: 'y' }, { id: 'no', label: t('cli.run.control.no', {}, locale), key: 'n' }] };
}

/** What the person typed that the flow keeps: scope, Run (a short id resolves), hold reason, resume answer for one task. */
export type RunControlInput = Readonly<{ scopeId?: string | undefined; runId?: string | undefined; reason?: string | undefined; taskId?: string | undefined; answer?: string | undefined; quota?: 'wait' | 'next-candidate' | undefined }>;

/**
 * A Run control for a person on a terminal (CLI review §run, owner 10-08 "değerler yalnız seçimle"): the scope (a change never takes a silent
 * default: picked, the configured one preselected), the Run (picked among the Runs whose state offers the control), the revision read just before
 * the card, a card naming scope, Run and consequence, and a command id from the system. `n`, Esc or silence write nothing. A Run that changed
 * meanwhile is read again and asked again (bounded). The AI path keeps its typed flags (`--scope --id --command-id --expected-revision`).
 */
export async function runControlFlow(action: RunControl, context: RunCommandContext, io: RunHumanIo, input: RunControlInput): Promise<void> {
  const { locale, print } = io;
  const scope = await familyScope(context, { command: `deckent run ${action}`, locale, explicit: input.scopeId, mutating: true, interactive: true, ask: io.ask });
  if (!scope) { print(t('cli.run.control.nothing', {}, locale)); return; }
  const scopeId = scope.scopeId;
  let runId = input.runId ? await resolveRunId(context, scopeId, input.runId) : undefined;
  if (!runId) {
    // An answer goes to a Run that waits (the service checks which task asked); every other control to the Runs whose state offers it.
    const runs = (await readScopeRuns(context, scopeId)).filter(run => input.answer !== undefined || input.quota !== undefined ? run.state.kind === 'parked' : runControls(run).includes(action));
    if (!runs.length) { print(t('cli.run.control.none', { scope: scopeId, action }, locale)); return; }
    const picked = await pickRun(io, scopeId, runs, t('cli.run.control.pick', { scope: scopeId, action }, locale));
    if (!picked) { print(t('cli.run.control.nothing', {}, locale)); return; }
    runId = picked.runId;
  }
  if (!context.inspectRun || (action === 'cancel' ? !context.deliverRunCancellation : !context.applyRunLifecycle)) throw ErrorRegistry.createError('INVENTORY_UNAVAILABLE');
  const reason = input.reason?.trim() || t('terminal.runControl.reasonDefault', {}, locale);
  for (let round = 0; ; round++) {
    const run = (await context.inspectRun(io.root, runQuerySchema.parse({ schemaVersion: 1, scopeId, runId }), io.options)).run;
    if (!run) throw ErrorRegistry.createError('RUN_NOT_FOUND', { params: { run: runId } });
    const extra = [...(action === 'hold' ? [t('cli.run.control.reason', { reason }, locale)] : []),
      ...(input.quota !== undefined ? [t('quotaask.control.choice', { choice: input.quota === 'wait' ? t('quotaask.choice.wait', {}, locale) : t('quotaask.choice.next-candidate', {}, locale) }, locale)] : []),
      ...(input.answer !== undefined ? [t('cli.run.control.answer', { task: input.taskId ?? '-', answer: input.answer }, locale)] : []), ...(round ? [t('cli.run.control.reread', {}, locale)] : [])];
    const answer = await io.ask(controlCard(action, run, scopeId, locale, extra));
    if (answer !== 'yes') {
      print(action === 'cancel' ? t('terminal.cancel.kept', { run: shownId(run.runId) }, locale) : t('terminal.runControl.kept', { run: shownId(run.runId) }, locale));
      return;
    }
    const commandId = `cli-run-${action}-${randomUUID()}`;
    try {
      if (action === 'cancel') {
        const result = await context.deliverRunCancellation!(io.root, { schemaVersion: 1, commandId, scopeId, runId, action: 'cancel', expectedRevision: run.revision }, io.options);
        print(terminalSafeText(renderRunCancellation(result, commandId, scopeId, runId, locale)));
        return;
      }
      const command = runLifecycleCommandSchema.parse({ schemaVersion: 1, commandId, scopeId, runId, expectedRevision: run.revision,
        ...(action === 'hold' ? { action, holdReason: reason } : input.quota !== undefined ? { action: 'quota-answer', choice: input.quota } : input.answer !== undefined ? { action: 'answer', answer: input.answer, taskId: input.taskId } : { action }) });
      const after = (await context.applyRunLifecycle!(io.root, command, io.options))?.lifecycle.run;
      const params = { run: shownId(runId), command: commandId, revision: after?.revision ?? '—', state: after ? runStateWord(after, locale) : '—' };
      print(terminalSafeText(action === 'hold' ? t('terminal.runControl.result.hold', params, locale)
        : action === 'resume' ? t('terminal.runControl.result.resume', params, locale) : t('terminal.runControl.result.close', params, locale)));
      return;
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      if (typeof code !== 'string' || !REGISTRY.control.staleCodes.includes(code) || round >= REGISTRY.control.staleRetries) throw error;
      print(t('cli.run.control.stale', {}, locale));
    }
  }
}
