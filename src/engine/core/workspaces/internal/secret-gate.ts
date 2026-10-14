import { randomUUID } from 'node:crypto';
import { AUDIT_EVENT_SCHEMA_VERSION, AUDIT_TRACKED_PATHS_MAX, type AttemptIdentity, type AuditEvent } from '#domain/index.js';
import { ErrorRegistry } from '#platform/index.js';
import type { AttemptStore } from '#engine/core/attempts/index.js';
import { recordWorkerTreeExclusions, type WorkerTreeExclusion } from './exclusion-receipt.js';

export type WorkerTreeLimit = 'files' | 'file-bytes' | 'total-bytes' | 'time';
/** One refused path of the worker tree and the rule that matched it (`deny-path:<glob>`, `pattern:<id>`, `known-secret`); never a value. */
export interface WorkerTreeFinding { readonly path: string; readonly rule: string }
/** The adapter's scan of the exact tree a worker would receive: clean, refused paths (sorted, `count` the full number) or the bound that stopped it. */
/** `excluded` (present only when non-empty): hits the operator's `execution.secretGate` lists lifted, each with the entry that lifted it. */
export type WorkerTreeScan = Readonly<{ status: 'clean'; excluded?: readonly WorkerTreeExclusion[] } | { status: 'refused'; findings: readonly WorkerTreeFinding[]; count: number; excluded?: readonly WorkerTreeExclusion[] }
  | { status: 'incomplete'; limit: WorkerTreeLimit; observed: number; bound: number }>;
/** Paths the person's refusal text names; the audit record keeps up to `AUDIT_TRACKED_PATHS_MAX`. */
export const WORKER_TREE_SHOWN_PATHS = 16;
/** The `execution.secretGate` member that bounds each limit: the refusal names the setting to raise, language-neutral. */
const LIMIT_FIELDS: Readonly<Record<WorkerTreeLimit, string>> = Object.freeze({ files: 'maxFiles', 'file-bytes': 'maxFileBytes', 'total-bytes': 'maxTotalBytes', time: 'timeoutMs' });
export interface WorkerTreeGateContext {
  readonly identity: AttemptIdentity;
  readonly principal: Readonly<{ issuer: string; subject: string }>;
  readonly policyRevision: string;
  readonly now: () => number;
  /** The attempt journal: a dispatched attempt's config exclusions are kept there for every Run card. */
  readonly journal: AttemptStore;
}

/**
 * S6 (owner 2026-10-14): the one decision of the pre-dispatch secret gate. A clean tree passes (its config exclusions audited and journalled
 * first). Otherwise the refusal is recorded
 * in the Core audit (paths and rule ids only), the prepared checkout is released and a typed refusal is thrown before any container,
 * connection or dispatch claim. No audit, no closure: an unrecordable refusal throws the audit failure (transient; still nothing dispatched)
 * so the next turn scans and records again instead of closing the attempt without evidence.
 */
export async function enforceWorkerTreeGate(scan: WorkerTreeScan, context: WorkerTreeGateContext,
  record: (event: AuditEvent) => Promise<unknown>, release: () => Promise<unknown>): Promise<void> {
  if (scan.status === 'clean') {
    // S6 (owner 2026-10-15): every lifted hit is audited (path, rule, lifting entry — never a value) and journalled before the launch.
    // No audit, no dispatch: either failure is thrown and nothing starts.
    if (!scan.excluded?.length) return;
    const { identity, principal } = context;
    await record({ schemaVersion: AUDIT_EVENT_SCHEMA_VERSION, eventId: randomUUID(), scopeId: identity.scopeId,
      principal: { issuer: principal.issuer, subject: principal.subject }, policyRevision: context.policyRevision, atMs: context.now(),
      subject: { kind: 'worker-tree-excluded', runId: identity.runId, taskId: identity.taskId, attemptId: identity.attemptId, count: scan.excluded.length,
        entries: scan.excluded.slice(0, AUDIT_TRACKED_PATHS_MAX).map(({ path, rule, by }) => ({ path, rule, by })) } });
    await recordWorkerTreeExclusions(context.journal, identity, scan.excluded);
    return;
  }
  const refused = scan.status === 'refused', findings = refused ? scan.findings : [];
  const code = refused ? 'WORKER_TREE_SECRET_REFUSED' as const : 'WORKER_TREE_SCAN_INCOMPLETE' as const;
  const { identity, principal } = context;
  const event: AuditEvent = { schemaVersion: AUDIT_EVENT_SCHEMA_VERSION, eventId: randomUUID(), scopeId: identity.scopeId,
    principal: { issuer: principal.issuer, subject: principal.subject }, policyRevision: context.policyRevision, atMs: context.now(),
    subject: { kind: 'worker-tree-refused', runId: identity.runId, taskId: identity.taskId, attemptId: identity.attemptId, code,
      count: refused ? scan.count : 0, findings: findings.slice(0, AUDIT_TRACKED_PATHS_MAX).map(({ path, rule }) => ({ path, rule })),
      limit: refused ? null : scan.limit } };
  try { await record(event); } finally { await release().catch(() => undefined); }
  if (!refused) throw ErrorRegistry.createError(code, { params: { limit: LIMIT_FIELDS[scan.limit], observed: scan.observed, bound: scan.bound } });
  const shown = findings.slice(0, WORKER_TREE_SHOWN_PATHS);
  throw ErrorRegistry.createError(code, { params: { count: scan.count, paths: shown.map(finding => `${finding.path} (${finding.rule})`).join(', '),
    omitted: scan.count - shown.length } });
}
