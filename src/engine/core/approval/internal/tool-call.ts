import { randomUUID } from 'node:crypto';
import { approvalRequestSchema, approvalSubject, encodeCommandProjection, ApprovalError, type ApprovalActor, type ApprovalRecord, type ApprovalSubject } from '#domain/index.js';
import { sha256, type IntegrityAuthority } from '#platform/index.js';
import type { ApprovalStore } from './store.js';
import { expireApproval, sealApproval, verifyApproval } from './integrity.js';

type ToolCallSubject = Extract<ApprovalSubject, { kind: 'agent-tool-call' }>;
/** The action an agent tool-call approval authorizes: exactly this call of this turn, tool version, resource and arguments (C12). */
export const agentToolCallActionDigest = (scopeId: string, subject: ToolCallSubject) =>
  sha256(encodeCommandProjection('agent-tool-call:1', { scopeId, subject }));

/**
 * Opens (or returns the existing) pending approval of one agent tool call. Producer-only: the subject, digest and times come from the
 * engine's own turn state, never from a caller. Idempotent on the action digest, so a retried open never creates a second request.
 */
export function requestAgentToolApproval(store: ApprovalStore, integrity: IntegrityAuthority, input: { readonly scopeId: string;
  readonly subject: ToolCallSubject; readonly requester: ApprovalActor; readonly policyRevision: string; readonly summary: string;
  readonly createdAt: number; readonly expiresAt: number }): ApprovalRecord {
  const actionDigest = agentToolCallActionDigest(input.scopeId, input.subject);
  const existing = store.findToolCall(input.scopeId, actionDigest);
  if (existing) return verifyApproval(existing, integrity);
  const request = approvalRequestSchema.parse({ schemaVersion: 2, approvalId: randomUUID(), scopeId: input.scopeId, subject: input.subject,
    requester: input.requester, actionDigest, policyRevision: input.policyRevision, summary: input.summary.slice(0, 2048),
    createdAt: input.createdAt, expiresAt: input.expiresAt });
  return verifyApproval(store.create(sealApproval({ request, revision: 0, status: 'pending', decision: null }, integrity)), integrity);
}

export type AgentToolApprovalOutcome = 'allow' | 'deny' | 'expired' | 'cancelled';
/** Tolerance for a transient store failure while closing (attempts with a short backoff), not a policy or turn budget. */
const CLOSE_ATTEMPTS = 3, CLOSE_BACKOFF_MS = 20;

/**
 * Closes a pending request as expired. A failed transition is re-read: a terminal record means another writer settled it first and
 * that record is returned (it is authoritative). A record still pending or unreadable after the bounded attempts is
 * `APPROVAL_UNSETTLED`: a close is never reported as done when it did not happen (Astra 2092 R2).
 */
async function closeExpired(store: ApprovalStore, integrity: IntegrityAuthority, record: ApprovalRecord): Promise<ApprovalRecord> {
  let current = record;
  for (let attempt = 1; ; attempt++) {
    try { return expireApproval(store, integrity, current); } catch { /* re-read: a race or a failed write */ }
    let reread: ApprovalRecord | null;
    try { const loaded = store.load(record.request.scopeId, record.request.approvalId); reread = loaded ? verifyApproval(loaded, integrity) : null; }
    catch { reread = null; }
    if (reread && reread.status !== 'pending') return reread;
    if (attempt >= CLOSE_ATTEMPTS) throw new ApprovalError('APPROVAL_UNSETTLED');
    if (reread) current = reread;
    await new Promise(resolve => setTimeout(resolve, CLOSE_BACKOFF_MS * attempt));
  }
}

/**
 * Waits for the decision of one tool-call approval: `allow`/`deny` as decided, `expired` at its expiry, `cancelled` when the turn is
 * cancelled. An expired or abandoned request is durably closed as expired; if that close cannot be confirmed the wait throws
 * `APPROVAL_UNSETTLED` (the request then stays pending until its expiry or the service-start sweep). Nothing here permits a call
 * except a stored `allow`.
 */
export async function awaitAgentToolApproval(store: ApprovalStore, integrity: IntegrityAuthority, record: ApprovalRecord,
  now: () => number, signal: AbortSignal, pollMs = 250): Promise<AgentToolApprovalOutcome> {
  const { scopeId, approvalId } = record.request;
  const settled = (current: ApprovalRecord): AgentToolApprovalOutcome | null =>
    current.status === 'expired' ? 'expired' : current.status === 'decided' ? current.decision?.decision === 'allow' ? 'allow' : 'deny' : null;
  for (;;) {
    const loaded = store.load(scopeId, approvalId);
    const current = loaded ? verifyApproval(loaded, integrity) : null;
    if (!current) return 'expired';
    const stored = settled(current);
    if (stored) return stored;
    // A cancelled turn runs nothing, whatever a racing decision recorded; the close only keeps the request from staying decidable.
    if (signal.aborted) { await closeExpired(store, integrity, current); return 'cancelled'; }
    // At expiry the stored record wins: a decision committed just before the close is returned as decided.
    if (now() >= current.request.expiresAt) return settled(await closeExpired(store, integrity, current)) ?? 'expired';
    await new Promise<void>(resolve => {
      const timer = setTimeout(done, Math.max(1, Math.min(pollMs, current.request.expiresAt - now())));
      function done() { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); }
      signal.addEventListener('abort', done, { once: true });
    });
  }
}

/**
 * Service-start reconciliation: every agent tool-call approval still pending belongs to a turn that is no longer running (turns are
 * interrupted at start under endpoint custody), so it is closed as expired, one bounded page at a time. Task approvals are untouched.
 * A record that cannot be verified or closed is counted, never guessed.
 */
export function expireOrphanedToolCallApprovals(store: ApprovalStore, integrity: IntegrityAuthority, pageLimit: number) {
  let expired = 0, failed = 0, after: { readonly scopeId: string; readonly approvalId: string } | null = null;
  for (;;) {
    const page = store.pendingToolCalls(after, pageLimit);
    for (const { scopeId, approvalId } of page) {
      try {
        const loaded = store.load(scopeId, approvalId), current = loaded ? verifyApproval(loaded, integrity) : null;
        if (current?.status === 'pending' && approvalSubject(current.request).kind === 'agent-tool-call') { expireApproval(store, integrity, current); expired++; }
      } catch { failed++; }
    }
    if (page.length < pageLimit) return { expired, failed };
    after = page.at(-1)!;
  }
}
