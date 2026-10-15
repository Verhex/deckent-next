import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { APPROVAL_ASSURANCE, AUDIT_EVENT_SCHEMA_VERSION, ApprovalError, RegistryError, approvalAssuranceSchema, identitySchema, type AuditEvent } from '#domain/index.js';
import { CORE_TURN_ASSURANCE_REFERENCE } from '#platform/index.js';
import type { ApprovalAssuranceEvidence, ApprovalAssuranceProducer } from '#engine/core/authentication/index.js';
import type { TurnDecisionCapabilities } from './assurance.js';

const manifestSchema = z.object({ schemaVersion: z.literal(1), id: identitySchema, version: z.number().int().positive().safe(),
  level: approvalAssuranceSchema, rank: z.number().int().positive().safe() }).strict().readonly();
export type ApprovalAssuranceProducerManifest = z.infer<typeof manifestSchema>;
/** Trusted distribution code, never client input. Implementations attest service-held, scope/approval/principal-bound evidence. */
export interface ApprovalAssuranceAttester {
  attests(evidence: ApprovalAssuranceEvidence): boolean;
  settle?(evidence: ApprovalAssuranceEvidence): void;
}
export interface ApprovalAssuranceProducerRegistration {
  readonly manifest: ApprovalAssuranceProducerManifest;
  create(): ApprovalAssuranceAttester;
}
type Reference = { readonly id: string; readonly version: number };
const CORE = Object.freeze({ schemaVersion: 1 as const, ...CORE_TURN_ASSURANCE_REFERENCE, level: APPROVAL_ASSURANCE.turnBound, rank: 1 });
/** Add-only and sealed at composition. Overlay producer ids are dotted; Core levels and ranks cannot be replaced or lowered. */
export class ApprovalAssuranceProducerRegistry {
  private sealed = false;
  private readonly rows = new Map<string, { readonly manifest: ApprovalAssuranceProducerManifest; readonly create: () => ApprovalAssuranceAttester }>();
  register(input: ApprovalAssuranceProducerRegistration): void {
    if (this.sealed) throw new RegistryError('REGISTRY_SEALED');
    const parsed = manifestSchema.safeParse(input?.manifest);
    if (!parsed.success || typeof input?.create !== 'function') throw new RegistryError('REGISTRY_MANIFEST_INVALID');
    const manifest = parsed.data;
    if (manifest.id.startsWith('core.') || !manifest.id.includes('.')
      || manifest.level === APPROVAL_ASSURANCE.peerSession || manifest.level === CORE.level || manifest.rank <= CORE.rank)
      throw new RegistryError('REGISTRY_NAMESPACE_RESERVED');
    if (this.rows.size >= 127 || this.rows.has(manifest.id) || [...this.rows.values()].some(row => row.manifest.level === manifest.level || row.manifest.rank === manifest.rank))
      throw new RegistryError('REGISTRY_ADAPTER_DUPLICATE');
    const create = input.create;
    this.rows.set(manifest.id, Object.freeze({ manifest, create: () => create.call(input) }));
  }
  seal(): void { this.sealed = true; }
  manifests(): readonly ApprovalAssuranceProducerManifest[] { return Object.freeze([CORE, ...[...this.rows.values()].map(row => row.manifest)]); }
  /** Audit precedes construction/activation. All registrations (including inactive ones) are retained, never attestation secrets. */
  resolve(selection: readonly Reference[], turn: TurnDecisionCapabilities | undefined,
    record: (manifests: readonly (ApprovalAssuranceProducerManifest & { readonly active: boolean })[]) => void): readonly ApprovalAssuranceProducer[] {
    if (!this.sealed) throw new RegistryError('REGISTRY_MANIFEST_INVALID');
    const manifests = this.manifests();
    if (selection.length > manifests.length || new Set(selection.map(row => row.id)).size !== selection.length
      || selection.some(ref => !manifests.some(manifest => manifest.id === ref.id && manifest.version === ref.version))) throw new RegistryError('REGISTRY_ADAPTER_UNKNOWN');
    const active = new Set(selection.map(row => row.id));
    record(Object.freeze(manifests.map(manifest => Object.freeze({ ...manifest, active: active.has(manifest.id) }))));
    return Object.freeze(selection.flatMap(ref => {
      const row = this.rows.get(ref.id);
      if (!row) return turn ? [turn] : [];
      const attester = row.create();
      if (typeof attester?.attests !== 'function' || (attester.settle !== undefined && typeof attester.settle !== 'function')) throw new RegistryError('REGISTRY_FACTORY_MISMATCH');
      const { attests, settle } = attester;
      return [Object.freeze({ level: row.manifest.level, rank: row.manifest.rank, attests: (evidence: ApprovalAssuranceEvidence) => attests.call(attester, evidence) === true,
        settle: (evidence: ApprovalAssuranceEvidence) => settle?.call(attester, evidence) })];
    }));
  }
}
export const approvalAssuranceProducerRegistry = new ApprovalAssuranceProducerRegistry();
export function registerApprovalAssuranceProducer(registration: ApprovalAssuranceProducerRegistration): void { approvalAssuranceProducerRegistry.register(registration); }
/**
 * The read-only inventory an audit checkpoint summarises (REVIEW2561 R3): every registered manifest (Core included) with its active flag under
 * the configured selection, and the selection as configured. It creates no attester and writes no audit; one function for service, read and
 * re-baseline, so an added, removed, re-versioned or re-selected producer changes the checkpoint's producer digest.
 */
export function approvalAssuranceProducerInventory(selection: readonly Reference[], registry: ApprovalAssuranceProducerRegistry = approvalAssuranceProducerRegistry) {
  const chosen = new Set(selection.map(ref => `${ref.id}@${ref.version}`));
  return Object.freeze({ schemaVersion: 1 as const, manifests: registry.manifests().map(manifest => ({ ...manifest, active: chosen.has(`${manifest.id}@${manifest.version}`) })),
    selection: selection.map(ref => ({ id: ref.id, version: ref.version })) });
}
/** The versioned manifest inventory used by this decision path; no new ledger or decision owner. */
export function approvalAssuranceRegistrationEvent(context: Omit<AuditEvent, 'schemaVersion' | 'subject'>,
  producers: readonly (ApprovalAssuranceProducerManifest & { readonly active: boolean })[]): AuditEvent {
  return { schemaVersion: AUDIT_EVENT_SCHEMA_VERSION, ...context, principal: { issuer: context.principal.issuer, subject: context.principal.subject }, subject: { kind: 'approval-assurance-registration', schemaVersion: 1, producers: [...producers] } };
}

/** Composition port shared by normal and authority approvals; audit failure is never swallowed. */
export function resolveAuditedApprovalAssurance(selection: readonly Reference[], turn: TurnDecisionCapabilities | undefined,
  context: Omit<AuditEvent, 'schemaVersion' | 'subject' | 'eventId'>, record: (event: AuditEvent) => void): readonly ApprovalAssuranceProducer[] {
  try { return approvalAssuranceProducerRegistry.resolve(selection, turn,
    producers => record(approvalAssuranceRegistrationEvent({ ...context, eventId: randomUUID() }, producers))); }
  catch (error) { if (error instanceof RegistryError && error.code === 'REGISTRY_ADAPTER_UNKNOWN') throw new ApprovalError('APPROVAL_ASSURANCE_INSUFFICIENT'); throw error; }
}
