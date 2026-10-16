import { createHash } from 'node:crypto';
import { attemptSnapshotSchema, approvalRecordSchema, runSnapshotSchema, parseModelInvocationReceipt, modelInvocationPlanUsageSchema,
  modelActivationRecordSchema, modelCatalogActivationRecordSchema, modelCatalogChannelRecordSchema, modelCatalogModelRecordSchema } from '#domain/index.js';
import { RuntimeEventsError, runtimeEventsRecordSchema, type RuntimeEventsSelection, type RuntimeObservationRow,
  type RuntimeObservationCapture, type RuntimeEventsRecord } from '#engine/core/runtime/index.js';
import type { RuntimeEventsSettings, IntegrityAuthority } from '#platform/index.js';
import { parseProviderSpendCheckpoint } from '#engine/core/provider-spend/index.js';
import { verifyApproval } from '#engine/core/approval/index.js';
import { dispatchRecordSchema } from '#engine/core/dispatch/index.js';
import { workerEventLogSchema } from '#engine/core/worker-observation/index.js';

export type RuntimeObservationTable = { scope?: false; name: string; field: string; project: (raw: unknown, row: RuntimeObservationStoredRow, now: number) => RuntimeObservationRow };
export type RuntimeObservationStoredRow = { n: number; value: string | null; size: number; digest?: string; reservation_count?: number; watermark?: number; revision?: number; state?: string };
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

/** Storage-independent bounded DTO capture; the adapter owns the enclosing read transaction. */
export function captureRuntimeObservation(query: RuntimeEventsSelection, limits: RuntimeEventsSettings, now: number, integrity: IntegrityAuthority | undefined, ports: {
  page(table: RuntimeObservationTable, scopeId: string, after: number, limit: number, bytes: number): RuntimeObservationStoredRow[];
  planInvocation(scopeId: string, invocationId: string, bytes: number): { size: number; value: string | null } | undefined;
  now(): number;
}): RuntimeObservationCapture {
  const rows: RuntimeObservationRow[] = []; let bytes = 0;
  const base = (topic: RuntimeEventsRecord['topic'], entity: RuntimeEventsRecord['entity'], id: string, revision: number, status: RuntimeEventsRecord['status']) =>
    ({ topic, entity, id, revision, status, observedAt: now, evidence: 'ledger' as const, sourceLoss: false });
  const tables: RuntimeObservationTable[] = [];
  if (query.topics.includes('run')) tables.push({ name: 'runs', field: 'snapshot', project(raw, row) {
    const v = runSnapshotSchema.parse(raw); if (v.identity.scopeId !== query.scopeId || v.revision !== row.revision) throw new Error('binding');
    return { record: { ...base('run', 'run', v.identity.runId, v.revision, v.state.kind), cancelRequested: v.cancelRequested }, watermark: String(v.revision) };
  } }, { name: 'attempts', field: 'snapshot', project(raw, row) {
    const v = attemptSnapshotSchema.parse(raw); if (v.identity.scopeId !== query.scopeId || v.revision !== row.revision) throw new Error('binding');
    return { identity: v.identity, record: { ...base('run', 'attempt', v.identity.attemptId, v.revision, v.lastObservation?.result.kind ?? 'reserved'),
      runId: v.identity.runId, taskId: v.identity.taskId, attemptId: v.identity.attemptId, cancelRequested: v.cancelRequested }, watermark: String(v.revision) };
  } });
  if (query.topics.includes('approval')) tables.push({ name: 'approvals', field: 'snapshot', project(raw, row) {
    const v = verifyApproval(approvalRecordSchema.parse(raw), integrity!); if (v.request.scopeId !== query.scopeId || v.revision !== row.revision) throw new Error('binding');
    const status = v.status === 'pending' && v.request.expiresAt <= now ? 'expired' : v.status;
    return { record: { ...base('approval', 'approval', v.request.approvalId, v.revision, status), expiresAt: v.request.expiresAt }, watermark: `${v.revision}:${status}:${row.watermark}` };
  } });
  if (query.topics.includes('worker')) tables.push({ name: 'dispatches', field: 'record', project(raw) {
    // The existing dispatch validator is applied by the live collector before a private path is opened.
    const v = dispatchRecordSchema.parse(raw), identity = v.request.identity;
    if (identity.scopeId !== query.scopeId) throw new Error('binding');
    return { identity, ...(v.terminal ? {} : { workspace: v.request.workspace }), record: { ...base('worker', 'worker', identity.attemptId, v.grant?.generation ?? 0, v.terminal ? 'terminal' : 'unknown'),
      runId: identity.runId, taskId: identity.taskId, attemptId: identity.attemptId }, watermark: hash(JSON.stringify(raw)) };
  } });
  if (query.topics.includes('worker')) tables.push({ name: 'worker_event_logs', field: 'record', project(raw) {
    const v = workerEventLogSchema.parse(raw); if (v.identity.scopeId !== query.scopeId) throw new Error('binding');
    return { identity: v.identity, record: { ...base('worker', 'worker-log', v.identity.attemptId, v.eventCount, 'available'), eventCount: v.eventCount,
      runId: v.identity.runId, taskId: v.identity.taskId, attemptId: v.identity.attemptId, sourceLoss: v.projection === 'partial' }, watermark: hash(JSON.stringify(raw)) };
  } });
  if (query.topics.includes('usage')) tables.push({ name: 'provider_spend_accounts', field: 'record', project(raw, row) {
    const v = parseProviderSpendCheckpoint({ schemaVersion: 2, account: raw, revision: row.revision, digest: row.digest, reservationCount: row.reservation_count }).account; if (v.budget.scopeId !== query.scopeId) throw new Error('binding');
    return { budgetId: v.budget.budgetId, record: { ...base('usage', 'account', v.budget.budgetId, row.revision!, 'available'),
      currency: v.budget.currency, usageBasis: 'account-checkpoint', settledMinorUnits: v.settledMinorUnits, reservedMinorUnits: v.reservedMinorUnits, limitMinorUnits: v.budget.limitMinorUnits }, watermark: String(row.revision) };
  } }, { name: 'model_invocations', field: 'record', project(raw, row) {
    const v = parseModelInvocationReceipt(raw); if (v.request.scopeId !== query.scopeId) throw new Error('binding');
    return { reference: v.request.reference, record: base('usage', 'invocation', v.claim.invocationId, 0, row.state as RuntimeEventsRecord['status']), watermark: hash(JSON.stringify(raw)) };
  } }, { name: 'model_invocation_plan_usage', field: 'record', project(raw) {
    const v = modelInvocationPlanUsageSchema.parse(raw); if (v.scopeId !== query.scopeId) throw new Error('binding');
    // The corresponding invocation supplies its exact-reference inspection authority.
    const r = ports.planInvocation(query.scopeId, v.invocationId, limits.maxSnapshotBytes - bytes);
    if (!r?.value) throw new RuntimeEventsError('RUNTIME_EVENTS_TOO_LARGE'); bytes += r.size;
    const invocation = parseModelInvocationReceipt(JSON.parse(r.value));
    return { reference: invocation.request.reference, record: { ...base('usage', 'plan-usage', v.invocationId, 0, v.source === 'unavailable' ? 'unavailable' : 'available'), usageBasis: 'plan-usage' }, watermark: hash(JSON.stringify(raw)) };
  } });
  if (query.topics.includes('inventory')) tables.push({ name: 'model_activations', field: 'record', project(raw) {
    const v = modelActivationRecordSchema.parse(raw); if (v.scopeId !== query.scopeId) throw new Error('binding');
    return { reference: v.reference, record: { ...base('inventory', 'model', hash(JSON.stringify(v.reference)), v.revision, v.state), providerId: v.reference.providerId, modelId: v.reference.modelId }, watermark: String(v.revision) };
  } }, { name: 'model_catalog_activations', field: 'record', project(raw) {
    const v = modelCatalogActivationRecordSchema.parse(raw); if (v.scopeId !== query.scopeId) throw new Error('binding');
    return { catalogTarget: { channelId: v.channelId, modelId: v.modelId }, record: { ...base('inventory', 'model', hash(JSON.stringify([v.channelId, v.modelId])), v.revision, v.state), providerId: v.channelId, ...(v.modelId ? { modelId: v.modelId } : {}) }, watermark: String(v.revision) };
  } });
  if (query.topics.includes('inventory')) tables.push({ name: 'model_catalog_channels', scope: false, field: 'record', project(raw) {
    const v = modelCatalogChannelRecordSchema.parse(raw);
    return { catalogTarget: { channelId: v.channelId, modelId: null }, record: { ...base('inventory', 'catalog-channel', v.channelId, v.revision, 'registered'), providerId: v.channelId }, watermark: String(v.revision) };
  } }, { name: 'model_catalog_models', scope: false, field: 'record', project(raw) {
    const v = modelCatalogModelRecordSchema.parse(raw);
    return { catalogTarget: { channelId: v.channelId, modelId: null }, record: { ...base('inventory', 'catalog-model', hash(JSON.stringify([v.channelId, v.modelId])), v.revision, 'registered'), providerId: v.channelId, modelId: v.modelId }, watermark: String(v.revision) };
  } });
  const deadline = ports.now() + limits.snapshotDeadlineMs;
    for (const table of tables) {
      let after = 0;
      while (true) {
        if (ports.now() > deadline) throw new RuntimeEventsError('RUNTIME_EVENTS_LIMIT');
        // Closed table vocabulary above; page count and raw bytes are checked before materializing any JSON.
        const page = ports.page(table, query.scopeId, after, Math.min(limits.readPageSize, limits.maxSnapshotRows - rows.length + 1), limits.maxSnapshotBytes - bytes);
        if (!page.length) break;
        for (const row of page) {
          if (rows.length >= limits.maxSnapshotRows || row.value === null || row.size + bytes > limits.maxSnapshotBytes) throw new RuntimeEventsError('RUNTIME_EVENTS_TOO_LARGE');
          bytes += row.size; after = Number(row.n);
          const found = table.project(JSON.parse(row.value), row, now);
          rows.push({ ...found, record: runtimeEventsRecordSchema.parse(found.record) });
        }
      }
    }
  return { rows, sourceLoss: false };
}
