import type { ModelBindingDefinition, ModelReference } from '#domain/index.js';
import type { ModelActivationActor, ModelActivationAuthorization, ModelActivationCommand,
  ModelActivationReceipt, ModelActivationRecord } from '#domain/index.js';

/** Trusted admission after current authentication/policy. Adapters validate it before persistence. */
export interface ModelActivationAdmission {
  readonly command: ModelActivationCommand;
  readonly actor: ModelActivationActor;
  readonly authorization: ModelActivationAuthorization;
  readonly admittedAtMs: number;
  readonly definition?: ModelBindingDefinition;
}
export interface ModelActivationResult {
  readonly replayed: boolean;
  /** Historical command evidence, never a claim about the latest activation state. */
  readonly receipt: ModelActivationReceipt;
}
export interface ModelActivationStore {
  loadReceipt(scopeId: string, commandId: string): Promise<ModelActivationReceipt | null>;
  loadRecord(scopeId: string, reference: ModelReference): Promise<ModelActivationRecord | null>;
  admit(input: ModelActivationAdmission): Promise<ModelActivationResult>;
  close(): void;
}
export class ModelActivationStoreError extends Error {
  constructor(readonly code: 'MODEL_ACTIVATION_COMMAND_CONFLICT' | 'MODEL_ACTIVATION_CORRUPT'
    | 'MODEL_ACTIVATION_UNAVAILABLE' | 'MODEL_ACTIVATION_OUTCOME_UNKNOWN' | 'MODEL_ACTIVATION_CATALOG_CONFLICT') {
    super(code); this.name = 'ModelActivationStoreError';
  }
}
