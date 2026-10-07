import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { approvalRequestSchema, approvalSubject, encodeCommandProjection, ApprovalError, EffectError, type ApprovalActor, type ApprovalFacts, type ApprovalRecord, type ApprovalSubject,
  type EffectCommand, type EffectIntentApproval, type VerifiedPrincipal } from '#domain/index.js';
import { MAX_WALL_SKEW_MS, sha256, type ClockSample, type TrustedClock, type IntegrityAuthority } from '#platform/index.js';
import type { EffectApprovalGate } from '#engine/core/effect/index.js';
import type { ApprovalStore } from './store.js';
import { approvalRequestDigest, expireApproval, sealApproval, verifyApproval } from './integrity.js';
import { undeclaredAgentToolApprovalFacts } from './assurance.js';

type ToolCallSubject = Extract<ApprovalSubject, { kind: 'agent-tool-call' }>;
/** The action an agent tool-call approval authorizes: exactly this call of this turn, tool version, resource and arguments (C12). */
export const agentToolCallActionDigest = (scopeId: string, subject: ToolCallSubject) =>
  sha256(encodeCommandProjection('agent-tool-call:1', { scopeId, subject }));

/**
 * Opens (or returns the existing) pending approval of one agent tool call. Producer-only: the subject, digest and times come from the
 * engine's own turn state, never from a caller. Idempotent on the action digest, so a retried open never creates a second request.
 * Request v3 (B1): `facts` from the turn's permission cell; a producer that cannot name the cell (an MCP trust card) declares no risk,
 * and such a card needs the turn's own capability (unknown risk fails closed).
 */
export function requestAgentToolApproval(store: ApprovalStore, integrity: IntegrityAuthority, input: { readonly scopeId: string;
  readonly subject: ToolCallSubject; readonly requester: ApprovalActor; readonly policyRevision: string; readonly summary: string;
  readonly createdAt: number; readonly expiresAt: number; readonly facts?: ApprovalFacts }): ApprovalRecord {
  const actionDigest = agentToolCallActionDigest(input.scopeId, input.subject);
  const existing = store.findToolCall(input.scopeId, actionDigest);
  if (existing) return verifyApproval(existing, integrity);
  const request = approvalRequestSchema.parse({ schemaVersion: 3, approvalId: randomUUID(), scopeId: input.scopeId, subject: input.subject,
    requester: input.requester, actionDigest, policyRevision: input.policyRevision, summary: input.summary.slice(0, 2048),
    createdAt: input.createdAt, expiresAt: input.expiresAt, facts: input.facts ?? undeclaredAgentToolApprovalFacts(input.scopeId) });
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
  clock: TrustedClock, signal: AbortSignal, pollMs = 250, started: ClockSample = clock.sample()): Promise<AgentToolApprovalOutcome> {
  const { scopeId, approvalId, expiresAt } = record.request;
  // The producer passes its creation sample so preview/persistence time also spends the original TTL.
  const deadline = started.monotonicMs + Math.max(0, expiresAt - started.wallMs);
  const remaining = () => { const now = clock.sample(); return Math.min(expiresAt - now.wallMs, deadline - now.monotonicMs); };
  const settled = (current: ApprovalRecord): AgentToolApprovalOutcome | null =>
    current.status === 'expired' ? 'expired' : current.status === 'decided' ? current.decision?.decision === 'allow' ? 'allow' : 'deny' : null;
  for (;;) {
    const loaded = store.load(scopeId, approvalId);
    const current = loaded ? verifyApproval(loaded, integrity) : null;
    if (!current) return 'expired';
    // A terminal decision is durable history, not permission to consume an allow after expiry or cancellation.
    if (signal.aborted) { if (current.status === 'pending') await closeExpired(store, integrity, current); return 'cancelled'; }
    const left = remaining();
    if (left <= 0) { if (current.status === 'pending') await closeExpired(store, integrity, current); return 'expired'; }
    const stored = settled(current);
    if (stored) return stored;
    await new Promise<void>(resolve => {
      const timer = setTimeout(done, Math.max(1, Math.min(pollMs, left)));
      function done() { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); }
      signal.addEventListener('abort', done, { once: true });
    });
  }
}

/**
 * APPROVER-NOTE (owner 2026-10-07): the decider's own words on a decided tool-call approval — its sealed reason when the decision marks it as
 * theirs (`approverNote`), else null (a surface's default sentence, an expired or undecided record, a record that does not verify).
 */
export function agentToolApprovalNote(store: ApprovalStore, integrity: IntegrityAuthority, record: ApprovalRecord): string | null {
  const loaded = store.load(record.request.scopeId, record.request.approvalId);
  const current = loaded ? verifyApproval(loaded, integrity) : null;
  return current?.status === 'decided' && current.decision?.approverNote === true ? current.decision.reason : null;
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

/** One agent tool call at its effect (C12 G3): the subject rebuilt from the call being executed, and which stored approval the owner's allow
 * named (null when the owner was not asked). The reference only says which record to read; it never admits anything by itself. */
export interface AgentToolCallAdmission {
  readonly scopeId: string;
  readonly subject: ToolCallSubject;
  readonly approval: (EffectIntentApproval & { readonly started: ClockSample }) | null;
}

/**
 * The effect approval gate of one agent tool call (C12 G3): authority comes from the durable `agent-tool-call` record, never from turn
 * state. A call needs it when the effect decision asks (`require-approval` or a required descriptor) or when the owner was asked for it
 * (tool decision, write floor, shell risk). Then the command is admitted only by a sealed (MAC) `allow` whose subject and action digest
 * are exactly this call — rebuilt from the executed arguments, not copied from the request — requested by this principal, decided on the
 * request it names, and still inside its expiry at the claim (wall clock and the producer's monotonic TTL, I40-c). The claimed intent
 * pins the approval (its consumption); every later pass of that command verifies the pinned record without a window, even without a
 * pointer, and a terminal record replays untouched. `consumed` (per turn) keeps one approval to one command; across processes the subject's call position and the
 * turn's durable claim do (a turn runs once).
 */
export function agentToolCallApprovalGate(records: () => Promise<{ readonly store: ApprovalStore; readonly integrity: IntegrityAuthority }>, clock: TrustedClock,
  call: AgentToolCallAdmission, consumed: Map<string, string>): EffectApprovalGate {
  const expectedDigest = agentToolCallActionDigest(call.scopeId, call.subject);
  const verified = async (reference: EffectIntentApproval, command: EffectCommand, principal: VerifiedPrincipal) => {
    if (command.scopeId !== call.scopeId) throw new ApprovalError('APPROVAL_CONFLICT');
    // Opened only for a call that needs its record: a call nobody was asked for and the effect allows reads no approval.
    const { store, integrity } = await records();
    const loaded = store.load(command.scopeId, reference.approvalId);
    if (!loaded) throw new ApprovalError('APPROVAL_MISSING');
    const record = verifyApproval(loaded, integrity), { request } = record;
    const requester = request.requester;
    if (request.scopeId !== call.scopeId || !isDeepStrictEqual(approvalSubject(request), call.subject) || request.actionDigest !== expectedDigest
      || reference.actionDigest !== expectedDigest || requester.id !== principal.id || requester.issuer !== principal.issuer || requester.subject !== principal.subject) {
      throw new ApprovalError('APPROVAL_CONFLICT');
    }
    if (record.status === 'pending') throw new ApprovalError('APPROVAL_REQUIRED');
    if (record.status === 'expired') throw new ApprovalError('APPROVAL_EXPIRED');
    if (record.decision?.decision !== 'allow') throw new ApprovalError('APPROVAL_DENIED');
    if (record.decision.requestDigest !== approvalRequestDigest(request)) throw new ApprovalError('APPROVAL_INTEGRITY');
    return record;
  };
  return {
    async admit(descriptor, decision, command, principal, context) {
      const { record } = context;
      // A terminal record replays its outcome: nothing is admitted again.
      if (record && (record.state === 'settled' || record.state === 'refused')) return;
      // Consumed: the intent pinned this approval; it is still the sealed allow of exactly this call, whatever the clock says now.
      if (record?.intent.approval) { await verified(record.intent.approval, command, principal); return { approval: record.intent.approval }; }
      if (descriptor.approval !== 'required' && decision === 'allow' && !call.approval) return;
      if (!call.approval) throw new EffectError('EFFECT_APPROVAL_REQUIRED');
      const reference: EffectIntentApproval = { approvalId: call.approval.approvalId, actionDigest: call.approval.actionDigest };
      const stored = await verified(reference, command, principal);
      const user = consumed.get(reference.approvalId);
      if (user !== undefined && user !== command.commandId) throw new ApprovalError('APPROVAL_CONFLICT');
      // Admission is measured now (and again right before the claim): the owner's allow is usable only inside the request's expiry.
      const now = clock.sample(), { started } = call.approval, { expiresAt } = stored.request;
      if (now.wallMs >= expiresAt || now.monotonicMs - started.monotonicMs >= expiresAt - started.wallMs) throw new ApprovalError('APPROVAL_EXPIRED');
      if (stored.decision!.decidedAt > now.wallMs + MAX_WALL_SKEW_MS) throw new ApprovalError('APPROVAL_CONFLICT');
      consumed.set(reference.approvalId, command.commandId);
      return { approval: reference };
    },
  };
}
