import { type RunView, type SurfaceSnapshotAccess, sessionApprovalResultSchema, acceptSessionStandingClearance, runLifecycleCommandSchema } from '#engine/index.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { shortId, t, type ConfigLoadOptions, type Locale } from '#platform/index.js';
import { approvalDecisionClass, approvalFacts, approvalRecordSchema, approvalSubject, type ApprovalFacts, type ApprovalRecord } from '#domain/index.js';
import type { StandingScope } from '#surfaces/core/terminal/index.js';
import type { RunCancellationDeliveryHandler, RunCancellationRenderer, RunLifecycleHandler, RunQueryHandler } from './context.js';
import { renderWorkerTranscript, type WorkerObservationHandler, type InventoryQueryHandler, type WorkerTranscriptHandler } from '#surfaces/core/monitor/index.js';
import type { WorklineApproval, WorklineLedgerPorts } from '#surfaces/core/terminal-ledger/index.js';

import { ticketSummaryBlock, queueSummaryRequest, DELIVERY_RENDER_LIMITS, type DeliverySummaryReader } from '#surfaces/core/delivery-summary/index.js';
import { withSurfaceSnapshot } from '#surfaces/core/terminal-admin/index.js';

const approvalPageSchema = z.array(approvalRecordSchema);

/** The card's risk and undo words from the producer's facts (B1 single card); a v1/v2 record declared none (`null`, shown as not declared). */
const riskWord = (risk: ApprovalFacts['risk']) => !risk ? null : risk.source === 'cell' ? risk.cell : `${risk.effectClass}${risk.authority ? ' · authority' : ''}`;
const undoWord = (undo: ApprovalFacts['reversibility']) => !undo ? null : undo.kind === 'compensation' ? `${undo.operation.id}@${undo.operation.version}` : undo.kind;
function approvalDeciderLabel(record: ApprovalRecord, locale?: Locale): string {
  const kind = record.decision ? approvalDecisionClass(record.decision) : 'unknown';
  if (kind === 'human-tty') return t('approval.decider.human-tty', {}, locale);
  if (kind === 'ai-policy') return t('approval.decider.ai-policy', {}, locale);
  if (kind === 'system') return t('approval.decider.system', {}, locale);
  return t('approval.decider.unknown', {}, locale);
}
function approvalView(record: ApprovalRecord, locale?: Locale): WorklineApproval {
  const { request } = record, subject = approvalSubject(request), facts = approvalFacts(request);
  // A tool-call approval (C12) has no run or task: its summary names the tool, resource and argument digest.
  return Object.freeze({ approvalId: request.approvalId, runId: subject.kind === 'task' || subject.kind === 'run-create' ? subject.runId : '-', taskId: subject.kind === 'task' ? subject.taskId : '-', summary: request.summary,
    requester: request.requester.id, revision: record.revision, status: record.status, decision: record.decision?.decision ?? null, expiresAt: request.expiresAt,
    risk: riskWord(facts?.risk ?? null), undo: undoWord(facts?.reversibility ?? null), ...(facts ? { requiredAssurance: facts.requiredAssurance } : {}),
    ...(record.decision ? { deciderLabel: approvalDeciderLabel(record, locale) } : {}),
    createdAt: request.createdAt, ...(subject.kind === 'agent-tool-call' ? { tool: subject.tool, target: subject.resource } : {}),
    ...(subject.kind === 'config-change' ? { config: { action: subject.action, layer: subject.layer, keyPath: subject.keyPath, ruleId: subject.ruleId } } : {}) });
}

/** The Run state a control left, in the session language (the Runs list's own state words). */
function runStateWord(state: RunView['state'], locale: Locale): string {
  if (state.kind === 'running') return t('terminal.jobs.state.running', {}, locale);
  if (state.kind === 'parked') return t('terminal.jobs.state.parked', {}, locale);
  switch (state.outcome) {
    case 'completed': return t('terminal.jobs.state.completed', {}, locale);
    case 'incomplete': return t('terminal.jobs.state.incomplete', {}, locale);
    case 'failed': return t('terminal.jobs.state.failed', {}, locale);
    case 'cancelled': return t('terminal.jobs.state.cancelled', {}, locale);
    default: return t('terminal.jobs.state.unknown', {}, locale);
  }
}

/** Terminal ports over the same handlers as the CLI commands (`workers`, `run`, `inventory`, `approvals`, `task transcript`, `run cancel`). */
export function createWorklineLedgerPorts(input: {
  readonly root: string; readonly scopeId: string; readonly options: ConfigLoadOptions; readonly locale?: Locale; readonly workerHeartbeatMs?: number;
  /** Page limit for approval listing (`approvals.pageSize`); the runtime rejects larger pages. */
  readonly approvalPageSize?: number;
  readonly inspectWorkers?: WorkerObservationHandler;
  readonly inspectRun?: RunQueryHandler;
  /** The queue rows' summaries of a Run window, from the delivery card's reader; absent: the rows show without them. */
  readonly describeQueueSummaries?: DeliverySummaryReader;
  readonly inspectInventory?: InventoryQueryHandler;
  readonly inspectWorkerTranscript?: WorkerTranscriptHandler;
  readonly listApprovals?: (input: unknown) => Promise<unknown>; readonly decideApproval?: (input: unknown) => Promise<unknown>;
  readonly clearSessionStanding?: (input: { schemaVersion: 1; scopeId: string; sessionId: string }) => Promise<unknown>;
  readonly followEvents?: WorklineLedgerPorts['followEvents'];
  readonly inspectSurfaceAccess?: () => Promise<SurfaceSnapshotAccess | null>;
  readonly inspectSurfaceRunIds?: () => Promise<readonly string[]>;
  readonly deliverRunCancellation?: RunCancellationDeliveryHandler;
  /** `deckent run hold|resume|close`'s own lifecycle application (Y1); absent: the Runs window offers no control keys. */
  readonly applyRunLifecycle?: RunLifecycleHandler;
  /** The host's cancellation text (CLI `run cancel`), given as a port. */
  readonly renderRunCancellation: RunCancellationRenderer;
}): WorklineLedgerPorts | undefined {
  if (!input.inspectWorkers || !input.inspectRun) return undefined;
  const { root, scopeId, options, inspectWorkers, inspectRun, inspectInventory, workerHeartbeatMs, inspectWorkerTranscript, listApprovals, decideApproval,
    deliverRunCancellation, renderRunCancellation, followEvents, applyRunLifecycle } = input;
  const locale = input.locale ?? 'en', pageSize = input.approvalPageSize ?? 100;
  return withSurfaceSnapshot({
    scopeId,
    ...(input.clearSessionStanding ? { async clearSessionStanding(sessionId: string) {
      const command = { schemaVersion: 1 as const, scopeId, sessionId };
      acceptSessionStandingClearance(command, await input.clearSessionStanding!(command));
    } } : {}),
    ...(followEvents ? { followEvents } : {}),
    ...(workerHeartbeatMs === undefined ? {} : { workerHeartbeatMs }),
    async listWorkers() { return inspectWorkers(root, { schemaVersion: 1, scopeId, after: null, limit: 20 }, options); },
    async inspectRun(runId: string) { return (await inspectRun(root, { schemaVersion: 1, scopeId, runId }, options)).run; },
    ...(input.describeQueueSummaries ? { async queueSummaryLines(views) {
      const read = await input.describeQueueSummaries!(root, views.map(view => queueSummaryRequest(view, DELIVERY_RENDER_LIMITS.cardTopPaths)), options).catch(() => null);
      return views.map((_, index) => ticketSummaryBlock(read?.[index] ?? null, undefined, locale));
    } } : {}),
    ...(input.inspectSurfaceRunIds ? { listRunIds: input.inspectSurfaceRunIds } : inspectInventory ? {
      async listRunIds() {
        const page = await inspectInventory(root, { schemaVersion: 1, scopeId, after: null, limit: 50 }, options);
        const ids = new Set<string>();
        for (const entry of page.page.entries) ids.add(entry.identity.runId);
        return Object.freeze([...ids]);
      },
    } : {}),
    // Same local SDK/CLI producer as `deckent task transcript`; attempt `read-output` is enforced there.
    ...(inspectWorkerTranscript ? {
      async inspectTranscript(attempt) {
        return renderWorkerTranscript(await inspectWorkerTranscript(root, attempt, options), locale);
      },
    } : {}),
    // Approvals go through the runtime service like `deckent approvals list|decide`: the service authenticates the
    // connecting peer and opens the live local session for the decision; the terminal adds no authority of its own.
    ...(listApprovals && decideApproval ? {
      async listApprovalPage(afterId: string | null) {
        const records = approvalPageSchema.parse(await listApprovals({ schemaVersion: 1, scopeId, afterId, limit: pageSize }));
        const items = records.map(record => approvalView(record, locale));
        return Object.freeze({ items: Object.freeze(items), nextAfter: items.length >= pageSize ? items.at(-1)!.approvalId : null });
      },
      // B1: the card declares itself and forwards its turn's one-time capability when it has one (the same single y; nothing else to type).
      async decideApproval(approval: Pick<WorklineApproval, 'approvalId' | 'revision' | 'decisionCapability'>, decision: 'allow' | 'deny', standing?: StandingScope, typed?: string) {
        // The person's own reason (Tab on the card, kept within the record's bound there) goes to the decision record trimmed; none: the default.
        const own = typed?.trim();
        const result = await decideApproval({ schemaVersion: 1, scopeId, approvalId: approval.approvalId,
          commandId: `terminal-${randomUUID()}`, expectedRevision: approval.revision, decision, channel: 'local-terminal-card',
          ...(standing === 'session' ? { standing: 'session' } : {}),
          ...(approval.decisionCapability ? { decisionCapability: approval.decisionCapability } : {}),
          reason: own || (decision === 'allow' ? t('terminal.approval.reasonAllow', {}, locale) : t('terminal.approval.reasonDeny', {}, locale)),
          // APPROVER-NOTE (v21): the person's own words are marked as theirs, so a turn's call gives them to the model as the approver's note.
          ...(own ? { approverNote: true } : {}) });
        if (standing === 'session') {
          const answer = sessionApprovalResultSchema.parse(result);
          return { ...approvalView(answer.record, locale), standing: answer.standing };
        }
        const record = approvalRecordSchema.parse(result);
        return standing ? { ...approvalView(record, locale), standing: { scope: standing, saved: false, reason: 'protocol' } } : approvalView(record, locale);
      },
    } : {}),
    // Same governed cancellation as `deckent run cancel`, against the revision the operator confirmed.
    ...(deliverRunCancellation ? {
      async cancelRun(runId: string, expectedRevision: number) {
        const commandId = `terminal-cancel-${randomUUID()}`;
        const result = await deliverRunCancellation(root, { schemaVersion: 1, commandId, scopeId, runId, action: 'cancel', expectedRevision }, options);
        return renderRunCancellation(result, commandId, scopeId, runId, locale);
      },
    } : {}),
    // Y1: the same lifecycle command as `deckent run hold|resume|close` against the revision the person confirmed; policy and the
    // service's state rules decide (a refusal is the typed error, rendered by the window). Nothing here pre-decides eligibility.
    ...(applyRunLifecycle ? {
      async controlRun(runId: string, action: 'hold' | 'resume' | 'close', expectedRevision: number, typed?: string) {
        const commandId = `terminal-run-${action}-${randomUUID()}`, own = typed?.trim();
        const command = runLifecycleCommandSchema.parse(action === 'hold'
          ? { schemaVersion: 1, commandId, scopeId, runId, action, holdReason: own || t('terminal.runControl.reasonDefault', {}, locale), expectedRevision }
          : { schemaVersion: 1, commandId, scopeId, runId, action, expectedRevision });
        const result = await applyRunLifecycle(root, command, options), run = result?.lifecycle.run;
        const params = { run: shortId(runId), command: commandId, revision: run?.revision ?? '—', state: run ? runStateWord(run.state, locale) : '—' };
        return action === 'hold' ? t('terminal.runControl.result.hold', params, locale)
          : action === 'resume' ? t('terminal.runControl.result.resume', params, locale) : t('terminal.runControl.result.close', params, locale);
      },
      // BR2 (K7 port): the same in-process lifecycle command as `deckent run resume --task --answer` (CLI `run-control.ts`); no service protocol change
      // and no MCP surface (answering is a human decision). The answer is the person's own text; the schema bounds it.
      async answerTask(runId: string, taskId: string, answer: string, expectedRevision: number) {
        const commandId = `terminal-run-answer-${randomUUID()}`;
        const command = runLifecycleCommandSchema.parse({ schemaVersion: 1, commandId, scopeId, runId, action: 'answer', taskId, answer, expectedRevision });
        const result = await applyRunLifecycle(root, command, options), run = result?.lifecycle.run;
        return t('terminal.runAnswer.result', { run: shortId(runId), command: commandId, revision: run?.revision ?? '—', state: run ? runStateWord(run.state, locale) : '—' }, locale);
      },
    } : {}),
  }, input.inspectSurfaceAccess);
}
