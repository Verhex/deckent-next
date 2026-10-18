import type { RunView } from '#engine/index.js';
import { shortId } from '#platform/index.js';
import { DecisionCard, approvalTemplateLine, projectApprovalDecisionText, type ApprovalDecisionLabels } from '#surfaces/core/approval-presentation/index.js';
import { fillTemplate, type RunControlAction, type WorklineLedgerPorts } from '#surfaces/core/terminal-ledger/index.js';
import { useHumanTextSecrets } from '#surfaces/core/terminal-render/index.js';
import { runStateText, runTitle } from './job-windows.js';
import type { LocalExecution, WorklinePanel } from './workline-panel.js';
import type { WorkSurfaceLabels } from './workline-actions.js';

/**
 * Y1 (owner 2026-10-14): the Runs window's control keys. `h` holds, `r` resumes and `c` closes a parked Run, each only after its own y/N card;
 * the decision goes through the ledger port to `deckent run hold|resume|close`'s application, which authorizes and checks the Run's state.
 */
export interface RunControlLabels {
  /** The key words the Runs window adds for the selected Run (only the keys its state offers). */
  readonly keyHold: string; readonly keyResume: string; readonly keyClose: string;
  /** Card titles (`{run}` short id), the action's consequence, the Run's state line and the full identity. */
  readonly holdTitle: string; readonly resumeTitle: string; readonly closeTitle: string;
  readonly holdDetail: string; readonly resumeDetail: string; readonly closeDetail: string;
  readonly state: string; readonly identity: string;
  readonly prompt: string; readonly holdPrompt: string; readonly pending: string;
  /** `{run}`: the card was answered no (or closed); nothing was sent. `{run}`: the Run is no longer there. */
  readonly kept: string; readonly gone: string;
  readonly reason: Readonly<{ label: string; hint: string; empty: string }>;
}
export type RunControlPresentation = Readonly<{ kind: 'run-control'; run: RunView; action: RunControlAction }>;
/** K7 needs-input: the answer card's words; the answer is typed in the card's reason field (Tab) and sent only with `y`. */
export interface RunAnswerLabels {
  readonly title: string; readonly question: string; readonly detail: string; readonly prompt: string;
  readonly reason: Readonly<{ label: string; hint: string; empty: string }>;
  /** `{run}`: `y` with no answer written (nothing sent); `{run}`: the Run no longer waits for an answer (nothing sent). */
  readonly empty: string; readonly none: string;
}
export type RunAnswerPresentation = Readonly<{ kind: 'run-answer'; run: RunView; question: string }>;

/** The question a needs-input task asks, or null (K7: `a` answers it). */
export function needsInputTask(run: RunView): Readonly<{ taskId: string; question: string }> | null {
  for (const task of run.tasks ?? []) if (task.decision?.reason === 'needs-input' && task.decision.question) return { taskId: task.id, question: task.decision.question };
  return null;
}
/**
 * The keys a Run's observed state offers (display only: the service re-checks state and policy at the confirmed revision). Hold: a Run
 * that is not finished, not cancelling and not already held; close: a parked Run; resume: a Run parked by an operator hold (its own park or,
 * MCP-AI-AKTOR, an `operatorHold` overlay kept over another park — resume removes the overlay and the original reason stays) or a failed
 * progression — the only parks resume lifts (a question, a decision or a quota wait survives resume, so it is not offered there).
 */
export function runControlActions(run: RunView): readonly RunControlAction[] {
  if (run.state.kind === 'terminal' || run.cancellationRequested) return [];
  if (run.state.kind !== 'parked') return ['hold'];
  const held = run.state.reason === 'operator-hold' || run.state.operatorHold !== undefined;
  return [...(held ? [] : ['hold' as const]), ...(held || run.state.reason === 'progression-failed' ? ['resume' as const] : []), 'close'];
}
/** The y/N card of one Run control: what it does, the Run's observed state and revision, and its identity. Hold also takes a reason (Tab). */
export function RunControlDecisionCard({ value, work, labels, pending, onDecide }: { readonly value: RunControlPresentation; readonly work: WorkSurfaceLabels; readonly labels: ApprovalDecisionLabels;
  readonly pending: boolean; readonly onDecide: (yes: boolean, reason?: string) => void }) {
  const known = useHumanTextSecrets(), p = (text: string) => projectApprovalDecisionText(text, known), words = work.runControl!, jobs = work.jobs!, { run, action } = value;
  const title = action === 'hold' ? words.holdTitle : action === 'resume' ? words.resumeTitle : words.closeTitle;
  const detail = action === 'hold' ? words.holdDetail : action === 'resume' ? words.resumeDetail : words.closeDetail;
  return <DecisionCard title={approvalTemplateLine(title, { run: p(shortId(run.runId)), title: p(runTitle(run, jobs)) })}
    projectedLines={[approvalTemplateLine(detail, {}), approvalTemplateLine(words.state, { state: runStateText(run, jobs), revision: String(run.revision) }),
      approvalTemplateLine(words.identity, { run: p(run.runId) })]}
    decisionLabels={labels} prompt={action === 'hold' ? words.holdPrompt : words.prompt} pendingText={words.pending} position={work.window.position} pending={pending}
    {...(action === 'hold' ? { reason: words.reason } : {})} onDecide={(yes, _standing, reason) => onDecide(yes, reason)} />;
}

/**
 * One Run control from the Runs window (`h`/`r`/`c` on a row): the Run is read again (its revision is what the card shows and what the
 * command carries), the card asks, and only `y` sends the control. Returns the line for the transcript: the result, the typed refusal, or
 * that nothing was sent.
 */
export async function runControlAction(panel: WorklinePanel, execution: LocalExecution, ledger: WorklineLedgerPorts, work: WorkSurfaceLabels, runId: string, action: RunControlAction,
  errorText: (error: unknown) => string, reason: () => string | undefined): Promise<string | null> {
  const words = work.runControl!, fresh = await ledger.inspectRun(runId);
  if (execution.signal.aborted) return null;
  if (!fresh) return fillTemplate(words.gone, { run: shortId(runId) });
  const answer = await panel.pick(execution, { kind: 'run-control', run: fresh, action }, ['allow', 'deny']);
  if (execution.signal.aborted) return null;
  if (answer !== 'allow') return fillTemplate(words.kept, { run: shortId(fresh.runId) });
  try { return await ledger.controlRun!(fresh.runId, action, fresh.revision, action === 'hold' ? reason() : undefined); }
  catch (error) { return errorText(error); }
}

/** The needs-input answer card: the worker's question, what the answer does, the Run's state and identity; Tab writes the answer, `y` sends it. */
export function RunAnswerDecisionCard({ value, work, labels, pending, onDecide }: { readonly value: RunAnswerPresentation; readonly work: WorkSurfaceLabels; readonly labels: ApprovalDecisionLabels;
  readonly pending: boolean; readonly onDecide: (yes: boolean, answer?: string) => void }) {
  const known = useHumanTextSecrets(), p = (text: string) => projectApprovalDecisionText(text, known), words = work.runAnswer!, control = work.runControl!, jobs = work.jobs!, { run } = value;
  return <DecisionCard title={approvalTemplateLine(words.title, { run: p(shortId(run.runId)), title: p(runTitle(run, jobs)) })}
    projectedLines={[approvalTemplateLine(words.question, { question: p(value.question) }), approvalTemplateLine(words.detail, {}),
      approvalTemplateLine(control.state, { state: runStateText(run, jobs), revision: String(run.revision) }), approvalTemplateLine(control.identity, { run: p(run.runId) })]}
    decisionLabels={labels} prompt={words.prompt} pendingText={control.pending} position={work.window.position} pending={pending} reason={words.reason}
    onDecide={(yes, _standing, answer) => onDecide(yes, answer)} />;
}

/**
 * K7 needs-input from the Runs window (`a` on a row): the Run is read again (its revision and the waiting task's question are what the card
 * shows and what the command carries), the card asks, and only `y` with an answer written sends it. Returns the transcript line.
 */
export async function runAnswerAction(panel: WorklinePanel, execution: LocalExecution, ledger: WorklineLedgerPorts, work: WorkSurfaceLabels, runId: string,
  errorText: (error: unknown) => string, answer: () => string | undefined): Promise<string | null> {
  const words = work.runAnswer!, fresh = await ledger.inspectRun(runId);
  if (execution.signal.aborted) return null;
  const waiting = fresh ? needsInputTask(fresh) : null;
  if (!fresh || !waiting) return fillTemplate(words.none, { run: shortId(runId) });
  const decision = await panel.pick(execution, { kind: 'run-answer', run: fresh, question: waiting.question }, ['allow', 'deny']);
  if (execution.signal.aborted) return null;
  if (decision !== 'allow') return fillTemplate(work.runControl!.kept, { run: shortId(fresh.runId) });
  const text = answer()?.trim();
  if (!text) return fillTemplate(words.empty, { run: shortId(fresh.runId) });
  try { return await ledger.answerTask!(fresh.runId, waiting.taskId, text, fresh.revision); }
  catch (error) { return errorText(error); }
}
