import type { ModelActivationRecord, ModelBindingDefinition, ModelInvocationActor, ModelInvocationAuthorization,
  ModelInvocationClaim, ModelInvocationCommand, ModelInvocationNativeResponse, ModelInvocationProfile,
  ModelInvocationPurgeCommand, ModelInvocationPurgeReceipt, ModelInvocationReceipt, ModelInvocationResponseContent,
  ModelInvocationResponseEvidence, ModelInvocationUnknownReason } from '#domain/index.js';

export interface ModelInvocationAdmission {
  readonly command: ModelInvocationCommand;
  readonly requestDigest: string;
  readonly actor: ModelInvocationActor;
  readonly authorization: ModelInvocationAuthorization;
  readonly definition: ModelBindingDefinition;
  readonly activation: ModelActivationRecord;
  readonly profile: ModelInvocationProfile;
  readonly profileDigest: string;
  readonly invocationId: string;
  readonly claimedAtMs: number;
}
export interface ModelInvocationRecord { readonly receipt: ModelInvocationReceipt; readonly content: ModelInvocationResponseContent | null;
  readonly purge: ModelInvocationPurgeReceipt | null }
export interface ModelInvocationClaimResult { readonly replayed: boolean; readonly record: ModelInvocationRecord }
export interface ModelInvocationPurgeAdmission { readonly command: ModelInvocationPurgeCommand; readonly actor: ModelInvocationActor;
  readonly authorization: ModelInvocationAuthorization; readonly purgedAtMs: number }
export interface ModelInvocationPurgeResult { readonly replayed: boolean; readonly receipt: ModelInvocationPurgeReceipt }
export interface ModelInvocationPurgeStore { purgeContent(input: ModelInvocationPurgeAdmission): Promise<ModelInvocationPurgeResult>; close(): void }
export interface ModelInvocationStore {
  loadReceipt(scopeId: string, commandId: string): Promise<ModelInvocationRecord | null>;
  claim(input: ModelInvocationAdmission): Promise<ModelInvocationClaimResult>;
  recordResponse(claim: ModelInvocationClaim, response: ModelInvocationNativeResponse, observedAtMs: number): Promise<ModelInvocationRecord>;
  recordRejected(claim: ModelInvocationClaim, evidence: ModelInvocationResponseEvidence, observedAtMs: number): Promise<ModelInvocationRecord>;
  recordUnknown(claim: ModelInvocationClaim, reason: ModelInvocationUnknownReason, observedAtMs: number, evidence?: ModelInvocationResponseEvidence | null): Promise<ModelInvocationRecord>;
  loadInvocation(scopeId: string, invocationId: string): Promise<ModelInvocationRecord | null>;
  close(): void;
}
export type ModelInvocationStoreErrorCode = 'MODEL_INVOCATION_COMMAND_CONFLICT' | 'MODEL_INVOCATION_CORRUPT'
  | 'MODEL_INVOCATION_UNAVAILABLE' | 'MODEL_INVOCATION_OUTCOME_UNKNOWN' | 'MODEL_INVOCATION_ACTIVATION_CONFLICT'
  | 'MODEL_INVOCATION_ALLOCATION_CONFLICT' | 'MODEL_INVOCATION_QUOTA_EXHAUSTED' | 'MODEL_INVOCATION_CAPACITY_EXHAUSTED'
  | 'MODEL_INVOCATION_DELIVERY_UNAVAILABLE' | 'MODEL_INVOCATION_RESULT_LIMIT';
export class ModelInvocationStoreError extends Error {
  constructor(readonly code: ModelInvocationStoreErrorCode) { super(code); this.name = 'ModelInvocationStoreError'; }
}
