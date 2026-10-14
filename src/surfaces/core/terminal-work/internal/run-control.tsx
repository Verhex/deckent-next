import { useState } from 'react';
import type { RunView } from '#engine/index.js';
import { shortId } from '#platform/index.js';
import { DecisionCard, approvalTemplateLine, projectApprovalDecisionText, type ApprovalDecisionLabels } from '#surfaces/core/approval-presentation/index.js';
import { fillTemplate, loadRunViewsForWatch, type RunControlAction, type WorklineLedgerPorts } from '#surfaces/core/terminal-ledger/index.js';
import { projectHumanPickerText, span, useHumanTextSecrets, type Span } from '#surfaces/core/terminal-render/index.js';
import { Window, type WindowLine } from '#surfaces/core/terminal-window/index.js';
import { runStateText, runTitle } from './job-windows.js';
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
}
export type RunsWindowPresentation = Readonly<{ kind: 'runs-window'; title: string; rows: readonly Readonly<{ spans: readonly Span[]; actions: readonly RunControlAction[] }>[]; status: string;
  empty: string; selected: number }>;
export type RunControlPresentation = Readonly<{ kind: 'run-control'; run: RunView; action: RunControlAction }>;

const KEYS: Readonly<Record<string, RunControlAction>> = Object.freeze({ h: 'hold', r: 'resume', c: 'close' });
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
/** One typed letter selects a key; Ctrl/Alt chords, pasted or coalesced text never do (the decision-key rule for an opening key). */
export function runControlKey(input: string, key: Readonly<{ ctrl?: boolean; meta?: boolean }>): RunControlAction | null {
  return key.ctrl || key.meta || input.length !== 1 ? null : KEYS[input] ?? null;
}
function runsHints(labels: RunControlLabels, actions: readonly RunControlAction[]): string {
  const words = actions.map(action => action === 'hold' ? labels.keyHold : action === 'resume' ? labels.keyResume : labels.keyClose);
  return [labels.hints, ...(words.length ? words : [labels.noKeys])].join(' · ');
}

/** The Runs list with a selection; `h`/`r`/`c` answer `<action>:<row>` when the selected row offers it, Esc closes (`null`). */
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
    const rows = runs.map(run => ({ actions: runControlActions(run), spans: [span(runTitle(run, jobs), { bold: true }), span(` [${runStateText(run, jobs)}]`, { role: run.cancellationRequested ? 'warning' as const : 'accent' as const }),
      span(` · ${shortId(run.runId)}`, { role: 'muted' as const })] }));
    const choices = ['close', ...rows.flatMap((row, index) => row.actions.map(action => `${action}:${index}`))];
    const choice = await panel.pick(execution, { kind: 'runs-window', title, rows, status, empty: work.live!.empty, selected }, choices);
    if (choice === null || choice === 'close' || execution.signal.aborted) break;
    const [action, index] = choice.split(':') as [RunControlAction, string];
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
