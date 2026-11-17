import { AsyncLocalStorage } from 'node:async_hooks';
import { z } from 'zod';
import { isAiPrincipal, isWorkloadPrincipalRef, approvalSubject, encodeCommandProjection, identitySchema, type ApprovalActor, type ApprovalRecord, type RunSnapshot } from '#domain/index.js';
import { ErrorRegistry, sha256 } from '#platform/index.js';
import { approvalRequestDigest, decidedRefusal } from '#engine/core/approval/index.js';
import data from './session-registry.json' with { type: 'json' };

/** Versioned module data, neither mutable policy nor a worker/concurrency ceiling. */
export const runSessionRegistryData = z.strictObject({ schemaVersion: z.literal(1), maxEntries: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).parse(data);
const actorSchema = z.strictObject({ id: identitySchema, issuer: identitySchema, subject: identitySchema });
const keySchema = z.strictObject({ ledger: identitySchema, companyId: identitySchema, scopeId: identitySchema, commandId: identitySchema, runId: identitySchema, actor: actorSchema });
export type RunSessionIdentity = z.infer<typeof keySchema>;
export interface RunSessionState { readonly run: RunSnapshot | null; readonly intent: { readonly actor: ApprovalActor; readonly commandId: string } | null; readonly approval: ApprovalRecord | null; readonly now: number; readonly admissionWindowMs: number }
export type RunSessionRead = (identity: RunSessionIdentity, approvalId: string | null) => Promise<RunSessionState>;
type Basis = Readonly<{ approvalId: string; requestDigest: string; actionDigest: string; decisionCommandId: string | null }>;
type Admission = Readonly<{ authorityDigest: string; eligible: boolean }>;
type Slot = { identity: RunSessionIdentity; generation: number; pins: Set<symbol>; basis: Basis | null; admission: Admission | null; unknown: boolean; baseline: string | null };
export type RunSessionPin = Readonly<{ key: string; slot: object; producer: symbol }>;
const digest = (value: unknown) => sha256(encodeCommandProjection('run-session:1', value));
const actorEqual = (a: ApprovalActor, b: ApprovalActor) => a.id === b.id && a.issuer === b.issuer && a.subject === b.subject;
const keyOf = (value: RunSessionIdentity) => JSON.stringify([value.ledger, value.companyId, value.scopeId, value.commandId, value.actor.id, value.actor.issuer, value.actor.subject]);
/** Empty at service custody. Q/D/A are actual commit provenance, never timestamps or evidence of permission. */
export class RunSessionRegistry {
  private readonly slots = new Map<string, Slot>();
  private sweepWork: Promise<void> | undefined;
  private sweepFull = false;
  private sweepOffset = 0;
  constructor(private readonly read: RunSessionRead, readonly limit = runSessionRegistryData.maxEntries) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('RUN_SESSION_REGISTRY_INVALID');
  }
  get count() { return this.slots.size; }
  private existing(identity: RunSessionIdentity) {
    const slot = this.slots.get(keyOf(identity));
    if (slot && digest(slot.identity) !== digest(identity)) throw ErrorRegistry.createError('RUN_COMMAND_CONFLICT');
    return slot;
  }
  async reserve(input: RunSessionIdentity, baseline: ApprovalRecord | null = null, operation: 'proposal' | 'approval' = 'proposal'): Promise<RunSessionPin> {
    const identity = keySchema.parse(input);
    if (!this.existing(identity) && this.count >= this.limit) await this.sweep();
    let slot = this.existing(identity);
    if (!slot) {
      if (this.count >= this.limit) throw ErrorRegistry.createError('AI_RUN_SESSION_CAPACITY', { params: { count: this.count, limit: this.limit, operation } });
      slot = { identity, generation: 0, pins: new Set(), basis: null, admission: null, unknown: false, baseline: baseline ? digest(baseline) : null };
      this.slots.set(keyOf(identity), slot);
    }
    const producer = Symbol(); slot.pins.add(producer); slot.generation++;
    return { key: keyOf(identity), slot, producer };
  }
  private pinned(pin: RunSessionPin) {
    const slot = this.slots.get(pin.key);
    if (!slot || slot !== pin.slot || !slot.pins.has(pin.producer)) throw new Error('RUN_SESSION_PRODUCER_MISSING');
    return slot;
  }
  /** The adapter calls only after COMMIT; the trusted caller has verified the record seal. */
  request(pin: RunSessionPin, record: ApprovalRecord) {
    const slot = this.pinned(pin), subject = approvalSubject(record.request);
    if (subject.kind !== 'run-create' || subject.commandId !== slot.identity.commandId || subject.runId !== slot.identity.runId
      || record.request.scopeId !== slot.identity.scopeId || !actorEqual(record.request.requester, slot.identity.actor)) throw ErrorRegistry.createError('APPROVAL_CONFLICT');
    slot.basis = { approvalId: record.request.approvalId, requestDigest: approvalRequestDigest(record.request), actionDigest: record.request.actionDigest, decisionCommandId: null };
    slot.generation++; slot.unknown = false;
  }
  decision(pin: RunSessionPin, record: ApprovalRecord) {
    if (record.status !== 'decided' || record.decision?.decision !== 'allow' || record.decision.requestDigest !== approvalRequestDigest(record.request)) throw ErrorRegistry.createError('APPROVAL_CONFLICT');
    this.request(pin, record);
    const slot = this.pinned(pin); slot.basis = { ...slot.basis!, decisionCommandId: record.decision.commandId }; slot.generation++;
  }
  admission(pin: RunSessionPin, run: RunSnapshot, actor: ApprovalActor, commandId: string) {
    const slot = this.pinned(pin), id = slot.identity, approval = run.authority?.approval, basis = slot.basis;
    if (run.identity.scopeId !== id.scopeId || run.identity.runId !== id.runId || commandId !== id.commandId || !actorEqual(actor, id.actor)) throw ErrorRegistry.createError('RUN_COMMAND_CONFLICT');
    const eligible = !approval || !!basis && approval.approvalId === basis.approvalId && approval.actionDigest === basis.actionDigest
      && approval.requestDigest === basis.requestDigest && (basis.decisionCommandId === null || approval.commandId === basis.decisionCommandId);
    slot.admission = { authorityDigest: digest(run.authority ?? null), eligible }; slot.generation++; slot.unknown = false;
  }
  eligible(identity: RunSessionIdentity, run: RunSnapshot): boolean {
    const slot = this.existing(identity);
    return !!slot?.admission?.eligible && slot.admission.authorityDigest === digest(run.authority ?? null);
  }
  /** Rollback and retirement differ: transient failure needs verified durable absence, terminal work may be retired. */
  async finish(pin: RunSessionPin) {
    const slot = this.pinned(pin); slot.pins.delete(pin.producer); slot.generation++;
    await this.reconcile(pin.key, slot);
  }
  private async reconcile(key: string, slot: Slot) {
    if (slot.pins.size) return;
    const generation = slot.generation, basis = slot.basis, admission = slot.admission;
    let state: RunSessionState;
    try { state = await this.read(slot.identity, basis?.approvalId ?? null); }
    catch (error) {
      if (this.slots.get(key) !== slot || slot.generation !== generation) return;
      slot.unknown = true;
      throw error;
    }
    if (this.slots.get(key) !== slot || slot.generation !== generation || slot.pins.size || slot.basis !== basis || slot.admission !== admission) return;
    const { run, intent, approval } = state;
    if (run && (!intent || !actorEqual(intent.actor, slot.identity.actor) || intent.commandId !== slot.identity.commandId)) { slot.unknown = true; throw ErrorRegistry.createError('RUN_STORE_CORRUPT'); }
    if (run) {
      if (run.state.kind === 'terminal') this.slots.delete(key);
      // A is retained for the whole active Run, including its consumed Q/D after the approval window.
      else slot.unknown = false;
      return;
    }
    if (admission) { slot.unknown = true; throw ErrorRegistry.createError('RUN_STORE_CORRUPT'); }
    if (!basis) {
      // No producer basis: only a verified empty durable state proves rollback. An unobserved commit stays unknown.
      if (!approval || slot.baseline !== null && digest(approval) === slot.baseline) this.slots.delete(key);
      else { slot.unknown = true; throw ErrorRegistry.createError('APPROVAL_CONFLICT'); }
      return;
    }
    if (!approval) { slot.unknown = true; throw ErrorRegistry.createError('APPROVAL_MISSING'); }
    const same = approval.request.approvalId === basis.approvalId && approvalRequestDigest(approval.request) === basis.requestDigest;
    if (!same || approval.status === 'expired' || approval.decision?.decision === 'deny'
      || approval.status === 'pending' && state.now >= approval.request.expiresAt
      || approval.status === 'decided' && decidedRefusal(approval, { now: state.now, window: state.admissionWindowMs }) === 'APPROVAL_EXPIRED') { this.slots.delete(key); return; }
    // The reader checks existing TTL/window rules using its trusted clock; it never changes startup eligibility.
    slot.unknown = false;
  }
  /** One coalesced sweep. Producers never hold a lock across these bounded tracked-key reads. */
  sweep(pageSize?: number): Promise<void> {
    if (this.sweepWork) { if (pageSize === undefined) this.sweepFull = true; return this.sweepWork; }
    const all = [...this.slots], count = pageSize === undefined ? all.length : Math.min(pageSize, all.length);
    this.sweepFull = pageSize === undefined;
    let visited = 0;
    const work = (async () => {
      while (visited < (this.sweepFull ? all.length : count)) {
        const [key, slot] = all[(this.sweepOffset + visited++) % all.length]!; await this.reconcile(key, slot);
      }
      this.sweepOffset = all.length ? (this.sweepOffset + visited) % all.length : 0;
    })();
    this.sweepWork = work.finally(() => { this.sweepWork = undefined; });
    return this.sweepWork;
  }
}

/** Code-only propagation of the one service-owned reference; no token is accepted on a wire or stored record. */
const serviceSession = new AsyncLocalStorage<RunSessionRegistry>();
export const runProgressionSession = () => serviceSession.getStore();
export const withRunProgressionSession = <T>(registry: RunSessionRegistry, work: () => T): T => serviceSession.run(registry, work);
export function beginRunSession(registry: RunSessionRegistry | undefined, identity: RunSessionIdentity, principal: import('#domain/index.js').VerifiedPrincipal) {
  return registry && isAiPrincipal(principal) ? registry.reserve(identity) : Promise.resolve(undefined);
}
export function beginRunDecisionSession(registry: RunSessionRegistry | undefined, record: ApprovalRecord | null, base: Pick<RunSessionIdentity, 'ledger' | 'companyId'>) {
  const subject = record && approvalSubject(record.request);
  return registry && record?.status === 'pending' && subject?.kind === 'run-create' && isWorkloadPrincipalRef(record.request.requester)
    ? registry.reserve({ ...base, scopeId: record.request.scopeId, commandId: subject.commandId, runId: subject.runId, actor: record.request.requester }, record, 'approval') : Promise.resolve(undefined);
}
