import { AUDIT_EVENT_SCHEMA_VERSION, AUTHORITY_DOCUMENT_TARGET_KIND, POLICY_ADMINISTER_OPERATION, STANDING_GRANT_KIND, STANDING_GRANTS_MAX, authorityDocuments, delegationWithin, isStandingGrantId,
  planPolicyChange, policySchema, standingGrantChange, sessionPattern, standingGrantId, standingRevokeChange, type AuditEvent, type EffectCommand, type PolicyChange, type SessionCell, type StandingPattern,
  type VerifiedPrincipal } from '#domain/index.js';
import { sha256 } from '#platform/index.js';
import type { PolicySource } from '#engine/core/policy/index.js';
import type { EffectOutcome } from '#engine/core/effect/index.js';

/**
 * The standing-approval key of one agent call and whether this conversation already stands for it (`memory`), or null when the call's cell
 * or target cannot stand (static write floor, destructive shell, fetch, an unsafe or oversized target). Self-source permits a session
 * answer only, through a separate key. The application service composition asks.
 */
export function standingCallKey(call: { readonly tool: string; readonly cell: string; readonly path: string | null; readonly command: string | null },
  memory?: { readonly sessions: SessionStanding; readonly session: string }): { readonly key: string; readonly cell: StandingCellName; readonly session: boolean } | null {
  const found = sessionPattern(call);
  return found.ok ? { key: found.pattern.key, cell: found.pattern.cell, session: memory?.sessions.has(memory.session, found.pattern.key) ?? false } : null;
}

/** Cells a session answer may lower; persisted grants remain restricted to the domain's StandingCell. */
export type StandingCellName = SessionCell;

/** Typed refusals of the standing-approval application (never a silent no-op: the card tells the person what was not saved). */
export class StandingApprovalError extends Error {
  constructor(readonly code: 'STANDING_UNSUPPORTED' | 'STANDING_LIMIT' | 'STANDING_DELEGATION' | 'STANDING_NOT_FOUND' | 'STANDING_NOT_SETTLED', readonly detail: string | null = null) {
    super(code); this.name = 'StandingApprovalError';
  }
}

/**
 * "This session" memory (owner 2026-09-28): one service-process map, never a file — a restarted service starts empty. The key names the
 * scope, the person and the client's conversation (`sessionId`; a turn without one is its own session), so a standing approval never
 * crosses persons, scopes or conversations. Bounded per session; the oldest pattern leaves first.
 */
export class SessionStanding {
  private readonly sessions = new Map<string, Set<string>>();
  constructor(private readonly perSession = STANDING_GRANTS_MAX, private readonly maxSessions = 256) {}
  static sessionKey(scopeId: string, principal: { readonly issuer: string; readonly subject: string }, conversation: string) {
    return sha256(`standing-session:1\0${scopeId}\0${principal.issuer}\0${principal.subject}\0${conversation}`);
  }
  remember(session: string, key: string) {
    let keys = this.sessions.get(session);
    if (!keys) {
      keys = new Set();
      this.sessions.set(session, keys);
      for (const oldest of this.sessions.keys()) { if (this.sessions.size <= this.maxSessions) break; this.sessions.delete(oldest); }
    }
    keys.delete(key); keys.add(key);
    for (const oldest of keys) { if (keys.size <= this.perSession) break; keys.delete(oldest); }
  }
  has(session: string, key: string) { return this.sessions.get(session)?.has(key) ?? false; }
  forget(session: string) { this.sessions.delete(session); }
  clear() { this.sessions.clear(); }
}

export interface StandingGrantView { readonly id: string; readonly key: string; readonly tool: string; readonly kind: 'command' | 'directory' | 'unknown'; readonly text: string }
/** What the card may offer for "in this project always": the person's own persisted grant, or why not. */
export type StandingOffer = { readonly available: true } | { readonly available: false; readonly reason: 'unsupported' | 'limit' | 'delegation' };

export interface PersistentStandingDependencies {
  /** The authority producer of `policy.administer@1` (`PolicyAdministrationApplication.submit`). */
  readonly administration: { submit(input: EffectCommand, credential?: unknown): Promise<EffectOutcome> };
  /** Decides one pending operation approval `allow` as the person the card belongs to (the same session and channel as the card's decision). */
  readonly approve: (approval: { readonly approvalId: string; readonly revision: number }, commandId: string, reason: string) => Promise<unknown>;
  readonly policy: PolicySource;
}
const parseKey = (key: string): Pick<StandingGrantView, 'tool' | 'kind' | 'text'> => {
  const match = /^v1:([^:]+):(command|directory):([\s\S]*)$/u.exec(key);
  return match ? { tool: match[1]!, kind: match[2] as 'command' | 'directory', text: match[3]! } : { tool: '?', kind: 'unknown', text: key };
};

/**
 * Persisted standing approvals: the person's own `agent-tool-call` grants, written and removed only through `policy.administer@1`
 * (POLICY-ADMIN P3) — the same C11 intent, C12 sealed approval, delegation bound (I3, the decider's authority), `authority-change` audit and
 * archived two-file write as every governed policy change. The card was the person's answer, so no second card opens: the engine
 * submits the intent, decides the pending operation approval `allow` as that same person (company separation-of-duties data, if any,
 * applies to that decision too), and resubmits the same command. A person cannot persist what they do not hold: the bound refuses it.
 */
export class PersistentStanding {
  constructor(private readonly deps: PersistentStandingDependencies) {}
  private async snapshot() {
    let policy;
    try { policy = policySchema.parse(await this.deps.policy.load()); } catch (error) { throw new StandingApprovalError('STANDING_UNSUPPORTED', error instanceof Error ? error.message : null); }
    // Role-based authority (policy v2 + bindings) is what the governed change and its bound are made of; a v1 policy has neither.
    if (policy.schemaVersion !== 2) throw new StandingApprovalError('STANDING_UNSUPPORTED', 'policy v1');
    return policy;
  }
  private mine(policy: ReturnType<typeof policySchema.parse>, principal: { readonly issuer: string; readonly subject: string }) {
    return policy.grants.filter(grant => grant.resource.kind === STANDING_GRANT_KIND && isStandingGrantId(grant.id) && grant.principals !== 'all'
      && grant.principals.length === 1 && grant.principals[0]!.issuer === principal.issuer && grant.principals[0]!.subject === principal.subject);
  }
  /** The person's own persisted standing grants (read-only; for `deckent policy grants --mine` and the future `/policy`). */
  async list(scopeId: string, principal: { readonly issuer: string; readonly subject: string }): Promise<readonly StandingGrantView[]> {
    const grants = this.mine(await this.snapshot(), principal).filter(grant => grant.scopes === 'all' || grant.scopes.includes(scopeId));
    return Object.freeze(grants.map(grant => Object.freeze({ id: grant.id, key: grant.resource.ids === 'all' ? '*' : grant.resource.ids[0]!, ...parseKey(grant.resource.ids === 'all' ? '*' : grant.resource.ids[0]!) })));
  }
  /** Whether "always" can be offered for this pattern now: a policy that supports it, room for one more, and the person's own authority over it. */
  async offer(scopeId: string, principal: { readonly issuer: string; readonly subject: string }, pattern: StandingPattern): Promise<StandingOffer> {
    let policy;
    try { policy = await this.snapshot(); } catch { return { available: false, reason: 'unsupported' }; }
    if (this.mine(policy, principal).length >= STANDING_GRANTS_MAX) return { available: false, reason: 'limit' };
    try {
      const files = authorityDocuments(policy);
      const plan = planPolicyChange(files.policy, files.bindings, standingGrantChange({ id: standingGrantId('probe'), principal, scopeId, key: pattern.key }));
      return delegationWithin(policy, principal, plan.touched).ok ? { available: true } : { available: false, reason: 'delegation' };
    } catch { return { available: false, reason: 'unsupported' }; }
  }
  /** Persists one pattern as the person's own grant; an already persisted pattern is returned as it is (no second card, no second change). */
  async persist(input: { readonly scopeId: string; readonly principal: VerifiedPrincipal; readonly pattern: StandingPattern; readonly sourceApprovalId: string }): Promise<StandingGrantView> {
    const { scopeId, principal, pattern } = input;
    const policy = await this.snapshot();
    const own = this.mine(policy, principal);
    const existing = own.find(grant => grant.resource.ids !== 'all' && grant.resource.ids.includes(pattern.key) && (grant.scopes === 'all' || grant.scopes.includes(scopeId)));
    const view = (id: string) => Object.freeze({ id, key: pattern.key, tool: pattern.tool, kind: pattern.kind, text: pattern.text });
    if (existing) return view(existing.id);
    if (own.length >= STANDING_GRANTS_MAX) throw new StandingApprovalError('STANDING_LIMIT');
    const id = standingGrantId(sha256(`standing-grant:1\0${scopeId}\0${principal.issuer}\0${principal.subject}\0${pattern.key}`).slice(0, 24));
    await this.apply({ scopeId, principal, change: standingGrantChange({ id, principal, scopeId, key: pattern.key }), tag: `persist:${id}`,
      reason: `Persisted from approval card ${input.sourceApprovalId}` });
    return view(id);
  }
  /** Removes one of the person's own standing grants by the same operation (`revoke <id>`). */
  async revoke(input: { readonly scopeId: string; readonly principal: VerifiedPrincipal; readonly id: string; readonly reason: string }): Promise<void> {
    const found = this.mine(await this.snapshot(), input.principal).find(grant => grant.id === input.id);
    if (!found) throw new StandingApprovalError('STANDING_NOT_FOUND');
    await this.apply({ scopeId: input.scopeId, principal: input.principal, change: standingRevokeChange(input.id), tag: `revoke:${input.id}`, reason: input.reason });
  }
  private async apply(input: { readonly scopeId: string; readonly principal: VerifiedPrincipal; readonly change: PolicyChange; readonly tag: string; readonly reason: string }) {
    const current = await this.snapshot();
    // The command names the revision it was made on: a grant added, revoked and added again is a new command each time.
    const commandId = sha256(`standing-change:1\0${input.scopeId}\0${input.principal.issuer}\0${input.principal.subject}\0${input.tag}\0${current.revision}`);
    const command: EffectCommand = { schemaVersion: 1, commandId, scopeId: input.scopeId, operation: POLICY_ADMINISTER_OPERATION.operation,
      target: { kind: AUTHORITY_DOCUMENT_TARGET_KIND, id: 'installation' }, idempotencyKey: commandId, input: input.change, expectedVersion: current.revision };
    try {
      let outcome = await this.deps.administration.submit(command);
      if (outcome.status === 'approval-pending') {
        await this.deps.approve({ approvalId: outcome.approval.approvalId, revision: outcome.approval.revision }, `${commandId}-approve`, input.reason);
        outcome = await this.deps.administration.submit(command);
      }
      if (outcome.status !== 'settled') throw new StandingApprovalError('STANDING_NOT_SETTLED');
    } catch (error) {
      // The decider's authority is the bound (I3): a person cannot persist what their own rules do not hold.
      if ((error as { code?: unknown } | null)?.code === 'POLICY_DELEGATION_EXCEEDS') throw new StandingApprovalError('STANDING_DELEGATION', (error as { detail?: string | null }).detail ?? null);
      throw error;
    }
  }
}

type AuditedStanding = { readonly source: 'session' | 'grant'; readonly key: string; readonly grantId: string | null };
/**
 * The sealed-audit event of a standing approval at work (audit subject `standing-approval`): `remembered` is one per call position of the turn
 * that showed the card, `used` one per call position of the turn a standing approval lowered (the effect gate may be asked several times).
 */
export function standingApprovalAuditEvent(input: { readonly phase: 'remembered' | 'used'; readonly scopeId: string; readonly turnId: string;
  readonly execution: { readonly round: number; readonly index: number }; readonly callId: string; readonly principal: { readonly issuer: string; readonly subject: string };
  readonly revision: string; readonly atMs: number; readonly standing: AuditedStanding; readonly cell: StandingCellName; readonly approvalId: string | null;
  readonly tool: { readonly name: string; readonly version: number }; readonly argsDigest: string; readonly summary: Extract<AuditEvent['subject'], { kind: 'standing-approval' }>['summary'] }): AuditEvent {
  const { scopeId, turnId, execution, standing } = input;
  return { schemaVersion: AUDIT_EVENT_SCHEMA_VERSION, scopeId, principal: { issuer: input.principal.issuer, subject: input.principal.subject }, policyRevision: input.revision, atMs: input.atMs,
    eventId: sha256(`standing-${input.phase}:1\0${scopeId}\0${turnId}\0${execution.round}\0${execution.index}${input.phase === 'used' ? `\0${input.argsDigest}` : ''}`),
    subject: { kind: 'standing-approval', phase: input.phase, source: standing.source, grantId: standing.grantId, cell: input.cell, keyDigest: sha256(standing.key), approvalId: input.approvalId,
      tool: { name: input.tool.name, version: input.tool.version }, call: { turnId, round: execution.round, index: execution.index, callId: input.callId }, summary: input.summary } };
}
/** Whether a decision taken again at an effect admission is the standing approval the audit event recorded (same source, key, grant and revision). */
export const isAuditedStanding = (audited: AuditedStanding, revision: string, again: { readonly decision: string; readonly revision: string; readonly relaxation: unknown; readonly standing?: AuditedStanding }) =>
  again.decision === 'allow' && again.revision === revision && again.relaxation === null && again.standing?.source === audited.source && again.standing.key === audited.key && again.standing.grantId === audited.grantId;
