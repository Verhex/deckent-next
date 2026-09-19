import type { ModelActivationRecord, ModelBindingDefinition, ModelInvocationActor, ModelInvocationAuthorization,
  ModelInvocationClaim, ModelInvocationCommand, ModelInvocationNativeResponse, ModelInvocationProfile,
  ModelInvocationReceipt, ModelInvocationUnknownReason } from '#domain/index.js';

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
export interface ModelInvocationClaimResult { readonly replayed: boolean; readonly receipt: ModelInvocationReceipt }
export interface ModelInvocationStore {
  loadReceipt(scopeId: string, commandId: string): Promise<ModelInvocationReceipt | null>;
  claim(input: ModelInvocationAdmission): Promise<ModelInvocationClaimResult>;
  recordResponse(claim: ModelInvocationClaim, response: ModelInvocationNativeResponse, observedAtMs: number): Promise<ModelInvocationReceipt>;
  recordUnknown(claim: ModelInvocationClaim, reason: ModelInvocationUnknownReason, observedAtMs: number): Promise<ModelInvocationReceipt>;
  loadInvocation(scopeId: string, invocationId: string): Promise<ModelInvocationReceipt | null>;
  close(): void;
}
export type ModelInvocationStoreErrorCode = 'MODEL_INVOCATION_COMMAND_CONFLICT' | 'MODEL_INVOCATION_CORRUPT'
  | 'MODEL_INVOCATION_UNAVAILABLE' | 'MODEL_INVOCATION_OUTCOME_UNKNOWN' | 'MODEL_INVOCATION_ACTIVATION_CONFLICT'
  | 'MODEL_INVOCATION_ALLOCATION_CONFLICT' | 'MODEL_INVOCATION_QUOTA_EXHAUSTED' | 'MODEL_INVOCATION_CAPACITY_EXHAUSTED';
export class ModelInvocationStoreError extends Error {
  constructor(readonly code: ModelInvocationStoreErrorCode) { super(code); this.name = 'ModelInvocationStoreError'; }
}
