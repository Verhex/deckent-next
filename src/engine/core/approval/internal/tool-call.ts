import { randomUUID } from 'node:crypto';
import { approvalRequestSchema, encodeCommandProjection, type ApprovalActor, type ApprovalRecord, type ApprovalSubject } from '#domain/index.js';
import { sha256, type IntegrityAuthority } from '#platform/index.js';
import type { ApprovalStore } from './store.js';
import { sealApproval, verifyApproval } from './integrity.js';

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
/**
 * Waits for the decision of one tool-call approval: `allow`/`deny` as decided, `expired` at its expiry, `cancelled` when the turn is
 * cancelled. An expired or abandoned request is closed as expired, never left pending, and never permits the call.
 */
export async function awaitAgentToolApproval(store: ApprovalStore, integrity: IntegrityAuthority, record: ApprovalRecord,
  now: () => number, signal: AbortSignal, pollMs = 250): Promise<AgentToolApprovalOutcome> {
  const { scopeId, approvalId } = record.request;
  const close = (current: ApprovalRecord) => {
    if (current.status !== 'pending') return;
    try { store.transition(current, sealApproval({ request: current.request, revision: 1, status: 'expired', decision: null }, integrity)); }
    catch { /* A concurrent decision won: the stored record stays authoritative. */ }
  };
  for (;;) {
    const loaded = store.load(scopeId, approvalId);
    const current = loaded ? verifyApproval(loaded, integrity) : null;
    if (!current || current.status === 'expired') return 'expired';
    if (current.status === 'decided') return current.decision?.decision === 'allow' ? 'allow' : 'deny';
    if (signal.aborted) { close(current); return 'cancelled'; }
    if (now() >= current.request.expiresAt) { close(current); return 'expired'; }
    await new Promise<void>(resolve => {
      const timer = setTimeout(done, Math.max(1, Math.min(pollMs, current.request.expiresAt - now())));
      function done() { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); }
      signal.addEventListener('abort', done, { once: true });
    });
  }
}
