import { useHumanTextSecrets } from '#surfaces/core/terminal-render/index.js';
import { ApprovalProjectedNotice, ApprovalProjectedPicker, DecisionCard, projectApprovalDecisionText, approvalSummarySpans, approvalTemplateSpans, approvalTemplateLine, assembleApprovalCard,
  type ApprovalDecisionLabels, type ApprovalDecisionLine } from '#surfaces/core/approval-presentation/index.js';
import type { KnownSecretSnapshot } from '#platform/index.js';
import type { RunView } from '#engine/index.js';
import type { StandingScope } from '#surfaces/core/terminal-kit/index.js';
import type { WorkSurfaceLabels } from './workline-actions.js';
import type { WorklineApproval } from './approval-watch.js';
import { fillTemplate, formatDuration } from './worker-line.js';
import type { ApprovalDecisionNoticePresentation, ApprovalRowPresentation } from './approval-decision-notice.js';
/** Private copy of display fields only. The original authority DTO never crosses the public renderer boundary. */
export type ApprovalCardPresentation = Readonly<{ displayId: string; displayRun: string; displayTask: string; displayRequester: string; summary: string;
  risk: string | null | undefined; undo: string | null | undefined; requiredAssurance: string | undefined; expiresAt: number; hasDecisionCapability: boolean }>;
export const approvalCardPresentation = (item: WorklineApproval): ApprovalCardPresentation => ({ displayId: item.approvalId, displayRun: item.runId, displayTask: item.taskId,
  displayRequester: item.requester, summary: item.summary, risk: item.risk, undo: item.undo, requiredAssurance: item.requiredAssurance, expiresAt: item.expiresAt, hasDecisionCapability: Boolean(item.decisionCapability) });
export const approvalRowPresentation = (item: WorklineApproval, rowNumber: number, now: number, work: WorkSurfaceLabels): Omit<ApprovalRowPresentation, 'kind'> => ({
  rowNumber, summary: item.summary, displayId: item.approvalId, displayRun: item.runId, displayTask: item.taskId, itemTemplate: work.approvalItem, durationText: formatDuration(item.expiresAt - now, work.workerLine) });
function projectRow(raw: Omit<ApprovalRowPresentation, 'kind'>, known?: KnownSecretSnapshot): ApprovalDecisionLine {
  const summary = projectApprovalDecisionText(raw.summary, known), id = projectApprovalDecisionText(raw.displayId, known), run = projectApprovalDecisionText(raw.displayRun, known), task = projectApprovalDecisionText(raw.displayTask, known);
  return { spans: approvalTemplateSpans(raw.itemTemplate, { n: raw.rowNumber, id: id.spans, run: run.spans, task: task.spans, summary: approvalSummarySpans(summary), duration: raw.durationText }), fields: [id, run, task, summary] };
}
/** These private adapters read context below the real Workline Provider, then pass completed projections only. */
export function ApprovalDecisionNoticeRow({ raw, labels, error }: { readonly raw: ApprovalDecisionNoticePresentation; readonly labels: ApprovalDecisionLabels; readonly error: boolean }) {
  const known = useHumanTextSecrets(), line = raw.kind === 'approval-row' ? projectRow(raw, known) : approvalTemplateLine(raw.notFoundTemplate, { ref: projectApprovalDecisionText(raw.ref, known) });
  return <ApprovalProjectedNotice line={line} labels={labels} error={error} />;
}
export function ApprovalDecisionPicker({ rows, labels, onSelect, onCancel }: { readonly rows: readonly Omit<ApprovalRowPresentation, 'kind'>[]; readonly labels: ApprovalDecisionLabels;
  readonly onSelect: (index: number) => void; readonly onCancel: () => void }) {
  const known = useHumanTextSecrets();
  return <ApprovalProjectedPicker lines={rows.map(raw => projectRow(raw, known))} labels={labels} onSelect={onSelect} onCancel={onCancel} />;
}
export function approvalDecisionCardLines(approval: ApprovalCardPresentation, work: WorkSurfaceLabels, preview: string | undefined, covers: Readonly<{ template: string; pattern: string }> | null, known?: KnownSecretSnapshot) {
  const p = (text: string) => projectApprovalDecisionText(text, known), card = work.approvalCard, required = approval.requiredAssurance;
  const assurance = required === undefined ? null : required === 'peer-session' ? approvalTemplateLine(card.assurancePeer, {}) : required === 'turn-bound'
    ? approvalTemplateLine(approval.hasDecisionCapability ? card.assuranceTurnHere : card.assuranceTurnElsewhere, {}) : approvalTemplateLine(card.assuranceOther, { level: p(required) });
  return assembleApprovalCard({ subject: preview === undefined ? approvalTemplateLine(work.approvalSubject, { id: p(approval.displayId), run: p(approval.displayRun), task: p(approval.displayTask), requester: p(approval.displayRequester) }) : null,
    summary: p(approval.summary), risk: approvalTemplateLine(card.risk, { risk: p(approval.risk || card.notDeclared), undo: p(approval.undo || card.notDeclared) }), preview: preview === undefined ? null : p(preview), previewMore: work.approvalPreviewMore,
    covers: covers ? approvalTemplateLine(covers.template, { pattern: p(covers.pattern) }) : null, expiry: approvalTemplateLine(`${fillTemplate(work.approvalExpires, { duration: formatDuration(approval.expiresAt - Date.now(), work.workerLine) })} ${card.onExpiry}`, {}), assurance });
}
export function ApprovalDecisionCard({ presentation, work, labels, preview, scoped, onDecide }: { readonly presentation: ApprovalCardPresentation; readonly work: WorkSurfaceLabels; readonly labels: ApprovalDecisionLabels; readonly preview: string | undefined;
  readonly scoped: Readonly<{ scopes: readonly StandingScope[]; pattern: string; labels: NonNullable<WorkSurfaceLabels['approvalStanding']> }> | null; readonly onDecide: (yes: boolean, standing?: StandingScope) => void }) {
  const known = useHumanTextSecrets(), prompt = !scoped ? work.approvalPrompt : scoped.scopes.length === 2 ? scoped.labels.promptBoth : scoped.scopes[0] === 'session' ? scoped.labels.promptSession : scoped.labels.promptAlways;
  return <DecisionCard title={approvalTemplateLine(work.approvalTitle, {})} projectedLines={approvalDecisionCardLines(presentation, work, preview, scoped ? { template: scoped.labels.covers, pattern: scoped.pattern } : null, known)} decisionLabels={labels}
    prompt={prompt} pendingText={work.approvalPending} scopes={scoped?.scopes ?? []} onDecide={onDecide} />;
}
type CancellationCardPresentation = Readonly<{ displayRun: string; displayScope: string; displayRevision: number; displayPhases: string; cancellationRequested: boolean }>;
export function cancellationCardPresentation(run: RunView): CancellationCardPresentation {
  const counts = new Map<string, number>(); for (const task of run.tasks) counts.set(task.phase, (counts.get(task.phase) ?? 0) + 1);
  return { displayRun: run.runId, displayScope: run.scopeId, displayRevision: run.revision, displayPhases: [...counts.entries()].map(([phase, count]) => `${phase}:${count}`).join(' ') || '—', cancellationRequested: run.cancellationRequested };
}
/** Cancellation shares the private Provider boundary; the public card receives no transported strings or Run DTO. */
export function CancellationDecisionCard({ presentation: raw, work, labels, onDecide }: { readonly presentation: CancellationCardPresentation; readonly work: WorkSurfaceLabels; readonly labels: ApprovalDecisionLabels; readonly onDecide: (yes: boolean) => void }) {
  const known = useHumanTextSecrets(), p = (text: string) => projectApprovalDecisionText(text, known);
  return <DecisionCard title={approvalTemplateLine(work.cancelTitle, { run: p(raw.displayRun) })} projectedLines={[approvalTemplateLine(work.cancelDetail, { revision: p(String(raw.displayRevision)), scope: p(raw.displayScope), phases: p(raw.displayPhases) }), ...(raw.cancellationRequested ? [approvalTemplateLine(work.cancelAlreadyRequested, {})] : [])]}
    decisionLabels={labels} prompt={work.cancelPrompt} pendingText={work.cancelPending} onDecide={onDecide} />;
}
