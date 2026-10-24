import { AUDIT_EVENT_SCHEMA_VERSION, AUDIT_POLICY_TURN_LIMITS, auditEventSchema, encodeCommandProjection, type AuditEvent } from '#domain/index.js';
import { sha256 } from '#platform/index.js';

type Subject = Extract<AuditEvent['subject'], { kind: 'policy-turn' }>;
type Refused = Subject['refused']['calls'][number];
type Allowed = Subject['allowed']['calls'][number];
type Tool = { readonly name: string; readonly version: number };
/**
 * S5 D1 (AUDITOR-MODEL, owner Q5 2026-10-17): the one `policy-turn` record of an agent turn. The turn's decision component notes each refused
 * call decision and each plain allow that ran; `event` builds the single sealed-to-be event (null when the turn decided nothing). Bounded:
 * at most `AUDIT_POLICY_TURN_LIMITS` entries per list, the counts stay exact and refusals past the bound raise `ceiling` (a deny flood is
 * one bounded row). The identity is the content's digest, so a replayed flush of the same turn content appends nothing new.
 */
export class PolicyTurnRecord {
  private readonly refusedCalls: Refused[] = [];
  private readonly allowedCalls: Allowed[] = [];
  private refusedCount = 0;
  private allowedCount = 0;
  private revision: string | null = null;
  private flushed: string | null = null;
  constructor(private readonly input: { readonly scopeId: string; readonly turnId: string; readonly principal: { readonly issuer: string; readonly subject: string } },
    private readonly limits: { readonly refusedMax: number; readonly allowedMax: number } = AUDIT_POLICY_TURN_LIMITS) {}
  refused(entry: { readonly tool: { readonly name: string; readonly version: number }; readonly call: Refused['call']; readonly cell: Refused['cell'];
    readonly decision: Refused['decision']; readonly stage: Refused['stage']; readonly argsDigest: string; readonly revision: string }): void {
    this.refusedCount++; this.revision = entry.revision;
    if (this.refusedCalls.length < this.limits.refusedMax) this.refusedCalls.push({ tool: { name: entry.tool.name, version: entry.tool.version }, call: { ...entry.call },
      cell: entry.cell, decision: entry.decision, stage: entry.stage, argsDigest: entry.argsDigest, revision: entry.revision });
  }
  allowed(entry: { readonly tool: { readonly name: string; readonly version: number }; readonly call: Allowed['call']; readonly cell: Allowed['cell'];
    readonly argsDigest: string; readonly revision: string }): void {
    this.allowedCount++; this.revision = entry.revision;
    if (this.allowedCalls.length < this.limits.allowedMax) this.allowedCalls.push({ tool: { name: entry.tool.name, version: entry.tool.version }, call: { ...entry.call },
      cell: entry.cell, argsDigest: entry.argsDigest, revision: entry.revision });
  }
  /** One refused decision as the decision component holds it (null: an unreadable or invalid policy, i.e. deny); nothing without a call position. */
  note(tool: Tool, call: Refused['call'] | undefined, cell: Refused['cell'], decision: { readonly decision: string; readonly revision: string } | null, stage: Refused['stage'], argsDigest: string): void {
    if (call) this.refused({ tool, call, cell, decision: !decision || decision.decision === 'deny' ? 'deny' : 'require-approval', stage, argsDigest, revision: decision?.revision ?? 'unknown' });
  }
  /** Seals the record through `write` (the one audit writer) once per content: true when durable or empty, false when the audit refused it. */
  async flush(atMs: number, write: (event: AuditEvent) => unknown): Promise<boolean> {
    try {
      const event = this.event(atMs);
      if (!event || event.eventId === this.flushed) return true;
      await write(event); this.flushed = event.eventId; return true;
    } catch { return false; }
  }
  /** The turn's record at `atMs` (the caller's trusted clock), or null when nothing was decided. The policy revision is the last one decided on. */
  event(atMs: number): AuditEvent | null {
    if (this.revision === null) return null;
    const subject: Subject = { kind: 'policy-turn', turnId: this.input.turnId, ceiling: this.refusedCount > this.limits.refusedMax,
      refused: { count: this.refusedCount, calls: [...this.refusedCalls] }, allowed: { count: this.allowedCount, calls: [...this.allowedCalls] } };
    return auditEventSchema.parse({ schemaVersion: AUDIT_EVENT_SCHEMA_VERSION, eventId: `policy-turn:${sha256(encodeCommandProjection('policy-turn:1', { scopeId: this.input.scopeId, subject }))}`,
      scopeId: this.input.scopeId, principal: { issuer: this.input.principal.issuer, subject: this.input.principal.subject }, policyRevision: this.revision, atMs, subject });
  }
}
