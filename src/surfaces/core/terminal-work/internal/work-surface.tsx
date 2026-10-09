import { standingAnswerNotice, clearStandingNotice } from '#surfaces/core/approval-presentation/index.js';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { RunView } from '#engine/index.js';
import { type WorkLedgerEntry, type WorkLedgerWorkerEntry, type WorklineLedgerPorts, APPROVAL_SCAN_MAX_PAGES, EMPTY_APPROVAL_WATCH, approvalWatchStep, scanPendingApprovals, type WorklineApproval, fillTemplate } from '#surfaces/core/terminal-ledger/index.js';
import { type WorklineActionLabels, type WorkSurfaceLabels } from './workline-actions.js';
import type { WorklinePanel, LocalExecution } from './workline-panel.js';
import type { PanelSnapshot, TerminalLocalContext, StandingScope } from '#surfaces/core/terminal-kit/index.js';
import { shortId } from '#platform/index.js';
import type { ApprovalDecisionLabels } from '#surfaces/core/approval-presentation/index.js';
import { ApprovalDecisionCard, ApprovalDecisionPicker, approvalRowPresentation, approvalCardPresentation, approvalDecisionCardLines, CancellationDecisionCard, cancellationCardPresentation, PanelWindow,
  type ApprovalWindowContext } from './approval-decision-view.js';
import { JobWindow, pickRun } from './job-windows.js';
import { systemSummaryEntry } from './system-summary.js';
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
  /** The observed workers are kept only while the worker watch runs (its live window shows them); they are cleared when the watch stops. */
  readonly watchingWorkers: boolean;
  /** False while a bound push stream is down; omitted keeps the port's own presence. */
  readonly pushLive?: boolean;
  /** Approval notification cadence; defaults to max(pollMs, APPROVAL_NOTIFY_MIN_MS). */
  readonly approvalPollMs?: number;
  /** What the approval window names besides the approval itself: the project path and the session's mode (display only). */
  readonly context?: ApprovalWindowContext;
}
/** A tool call of the running turn waiting for the owner (T-L4): its preview is shown; the decision goes through `decideApproval`. */
export type TurnApprovalRequest = Readonly<{ approvalId: string; revision: number; summary: string; preview: string; expiresAt: number;
  /** The scopes the service offers beyond "this once" and exactly what they cover (absent: the plain y/N card). */
  standing?: Readonly<{ scopes: readonly StandingScope[]; pattern: string }>; decisionCapability?: string; risk?: string | null; requiredAssurance?: string }>; // v19 (B1)
/**
 * Worker observation, approval notifications and the y/N cards for approvals and run cancellation. Every decision goes
 * through a runtime port; the view never decides, remembers or auto-approves anything. Read-only commands never prompt.
 */
export const APPROVAL_NOTIFY_MIN_MS = 10_000;
export function useWorkSurface({ panel, state, ledger, labels, push, errorText, pollMs, watchingWorkers, approvalPollMs, pushLive, context }: WorkSurfaceInput) {
  const work = labels.work;
  const [workers, setWorkers] = useState<readonly WorkLedgerWorkerEntry[]>([]);
  const presentation = panel.presentation(state);
  const modal = presentation?.kind === 'approval' || presentation?.kind === 'cancel' || presentation?.kind === 'window' || presentation?.kind === 'job-window' || presentation?.kind === 'job-picker' ? presentation : null;
  // A list window's decision carries the reason typed on the approval window it opened (the picker answer itself is only allow/deny).
  const pickedReason = useRef<string | undefined>(undefined);
  const picker = presentation?.kind === 'approvals' && state.picker ? presentation.rows : null;
  const slashSummary = useRef<string[] | null>(null);
  const output = useCallback((text: string) => { if (slashSummary.current) slashSummary.current.push(text); else push([systemSummaryEntry(text)]); }, [push]);
  const [approvalStatus, setApprovalStatus] = useState('');
  const approvalWatch = useRef(EMPTY_APPROVAL_WATCH);
  useEffect(() => { if (!watchingWorkers && !ledger?.readSurfaceSnapshot) setWorkers([]); }, [watchingWorkers, ledger?.readSurfaceSnapshot]);
  const observeApprovals = useCallback((items: readonly WorklineApproval[]) => {
    const { state, fresh } = approvalWatchStep(approvalWatch.current, { items, nextAfter: null }, Date.now());
    approvalWatch.current = state;
    if (work && fresh.length) setApprovalStatus(fillTemplate(work.approvalNotify, { count: fresh.length }));
  }, [work]);
  const observeWorkers = useCallback((entries: readonly WorkLedgerEntry[]) => { setWorkers(entries.filter((entry): entry is WorkLedgerWorkerEntry => entry.kind === 'worker')); }, []);
  // Without push snapshots: one bounded approval page per tick, never faster than APPROVAL_NOTIFY_MIN_MS.
  const connected = pushLive ?? Boolean(ledger?.followEvents);
  useSingleFlightPoll(Boolean(work && ledger?.listApprovalPage) && !connected && !ledger?.readSurfaceSnapshot, approvalPollMs ?? Math.max(pollMs, APPROVAL_NOTIFY_MIN_MS), async current => {
    const page = await ledger!.listApprovalPage!(approvalWatch.current.cursor);
    if (!current()) return;
    const { state, fresh } = approvalWatchStep(approvalWatch.current, page, Date.now());
    approvalWatch.current = state;
    if (fresh.length) setApprovalStatus(fillTemplate(work!.approvalNotify, { count: fresh.length }));
  }, error => setApprovalStatus(`${work!.approvalPollFailed}: ${errorText(error)}`));
  const run = async (command: 'approvals' | 'cancel', _args: string, execution: LocalExecution, selectedApprovalId?: string, selectedRunId?: string): Promise<void> => {
    if (!work || !ledger) return;
    const title = command === 'approvals' ? work.window.approvalsTitle : work.jobs!.runTitle;
    slashSummary.current = [];
    try {
      if (command === 'cancel') {
        const selected = selectedRunId ? await ledger.inspectRun(selectedRunId) : null;
        const view = selectedRunId ? selected && selected.state?.kind !== 'terminal' && !selected.cancellationRequested ? selected : null : await pickRun(panel, execution, ledger, work, true);
        if (!view || execution.signal.aborted) { output(fillTemplate(work.jobs!.closed, { title })); return; }
        const answer = await panel.pick(execution, { kind: 'cancel', run: view }, ['allow', 'deny']);
        if (!execution.signal.aborted) await cancelRun(view, answer === 'allow');
        return;
      }
      const { pending, truncated } = await scanPendingApprovals(ledger.listApprovalPage!, Date.now());
      if (!pending.length) setApprovalStatus('');
      const clearSession = ledger.clearSessionStanding && work.sessionStandingClear ? work.jobs!.clearSession : undefined;
      const status = truncated ? fillTemplate(work.approvalsTruncated, { pages: APPROVAL_SCAN_MAX_PAGES }) : approvalStatus;
      if (!pending.length && !clearSession) {
        await panel.pick(execution, { kind: 'window', title, body: [work.approvalsNone, ...(status ? [status] : [])], hints: work.jobs!.hints, confirm: false }, ['close']);
        output(work.approvalsNone); return;
      }
      const choice = selectedApprovalId ? String(pending.findIndex(item => item.approvalId === selectedApprovalId)) : await panel.pick(execution, { kind: 'approvals', rows: pending, ...(clearSession ? { clearSession } : {}), ...(status ? { status } : {}) },
        [...pending.map((_, index) => String(index)), ...(clearSession ? ['clear-session'] : [])]);
      if (choice === null || execution.signal.aborted) { output(fillTemplate(work.jobs!.closed, { title })); return; }
      if (choice === 'clear-session') {
        const answer = await panel.pick(execution, { kind: 'window', title: clearSession!, body: [work.jobs!.clearDetail], hints: work.cancelPrompt, confirm: true }, ['allow', 'deny']);
        if (answer === 'allow' && !execution.signal.aborted) {
          const cleared = await clearStandingNotice(execution.input.context.sessionId, ledger.clearSessionStanding!, work.sessionStandingClear!);
          output(cleared.text);
        } else output(work.jobs!.kept);
        return;
      }
      const target = pending[Number(choice)];
      if (!target) {
        await panel.pick(execution, { kind: 'window', title, body: [fillTemplate(work.approvalNotFound, { ref: shortId(selectedApprovalId ?? '') })], hints: work.jobs!.hints, confirm: false }, ['close']);
        output(fillTemplate(work.jobs!.closed, { title })); return;
      }
      while (!execution.signal.aborted) {
        pickedReason.current = undefined;
        const answer = await panel.pick(execution, { kind: 'approval', approval: target, remaining: pending.length - 1 }, ['allow', 'deny']);
        if (answer === null || execution.signal.aborted) { output(fillTemplate(work.jobs!.closed, { title })); return; }
        try { await decideApproval(target, pending.length - 1, answer === 'allow', undefined, pickedReason.current); return; }
        catch (error) {
          if (!['APPROVAL_ASSURANCE_INSUFFICIENT', 'APPROVAL_SURFACE_RESTRICTED'].includes(String((error as { code?: unknown }).code))) throw error;
          await panel.pick(execution, { kind: 'window', title, body: [errorText(error)], hints: work.jobs!.hints, confirm: false }, ['close']);
        }
      }
    } catch (error) {
      await panel.pick(execution, { kind: 'window', title, body: [errorText(error)], hints: work.jobs!.hints, confirm: false }, ['close']);
      if (!slashSummary.current?.some(text => text.includes(errorText(error)))) output(errorText(error));
    } finally {
      const summary = slashSummary.current; slashSummary.current = null;
      if (!execution.signal.aborted) push([systemSummaryEntry(summary?.length ? summary.join(' · ') : fillTemplate(work.jobs!.closed, { title }))]);
    }
  };
  // T2 integration: a decision notice names the approval by its short id; the full id is a detail line under it (never the primary line).
  const identified = useCallback((template: string, approvalId: string) => fillTemplate(template, { id: shortId(approvalId) }), []);
  const decideApproval = useCallback(async (approval: WorklineApproval, remaining: number, yes: boolean, standing?: StandingScope, reason?: string) => {
    const result: string[] = [];
    try {
      const record = await ledger!.decideApproval!(approval, yes ? 'allow' : 'deny', standing, reason);
      setApprovalStatus(remaining > 0 ? fillTemplate(work!.approvalMore, { count: remaining }) : '');
      const decision = record.decision ?? (yes ? 'allow' : 'deny');
      result.push(identified(decision === 'allow' ? work!.approvalAllowed : work!.approvalDenied, record.approvalId));
      if (standing && work!.approvalStanding) result.push(standingAnswerNotice(shortId(record.approvalId), standing, record.standing, work!.approvalStanding).text);
      if (remaining > 0) result.push(fillTemplate(work!.approvalMore, { count: remaining }));
      output(result.join(' · '));
    } catch (error) {
      if (standing === 'session' && work?.approvalStanding?.unconfirmedSession) result.push(fillTemplate(work.approvalStanding.unconfirmedSession, { id: shortId(approval.approvalId), reason: 'transport-unknown' }));
      result.push(errorText(error));
      if (!['APPROVAL_ASSURANCE_INSUFFICIENT', 'APPROVAL_SURFACE_RESTRICTED'].includes(String((error as { code?: unknown }).code))) result.push(identified(work!.approvalUnsettled, approval.approvalId));
      output(result.join(' · ')); throw error;
    }
  }, [errorText, identified, ledger, output, work]);
  const cancelRun = useCallback(async (view: RunView, yes: boolean) => {
    try {
      if (!yes) { output(fillTemplate(work!.cancelKept, { run: shortId(view.runId) })); return; }
      output(await ledger!.cancelRun!(view.runId, view.revision));
    } catch (error) { output(errorText(error)); }
  }, [errorText, ledger, output, work]);
  const noteUnsettled = useCallback((approvalId: string) => {
    if (work) output(identified(work.approvalUnsettled, approvalId));
  }, [identified, output, work]);
  let card: ReactNode = null;
  if (work && (modal?.kind === 'job-window' || modal?.kind === 'job-picker')) {
    card = <JobWindow key={state.picker?.pickerHandle} value={modal} work={work} onAnswer={choice => { panel.choose(state.picker?.pickerHandle, choice); }} />;
  } else if (work && modal?.kind === 'approval') {
    const { approval, preview } = modal;
    // The scopes are offered only when the service named them AND the labels exist: a card never shows a key it cannot explain.
    const scoped = modal.standing && work.approvalStanding && modal.standing.scopes.length > 0 ? { labels: work.approvalStanding, ...modal.standing } : null;
    card = <ApprovalDecisionCard key={`approval:${state.approval?.cardHandle ?? state.picker?.pickerHandle ?? state.active?.inputId}`} presentation={approvalCardPresentation(approval)} work={work} labels={labels.render ?? {}} preview={preview} scoped={scoped}
      pending={state.approval ? state.approval.phase !== 'pending' : !state.picker} {...(context ? { context } : {})}
      onDecide={(yes, standing, reason) => {
        if (state.approval) panel.decide(state.approval.cardHandle, yes, standing, reason ?? '');
        else { pickedReason.current = reason; panel.choose(state.picker?.pickerHandle, yes ? 'allow' : 'deny'); }
      }} />;
  } else if (work && modal?.kind === 'cancel') {
    const view = modal.run;
    card = <CancellationDecisionCard key={`cancel:${view.runId}`} presentation={cancellationCardPresentation(view)} work={work} labels={labels.render ?? {}}
      pending={!state.picker} onDecide={yes => { panel.choose(state.picker?.pickerHandle, yes ? 'allow' : 'deny'); }} />;
  } else if (modal?.kind === 'window') {
    card = <PanelWindow key={`window:${state.picker?.pickerHandle}`} window={modal} labels={labels.render ?? {}} pending={!state.picker} position={work?.window.position}
      onAnswer={answer => { panel.choose(state.picker?.pickerHandle, answer); }} />;
  }
  const pickerOpen = picker !== null && modal === null;
  const region = (
    <>
      {picker && modal === null && work ? <ApprovalDecisionPicker key={state.picker?.pickerHandle} rows={picker.map((item, index) => approvalRowPresentation(item, index + 1, Date.now(), work))} labels={labels.render ?? {}} work={work}
        clearSession={presentation?.kind === 'approvals' ? presentation.clearSession : undefined} status={presentation?.kind === 'approvals' ? presentation.status : undefined}
        onSelect={index => { panel.choose(state.picker?.pickerHandle, index === picker.length ? 'clear-session' : String(index)); }} onCancel={() => { panel.choose(state.picker?.pickerHandle, null); }} /> : null}
      {card}
    </>
  );
  return { openApproval: (approvalId: string, execution: LocalExecution) => run('approvals', '', execution, approvalId), approvalStatus, observeWorkers, observeApprovals, run, decideApproval, noteUnsettled, modalOpen: modal !== null, pickerOpen, region, workers };
}
/** Legacy string compatibility; the actual card consumes completed spans/counts in a Provider child. */
export function approvalCardLines(approval: WorklineApproval, work: WorkSurfaceLabels, preview: string | undefined, covers: string | null, context: ApprovalWindowContext = {}, now = Date.now()): string[] {
  return approvalDecisionCardLines(approvalCardPresentation(approval), work, preview, covers === null ? null : { scopes: ['session'], pattern: covers }, undefined, context, now)
    .map(line => [plainText(line.label ?? []), plainText(line.spans)].filter(Boolean).join(' '));
}
