import { assertBeuserAccess, pinBeuserLimits, BeuserContractError, type BeuserContext, type BeuserRealmObservation, type RealmPort } from '#engine/core/beuser-contract/index.js';
import type { BeuserBinding } from '#domain/index.js';
import { beuserBindingDigest } from './seal.js';

export interface BeuserRealmHandle {
  readonly binding: BeuserBinding; readonly incarnation: string; readonly containerId: string;
  readonly controlDirectory: string; readonly controlIdentity: string;
}
export interface BeuserRealmReadback { readonly valid: boolean; readonly evidenceRefs: readonly string[] }
export interface BeuserRealmRemoval {
  readonly processesAbsent: boolean; readonly cgroupAbsent: boolean; readonly filesystemAbsent: boolean;
  readonly evidenceRefs: readonly string[];
}
/** Trusted supervisor I/O. `publish` persists immutable custody before any container starts. */
export interface BeuserRealmRuntime {
  create(context: BeuserContext, publish: (handle: BeuserRealmHandle) => Promise<void>): Promise<BeuserRealmHandle>;
  inspect(context: BeuserContext, handle: BeuserRealmHandle): Promise<BeuserRealmReadback>;
  remove(context: BeuserContext, handle: BeuserRealmHandle): Promise<BeuserRealmRemoval>;
}
export interface BeuserRealmLease {
  readonly handle: BeuserRealmHandle | null; readonly observation: BeuserRealmObservation;
}
/** C6 binds these CAS operations to the existing Attempt/supervisor owner; no second product ledger. */
export interface BeuserRealmCustody {
  reserve(context: BeuserContext): Promise<void>;
  publish(context: BeuserContext, handle: BeuserRealmHandle): Promise<void>;
  load(context: BeuserContext): Promise<BeuserRealmLease | null>;
  settle(context: BeuserContext, observation: BeuserRealmObservation): Promise<void>;
}
export class BeuserRealmApplication implements RealmPort {
  constructor(private readonly runtime: BeuserRealmRuntime, private readonly custody: BeuserRealmCustody) {}
  private check(context: BeuserContext, cleanup = false) {
    pinBeuserLimits(context.limits);
    const checked = cleanup ? { ...context, signal: new AbortController().signal } : context;
    assertBeuserAccess(checked, context.binding, context.principal, { kind: 'beuser-sandbox', id: context.binding.realmId }, cleanup ? 'destroy' : 'create');
  }
  private async lease(context: BeuserContext): Promise<BeuserRealmLease> {
    const lease = await this.custody.load(context);
    if (!lease || beuserBindingDigest(lease.observation.binding) !== beuserBindingDigest(context.binding)
      || lease.handle && beuserBindingDigest(lease.handle.binding) !== beuserBindingDigest(context.binding)) throw new BeuserContractError('BEUSER_TARGET_NOT_SANDBOX');
    return lease;
  }
  private async record(context: BeuserContext, state: BeuserRealmObservation['state'], evidenceRefs: readonly string[]) {
    const observation = Object.freeze({ binding: context.binding, state, evidenceRefs: Object.freeze([...evidenceRefs]) });
    await this.custody.settle(context, observation);
    return observation;
  }
  async create(context: BeuserContext): Promise<BeuserRealmObservation> {
    this.check(context);
    // Reserve is an atomic, durable, never-reuse claim, including failed/unknown creates.
    await this.custody.reserve(context);
    try {
      await this.runtime.create(context, handle => this.custody.publish(context, handle));
      return await this.record(context, 'created', []);
    } catch (error) {
      // A partial create is reconciled through retained immutable custody, never retried by name.
      await this.destroy(context);
      throw error;
    }
  }
  async admit(context: BeuserContext, observation: BeuserRealmObservation): Promise<BeuserRealmObservation> {
    this.check(context);
    if (beuserBindingDigest(observation.binding) !== beuserBindingDigest(context.binding)) throw new BeuserContractError('BEUSER_TARGET_NOT_SANDBOX');
    const lease = await this.lease(context);
    if (!lease.handle || !['created', 'admitted'].includes(lease.observation.state)) throw new BeuserContractError('BEUSER_TARGET_NOT_SANDBOX');
    let readback: BeuserRealmReadback;
    try { readback = await this.runtime.inspect(context, lease.handle); }
    catch { await this.quarantine(context, 'BEUSER_TARGET_NOT_SANDBOX'); throw new BeuserContractError('BEUSER_TARGET_NOT_SANDBOX'); }
    if (!readback.valid || !readback.evidenceRefs.length) {
      await this.quarantine(context, 'BEUSER_TARGET_NOT_SANDBOX');
      throw new BeuserContractError('BEUSER_TARGET_NOT_SANDBOX');
    }
    return this.record(context, 'admitted', readback.evidenceRefs);
  }
  async observe(context: BeuserContext): Promise<BeuserRealmObservation> {
    this.check(context);
    const lease = await this.lease(context);
    if (lease.observation.state !== 'admitted' || !lease.handle) return lease.observation;
    // A once-valid inspection never authorizes a changed container incarnation.
    return this.admit(context, lease.observation);
  }
  async destroy(context: BeuserContext): Promise<BeuserRealmObservation> {
    this.check(context, true);
    const cleanup = { ...context, signal: AbortSignal.timeout(context.limits.cleanupDeadlineMs) };
    const lease = await this.lease(cleanup);
    if (lease.observation.state === 'destroyed') return lease.observation;
    if (!lease.handle) return this.record(cleanup, 'quarantined', []);
    try {
      const proof = await this.runtime.remove(cleanup, lease.handle);
      return await this.record(cleanup, proof.processesAbsent && proof.cgroupAbsent && proof.filesystemAbsent && proof.evidenceRefs.length ? 'destroyed' : 'quarantined', proof.evidenceRefs);
    } catch { return this.record(cleanup, 'quarantined', lease.observation.evidenceRefs); }
  }
  async reconcile(context: BeuserContext): Promise<BeuserRealmObservation> { return this.destroy(context); }
  async quarantine(context: BeuserContext, _reason: string): Promise<BeuserRealmObservation> {
    void _reason; // The caller owns the typed audit reason; custody retains only the bounded observation.
    this.check(context, true);
    const lease = await this.lease(context);
    if (lease.observation.state === 'destroyed') return lease.observation;
    return this.record(context, 'quarantined', lease.observation.evidenceRefs);
  }
}
