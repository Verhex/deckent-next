import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowPicker } from '#surfaces/core/terminal-render/index.js';
import type { AgentToolApprovalSettlement } from '#domain/index.js';
import type { RunView } from '#engine/index.js';
import type { WorkLedgerEntry, WorkLedgerWorkerEntry } from './work-ledger.js';
import type { WorklineLedgerPorts } from './workline-ledger.js';
import { notice, type WorklineActionLabels, type WorkSurfaceLabels } from './workline-actions.js';
import { APPROVAL_SCAN_MAX_PAGES, EMPTY_APPROVAL_WATCH, approvalWatchStep, scanPendingApprovals, type WorklineApproval } from './approval-watch.js';
import type { StandingScope } from '#surfaces/core/terminal-kit/index.js';
import { fillTemplate, formatDuration } from './worker-line.js';
import { WorkerPanel } from './worker-panel.js';
import { DecisionCard } from './decision-card.js';
import { terminalSafeText } from '#surfaces/core/terminal-render/index.js';
import { useSingleFlightPoll } from './use-poll.js';

export interface WorkSurfaceInput {
  readonly ledger: WorklineLedgerPorts | undefined;
  readonly labels: WorklineActionLabels;
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
type Modal =
  | Readonly<{ kind: 'approval'; approval: WorklineApproval; remaining: number; preview?: string; standing?: TurnApprovalRequest['standing']; retry?: number }>
  | Readonly<{ kind: 'cancel'; run: RunView }>
  | null;

const SUMMARY_MAX = 160;
/** Only a picker row is clipped (it selects; the card never clips or flattens: summary lines, binding line first, the whole covers line). */
const clip = (text: string) => { const flat = terminalSafeText(text).replace(/\s+/g, ' ').trim(); return flat.length > SUMMARY_MAX ? `${flat.slice(0, SUMMARY_MAX - 1)}…` : flat; };

function phaseCounts(run: RunView): string {
  const counts = new Map<string, number>(); for (const task of run.tasks) counts.set(task.phase, (counts.get(task.phase) ?? 0) + 1);
  return [...counts.entries()].map(([phase, count]) => `${phase}:${count}`).join(' ') || '—';
}

/**
 * Worker live panel, approval notifications and the y/N cards for approvals and run cancellation. Every decision goes
 * through a runtime port; the view never decides, remembers or auto-approves anything. Read-only commands never prompt.
 */
export const APPROVAL_NOTIFY_MIN_MS = 10_000;

export function useWorkSurface({ ledger, labels, push, errorText, pollMs, watchingWorkers, approvalPollMs }: WorkSurfaceInput) {
  const work = labels.work;
  const [workers, setWorkers] = useState<readonly WorkLedgerWorkerEntry[]>([]);
  const [modal, setModal] = useState<Modal>(null);
  const [picker, setPicker] = useState<readonly WorklineApproval[] | null>(null);
  const approvalWatch = useRef(EMPTY_APPROVAL_WATCH);
  const mounted = useRef(true);
  const approvalGate = useRef<((choice: { readonly index: number } | null) => void) | null>(null);
  useEffect(() => () => { mounted.current = false; const resolve = approvalGate.current; approvalGate.current = null; resolve?.(null); }, []);
  const finishPicker = (choice: { readonly index: number } | null) => { const resolve = approvalGate.current; approvalGate.current = null; resolve?.(choice); };
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

  const run = useCallback(async (command: 'approvals' | 'cancel', args: string): Promise<void> => {
    if (!work || !ledger) return;
    const ref = args.trim();
    if (command === 'cancel') {
      if (!ref || /\s/.test(ref)) { push([notice('error', work.cancelUsage)]); return; }
      const view = await ledger.inspectRun(ref);
      if (!view) { push([notice('error', labels.runNotFound)]); return; }
      setModal({ kind: 'cancel', run: view });
      return;
    }
    const now = Date.now();
    const { pending, truncated } = await scanPendingApprovals(ledger.listApprovalPage!, now);
    const rows = pending.map((item, index) => notice('info', approvalLine(item, index, now, work)));
    const bound = truncated ? [notice('info', fillTemplate(work.approvalsTruncated, { pages: APPROVAL_SCAN_MAX_PAGES }))] : [];
    if (!pending.length) { push([...bound, notice('info', work.approvalsNone)]); return; }
    if (!ref) {
      if (bound.length) push(bound);
      setPicker(pending);
      const choice = await new Promise<{ readonly index: number } | null>(resolve => { approvalGate.current = resolve; });
      approvalGate.current = null;
      if (!mounted.current) return;
      setPicker(null);
      if (!choice) return;
      const picked = pending[choice.index];
      if (!picked) return;
      setModal({ kind: 'approval', approval: picked, remaining: pending.length - 1 });
      return;
    }
    const target = /^[1-9][0-9]*$/.test(ref) ? pending[Number(ref) - 1] : pending.find(item => item.approvalId === ref);
    if (!target) { push([...rows, ...bound, notice('error', fillTemplate(work.approvalNotFound, { ref }))]); return; }
    push([...rows, ...bound]);
    setPicker(null);
    setModal({ kind: 'approval', approval: target, remaining: pending.length - 1 });
  }, [labels.runNotFound, ledger, push, work]);

  const decideApproval = useCallback(async (approval: WorklineApproval, remaining: number, yes: boolean, standing?: StandingScope) => {
    let refused = false; try {
      const record = await ledger!.decideApproval!(approval, yes ? 'allow' : 'deny', standing);
      const decision = record.decision ?? (yes ? 'allow' : 'deny');
      push([notice('info', fillTemplate(decision === 'allow' ? work!.approvalAllowed : work!.approvalDenied, { id: record.approvalId }))]);
      // What the service answered about the standing scope is shown as it is: a saved answer, or the reason it was not saved (the call
      // itself was allowed once either way).
      if (standing && work!.approvalStanding) {
        const answer = record.standing;
        const labels = work!.approvalStanding, always = standing === 'always';
        push([notice(answer?.saved ? 'info' : 'error', fillTemplate(answer?.saved ? (always ? labels.savedAlways : labels.savedSession) : (always ? labels.notSavedAlways : labels.notSavedSession),
          { id: record.approvalId, reason: answer?.reason ?? 'unconfirmed' }))]);
      }
      if (remaining > 0) push([notice('info', fillTemplate(work!.approvalMore, { count: remaining }))]);
    } catch (error) { push([notice('error', errorText(error))]); refused = ['APPROVAL_ASSURANCE_INSUFFICIENT', 'APPROVAL_SURFACE_RESTRICTED'].includes(String((error as { code?: unknown }).code)); }
    // A late answer touches only its own card (Astra 2092 R1); a typed refusal that leaves the request pending (B1/K3, Sol 2234 R3) keeps it open for a new answer (a deny); any other failure closes it, never as decided.
    finally { setModal(current => current?.kind === 'approval' && current.approval.approvalId === approval.approvalId ? (refused ? { ...current, retry: (current.retry ?? 0) + 1 } : null) : current); }
  }, [errorText, ledger, push, work]);

  const cancelRun = useCallback(async (view: RunView, yes: boolean) => {
    try {
      if (!yes) { push([notice('info', fillTemplate(work!.cancelKept, { run: view.runId }))]); return; }
      push([notice('info', await ledger!.cancelRun!(view.runId, view.revision))]);
    } catch (error) { push([notice('error', errorText(error))]); }
    finally { setModal(current => current?.kind === 'cancel' && current.run.runId === view.runId ? null : current); }
  }, [errorText, ledger, push, work]);

  /** Opens the card for a call of the running turn; the turn waits in the service until the decision (or expiry) lands. */
  const askTurnApproval = useCallback((request: TurnApprovalRequest) => {
    setModal({ kind: 'approval', remaining: 0, preview: request.preview, ...(request.standing ? { standing: request.standing } : {}), approval: { approvalId: request.approvalId, runId: '-', taskId: '-',
      summary: request.summary, requester: '-', revision: request.revision, status: 'pending', decision: null, expiresAt: request.expiresAt, ...(request.decisionCapability
        ? { decisionCapability: request.decisionCapability } : {}), ...(request.risk !== undefined ? { risk: request.risk } : {}), ...(request.requiredAssurance ? { requiredAssurance: request.requiredAssurance } : {}) } });
  }, []);
  /** The call's approval settled elsewhere (expiry, cancel): its card closes without a decision. `unsettled`: the service could not
   * confirm closing the request; the owner is told it permits nothing and closes at its expiry or the next service start. */
  const settleTurnApproval = useCallback((approvalId: string, outcome: AgentToolApprovalSettlement) => {
    setModal(current => current?.kind === 'approval' && current.approval.approvalId === approvalId ? null : current);
    if (outcome === 'unsettled' && work) push([notice('error', fillTemplate(work.approvalUnsettled, { id: approvalId }))]);
  }, [push, work]);

  let card: ReactNode = null;
  if (work && modal?.kind === 'approval') {
    const { approval, remaining, preview } = modal;
    // The scopes are offered only when the service named them AND the labels exist: a card never shows a key it cannot explain.
    const scoped = modal.standing && work.approvalStanding && modal.standing.scopes.length > 0 ? { labels: work.approvalStanding, ...modal.standing } : null;
    const scopedPrompt = !scoped ? work.approvalPrompt : scoped.scopes.length === 2 ? scoped.labels.promptBoth : scoped.scopes[0] === 'session' ? scoped.labels.promptSession : scoped.labels.promptAlways;
    card = <DecisionCard key={`approval:${approval.approvalId}:${modal.retry ?? 0}`} title={work.approvalTitle} prompt={scopedPrompt} pendingText={work.approvalPending} scopes={scoped?.scopes ?? []}
      lines={approvalCardLines(approval, work, preview, scoped ? fillTemplate(scoped.labels.covers, { pattern: terminalSafeText(scoped.pattern) }) : null)}
      onDecide={(yes, standing) => void decideApproval(approval, remaining, yes, standing)} />;
  } else if (work && modal?.kind === 'cancel') {
    const view = modal.run;
    card = <DecisionCard key={`cancel:${view.runId}`} title={fillTemplate(work.cancelTitle, { run: view.runId })} prompt={work.cancelPrompt}
      pendingText={work.cancelPending} lines={[fillTemplate(work.cancelDetail, { revision: view.revision, scope: view.scopeId, phases: phaseCounts(view) }),
        ...(view.cancellationRequested ? [work.cancelAlreadyRequested] : [])]} onDecide={yes => void cancelRun(view, yes)} />;
  }
  const pickerOpen = picker !== null && modal === null;
  const region = (
    <>
      {work ? <WorkerPanel workers={workers} labels={work.panel} line={work.workerLine} /> : null}
      {picker && modal === null && work ? <ArrowPicker rows={picker.map((item, index) => approvalLine(item, index, Date.now(), work))}
        onSelect={index => finishPicker({ index })} onCancel={() => finishPicker(null)} /> : null}
      {card}
    </>
  );
  return { observeWorkers, run, askTurnApproval, settleTurnApproval, modalOpen: modal !== null, pickerOpen, region };
}

function approvalLine(item: WorklineApproval, index: number, now: number, work: WorkSurfaceLabels): string {
  return fillTemplate(work.approvalItem, { n: index + 1, id: item.approvalId, run: item.runId, task: item.taskId,
    summary: clip(item.summary), duration: formatDuration(item.expiresAt - now, work.workerLine) });
}

/** The single approval card (APPROVAL-SURFACE §B, B1): ledger id line, the summary whole (binding line first), the typed risk line before the preview
 * (no preview bound can push it off), the preview, what a standing answer covers, expiry + nothing runs, and the required assurance when declared. */
export function approvalCardLines(approval: WorklineApproval, work: WorkSurfaceLabels, preview: string | undefined, covers: string | null): string[] {
  const card = work.approvalCard, word = (value: string | null | undefined) => value ? terminalSafeText(value) : card.notDeclared, required = approval.requiredAssurance;
  const assurance = required === undefined ? [] : [required === 'peer-session' ? card.assurancePeer : required !== 'turn-bound' ? fillTemplate(card.assuranceOther, { level: terminalSafeText(required) }) : approval.decisionCapability ? card.assuranceTurnHere : card.assuranceTurnElsewhere]; // Sol 2234 R1: another level is named, never peer-session
  return [...(preview === undefined ? [fillTemplate(work.approvalSubject, { id: approval.approvalId, run: approval.runId, task: approval.taskId, requester: approval.requester })] : []),
    ...terminalSafeText(approval.summary).split('\n'), fillTemplate(card.risk, { risk: word(approval.risk), undo: word(approval.undo) }),
    ...(preview === undefined ? [] : previewLines(preview, work.approvalPreviewMore)), ...(covers === null ? [] : [covers]),
    `${fillTemplate(work.approvalExpires, { duration: formatDuration(approval.expiresAt - Date.now(), work.workerLine) })} ${card.onExpiry}`, ...assurance];
}

/** A call preview is shown up to 24 lines; the rest is counted, never silently dropped. */
function previewLines(preview: string, more: string): string[] {
  // The preview carries file content and model-chosen text: nothing in it may style, hide or move text on the owner's card.
  const lines = terminalSafeText(preview).split('\n');
  return lines.length <= 24 ? lines : [...lines.slice(0, 24), fillTemplate(more, { count: lines.length - 24 })];
}
