import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { t, type ConfigLoadOptions, type Locale } from '#platform/index.js';
import { approvalRecordSchema, type ApprovalRecord } from '#domain/index.js';
import type { RunCancellationDeliveryHandler, RunQueryHandler } from './run.js';
import { renderRunCancellation } from './run.js';
import type { WorkerObservationHandler } from './workers.js';
import type { InventoryQueryHandler } from './inventory.js';
import type { WorkerTranscriptHandler } from './transcript.js';
import { renderWorkerTranscript } from './transcript.js';
import type { WorklineApproval, WorklineLedgerPorts } from '#surfaces/core/terminal/index.js';

const approvalPageSchema = z.array(approvalRecordSchema);

function approvalView(record: ApprovalRecord): WorklineApproval {
  const { request } = record;
  return Object.freeze({ approvalId: request.approvalId, runId: request.runId, taskId: request.taskId, summary: request.summary,
    requester: request.requester.id, revision: record.revision, status: record.status, decision: record.decision?.decision ?? null, expiresAt: request.expiresAt });
}

/** Terminal ports over the same handlers as the CLI commands (`workers`, `run`, `inventory`, `approvals`, `task transcript`, `run cancel`). */
export function createWorklineLedgerPorts(input: {
  readonly root: string;
  readonly scopeId: string;
  readonly options: ConfigLoadOptions;
  readonly locale?: Locale;
  readonly workerHeartbeatMs?: number;
  /** Page limit for approval listing (`approvals.pageSize`); the runtime rejects larger pages. */
  readonly approvalPageSize?: number;
  readonly inspectWorkers?: WorkerObservationHandler;
  readonly inspectRun?: RunQueryHandler;
  readonly inspectInventory?: InventoryQueryHandler;
  readonly inspectWorkerTranscript?: WorkerTranscriptHandler;
  readonly listApprovals?: (input: unknown) => Promise<unknown>;
  readonly decideApproval?: (input: unknown) => Promise<unknown>;
  readonly deliverRunCancellation?: RunCancellationDeliveryHandler;
}): WorklineLedgerPorts | undefined {
  if (!input.inspectWorkers || !input.inspectRun) return undefined;
  const { root, scopeId, options, inspectWorkers, inspectRun, inspectInventory, workerHeartbeatMs, inspectWorkerTranscript, listApprovals, decideApproval,
    deliverRunCancellation } = input;
  const locale = input.locale ?? 'en';
  const pageSize = input.approvalPageSize ?? 100;
  return {
    scopeId,
    ...(workerHeartbeatMs === undefined ? {} : { workerHeartbeatMs }),
    async listWorkers() {
      return inspectWorkers(root, { schemaVersion: 1, scopeId, after: null, limit: 20 }, options);
    },
    async inspectRun(runId: string) {
      const view = await inspectRun(root, { schemaVersion: 1, scopeId, runId }, options);
      return view.run;
    },
    ...(inspectInventory ? {
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
        const items = records.map(approvalView);
        return Object.freeze({ items: Object.freeze(items), nextAfter: items.length >= pageSize ? items.at(-1)!.approvalId : null });
      },
      async decideApproval(approval: Pick<WorklineApproval, 'approvalId' | 'revision'>, decision: 'allow' | 'deny') {
        const record = approvalRecordSchema.parse(await decideApproval({ schemaVersion: 1, scopeId, approvalId: approval.approvalId,
          commandId: `terminal-${randomUUID()}`, expectedRevision: approval.revision, decision,
          reason: decision === 'allow' ? t('terminal.approval.reasonAllow', {}, locale) : t('terminal.approval.reasonDeny', {}, locale) }));
        return approvalView(record);
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
  };
}
