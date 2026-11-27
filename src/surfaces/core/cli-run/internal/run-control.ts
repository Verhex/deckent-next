import { openTaskQuestion, runControlActions } from '#surfaces/core/terminal-ledger/index.js';
import { randomUUID } from 'node:crypto';
import { sameAttemptIdentity, type AttemptIdentity } from '#domain/index.js';
import { ErrorRegistry, EXIT_CODES, t, terminalSafeText, type ExitCode, type Locale } from '#platform/index.js';
import { runLifecycleCommandSchema, runQuerySchema, type RunView } from '#engine/index.js';
import type { RunCommandContext } from './context.js';
import { familyScope, pickRun, readScopeRuns, resolveRunId, runStateWord, runTitle, shownId, type RunHumanIo } from './run-human.js';
import { runHoldReasonText } from '#surfaces/core/recovery-text/index.js';
import { renderRunCancellation, runCancellationExitCode } from './cancellation.js';
import REGISTRY from './run.json' with { type: 'json' };

export type RunControl = 'cancel' | 'hold' | 'resume' | 'close';

/** Cancel remains available until terminal, including repeated delivery to workers. */
export function runControls(run: RunView): readonly RunControl[] {
  return run.state.kind === 'terminal' ? [] : ['cancel', ...runControlActions(run)];
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
  options: [{ id: 'yes', label: t('cli.run.control.yes', {}, locale), role: 'yes' as const }, { id: 'no', label: t('cli.run.control.no', {}, locale), role: 'no' as const }] };
}

/** What the person typed that the flow keeps: scope, Run (a short id resolves), hold reason, resume answer for one task. */
export type RunControlInput = Readonly<{ scopeId?: string | undefined; runId?: string | undefined; reason?: string | undefined; taskId?: string | undefined; answer?: string | undefined; quota?: 'wait' | 'next-candidate' | undefined }>;

type TaskQuestion = Readonly<{ text: string; source: AttemptIdentity }>;

function readTaskQuestion(run: RunView, taskId: string | undefined, source: AttemptIdentity | undefined): TaskQuestion | undefined {
  if (taskId === undefined || !source) return undefined;
  const open = openTaskQuestion(run, taskId);
  return open ? { text: open.question, source } : undefined;
}

/**
 * A Run control for a person on a terminal (CLI review §run, owner 10-08 "değerler yalnız seçimle"): the scope (a change never takes a silent
 * default: picked, the configured one preselected), the Run (picked among the Runs whose state offers the control), the revision read just before
 * the card, a card naming scope, Run and consequence, and a command id from the system. `n`, Esc or silence write no control (a binding repair
 * the CLI entry made for this call before the card stays, owner 2026-11-27). A Run that changed
 * meanwhile is read again and asked again if the action remains available and a task answer still matches its original question (bounded).
 * The AI path keeps its typed flags (`--scope --id --command-id --expected-revision`).
 */
export async function runControlFlow(action: RunControl, context: RunCommandContext, io: RunHumanIo, input: RunControlInput): Promise<ExitCode> {
  const { locale, print } = io;
  const scope = await familyScope(context, { command: `deckent run ${action}`, locale, explicit: input.scopeId, mutating: true, interactive: true, ask: io.ask });
  if (!scope) { print(t('cli.run.control.nothing', {}, locale)); return EXIT_CODES.error; }
  const scopeId = scope.scopeId;
  const answerTaskId = input.answer === undefined ? undefined : input.taskId;
  const answering = input.answer !== undefined || input.quota !== undefined;
  const eligible = (run: RunView, question?: TaskQuestion) => input.quota !== undefined
    ? !run.cancellationRequested && run.state.kind === 'parked' && run.state.reason === 'quota-ask' && (run.quotaWaits?.length ?? 0) > 0
    : answering ? question !== undefined : runControls(run).includes(action);
  let originalQuestion: TaskQuestion | undefined;
  let runId = input.runId ? await resolveRunId(context, scopeId, input.runId) : undefined;
  if (!runId) {
    const sources = new Map<string, AttemptIdentity>();
    const runs = await readScopeRuns(context, scopeId, ({ run, answerSource }) => {
      if (run && answerSource) sources.set(run.runId, answerSource);
    }, answerTaskId);
    const choices = runs.flatMap(run => {
      const question = readTaskQuestion(run, answerTaskId, sources.get(run.runId));
      return eligible(run, question) ? [{ run, question }] : [];
    });
    if (!choices.length) { print(t('cli.run.control.none', { scope: scopeId, action }, locale)); return EXIT_CODES.error; }
    const picked = await pickRun(io, scopeId, choices.map(choice => choice.run), t('cli.run.control.pick', { scope: scopeId, action }, locale));
    if (!picked) { print(t('cli.run.control.nothing', {}, locale)); return EXIT_CODES.error; }
    runId = picked.runId;
    originalQuestion = choices.find(choice => choice.run === picked)?.question;
  }
  const bound = action === 'hold' || action === 'resume' && !answering;
  const inspect = (bound ? context.inspectRunControl : undefined) ?? context.inspectRun;
  if (!inspect || (action === 'cancel' ? !context.deliverRunCancellation : !context.applyRunLifecycle)) throw ErrorRegistry.createError('INVENTORY_UNAVAILABLE');
  const reason = input.reason?.trim() || t('terminal.runControl.reasonDefault', {}, locale);
  for (let round = 0; ; round++) {
    const { run, answerSource, controlBinding } = await inspect(io.root, runQuerySchema.parse({ schemaVersion: 1, scopeId, runId }), io.options, answerTaskId);
    if (!run) throw ErrorRegistry.createError('RUN_NOT_FOUND', { params: { run: runId } });
    if (bound && context.repairedRunControlBinding !== undefined && controlBinding !== context.repairedRunControlBinding) throw ErrorRegistry.createError('RUN_CONTROL_BINDING_CHANGED');
    const question = readTaskQuestion(run, answerTaskId, answerSource);
    if (!eligible(run, question)) {
      const id = shownId(run.runId);
      print(terminalSafeText(answering ? t('cli.run.control.questionUnavailable', { run: id }, locale)
        : t('run.control.noActionInState', { run: id, state: runStateWord(run, locale) }, locale)));
      return EXIT_CODES.error;
    }
    if (question && originalQuestion && (question.text !== originalQuestion.text || !sameAttemptIdentity(question.source, originalQuestion.source))) {
      print(terminalSafeText(t('cli.run.control.questionChanged', { task: question.source.taskId }, locale)));
      return EXIT_CODES.error;
    }
    originalQuestion ??= question;
    // S6R-6: a held Run's card says why it is held, in words (a system hold's catalog text, never its raw code).
    const held = action === 'hold' ? null : runHoldReasonText(run.state, locale);
    const extra = [...(action === 'hold' ? [t('cli.run.control.reason', { reason }, locale)] : []), ...(held ? [t('recovery.hold.cardReason', { reason: held }, locale)] : []),
      ...(input.quota !== undefined ? [t('quotaask.control.choice', { choice: input.quota === 'wait' ? t('quotaask.choice.wait', {}, locale) : t('quotaask.choice.next-candidate', {}, locale) }, locale)] : []),
      ...(input.answer !== undefined ? [t('cli.run.control.answer', { task: input.taskId ?? '-', answer: input.answer }, locale)] : []), ...(round ? [t('cli.run.control.reread', {}, locale)] : [])];
    const answer = await io.ask(controlCard(action, run, scopeId, locale, extra));
    if (answer !== 'yes') {
      print(action === 'cancel' ? t('terminal.cancel.kept', { run: shownId(run.runId) }, locale) : t('terminal.runControl.kept', { run: shownId(run.runId) }, locale));
      return EXIT_CODES.error;
    }
    const commandId = `cli-run-${action}-${randomUUID()}`;
    try {
      if (action === 'cancel') {
        const result = await context.deliverRunCancellation!(io.root, { schemaVersion: 1, commandId, scopeId, runId, action: 'cancel', expectedRevision: run.revision }, io.options);
        print(terminalSafeText(renderRunCancellation(result, commandId, scopeId, runId, locale)));
        return runCancellationExitCode(result);
      }
      const command = runLifecycleCommandSchema.parse({ schemaVersion: 1, commandId, scopeId, runId, expectedRevision: run.revision,
        ...(action === 'hold' ? { action, holdReason: reason } : input.quota !== undefined ? { action: 'quota-answer', choice: input.quota } : input.answer !== undefined ? { action: 'answer', answer: input.answer, taskId: input.taskId } : { action }) });
      const after = (await context.applyRunLifecycle!(io.root, command, io.options, ...(bound && controlBinding !== undefined ? [controlBinding] : [])))?.lifecycle.run;
      const params = { run: shownId(runId), command: commandId, revision: after?.revision ?? '—', state: after ? runStateWord(after, locale) : '—' };
      print(terminalSafeText(action === 'hold' ? t('terminal.runControl.result.hold', params, locale)
        : action === 'resume' ? t('terminal.runControl.result.resume', params, locale) : t('terminal.runControl.result.close', params, locale)));
      return after ? EXIT_CODES.success : EXIT_CODES.error;
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      if (typeof code !== 'string' || !REGISTRY.control.staleCodes.includes(code) || round >= REGISTRY.control.staleRetries) throw error;
      print(t('cli.run.control.stale', {}, locale));
    }
  }
}
