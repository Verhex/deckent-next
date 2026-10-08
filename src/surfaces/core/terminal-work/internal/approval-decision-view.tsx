import { useEffect, useState } from 'react';
import { span, useHumanTextSecrets } from '#surfaces/core/terminal-render/index.js';
import { Window, WINDOW_PRIORITY } from '#surfaces/core/terminal-window/index.js';
import { ARROW_PICKER_ROWS } from '#surfaces/core/terminal-picker/index.js';
import { ApprovalProjectedNotice, ApprovalProjectedPicker, DecisionCard, decisionWindowLines, projectApprovalDecisionText, approvalSummarySpans, approvalTemplateSpans, approvalTemplateLine,
  type ApprovalDecisionLabels, type ApprovalDecisionLine } from '#surfaces/core/approval-presentation/index.js';
import type { KnownSecretSnapshot } from '#platform/index.js';
import type { AgentShellPosture, AgentToolCardCall, ApprovalPreviewCutFacts } from '#domain/index.js';
import type { RunView } from '#engine/index.js';
import type { StandingScope } from '#surfaces/core/terminal-kit/index.js';
import { shortId } from '#platform/index.js';
import type { WorkSurfaceLabels } from './workline-actions.js';
import { type WorklineApproval, fillTemplate, formatDuration, formatTaskPhases } from '#surfaces/core/terminal-ledger/index.js';
import type { ApprovalDecisionNoticePresentation, ApprovalRowPresentation } from './approval-decision-notice.js';
import type { PanelWindowPresentation } from './workline-panel.js';
import { approvalCallOf, approvalToolKind, approvalToolParts, approvalWindowHints, approvalWindowLines, approvalWindowTitle, countdownClock } from './approval-window.js';

/** The countdown and expiry check tick once a second (a clock unit, not a tunable). */
const SECOND = 1000;
/** Private copy of display fields only. The original authority DTO never crosses the public renderer boundary. */
export type ApprovalCardPresentation = Readonly<{ displayId: string; displayRun: string; displayTask: string; displayRequester: string; summary: string;
  risk: string | null | undefined; undo: string | null | undefined; requiredAssurance: string | undefined; expiresAt: number; hasDecisionCapability: boolean;
  tool: string | undefined; target: string | null | undefined; posture: AgentShellPosture | undefined;
  call: AgentToolCardCall | undefined; previewCut: ApprovalPreviewCutFacts | undefined; config: WorklineApproval['config'] }>;
export const approvalCardPresentation = (item: WorklineApproval): ApprovalCardPresentation => ({ displayId: item.approvalId, displayRun: item.runId, displayTask: item.taskId,
  displayRequester: item.requester, summary: item.summary, risk: item.risk, undo: item.undo, requiredAssurance: item.requiredAssurance, expiresAt: item.expiresAt, hasDecisionCapability: Boolean(item.decisionCapability),
  tool: item.tool, target: item.target, posture: item.posture, call: item.call, previewCut: item.previewCut, config: item.config });
/** The list row's "what": the tool's sentence with its target (a task approval keeps its summary). */
function rowWhat(item: WorklineApproval, work: WorkSurfaceLabels): string {
  const call = approvalCallOf(item);
  if (!call) return item.summary;
  const kind = approvalToolKind(call.tool), parts = approvalToolParts(call.tool), target = call.target ?? '';
  const said = fillTemplate(work.approvalWindow.what[kind], { path: target, host: target, tool: parts.tool, server: parts.server, changes: '' });
  // The shell sentence names no target of its own: the row adds the command so the list says what would run.
  return kind === 'shell' && target ? `${said}: ${target}` : said;
}
export const approvalRowPresentation = (item: WorklineApproval, rowNumber: number, now: number, work: WorkSurfaceLabels): Omit<ApprovalRowPresentation, 'kind'> => ({
  rowNumber, summary: item.summary, displayId: item.approvalId, displayRun: item.runId, displayTask: item.taskId, itemTemplate: work.approvalItem, durationText: formatDuration(item.expiresAt - now, work.workerLine),
  what: rowWhat(item, work), requester: item.requester === '-' ? work.approvalWindow.onBehalfSelf : item.requester,
  ageText: item.createdAt === undefined ? work.approvalWindow.ageUnknown : formatDuration(now - item.createdAt, work.workerLine) });
function projectRow(raw: Omit<ApprovalRowPresentation, 'kind'>, known?: KnownSecretSnapshot): ApprovalDecisionLine {
  const p = (text: string) => projectApprovalDecisionText(text, known);
  const summary = p(raw.summary), id = p(shortId(raw.displayId)), run = p(shortId(raw.displayRun)), task = p(shortId(raw.displayTask)), what = p(raw.what), requester = p(raw.requester);
  return { spans: approvalTemplateSpans(raw.itemTemplate, { n: raw.rowNumber, id: id.spans, run: run.spans, task: task.spans, summary: approvalSummarySpans(summary), duration: raw.durationText,
    what: approvalSummarySpans(what), requester: requester.spans, age: raw.ageText }), fields: [id, run, task, summary, what, requester] };
}
/** These private adapters read context below the real Workline Provider, then pass completed projections only. */
export function ApprovalDecisionNoticeRow({ raw, labels, error }: { readonly raw: ApprovalDecisionNoticePresentation; readonly labels: ApprovalDecisionLabels; readonly error: boolean }) {
  const known = useHumanTextSecrets(), line = raw.kind === 'approval-row' ? projectRow(raw, known) : approvalTemplateLine(raw.notFoundTemplate, { ref: projectApprovalDecisionText(raw.ref, known) });
  return <ApprovalProjectedNotice line={line} labels={labels} error={error} />;
}
/** `/approvals` as a list window; choosing a row opens the same approval window. */
export function ApprovalDecisionPicker({ rows, labels, work, clearSession, status, onSelect, onCancel }: { readonly rows: readonly Omit<ApprovalRowPresentation, 'kind'>[]; readonly labels: ApprovalDecisionLabels;
  readonly work: WorkSurfaceLabels; readonly clearSession?: string | undefined; readonly status?: string | undefined; readonly onSelect: (index: number) => void; readonly onCancel: () => void }) {
  const known = useHumanTextSecrets();
  return <Window title={[span(work.window.approvalsTitle)]} status={[span(status || String(rows.length))]} hints={work.window.pick} position={work.window.position} footerRows={ARROW_PICKER_ROWS + 2}
    footer={focused => <ApprovalProjectedPicker lines={[...rows.map(raw => projectRow(raw, known)), ...(clearSession ? [approvalTemplateLine('{text}', { text: projectApprovalDecisionText(clearSession, known) })] : [])]} labels={labels} active={focused} onSelect={onSelect} onCancel={onCancel} />} />;
}
/** The terminal's own context an approval window names: the project path and the session's permission mode (display only). */
export type ApprovalWindowContext = Readonly<{ project?: string | undefined; home?: string | undefined; mode?: string | undefined }>;
type Scoped = Readonly<{ scopes: readonly StandingScope[]; pattern: string; labels: NonNullable<WorkSurfaceLabels['approvalStanding']> }>;
/** The approval window's rows at `now` (T-APPROVAL-WINDOW): nine labelled fields, assurance and scope sentences, the preview, the details. */
export function approvalDecisionCardLines(approval: ApprovalCardPresentation, work: WorkSurfaceLabels, preview: string | undefined, standing: Readonly<{ scopes: readonly StandingScope[]; pattern: string }> | null,
  known?: KnownSecretSnapshot, context: ApprovalWindowContext = {}, now = Date.now()) {
  const p = (text: string) => projectApprovalDecisionText(text, known), card = work.approvalCard, required = approval.requiredAssurance;
  const assurance = required === undefined ? null : required === 'peer-session' ? approvalTemplateLine(card.assurancePeer, {}) : required === 'turn-bound'
    ? approvalTemplateLine(approval.hasDecisionCapability ? card.assuranceTurnHere : card.assuranceTurnElsewhere, {}) : approvalTemplateLine(card.assuranceOther, { level: p(required) });
  return approvalWindowLines({ approvalId: approval.displayId, summary: approval.summary, requester: approval.displayRequester, runId: approval.displayRun, taskId: approval.displayTask,
    expiresAt: approval.expiresAt, tool: approval.tool, target: approval.target, preview, risk: approval.risk, undo: approval.undo, requiredAssurance: required, assuranceLine: assurance,
    standing, project: context.project, home: context.home, mode: context.mode, posture: approval.posture, call: approval.call, previewCut: approval.previewCut, config: approval.config }, work.approvalWindow, now, known);
}
/** The live clock of a window: re-renders once a second until `until`, then stops. */
function useNow(until: number): number {
  const [now, setNow] = useState(() => Date.now());
  const expired = now >= until;
  useEffect(() => {
    if (expired) return undefined;
    const timer = setInterval(() => { setNow(Date.now()); }, SECOND);
    return () => clearInterval(timer);
  }, [expired, until]);
  return now;
}
/**
 * The approval window (T-APPROVAL-WINDOW): it outranks every other window, counts down live, and after expiry decides nothing (the
 * controller and the service refuse it as well). `y`/`s`/`a` only as offered; `n`, Enter and Esc deny; Tab writes a reason.
 */
export function ApprovalDecisionCard({ presentation, work, labels, preview, scoped, pending, context, onDecide }: { readonly presentation: ApprovalCardPresentation; readonly work: WorkSurfaceLabels; readonly labels: ApprovalDecisionLabels; readonly preview: string | undefined;
  readonly pending?: boolean; readonly scoped: Scoped | null; readonly context?: ApprovalWindowContext; readonly onDecide: (yes: boolean, standing?: StandingScope, reason?: string) => void }) {
  const known = useHumanTextSecrets(), now = useNow(presentation.expiresAt), win = work.approvalWindow, left = presentation.expiresAt - now;
  const decide = (yes: boolean, standing?: StandingScope, reason?: string) => { if (Date.now() < presentation.expiresAt) onDecide(yes, standing, reason); };
  return <DecisionCard title={approvalWindowTitle({ approvalId: presentation.displayId, summary: presentation.summary, requester: presentation.displayRequester, runId: presentation.displayRun,
      taskId: presentation.displayTask, expiresAt: presentation.expiresAt, tool: presentation.tool, config: presentation.config }, win, known)}
    projectedLines={approvalDecisionCardLines(presentation, work, preview, scoped, known, context, now)} decisionLabels={labels}
    status={[span(left > 0 ? countdownClock(left) : win.expired, { role: left > 0 ? 'accent' : 'error' })]} priority={WINDOW_PRIORITY.approval} position={work.window.position}
    reason={win.reason} prompt={approvalWindowHints(win, scoped?.scopes ?? [])} pendingText={work.approvalPending} {...(pending === undefined ? {} : { pending })} scopes={scoped?.scopes ?? []} onDecide={decide} />;
}
type CancellationCardPresentation = Readonly<{ displayRun: string; displayScope: string; displayRevision: number; displayPhases: string; cancellationRequested: boolean }>;
export function cancellationCardPresentation(run: RunView): CancellationCardPresentation {
  const counts = new Map<string, number>(); for (const task of run.tasks) counts.set(task.phase, (counts.get(task.phase) ?? 0) + 1);
  return { displayRun: run.runId, displayScope: run.scopeId, displayRevision: run.revision, displayPhases: [...counts.entries()].map(([phase, count]) => `${phase}:${count}`).join(' ') || '—', cancellationRequested: run.cancellationRequested };
}
/** Cancellation shares the private Provider boundary; the public card receives no transported strings or Run DTO. */
export function CancellationDecisionCard({ presentation: raw, work, labels, pending, onDecide }: { readonly presentation: CancellationCardPresentation; readonly pending?: boolean; readonly work: WorkSurfaceLabels; readonly labels: ApprovalDecisionLabels; readonly onDecide: (yes: boolean) => void }) {
  const known = useHumanTextSecrets(), p = (text: string) => projectApprovalDecisionText(text, known);
  // T2 integration: the phases read as counts in words (L3 card words) and the title carries the short run id; the full id is a detail line.
  const card = work.workerLine.card, phases = card ? formatTaskPhases(raw.displayPhases, card) : raw.displayPhases;
  return <DecisionCard title={approvalTemplateLine(work.cancelTitle, { run: p(shortId(raw.displayRun)) })} projectedLines={[approvalTemplateLine(work.cancelDetail, { revision: p(String(raw.displayRevision)), scope: p(raw.displayScope), phases: p(phases) }),
    ...(raw.cancellationRequested ? [approvalTemplateLine(work.cancelAlreadyRequested, {})] : []), ...(work.cancelIdentity ? [approvalTemplateLine(work.cancelIdentity, { run: p(raw.displayRun) })] : [])]}
    decisionLabels={labels} prompt={work.cancelPrompt} pendingText={work.cancelPending} position={work.window.position} {...(pending === undefined ? {} : { pending })} onDecide={yes => onDecide(yes)} />;
}
/**
 * A generic window of the panel (TS-WINDOW): a confirmation answers `allow` only on a typed `y` (`n`, Enter, Esc deny); an information
 * window closes on Esc, Enter or `q`. Its body passes the same decision projection as every other transported line.
 */
export function PanelWindow({ window: value, labels, pending, position, onAnswer }: { readonly window: PanelWindowPresentation; readonly labels: ApprovalDecisionLabels;
  readonly pending: boolean; readonly position?: string | undefined; readonly onAnswer: (answer: 'allow' | 'deny' | 'close') => void }) {
  const known = useHumanTextSecrets(), lines = value.body.map(text => approvalTemplateLine('{text}', { text: projectApprovalDecisionText(text, known) }));
  const title = approvalTemplateLine('{text}', { text: projectApprovalDecisionText(value.title, known) });
  if (value.confirm) return <DecisionCard title={title} projectedLines={lines} decisionLabels={labels} prompt={value.hints} pendingText={value.hints} pending={pending}
    {...(position ? { position } : {})} onDecide={yes => onAnswer(yes ? 'allow' : 'deny')} />;
  return <Window title={title.spans} body={decisionWindowLines(lines, labels)} hints={value.hints} position={position ?? '{from}-{to}/{total}'}
    onInput={(input, key) => { if (key.return || input === 'q') { onAnswer('close'); return true; } return false; }} onClose={() => onAnswer('close')} />;
}
