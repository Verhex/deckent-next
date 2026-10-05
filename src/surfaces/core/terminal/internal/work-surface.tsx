import { standingAnswerNotice, clearStandingNotice } from '#surfaces/core/approval-presentation/index.js';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { RunView } from '#engine/index.js';
import type { WorkLedgerEntry, WorkLedgerWorkerEntry } from './work-ledger.js';
import type { WorklineLedgerPorts } from './workline-ledger.js';
import { notice, type WorklineActionLabels, type WorkSurfaceLabels } from './workline-actions.js';
import { APPROVAL_SCAN_MAX_PAGES, EMPTY_APPROVAL_WATCH, approvalWatchStep, scanPendingApprovals, type WorklineApproval } from './approval-watch.js';
import type { WorklinePanel, LocalExecution } from './workline-panel.js';
import type { PanelSnapshot, TerminalLocalContext, StandingScope } from '#surfaces/core/terminal-kit/index.js';
import { fillTemplate } from './worker-line.js';
import { WorkerPanel } from './worker-panel.js';
import type { ApprovalDecisionLabels } from '#surfaces/core/approval-presentation/index.js';
import { ApprovalDecisionCard, ApprovalDecisionPicker, approvalRowPresentation, approvalCardPresentation, approvalDecisionCardLines, CancellationDecisionCard, cancellationCardPresentation } from './approval-decision-view.js';
import { makeApprovalNotFoundNotice, makeApprovalRowNotice } from './approval-decision-notice.js';
import { plainText } from '#surfaces/core/terminal-render/index.js';
import { useSingleFlightPoll } from '#surfaces/core/terminal-kit/index.js';
export interface WorkSurfaceInput {
  readonly panel: WorklinePanel;
  readonly state: PanelSnapshot<TerminalLocalContext>;
  readonly ledger: WorklineLedgerPorts | undefined;
  readonly labels: WorklineActionLabels & { readonly render?: ApprovalDecisionLabels };
  readonly push: (entries: readonly WorkLedgerEntry[]) => void;
  readonly errorText: (error: unknown) => string;
  /** The worker heartbeat; the approval notification poll never runs faster. */
  readonly pollMs: number;
  /** The live panel shows only while the worker watch runs; it is cleared when the watch stops. */
  readonly watchingWorkers: boolean;
  /** Approval notification cadence; defaults to max(pollMs, APPROVAL_NOTIFY_MIN_MS). */
  readonly approvalPollMs?: number;
}
/** A tool call of the running turn waiting for the owner (T-L4): its preview is shown; the decision goes through `decideApproval`. */
export type TurnApprovalRequest = Readonly<{ approvalId: string; revision: number; summary: string; preview: string; expiresAt: number;
  /** The scopes the service offers beyond "this once" and exactly what they cover (absent: the plain y/N card). */
  standing?: Readonly<{ scopes: readonly StandingScope[]; pattern: string }>; decisionCapability?: string; risk?: string | null; requiredAssurance?: string }>; // v19 (B1)
/**
 * Worker live panel, approval notifications and the y/N cards for approvals and run cancellation. Every decision goes
 * through a runtime port; the view never decides, remembers or auto-approves anything. Read-only commands never prompt.
 */
export const APPROVAL_NOTIFY_MIN_MS = 10_000;
export function useWorkSurface({ panel, state, ledger, labels, push, errorText, pollMs, watchingWorkers, approvalPollMs }: WorkSurfaceInput) {
  const work = labels.work;
  const [workers, setWorkers] = useState<readonly WorkLedgerWorkerEntry[]>([]);
  const presentation = panel.presentation(state);
  const modal = presentation?.kind === 'approval' || presentation?.kind === 'cancel' ? presentation : null;
  const picker = presentation?.kind === 'approvals' && state.picker ? presentation.rows : null;
  const approvalWatch = useRef(EMPTY_APPROVAL_WATCH);
  useEffect(() => { if (!watchingWorkers) setWorkers([]); }, [watchingWorkers]);
  const observeWorkers = useCallback((entries: readonly WorkLedgerEntry[]) => { setWorkers(entries.filter((entry): entry is WorkLedgerWorkerEntry => entry.kind === 'worker')); }, []);
  // Default on whenever approvals are wired (legacy kept approvals behind an off-by-default flag): one bounded page per tick,
  // never more often than APPROVAL_NOTIFY_MIN_MS so an idle terminal adds negligible runtime load (lead integration decision).
  useSingleFlightPoll(Boolean(work && ledger?.listApprovalPage), approvalPollMs ?? Math.max(pollMs, APPROVAL_NOTIFY_MIN_MS), async current => {
    const page = await ledger!.listApprovalPage!(approvalWatch.current.cursor);
    if (!current()) return;
    const { state, fresh } = approvalWatchStep(approvalWatch.current, page, Date.now());
    approvalWatch.current = state;
    if (fresh.length) push([notice('info', fillTemplate(work!.approvalNotify, { count: fresh.length }))]);
  }, error => push([notice('error', `${work!.approvalPollFailed}: ${errorText(error)}`)]));
  const run = async (command: 'approvals' | 'cancel', args: string, execution: LocalExecution): Promise<void> => {
    if (!work || !ledger) return;
    const ref = args.trim();
    if (command === 'cancel') {
      if (!ref || /\s/.test(ref)) { push([notice('error', work.cancelUsage)]); return; }
      const view = await ledger.inspectRun(ref);
      if (!view) { push([notice('error', labels.runNotFound)]); return; }
      const answer = await panel.pick(execution, { kind: 'cancel', run: view }, ['allow', 'deny']);
      if (answer !== null && !execution.signal.aborted) await cancelRun(view, answer === 'allow');
      return;
    }
    if (ref === 'clear-session') {
      if (!ledger.clearSessionStanding || !work.sessionStandingClear) { push([notice('error', work.unavailable)]); return; }
      const answer = await clearStandingNotice(execution.input.context.sessionId, ledger.clearSessionStanding, work.sessionStandingClear);
      push([notice(answer.level, answer.text)]);
      return;
    }
    const now = Date.now();
    const { pending, truncated } = await scanPendingApprovals(ledger.listApprovalPage!, now);
    const rows = pending.map((item, index) => makeApprovalRowNotice(approvalRowPresentation(item, index + 1, now, work), work.approvalTitle));
    const bound = truncated ? [notice('info', fillTemplate(work.approvalsTruncated, { pages: APPROVAL_SCAN_MAX_PAGES }))] : [];
    if (!pending.length) { push([...bound, notice('info', work.approvalsNone)]); return; }
    let target: WorklineApproval | undefined;
    if (!ref) {
      if (bound.length) push(bound);
      const choice = await panel.pick(execution, { kind: 'approvals', rows: pending }, pending.map((_, index) => String(index)));
      if (choice === null || execution.signal.aborted) return;
      target = pending[Number(choice)];
    } else target = /^[1-9][0-9]*$/.test(ref) ? pending[Number(ref) - 1] : pending.find(item => item.approvalId === ref);
    if (!target) { push([...rows, ...bound, makeApprovalNotFoundNotice(args, work.approvalNotFound, work.approvalTitle)]); return; }
    if (ref) push([...rows, ...bound]);
    while (!execution.signal.aborted) {
      const answer = await panel.pick(execution, { kind: 'approval', approval: target, remaining: pending.length - 1 }, ['allow', 'deny']);
      if (answer === null || execution.signal.aborted) return;
      try { await decideApproval(target, pending.length - 1, answer === 'allow'); return; }
      catch (error) { if (!['APPROVAL_ASSURANCE_INSUFFICIENT', 'APPROVAL_SURFACE_RESTRICTED'].includes(String((error as { code?: unknown }).code))) return; }
    }
  };
  const decideApproval = useCallback(async (approval: WorklineApproval, remaining: number, yes: boolean, standing?: StandingScope) => {
    try {
      const record = await ledger!.decideApproval!(approval, yes ? 'allow' : 'deny', standing);
      const decision = record.decision ?? (yes ? 'allow' : 'deny');
      push([notice('info', fillTemplate(decision === 'allow' ? work!.approvalAllowed : work!.approvalDenied, { id: record.approvalId }))]);
      // What the service answered about the standing scope is shown as it is: a saved answer, or the reason it was not saved (the call
      // itself was allowed once either way).
      if (standing && work!.approvalStanding) {
        const answer = standingAnswerNotice(record.approvalId, standing, record.standing, work!.approvalStanding);
        push([notice(answer.level, answer.text)]);
      }
      if (remaining > 0) push([notice('info', fillTemplate(work!.approvalMore, { count: remaining }))]);
    } catch (error) {
      if (standing === 'session' && work?.approvalStanding?.unconfirmedSession) push([notice('error', fillTemplate(work.approvalStanding.unconfirmedSession, { id: approval.approvalId, reason: 'transport-unknown' }))]);
      push([notice('error', errorText(error))]);
      if (!['APPROVAL_ASSURANCE_INSUFFICIENT', 'APPROVAL_SURFACE_RESTRICTED'].includes(String((error as { code?: unknown }).code)))
        push([notice('error', fillTemplate(work!.approvalUnsettled, { id: approval.approvalId }))]);
      throw error;
    }
  }, [errorText, ledger, push, work]);
  const cancelRun = useCallback(async (view: RunView, yes: boolean) => {
    try {
      if (!yes) { push([notice('info', fillTemplate(work!.cancelKept, { run: view.runId }))]); return; }
      push([notice('info', await ledger!.cancelRun!(view.runId, view.revision))]);
    } catch (error) { push([notice('error', errorText(error))]); }
  }, [errorText, ledger, push, work]);
  const noteUnsettled = useCallback((approvalId: string) => {
    if (work) push([notice('error', fillTemplate(work.approvalUnsettled, { id: approvalId }))]);
  }, [push, work]);
  let card: ReactNode = null;
  if (work && modal?.kind === 'approval') {
    const { approval, preview } = modal;
    // The scopes are offered only when the service named them AND the labels exist: a card never shows a key it cannot explain.
    const scoped = modal.standing && work.approvalStanding && modal.standing.scopes.length > 0 ? { labels: work.approvalStanding, ...modal.standing } : null;
    card = <ApprovalDecisionCard key={`approval:${state.approval?.cardHandle ?? state.picker?.pickerHandle ?? state.active?.inputId}`} presentation={approvalCardPresentation(approval)} work={work} labels={labels.render ?? {}} preview={preview} scoped={scoped}
      pending={state.approval ? state.approval.phase !== 'pending' : !state.picker}
      onDecide={(yes, standing) => { if (state.approval) panel.decide(state.approval.cardHandle, yes, standing); else panel.choose(state.picker?.pickerHandle, yes ? 'allow' : 'deny'); }} />;
  } else if (work && modal?.kind === 'cancel') {
    const view = modal.run;
    card = <CancellationDecisionCard key={`cancel:${view.runId}`} presentation={cancellationCardPresentation(view)} work={work} labels={labels.render ?? {}}
      pending={!state.picker} onDecide={yes => { panel.choose(state.picker?.pickerHandle, yes ? 'allow' : 'deny'); }} />;
  }
  const pickerOpen = picker !== null && modal === null;
  const region = (
    <>
      {work ? <WorkerPanel workers={workers} labels={work.panel} line={work.workerLine} /> : null}
      {picker && modal === null && work ? <ApprovalDecisionPicker key={state.picker?.pickerHandle} rows={picker.map((item, index) => approvalRowPresentation(item, index + 1, Date.now(), work))} labels={labels.render ?? {}}
        onSelect={index => { panel.choose(state.picker?.pickerHandle, String(index)); }} onCancel={() => { panel.choose(state.picker?.pickerHandle, null); }} /> : null}
      {card}
    </>
  );
  return { observeWorkers, run, decideApproval, noteUnsettled, modalOpen: modal !== null, pickerOpen, region };
}
/** Legacy string compatibility; the actual card consumes completed spans/counts in a Provider child. */
export function approvalCardLines(approval: WorklineApproval, work: WorkSurfaceLabels, preview: string | undefined, covers: string | null): string[] {
  return approvalDecisionCardLines(approvalCardPresentation(approval), work, preview, covers === null ? null : { template: '{pattern}', pattern: covers }).map(line => plainText(line.spans));
}
