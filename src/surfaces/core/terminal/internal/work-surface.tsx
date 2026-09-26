import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { AgentToolApprovalSettlement } from '#domain/index.js';
import type { RunView } from '#engine/index.js';
import type { WorkLedgerEntry, WorkLedgerWorkerEntry } from './work-ledger.js';
import type { WorklineLedgerPorts } from './workline-ledger.js';
import { notice, type WorklineActionLabels } from './workline-actions.js';
import { APPROVAL_SCAN_MAX_PAGES, EMPTY_APPROVAL_WATCH, approvalWatchStep, scanPendingApprovals, type WorklineApproval } from './approval-watch.js';
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
export type TurnApprovalRequest = Readonly<{ approvalId: string; revision: number; summary: string; preview: string; expiresAt: number }>;
type Modal =
  | Readonly<{ kind: 'approval'; approval: WorklineApproval; remaining: number; preview?: string }>
  | Readonly<{ kind: 'cancel'; run: RunView }>
  | null;

const SUMMARY_MAX = 160;
const clip = (text: string) => { const flat = terminalSafeText(text).replace(/\s+/g, ' ').trim(); return flat.length > SUMMARY_MAX ? `${flat.slice(0, SUMMARY_MAX - 1)}…` : flat; };

function phaseCounts(run: RunView): string {
  const counts = new Map<string, number>();
  for (const task of run.tasks) counts.set(task.phase, (counts.get(task.phase) ?? 0) + 1);
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
  const approvalWatch = useRef(EMPTY_APPROVAL_WATCH);
  useEffect(() => { if (!watchingWorkers) setWorkers([]); }, [watchingWorkers]);
  const observeWorkers = useCallback((entries: readonly WorkLedgerEntry[]) => {
    setWorkers(entries.filter((entry): entry is WorkLedgerWorkerEntry => entry.kind === 'worker'));
  }, []);

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
    const rows = pending.map((item, index) => notice('info', fillTemplate(work.approvalItem, { n: index + 1, id: item.approvalId, run: item.runId,
      task: item.taskId, summary: clip(item.summary), duration: formatDuration(item.expiresAt - now, work.workerLine) })));
    if (truncated) rows.push(notice('info', fillTemplate(work.approvalsTruncated, { pages: APPROVAL_SCAN_MAX_PAGES })));
    if (!pending.length) { push([...rows, notice('info', work.approvalsNone)]); return; }
    const target = !ref ? pending[0] : /^[1-9][0-9]*$/.test(ref) ? pending[Number(ref) - 1] : pending.find(item => item.approvalId === ref);
    if (!target) { push([...rows, notice('error', fillTemplate(work.approvalNotFound, { ref }))]); return; }
    push(rows);
    setModal({ kind: 'approval', approval: target, remaining: pending.length - 1 });
  }, [labels.runNotFound, ledger, push, work]);

  const decideApproval = useCallback(async (approval: WorklineApproval, remaining: number, yes: boolean) => {
    try {
      const record = await ledger!.decideApproval!(approval, yes ? 'allow' : 'deny');
      const decision = record.decision ?? (yes ? 'allow' : 'deny');
      push([notice('info', fillTemplate(decision === 'allow' ? work!.approvalAllowed : work!.approvalDenied, { id: record.approvalId }))]);
      if (remaining > 0) push([notice('info', fillTemplate(work!.approvalMore, { count: remaining }))]);
    } catch (error) { push([notice('error', errorText(error))]); }
    // A late answer closes only its own card: a newer card (the turn's next call) may already be open (Astra 2092 R1).
    finally { setModal(current => current?.kind === 'approval' && current.approval.approvalId === approval.approvalId ? null : current); }
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
    setModal({ kind: 'approval', remaining: 0, preview: request.preview, approval: { approvalId: request.approvalId, runId: '-', taskId: '-',
      summary: request.summary, requester: '-', revision: request.revision, status: 'pending', decision: null, expiresAt: request.expiresAt } });
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
    const subject = preview === undefined
      ? [fillTemplate(work.approvalSubject, { id: approval.approvalId, run: approval.runId, task: approval.taskId, requester: approval.requester })] : [];
    card = <DecisionCard key={`approval:${approval.approvalId}`} title={work.approvalTitle} prompt={work.approvalPrompt} pendingText={work.approvalPending}
      lines={[...subject, clip(approval.summary), ...(preview === undefined ? [] : previewLines(preview, work.approvalPreviewMore)),
        fillTemplate(work.approvalExpires, { duration: formatDuration(approval.expiresAt - Date.now(), work.workerLine) })]}
      onDecide={yes => void decideApproval(approval, remaining, yes)} />;
  } else if (work && modal?.kind === 'cancel') {
    const view = modal.run;
    card = <DecisionCard key={`cancel:${view.runId}`} title={fillTemplate(work.cancelTitle, { run: view.runId })} prompt={work.cancelPrompt}
      pendingText={work.cancelPending} lines={[fillTemplate(work.cancelDetail, { revision: view.revision, scope: view.scopeId, phases: phaseCounts(view) }),
        ...(view.cancellationRequested ? [work.cancelAlreadyRequested] : [])]} onDecide={yes => void cancelRun(view, yes)} />;
  }
  const region = (
    <>
      {work ? <WorkerPanel workers={workers} labels={work.panel} line={work.workerLine} /> : null}
      {card}
    </>
  );
  return { observeWorkers, run, askTurnApproval, settleTurnApproval, modalOpen: modal !== null, region };
}

/** A call preview is shown up to 24 lines; the rest is counted, never silently dropped. */
function previewLines(preview: string, more: string): string[] {
  // The preview carries file content and model-chosen text: nothing in it may style, hide or move text on the owner's card.
  const lines = terminalSafeText(preview).split('\n');
  return lines.length <= 24 ? lines : [...lines.slice(0, 24), fillTemplate(more, { count: lines.length - 24 })];
}
