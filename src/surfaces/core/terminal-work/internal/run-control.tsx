import { useState } from 'react';
import type { RunView } from '#engine/index.js';
import { shortId } from '#platform/index.js';
import { DecisionCard, approvalTemplateLine, projectApprovalDecisionText, type ApprovalDecisionLabels } from '#surfaces/core/approval-presentation/index.js';
import { fillTemplate, loadRunViewsForWatch, type RunControlAction, type WorklineLedgerPorts } from '#surfaces/core/terminal-ledger/index.js';
import { projectHumanPickerText, span, useHumanTextSecrets, type Span } from '#surfaces/core/terminal-render/index.js';
import { Window, type WindowLine } from '#surfaces/core/terminal-window/index.js';
import { runStateText, runTitle } from './job-windows.js';
import RUN_CONTROL from './run-control.json' with { type: 'json' };
import type { LocalExecution, WorklinePanel } from './workline-panel.js';
import type { WorkSurfaceLabels } from './workline-actions.js';

/**
 * Y1 (owner 2026-10-14): the Runs window's control keys. `h` holds, `r` resumes and `c` closes a parked Run, each only after its own y/N card;
 * the decision goes through the ledger port to `deckent run hold|resume|close`'s application, which authorizes and checks the Run's state.
 */
export interface RunControlLabels {
  /** `↑↓ choose · Esc close` and the key words added for the selected Run (only the keys its state offers). */
  readonly hints: string; readonly keyHold: string; readonly keyResume: string; readonly keyClose: string; readonly noKeys: string;
  /** Card titles (`{run}` short id), the action's consequence, the Run's state line and the full identity. */
  readonly holdTitle: string; readonly resumeTitle: string; readonly closeTitle: string;
  readonly holdDetail: string; readonly resumeDetail: string; readonly closeDetail: string;
  readonly state: string; readonly identity: string;
  readonly prompt: string; readonly holdPrompt: string; readonly pending: string;
  /** `{run}`: the card was answered no (or closed); nothing was sent. `{run}`: the Run is no longer there. */
  readonly kept: string; readonly gone: string;
  readonly reason: Readonly<{ label: string; hint: string; empty: string }>;
  /** The key word added for a Run whose task waits with a question (only where `answerTask` and `RunAnswerLabels` are both present). */
  readonly keyAnswer?: string;
}
/** BR2 (K7 port, owner 2026-10-23 Q1): the needs-input answer card's words; the answer is typed in the card's reason field (Tab) and sent only with `y`. */
export interface RunAnswerLabels {
  readonly title: string; readonly question: string; readonly detail: string; readonly prompt: string;
  readonly reason: Readonly<{ label: string; hint: string; empty: string }>;
  /** `{run}`: `y` with no answer written (nothing sent); `{run}`: the Run no longer waits for an answer (nothing sent); the stale reread note shown on the card. */
  readonly empty: string; readonly none: string; readonly reread: string;
}
/** A row key of the Runs window: the three Y1 controls and the answer to a worker's question. */
export type RunRowAction = RunControlAction | 'answer';
export type RunsWindowPresentation = Readonly<{ kind: 'runs-window'; title: string; rows: readonly Readonly<{ spans: readonly Span[]; actions: readonly RunRowAction[] }>[]; status: string;
  empty: string; selected: number }>;
export type RunControlPresentation = Readonly<{ kind: 'run-control'; run: RunView; action: RunControlAction }>;
export type RunAnswerPresentation = Readonly<{ kind: 'run-answer'; run: RunView; question: string; reread?: string }>;

const KEYS: Readonly<Record<string, RunRowAction>> = Object.freeze({ h: 'hold', r: 'resume', c: 'close', a: 'answer' });
/** The question a needs-input task asks, or null (`a` answers it). */
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
  return [...(held ? [] : ['hold' as const]), ...(held || run.state.reason === 'progression-failed' || run.state.reason === 'environment-not-ready' ? ['resume' as const] : []), 'close'];
}
/** One typed letter selects a key; Ctrl/Alt chords, pasted or coalesced text never do (the decision-key rule for an opening key). */
export function runControlKey(input: string, key: Readonly<{ ctrl?: boolean; meta?: boolean }>): RunRowAction | null {
  return key.ctrl || key.meta || input.length !== 1 ? null : KEYS[input] ?? null;
}
function runsHints(labels: RunControlLabels, actions: readonly RunRowAction[]): string {
  const words = actions.map(action => action === 'hold' ? labels.keyHold : action === 'resume' ? labels.keyResume : action === 'answer' ? labels.keyAnswer ?? '' : labels.keyClose).filter(Boolean);
  return [labels.hints, ...(words.length ? words : [labels.noKeys])].join(' · ');
}

/** The Runs list with a selection; `h`/`r`/`c`/`a` answer `<action>:<row>` when the selected row offers it, Esc closes (`null`). */
export function RunsControlWindow({ value, labels, position, onAnswer }: { readonly value: RunsWindowPresentation; readonly labels: RunControlLabels; readonly position: string;
  readonly onAnswer: (choice: string | null) => void }) {
  const known = useHumanTextSecrets(), [selected, setSelected] = useState(() => Math.min(value.selected, Math.max(0, value.rows.length - 1)));
  const project = (spans: readonly Span[]) => spans.flatMap(item => projectHumanPickerText(item.text, known).spans.map(part => ({ ...item, ...part })));
  const count = value.rows.length, row = value.rows[Math.min(selected, Math.max(0, count - 1))];
  // The last result (or typed refusal, possibly several lines) stays above the list until the next key's result replaces it.
  const notes: WindowLine[] = value.status ? [...value.status.split('\n').map(text => ({ spans: project([span(text, { role: 'accent' })]) })), { spans: [] }] : [];
  const body: WindowLine[] = [...notes, ...value.rows.map((item, index) => ({ spans: [span(index === selected ? '› ' : '  ', index === selected ? { role: 'accent', bold: true } : {}), ...project(item.spans)] })),
    ...(count ? [] : [{ spans: [span(value.empty, { role: 'muted' })] }])];
  return <Window title={[span(value.title)]} status={[span(String(count))]} body={body} hints={runsHints(labels, row?.actions ?? [])} position={position} reveal={notes.length + selected}
    onClose={() => onAnswer(null)} onInput={(input, key) => {
      if ((key.upArrow || key.downArrow) && !key.ctrl && !key.meta && count) { setSelected(current => (current + (key.upArrow ? count - 1 : 1)) % count); return true; }
      const action = runControlKey(input, key);
      if (action && row?.actions.includes(action)) { onAnswer(`${action}:${selected}`); return true; }
      return false;
    }} />;
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

/** The answer card: the worker's question, what the answer does, the Run's state and identity; Tab writes the answer, `y` sends it. */
export function RunAnswerDecisionCard({ value, work, labels, pending, onDecide }: { readonly value: RunAnswerPresentation; readonly work: WorkSurfaceLabels; readonly labels: ApprovalDecisionLabels;
  readonly pending: boolean; readonly onDecide: (yes: boolean, answer?: string) => void }) {
  const known = useHumanTextSecrets(), p = (text: string) => projectApprovalDecisionText(text, known), words = work.runAnswer!, control = work.runControl!, jobs = work.jobs!, { run } = value;
  return <DecisionCard title={approvalTemplateLine(words.title, { run: p(shortId(run.runId)), title: p(runTitle(run, jobs)) })}
    projectedLines={[approvalTemplateLine(words.question, { question: p(value.question) }), approvalTemplateLine(words.detail, {}),
      approvalTemplateLine(control.state, { state: runStateText(run, jobs), revision: String(run.revision) }), approvalTemplateLine(control.identity, { run: p(run.runId) }),
      ...(value.reread ? [approvalTemplateLine(value.reread, {})] : [])]}
    decisionLabels={labels} prompt={words.prompt} pendingText={control.pending} position={work.window.position} pending={pending} reason={words.reason}
    onDecide={(yes, _standing, answer) => onDecide(yes, answer)} />;
}

/**
 * The answer to a worker's question from the Runs window (`a` on a row): the Run is read again (its revision and the waiting task's question are
 * what the card shows and what the command carries), the card asks, and only `y` with an answer written sends it. A Run changed by another writer
 * meanwhile (a stale code from the registry) is read again and asked again, bounded by the registry's retries; any other refusal is the typed line.
 * `null`: the window was aborted.
 */
async function runAnswerFlow(panel: WorklinePanel, execution: LocalExecution, ledger: WorklineLedgerPorts, work: WorkSurfaceLabels, runId: string,
  errorText: (error: unknown) => string, answer: () => string | undefined): Promise<string | null> {
  const words = work.runAnswer!;
  for (let round = 0; ; round++) {
    const fresh = await ledger.inspectRun(runId);
    if (execution.signal.aborted) return null;
    const waiting = fresh ? needsInputTask(fresh) : null;
    if (!fresh || !waiting) return fillTemplate(words.none, { run: shortId(runId) });
    const decision = await panel.pick(execution, { kind: 'run-answer', run: fresh, question: waiting.question, ...(round ? { reread: words.reread } : {}) }, ['allow', 'deny']);
    if (execution.signal.aborted) return null;
    if (decision !== 'allow') return fillTemplate(work.runControl!.kept, { run: shortId(fresh.runId) });
    const text = answer()?.trim();
    if (!text) return fillTemplate(words.empty, { run: shortId(fresh.runId) });
    try { return await ledger.answerTask!(fresh.runId, waiting.taskId, text, fresh.revision); }
    catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      if (typeof code !== 'string' || !RUN_CONTROL.staleCodes.includes(code) || round >= RUN_CONTROL.staleRetries) return errorText(error);
    }
  }
}

/**
 * `/runs` with control keys: the list is read fresh each time it opens; a key re-reads the chosen Run (its revision is what the card shows
 * and what the command carries) and opens the card; `y` sends the control, anything else keeps the Run. The list then reopens with the
 * result as its status, until Esc. Returns the transcript summary: every result, or the window's closed line.
 */
export async function runRunsControl(panel: WorklinePanel, execution: LocalExecution, ledger: WorklineLedgerPorts, work: WorkSurfaceLabels,
  errorText: (error: unknown) => string, reason: () => string | undefined): Promise<string> {
  const words = work.runControl!, jobs = work.jobs!, title = work.live!.runsTitle, results: string[] = [];
  let status = '', selected = 0;
  while (!execution.signal.aborted) {
    const runs = await loadRunViewsForWatch(ledger);
    if (execution.signal.aborted) break;
    const answerable = Boolean(ledger.answerTask && work.runAnswer && words.keyAnswer);
    const rows = runs.map(run => ({ actions: [...runControlActions(run), ...(answerable && needsInputTask(run) ? ['answer' as const] : [])], spans: [span(runTitle(run, jobs), { bold: true }), span(` [${runStateText(run, jobs)}]`, { role: run.cancellationRequested ? 'warning' as const : 'accent' as const }),
      span(` · ${shortId(run.runId)}`, { role: 'muted' as const })] }));
    const choices = ['close', ...rows.flatMap((row, index) => row.actions.map(action => `${action}:${index}`))];
    const choice = await panel.pick(execution, { kind: 'runs-window', title, rows, status, empty: work.live!.empty, selected }, choices);
    if (choice === null || choice === 'close' || execution.signal.aborted) break;
    const [action, index] = choice.split(':') as [RunRowAction, string];
    if (action === 'answer') {
      const chosen = runs[Number(index)]!; selected = Number(index);
      const line = await runAnswerFlow(panel, execution, ledger, work, chosen.runId, errorText, reason).catch((error: unknown) => errorText(error));
      if (line === null || execution.signal.aborted) break;
      status = line; results.push(status); continue;
    }
    const chosen = runs[Number(index)]!, fresh = await ledger.inspectRun(chosen.runId); selected = Number(index);
    if (execution.signal.aborted) break;
    if (!fresh) { status = fillTemplate(words.gone, { run: shortId(chosen.runId) }); results.push(status); continue; }
    const answer = await panel.pick(execution, { kind: 'run-control', run: fresh, action }, ['allow', 'deny']);
    if (execution.signal.aborted) break;
    if (answer !== 'allow') status = fillTemplate(words.kept, { run: shortId(fresh.runId) });
    else {
      try { status = await ledger.controlRun!(fresh.runId, action, fresh.revision, action === 'hold' ? reason() : undefined); }
      catch (error) { status = errorText(error); }
    }
    results.push(status);
  }
  return results.length ? results.join(' · ') : fillTemplate(jobs.closed, { title });
}
